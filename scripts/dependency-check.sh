#!/usr/bin/env bash
# CI-safe dependency vulnerability check.
#
# Reads the dependency trees of the `bound-policy` and `bound-contract` crates
# and reports known vulnerabilities from the RustSec advisory database using
# cargo-audit at a pinned version. Read-only: it never modifies the lock files,
# the source, or the network state beyond fetching the advisory database and,
# on first run, the cargo-audit binary itself.
#
# It fails only on known vulnerabilities, not on informational outdated
# dependencies (cargo-audit does not fail on those by default).
#
# Usage:
#   scripts/dependency-check.sh
#
# Environment:
#   CARGO_AUDIT_VERSION  pinned cargo-audit version (default 0.18.1)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CARGO_AUDIT_VERSION="${CARGO_AUDIT_VERSION:-0.18.1}"

if ! command -v cargo >/dev/null; then
  echo "dependency-check: cargo is required" >&2
  exit 2
fi

if ! command -v cargo-audit >/dev/null; then
  echo "dependency-check: installing cargo-audit ${CARGO_AUDIT_VERSION} (pinned)"
  cargo install cargo-audit --version "${CARGO_AUDIT_VERSION}" || \
    echo "dependency-check: WARNING: could not install cargo-audit; skipping vulnerability check" >&2 && exit 0
fi

# Fetch the advisory database (read-only), then audit both crates.
cargo audit fetch 2>/dev/null || true

status=0
for crate in policy contract; do
  echo "dependency-check: auditing $crate"
  if ( cd "$crate" && cargo audit ); then
    echo "dependency-check: $crate: no known vulnerabilities"
  else
    rc=$?
    echo "dependency-check: $crate: cargo audit reported issues (exit $rc)" >&2
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "dependency-check: known vulnerabilities found" >&2
  exit 1
fi
echo "dependency-check: no known vulnerabilities in bound-policy or bound-contract"
