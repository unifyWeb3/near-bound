#!/usr/bin/env bash
# Deterministic Wasm build and verification for the bound contract.
#
# Builds contract/ with the pinned Rust toolchain (rust-toolchain.toml), a fixed
# CARGO_HOME, and path remapping so the machine does not leak into the bytes.
# Runs wasm-opt with fixed flags, builds twice in separate target directories,
# compares the SHA-256 bytes of both optimized artifacts, and writes a
# machine-readable local artifact manifest.
#
# The remediation artifact is never compared to the historical live hash: this
# branch is not deployed, and the two must remain separate.
#
# Usage:
#   scripts/build-wasm.sh [contract dir]
#
# Environment:
#   CARGO_HOME   override (default $HOME/.audit-cargo)
#   RUST_TOOLCHAIN override (default the rust-toolchain.toml channel, 1.99.1)
#   BINARYEN_DIR override (default $HOME/.audit-binaryen/binaryen-version_133)
#   MANIFEST     override (default target/certalyn-wasm-manifest.json)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTRACT_DIR="${1:-contract}"
MANIFEST="${MANIFEST:-$CONTRACT_DIR/target/certalyn-wasm-manifest.json}"
CARGO_HOME="${CARGO_HOME:-$HOME/.audit-cargo}"
BINARYEN_DIR="${BINARYEN_DIR:-$HOME/.audit-binaryen/binaryen-version_133}"

# Pinned Binaryen 133 (x86_64-linux). Version and SHA-256 are pinned together;
# neither is guessed at runtime.
BINARYEN_VERSION="version_133"
BINARYEN_ARCHIVE="binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz"
BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/${BINARYEN_ARCHIVE}"
BINARYEN_SHA256="2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489"

WASM_OPT_FLAGS=(-Oz --enable-nontrapping-float-to-int --enable-bulk-memory)

log() { printf '[build-wasm] %s\n' "$*" >&2; }

die() { printf '[build-wasm] ERROR: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- Rust toolchain --------------------------------------------------------
if ! have cargo || ! have rustc; then
  if [ -d "$HOME/.local/rust-toolchain/bin" ]; then
    export PATH="$HOME/.local/rust-toolchain/bin:$PATH"
  fi
fi
have cargo || die "cargo not found (install Rust 1.99.1 or put it on PATH)"
have rustc || die "rustc not found"

rustc_version="$(rustc --version)"
log "rustc: $rustc_version"

# --- Binaryen 133 ----------------------------------------------------------
WASM_OPT=""
if [ -x "$BINARYEN_DIR/bin/wasm-opt" ]; then
  WASM_OPT="$BINARYEN_DIR/bin/wasm-opt"
elif have wasm-opt; then
  WASM_OPT="$(command -v wasm-opt)"
else
  # Fetch and pin Binaryen 133 by version and SHA-256. Read-only verification,
  # no install into system locations.
  cache_dir="$HOME/.audit-binaryen/cache"
  mkdir -p "$cache_dir"
  archive="$cache_dir/$BINARYEN_ARCHIVE"
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
  mkdir -p "$BINARYEN_DIR"
  tar -xzf "$archive" -C "$HOME/.audit-binaryen"
  mv "$HOME/.audit-binaryen/binaryen-$BINARYEN_VERSION" "$BINARYEN_DIR"
  WASM_OPT="$BINARYEN_DIR/bin/wasm-opt"
fi
[ -x "$WASM_OPT" ] || die "wasm-opt not found at $WASM_OPT"
log "wasm-opt: $WASM_OPT"

# --- Fixed RUSTFLAGS: path remapping so the machine leaves the bytes -------
export CARGO_HOME
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$ROOT=repo --remap-path-prefix=$CARGO_HOME/registry/src=registry"

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
  ( cd "$CONTRACT_DIR" \
    && RUSTFLAGS="$RUSTFLAGS --remap-path-prefix=$target_dir=target" \
    && cargo build --release --locked --target wasm32-unknown-unknown --target-dir "$target_dir" \
    && "$WASM_OPT" "${WASM_OPT_FLAGS[@]}" "$profile_release" -o "$out_wasm" ) \
    || die "wasm build/optimize failed for $target_dir"

  [ -f "$out_wasm" ] || die "optimized wasm not produced at $out_wasm"
  sha256sum "$out_wasm" | awk '{print $1}'
}

TARGET_A="$(mktemp -d -t certalyn-build-a.XXXXXX)"
TARGET_B="$(mktemp -d -t certalyn-build-b.XXXXXX)"
WASM_A="$TARGET_A/bound_contract.wasm"
WASM_B="$TARGET_B/bound_contract.wasm"

cleanup() { rm -rf "$TARGET_A" "$TARGET_B"; }
trap cleanup EXIT

log "building wasm copy 1 ($TARGET_A)"
SHA_A="$(build_once "$TARGET_A" "$WASM_A")"
log "sha256 copy 1: $SHA_A"

log "building wasm copy 2 ($TARGET_B)"
SHA_B="$(build_once "$TARGET_B" "$WASM_B")"
log "sha256 copy 2: $SHA_B"

# A failed build inside the substitution must not look like a pass.
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
  "wasm_opt_flags": ["-Oz", "--enable-nontrapping-float-to-int", "--enable-bulk-memory"],
  "cargo_home": "$CARGO_HOME",
  "source_commit": "187fd92843d3a73702e19e95d13a06c36661c8a2",
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
