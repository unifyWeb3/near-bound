#!/usr/bin/env bash
# Deterministic Wasm build and verification for the Certalyn contract.
#
# Builds contract/ with Rust 1.99.1, a fixed CARGO_HOME, and path remapping
# so the machine does not leak into the bytes. It runs the checksum-verified
# Binaryen 133 optimizer with fixed flags, builds twice in separate target
# directories, compares the SHA-256 bytes of both artifacts, and writes a
# machine-readable local manifest.
#
# The remediation artifact is never compared to the historical live hash. This
# branch is not deployed, and the two must remain separate.
#
# Usage:
#   scripts/build-wasm.sh [contract dir]
#
# Environment:
#   CARGO_HOME         override (default $HOME/.audit-cargo)
#   BINARYEN_CACHE_DIR override (default $HOME/.audit-binaryen/cache)
#   MANIFEST           override (default <contract>/target/certalyn-wasm-manifest.json)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTRACT_DIR="${1:-contract}"
MANIFEST="${MANIFEST:-$CONTRACT_DIR/target/certalyn-wasm-manifest.json}"
CARGO_HOME="${CARGO_HOME:-$HOME/.audit-cargo}"
BINARYEN_CACHE_DIR="${BINARYEN_CACHE_DIR:-$HOME/.audit-binaryen/cache}"

# Pinned Rust toolchain. The repository's rust-toolchain.toml carries the same
# version, and the script refuses a different compiler.
RUST_VERSION="1.99.1"

# Pinned Binaryen 133 (x86_64-linux). The archive and the extracted optimizer
# are checked together. A system wasm-opt is never accepted.
BINARYEN_VERSION="version_133"
BINARYEN_ARCHIVE="binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz"
BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/${BINARYEN_ARCHIVE}"
BINARYEN_SHA256="2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489"
BINARYEN_WASM_OPT_SHA256="8f25e9fd5db0fc5f210003aaa432922feb2e52d309e430def2f929e34da9466b"

WASM_OPT_FLAGS=(-Oz --enable-nontrapping-float-to-int --enable-bulk-memory)

TARGET_A=""
TARGET_B=""
BINARYEN_TMP=""

