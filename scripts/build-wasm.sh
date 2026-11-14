#!/usr/bin/env bash
# Deterministic Wasm build and verification for the Certalyn contract.
#
# Builds contract/ with Rust 1.99.1 from a canonical fixed source path, a
# fixed CARGO_HOME, and path remapping so the machine does not leak into the
# bytes. It runs the checksum-verified Binaryen 133 optimizer with fixed
# flags, builds twice in separate target directories, compares the SHA-256
# bytes of both artifacts, and writes a machine-readable local manifest.
#
# Cargo embeds a path package's absolute source identity in crate metadata.
# Merely remapping diagnostics is therefore not enough: the checkout itself
# is copied to the same canonical path on every machine before Cargo runs.
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

# These paths are deliberately not configurable. Cargo's package identity for
# path dependencies includes their absolute location, so changing this path
# changes the Wasm bytes even when --remap-path-prefix hides the path from
# diagnostics. Keep one canonical location across developer machines and CI.
CANONICAL_BUILD_ROOT="/tmp/certalyn-wasm-build"
CANONICAL_SOURCE_ROOT="$CANONICAL_BUILD_ROOT/source"
CANONICAL_BUILD_LOCK="${CANONICAL_BUILD_ROOT}.lock"
CANONICAL_BUILD_MARKER="certalyn-wasm-build-v1"

