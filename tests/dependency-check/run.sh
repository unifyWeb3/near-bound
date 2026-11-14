#!/usr/bin/env bash
# Failure-path checks for scripts/dependency-check.sh.
#
# The test uses fake cargo commands. It proves that an installation failure, an
# advisory-database fetch failure, a reported vulnerability, a wrong tool
# version, and an affected crate in the production graph all fail the gate. It
# also proves that a clean fake audit uses only the scoped advisory exception.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d -t certalyn-dependency-check.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

note() { printf '[test] %s\n' "$*" >&2; }
pass() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'not ok  %s\n' "$*" >&2; }

mkdir -p "$TMP/bin" "$TMP/home/bin" "$TMP/build"
cat > "$TMP/bin/cargo" <<'SH'
#!/usr/bin/env bash
if [ -n "${FAKE_CARGO_LOG:-}" ]; then
  printf '%s\t%s\n' "$PWD" "$*" >> "$FAKE_CARGO_LOG"
fi
if [ "${1:-}" = "install" ]; then
  exit "${FAKE_INSTALL_STATUS:-0}"
fi
if [ "${1:-}" = "audit" ]; then
  shift
  exec cargo-audit "$@"
fi
if [ "${1:-}" = "tree" ]; then
  echo "bound-contract v0.1.0 (/tmp/contract)"
  if [ "${FAKE_TREE_CRYPTO_BIGINT:-0}" -ne 0 ]; then
    echo "crypto-bigint v${FAKE_TREE_CRYPTO_BIGINT_VERSION:-0.5.5}"
  fi
  exit "${FAKE_TREE_STATUS:-0}"
fi
exit 0
SH
cat > "$TMP/bin/cargo-audit" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  if [ "${FAKE_VERSION_STATUS:-0}" -ne 0 ]; then
    exit "$FAKE_VERSION_STATUS"
  fi
  echo "${FAKE_VERSION:-cargo-audit 0.23.0}"
  exit 0
fi
if [ "${1:-}" = "update-db" ]; then
  exit "${FAKE_FETCH_STATUS:-0}"
fi
exit "${FAKE_AUDIT_STATUS:-0}"
SH
chmod +x "$TMP/bin/cargo" "$TMP/bin/cargo-audit"

expect_failure() {
  local label="$1"
  shift
  local out rc
  out=$(env \
    PATH="$TMP/bin:$PATH" \
    CARGO_HOME="$TMP/home" \
    CARGO_AUDIT_BUILD_DIR="$TMP/build" \
    "$@" \
    bash "$ROOT/scripts/dependency-check.sh" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "$label: failed closed (exit $rc)"
  else
    fail "$label: expected a non-zero exit"
    printf '%s\n' "$out" | tail -8 >&2
  fi
}

note "dependency-check failure paths"
expect_failure "cargo-audit install failure" FAKE_VERSION_STATUS=1 FAKE_INSTALL_STATUS=42
expect_failure "advisory database fetch failure" FAKE_FETCH_STATUS=42
expect_failure "reported vulnerability" FAKE_AUDIT_STATUS=1
expect_failure "wrong cargo-audit version" FAKE_VERSION="cargo-audit v0.22.0"
expect_failure "affected crate in the production graph" FAKE_TREE_CRYPTO_BIGINT=1
expect_failure "production graph resolution failure" FAKE_TREE_STATUS=42

note "dependency-check clean path"
out=$(env \
  PATH="$TMP/bin:$PATH" \
  CARGO_HOME="$TMP/home" \
  CARGO_AUDIT_BUILD_DIR="$TMP/build" \
  FAKE_CARGO_LOG="$TMP/cargo.log" \
  FAKE_FETCH_STATUS=0 \
  FAKE_AUDIT_STATUS=0 \
  bash "$ROOT/scripts/dependency-check.sh" 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'no known vulnerabilities'; then
  pass "clean fake audit: succeeded"
else
  fail "clean fake audit: expected success, exit $rc"
  printf '%s\n' "$out" | tail -8 >&2
fi

if grep -Fq "$ROOT/contract"$'\taudit --ignore RUSTSEC-2026-0387' "$TMP/cargo.log"; then
  pass "contract audit: used the exact scoped advisory"
else
  fail "contract audit: expected the exact scoped advisory"
fi

if grep -Fq "$ROOT/policy"$'\taudit' "$TMP/cargo.log"; then
  pass "policy audit: did not suppress advisories"
else
  fail "policy audit: expected an unscoped audit"
fi

if grep -Fq "$ROOT/contract"$'\ttree --locked --target wasm32-unknown-unknown' "$TMP/cargo.log"; then
  pass "production graph: checked the Wasm target"
else
  fail "production graph: expected the Wasm target check"
fi

if grep -Fq -- '--ignore-crate=crypto-bigint' "$TMP/cargo.log"; then
  fail "production graph: used a crate-wide advisory suppression"
else
  pass "production graph: did not suppress the whole crate"
fi

out=$(env \
  PATH="$TMP/bin:$PATH" \
  CARGO_HOME="$TMP/home" \
  CARGO_AUDIT_BUILD_DIR="$TMP/build" \
  FAKE_FETCH_STATUS=0 \
  FAKE_AUDIT_STATUS=0 \
  FAKE_TREE_CRYPTO_BIGINT=1 \
  FAKE_TREE_CRYPTO_BIGINT_VERSION=0.7.6 \
  bash "$ROOT/scripts/dependency-check.sh" 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "production graph: accepted the patched crypto-bigint version"
else
  fail "production graph: expected the patched version to pass, exit $rc"
  printf '%s\n' "$out" | tail -8 >&2
fi

echo
echo "dependency-check tests: $PASS passed, $FAIL failed"
test "$FAIL" -eq 0
