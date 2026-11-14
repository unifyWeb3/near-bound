#!/usr/bin/env bash
# CI-safe dependency vulnerability check.
#
# Reads the dependency trees of the `bound-policy` and `bound-contract` crates
# and reports known vulnerabilities from the RustSec advisory database using
# cargo-audit at a pinned version. Read-only for the project: it never changes
# a lock file or source tree. It may install cargo-audit and fetch the public
# RustSec advisory database on the first run.
#
# The gate fails closed. A missing tool, an installation failure, an advisory
# database fetch failure, or a known vulnerability all produce a non-zero exit.
# Informational outdated-dependency notices do not fail the check.
#
# One exact RustSec advisory in the contract's test-only VM dependency is
# allowed only after the script proves that the affected crate is absent from
# the production Wasm dependency graph.
#
# Usage:
#   scripts/dependency-check.sh
#
# Environment:
#   CARGO_AUDIT_VERSION  pinned cargo-audit version (default 0.23.0)
#   CARGO_AUDIT_BUILD_DIR  compiler artifact directory (default
#                           $HOME/.cache/cargo-audit-build)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CARGO_AUDIT_VERSION="${CARGO_AUDIT_VERSION:-0.23.0}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "dependency-check: cargo is required" >&2
  exit 2
fi

# cargo-audit is installed under CARGO_HOME/bin. Make that location visible
# before checking for the command, otherwise a fresh install cannot be used in
# the same run.
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export CARGO_HOME
export PATH="$CARGO_HOME/bin:$PATH"

installed_version() {
  command -v cargo-audit >/dev/null 2>&1 || return 1
  cargo-audit --version 2>/dev/null | head -n 1
}

version_matches() {
  local installed
  installed="$(installed_version)" || return 1
  printf '%s\n' "$installed" | grep -Eq "(^|[^0-9])v?${CARGO_AUDIT_VERSION}([[:space:]]|$)"
}

if ! version_matches; then
  echo "dependency-check: installing cargo-audit ${CARGO_AUDIT_VERSION} (pinned)"
  # Keep Cargo's temporary and compiler artifacts out of the small /tmp
  # filesystem. The installed binary remains in CARGO_HOME/bin.
  install_root="${CARGO_AUDIT_BUILD_DIR:-$HOME/.cache/cargo-audit-build}"
  mkdir -p "$install_root/target" "$install_root/tmp"
  if ! TMPDIR="$install_root/tmp" cargo install cargo-audit \
    --version "$CARGO_AUDIT_VERSION" \
    --locked \
    --force \
    --target-dir "$install_root/target"; then
    echo "dependency-check: could not install cargo-audit ${CARGO_AUDIT_VERSION}" >&2
    exit 1
  fi
fi

if ! version_matches; then
  echo "dependency-check: cargo-audit version check failed" >&2
  installed_version >&2 || true
  exit 1
fi

echo "dependency-check: using $(installed_version)"

# Updating the advisory database is part of the check. If the update fails, the
# audit did not happen and the gate must not report success.
if ! cargo audit update-db; then
  echo "dependency-check: could not fetch the RustSec advisory database" >&2
  exit 1
fi

TEST_ONLY_ADVISORY="RUSTSEC-2026-0387"
TEST_ONLY_CRATE="crypto-bigint"
PATCHED_CRYPTO_BIGINT_VERSION="0.7.6"

# cargo-audit scans the whole lock file, including dev-only crates. Prove the
# affected crate and version are absent from the production Wasm graph before
# allowing this one advisory in the contract lock file.
echo "dependency-check: checking the production Wasm dependency graph"
if ! wasm_graph="$(cd contract && cargo tree \
  --locked \
  --target wasm32-unknown-unknown \
  --edges normal,build \
  --prefix none \
  --format '{p}')"; then
  echo "dependency-check: could not resolve the production Wasm dependency graph" >&2
  exit 1
fi
if ! printf '%s\n' "$wasm_graph" | grep -q '^bound-contract '; then
  echo "dependency-check: the production Wasm dependency graph is incomplete" >&2
  exit 1
fi

wasm_crypto_bigint_versions="$(
  printf '%s\n' "$wasm_graph" |
    awk '$1 == "crypto-bigint" { sub(/^v/, "", $2); print $2 }'
)"
for version in $wasm_crypto_bigint_versions; do
  newest="$(
    printf '%s\n%s\n' "$version" "$PATCHED_CRYPTO_BIGINT_VERSION" |
      LC_ALL=C sort -V |
      tail -n 1
  )"
  if [ "$version" != "$newest" ]; then
    echo "dependency-check: affected $TEST_ONLY_CRATE $version is present in the production Wasm graph" >&2
    exit 1
  fi
done

status=0
echo "dependency-check: auditing policy"
if (cd policy && cargo audit); then
  echo "dependency-check: policy: no known vulnerabilities"
else
  rc=$?
  echo "dependency-check: policy: cargo audit reported issues (exit $rc)" >&2
  status=1
fi

echo "dependency-check: auditing contract"
if (cd contract && cargo audit --ignore "$TEST_ONLY_ADVISORY"); then
  echo "dependency-check: contract: no known vulnerabilities outside the scoped test-only advisory"
else
  rc=$?
  echo "dependency-check: contract: cargo audit reported issues (exit $rc)" >&2
  status=1
fi

if [ "$status" -ne 0 ]; then
  echo "dependency-check: known vulnerabilities found" >&2
  exit 1
fi

echo "dependency-check: no known vulnerabilities in bound-policy or bound-contract"