case "$CONTRACT_DIR" in
  /*) CONTRACT_SOURCE="$CONTRACT_DIR" ;;
  *) CONTRACT_SOURCE="$ROOT/$CONTRACT_DIR" ;;
esac
CONTRACT_NAME="$(basename "$CONTRACT_SOURCE")"
CANONICAL_CONTRACT_DIR="$CANONICAL_SOURCE_ROOT/$CONTRACT_NAME"

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

TARGET_A="$CANONICAL_BUILD_ROOT/target-a"
TARGET_B="$CANONICAL_BUILD_ROOT/target-b"
BINARYEN_TMP=""
LOCK_OWNED="false"
BUILD_ROOT_OWNED="false"

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
case "$CARGO_HOME" in
  *[[:space:]]*) die "CARGO_HOME cannot contain whitespace, got: $CARGO_HOME" ;;
esac
[ -d "$CONTRACT_SOURCE" ] || die "contract directory not found: $CONTRACT_SOURCE"
[ -d "$ROOT/policy" ] || die "policy directory not found: $ROOT/policy"
[ -f "$ROOT/rust-toolchain.toml" ] || die "rust-toolchain.toml not found: $ROOT/rust-toolchain.toml"

cleanup() {
  [ -z "$BINARYEN_TMP" ] || rm -rf "$BINARYEN_TMP"
  if [ "$LOCK_OWNED" = "true" ]; then
    rm -rf "$CANONICAL_BUILD_LOCK"
    if [ "$BUILD_ROOT_OWNED" = "true" ]; then
      rm -rf "$CANONICAL_BUILD_ROOT"
    fi
  fi
}
trap cleanup EXIT

# Copy a source tree without its build output. The destination path is fixed,
# so Cargo sees the same path-package identity on every machine.
copy_source_tree() {
  local source_dir="$1"
  local destination_dir="$2"

  mkdir -p "$destination_dir"
  tar -C "$source_dir" --exclude='./target' --exclude='./target/**' -cf - . \
    | tar -C "$destination_dir" -xf -
}

# Claim the one canonical build location. A stale lock from an interrupted run
# is recoverable, but a live concurrent build is refused instead of racing.
acquire_canonical_build() {
  if [ -L "$CANONICAL_BUILD_LOCK" ]; then
    die "refusing to use symlinked canonical build lock: $CANONICAL_BUILD_LOCK"
  fi

  if ! mkdir "$CANONICAL_BUILD_LOCK" 2>/dev/null; then
    local lock_pid=""
    if [ -f "$CANONICAL_BUILD_LOCK/pid" ]; then
      lock_pid="$(cat "$CANONICAL_BUILD_LOCK/pid")"
    fi
    case "$lock_pid" in
      ''|*[!0-9]*) ;;
      *)
        if kill -0 "$lock_pid" 2>/dev/null; then
          die "another canonical Wasm build is running (pid $lock_pid)"
        fi
        ;;
    esac
    rm -rf "$CANONICAL_BUILD_LOCK"
    mkdir "$CANONICAL_BUILD_LOCK" \
      || die "cannot acquire canonical build lock: $CANONICAL_BUILD_LOCK"
  fi
  LOCK_OWNED="true"
  printf '%s\n' "$$" > "$CANONICAL_BUILD_LOCK/pid"

  if [ -L "$CANONICAL_BUILD_ROOT" ]; then
    die "refusing to use symlinked canonical build root: $CANONICAL_BUILD_ROOT"
  fi
  if [ -e "$CANONICAL_BUILD_ROOT" ]; then
    if [ ! -f "$CANONICAL_BUILD_ROOT/.certalyn-wasm-build" ] \
      || [ "$(cat "$CANONICAL_BUILD_ROOT/.certalyn-wasm-build")" != "$CANONICAL_BUILD_MARKER" ]; then
      die "refusing to replace unrecognized canonical build root: $CANONICAL_BUILD_ROOT"
    fi
    rm -rf "$CANONICAL_BUILD_ROOT"
  fi
  mkdir -p "$CANONICAL_BUILD_ROOT"
  printf '%s\n' "$CANONICAL_BUILD_MARKER" > "$CANONICAL_BUILD_ROOT/.certalyn-wasm-build"
  BUILD_ROOT_OWNED="true"

  mkdir -p "$CANONICAL_SOURCE_ROOT"
  copy_source_tree "$CONTRACT_SOURCE" "$CANONICAL_CONTRACT_DIR"
  copy_source_tree "$ROOT/policy" "$CANONICAL_SOURCE_ROOT/policy"
  cp "$ROOT/rust-toolchain.toml" "$CANONICAL_SOURCE_ROOT/rust-toolchain.toml"
}

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

# --- Canonical source and fixed path remapping ------------------------------
# Cargo's identity for a path package contains its absolute path. Stage the
# checkout at one canonical path before Cargo sees it, then remap that path
# and the registry sources out of diagnostics and metadata.
acquire_canonical_build

mkdir -p "$CARGO_HOME"
CARGO_HOME_REAL="$(readlink -f "$CARGO_HOME" 2>/dev/null || true)"

# The script owns these values. Ambient CI or developer flags would make local
# and CI artifacts differ, so they are deliberately not inherited.
unset CARGO_ENCODED_RUSTFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER CARGO_BUILD_RUSTC RUSTC
export CARGO_HOME

# The registry protocol is pinned, because the name of the registry source
# directory carries a hash of the protocol and the Cargo version. A different
# name is a different Wasm.
export CARGO_REGISTRIES_CRATES_IO_PROTOCOL="sparse"

# Fetch the locked dependencies before the remapping is worked out, so the
# registry source directory exists and its name can be remapped.
(cd "$CANONICAL_CONTRACT_DIR" && cargo fetch --locked) \
  || die "could not fetch the locked dependencies"

export RUSTFLAGS="--remap-path-prefix=$CANONICAL_BUILD_ROOT=certalyn-wasm-build"

# Every registry source directory is remapped to the same fixed name. The
# directory carries a hash of the registry protocol and the Cargo version, so
# without this the Wasm of one machine holds a different path than the Wasm of
# the next one, and the two are not byte identical.
remap_registry_sources() {
  local registry_src="$CARGO_HOME/registry/src"
  [ -d "$registry_src" ] || return 0
  local dir
  for dir in "$registry_src"/*/; do
    [ -d "$dir" ] || continue
    RUSTFLAGS="$RUSTFLAGS --remap-path-prefix=${dir%/}=registry"
  done
  if [ -n "$CARGO_HOME_REAL" ] && [ "$CARGO_HOME_REAL" != "$CARGO_HOME" ] \
    && [ -d "$CARGO_HOME_REAL/registry/src" ]; then
    for dir in "$CARGO_HOME_REAL/registry/src"/*/; do
      [ -d "$dir" ] || continue
      RUSTFLAGS="$RUSTFLAGS --remap-path-prefix=${dir%/}=registry"
    done
  fi
}
remap_registry_sources
export RUSTFLAGS

# --- Build one copy of the wasm --------------------------------------------
build_once() {
  local target_dir="$1"
  local out_wasm="$2"
  local profile_release
  profile_release="$target_dir/wasm32-unknown-unknown/release/bound_contract.wasm"

  (cd "$CANONICAL_CONTRACT_DIR" \
    && cargo build --release --locked --target wasm32-unknown-unknown --target-dir "$target_dir" \
    && "$WASM_OPT" "${WASM_OPT_FLAGS[@]}" "$profile_release" -o "$out_wasm") \
    || die "wasm build/optimize failed for $target_dir"

  [ -f "$out_wasm" ] || die "optimized wasm not produced at $out_wasm"
  sha256sum "$out_wasm" | awk '{print $1}'
}

mkdir -p "$TARGET_A" "$TARGET_B"
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
FINAL_WASM="$CONTRACT_SOURCE/target/wasm32-unknown-unknown/release/bound_contract.wasm"
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
  "canonical_build_root": "$CANONICAL_BUILD_ROOT",
  "canonical_source_root": "$CANONICAL_SOURCE_ROOT",
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