log() { printf '[build-wasm] %s\n' "$*" >&2; }
die() { printf '[build-wasm] ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Cargo requires an absolute home path. Reject a malformed value rather than
# creating a directory whose name is literally `CARGO_HOME=/...` under the
# contract directory.
case "$CARGO_HOME" in
  /*) ;;
  *) die "CARGO_HOME must be an absolute path, got: $CARGO_HOME" ;;
esac

cleanup() {
  [ -z "$TARGET_A" ] || rm -rf "$TARGET_A"
  [ -z "$TARGET_B" ] || rm -rf "$TARGET_B"
  [ -z "$BINARYEN_TMP" ] || rm -rf "$BINARYEN_TMP"
}
trap cleanup EXIT

# --- Rust toolchain --------------------------------------------------------
have cargo || die "cargo not found (install Rust $RUST_VERSION or put it on PATH)"
have rustc || die "rustc not found"

rustc_version="$(rustc --version)"
cargo_version="$(cargo --version)"
log "rustc: $rustc_version"
log "cargo: $cargo_version"
case "$rustc_version" in
  "rustc $RUST_VERSION "*) ;;
  *) die "rustc $RUST_VERSION is required, found: $rustc_version" ;;
esac
case "$cargo_version" in
  "cargo $RUST_VERSION "*) ;;
  *) die "cargo $RUST_VERSION is required, found: $cargo_version" ;;
esac

# --- Binaryen 133 ----------------------------------------------------------
mkdir -p "$BINARYEN_CACHE_DIR"
archive="$BINARYEN_CACHE_DIR/$BINARYEN_ARCHIVE"
if [ ! -f "$archive" ]; then
  log "fetching Binaryen $BINARYEN_VERSION"
  if have curl; then
    curl -fsSL -o "$archive" "$BINARYEN_URL" || die "failed to fetch $BINARYEN_URL"
  elif have wget; then
    wget -q -O "$archive" "$BINARYEN_URL" || die "failed to fetch $BINARYEN_URL"
  else
    die "neither curl nor wget is available to fetch Binaryen"
  fi
fi
printf '%s  %s\n' "$BINARYEN_SHA256" "$archive" | sha256sum -c - >/dev/null \
  || die "Binaryen $BINARYEN_ARCHIVE SHA-256 mismatch (expected $BINARYEN_SHA256)"

BINARYEN_TMP="$(mktemp -d -t certalyn-binaryen.XXXXXX)"
tar -xzf "$archive" -C "$BINARYEN_TMP"
WASM_OPT="$BINARYEN_TMP/binaryen-$BINARYEN_VERSION/bin/wasm-opt"
[ -x "$WASM_OPT" ] || die "pinned wasm-opt not found at $WASM_OPT"
printf '%s  %s\n' "$BINARYEN_WASM_OPT_SHA256" "$WASM_OPT" | sha256sum -c - >/dev/null \
  || die "pinned wasm-opt SHA-256 mismatch"
wasm_opt_version="$($WASM_OPT --version)"
case "$wasm_opt_version" in
  "wasm-opt version 133"*) ;;
  *) die "wasm-opt version 133 is required, found: $wasm_opt_version" ;;
esac
log "wasm-opt: $wasm_opt_version"

# --- Source identity --------------------------------------------------------
SOURCE_COMMIT="$(git rev-parse HEAD)"
SOURCE_DIRTY="false"
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  SOURCE_DIRTY="true"
fi

# --- Fixed RUSTFLAGS: path remapping so the machine leaves the bytes -------
# The script owns this value. Ambient CI or developer RUSTFLAGS would make
# local and CI artifacts differ, so they are deliberately not inherited.
export CARGO_HOME
export RUSTFLAGS="--remap-path-prefix=$ROOT=repo --remap-path-prefix=$CARGO_HOME/registry/src=registry"

mkdir -p "$CARGO_HOME"

# --- Build one copy of the wasm --------------------------------------------
build_once() {
  local target_dir="$1"
  local out_wasm="$2"
  local profile_release
  profile_release="$target_dir/wasm32-unknown-unknown/release/bound_contract.wasm"

  # The target directory is remapped as well. Without it the path of the
  # build directory reaches the bytes, and two builds in two directories are
  # two different artifacts.
  (cd "$CONTRACT_DIR" \
    && RUSTFLAGS="$RUSTFLAGS --remap-path-prefix=$target_dir=target" \
    && cargo build --release --locked --target wasm32-unknown-unknown --target-dir "$target_dir" \
    && "$WASM_OPT" "${WASM_OPT_FLAGS[@]}" "$profile_release" -o "$out_wasm") \
    || die "wasm build/optimize failed for $target_dir"

  [ -f "$out_wasm" ] || die "optimized wasm not produced at $out_wasm"
  sha256sum "$out_wasm" | awk '{print $1}'
}

TARGET_A="$(mktemp -d -t certalyn-build-a.XXXXXX)"
TARGET_B="$(mktemp -d -t certalyn-build-b.XXXXXX)"
WASM_A="$TARGET_A/bound_contract.wasm"
WASM_B="$TARGET_B/bound_contract.wasm"

log "building wasm copy 1 ($TARGET_A)"
SHA_A="$(build_once "$TARGET_A" "$WASM_A")"
log "sha256 copy 1: $SHA_A"

log "building wasm copy 2 ($TARGET_B)"
SHA_B="$(build_once "$TARGET_B" "$WASM_B")"
log "sha256 copy 2: $SHA_B"

[ -n "$SHA_A" ] || die "the first build produced no artifact"
[ -n "$SHA_B" ] || die "the second build produced no artifact"

if [ "$SHA_A" != "$SHA_B" ]; then
  die "deterministic build check failed: copy 1 $SHA_A != copy 2 $SHA_B"
fi

# Copy the verified artifact into the contract target dir for convenience.
FINAL_WASM="$ROOT/$CONTRACT_DIR/target/wasm32-unknown-unknown/release/bound_contract.wasm"
mkdir -p "$(dirname "$FINAL_WASM")"
cp "$WASM_A" "$FINAL_WASM"

# --- Machine-readable local artifact manifest ------------------------------
manifest_dir="$(dirname "$MANIFEST")"
mkdir -p "$manifest_dir"
cat > "$MANIFEST" <<MANIFEST_EOF
{
  "product": "Certalyn",
  "contract": "$CONTRACT_DIR",
  "toolchain": "$rustc_version",
  "binaryen_version": "$BINARYEN_VERSION",
  "binaryen_sha256": "$BINARYEN_SHA256",
  "wasm_opt_sha256": "$BINARYEN_WASM_OPT_SHA256",
  "wasm_opt_flags": ["-Oz", "--enable-nontrapping-float-to-int", "--enable-bulk-memory"],
  "cargo_home": "$CARGO_HOME",
  "source_commit": "$SOURCE_COMMIT",
  "source_dirty": $SOURCE_DIRTY,
  "artifact": "$FINAL_WASM",
  "artifact_sha256": "$SHA_A",
  "deterministic_double_build": true,
  "copy_1_sha256": "$SHA_A",
  "copy_2_sha256": "$SHA_B",
  "compared_to_historical_live_hash": false,
  "note": "The remediation artifact is local only and is not compared to the historical live hash. No redeployment is authorized."
}
MANIFEST_EOF

log "deterministic build OK: sha256 $SHA_A"
log "manifest: $MANIFEST"
printf '%s\n' "$SHA_A"
