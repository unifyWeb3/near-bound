#!/usr/bin/env bash
# Fake-NEAR shell tests for demo/agent.sh and demo/protocol_arm.sh.
#
# Exercises both demo scripts against a deterministic fake `near` executable
# (tests/fake-near/near): no testnet, no keys, no spending, no network.
#
# Asserts:
#   * JSON escaping (memo with quotes/backslashes round-trips)
#   * numeric rejection (zero, float, negative, non-digits, above u128 max)
#   * monotonic nonce behavior (concurrent-safe counter increases across runs)
#   * expected PASS/FAIL transcripts for protocol_arm.sh (all six steps PASS)
#   * settlement polling (agent.sh reports new receipts)
#
# Dependency-free: bash, python3, flock, base64 only.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAKE_NEAR="$ROOT/tests/fake-near/near"
AGENT_SH="$ROOT/demo/agent.sh"
PROTOCOL_ARM_SH="$ROOT/demo/protocol_arm.sh"

export FAKE_NEAR_STATE="${FAKE_NEAR_STATE:-$(mktemp -t certalyn-fake-state.XXXXXX.json)}"
cp "$ROOT/tests/fake-near/state.json" "$FAKE_NEAR_STATE"

PASS=0
FAIL=0

note() { printf '[test] %s\n' "$*" >&2; }
pass() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'not ok  %s\n' "$*" >&2; }

reset_state() {
  cp "$ROOT/tests/fake-near/state.json" "$FAKE_NEAR_STATE"
}

# ---- numeric rejection: agent.sh must exit non-zero for bad amounts ----
expect_rejection() {
  local label="$1"; shift
  local out rc
  out=$("$AGENT_SH" --contract bound-testnet-97685.testnet --agent bound-agent.testnet \
    --vendor bound-vendor.testnet --amount "$1" --key /tmp/no-such-key.json \
    --near-bin "$FAKE_NEAR" --nonce 100 "$@" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    fail "$label: expected rejection for amount '$1', exited 0"
    printf '%s\n' "$out" | tail -5 >&2
  else
    pass "$label: rejected amount '$1' (exit $rc)"
  fi
}

reset_state
note "numeric rejection (agent.sh)"
expect_rejection "zero amount" "0"
expect_rejection "float amount" "1.5"
expect_rejection "negative amount" "-5"
expect_rejection "non-digit amount" "abc"
expect_rejection "above u128 max" "340282366920938463463374607431768211456"

# ---- JSON escaping: memo with quotes and backslashes ----
reset_state
note "JSON escaping (agent.sh)"
out=$("$AGENT_SH" --contract bound-testnet-97685.testnet --agent bound-agent.testnet \
  --vendor bound-vendor.testnet --amount 1000000000000000000000000 \
  --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" --nonce 100 \
  --memo 'he said "hi" \t there' 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
  fail "JSON escaping: agent.sh exited $rc"
  printf '%s\n' "$out" | tail -8 >&2
elif printf '%s' "$out" | grep -q 'every hard check passed'; then
  pass "JSON escaping: memo with quotes/backslashes accepted"
else
  fail "JSON escaping: expected success, got:"
  printf '%s\n' "$out" | tail -8 >&2
fi

# ---- monotonic nonce: nonce increases across runs ----
reset_state
note "monotonic nonce (agent.sh)"
n1=$("$AGENT_SH" --contract bound-testnet-97685.testnet --agent bound-agent.testnet \
  --vendor bound-vendor.testnet --amount 1000000000000000000000000 \
  --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" 2>&1 \
  | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | tail -1)
n2=$("$AGENT_SH" --contract bound-testnet-97685.testnet --agent bound-agent.testnet \
  --vendor bound-vendor.testnet --amount 1000000000000000000000000 \
  --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" 2>&1 \
  | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | tail -1)
if [ -z "$n1" ] || [ -z "$n2" ]; then
  fail "monotonic nonce: could not read nonce from agent.sh output"
elif [ "$n2" -gt "$n1" ] 2>/dev/null; then
  pass "monotonic nonce: $n1 -> $n2 (increased)"
else
  fail "monotonic nonce: $n1 -> $n2 (not increased)"
fi

# ---- valid run with settlement polling ----
reset_state
note "settlement polling (agent.sh)"
out=$("$AGENT_SH" --contract bound-testnet-97685.testnet --agent bound-agent.testnet \
  --vendor bound-vendor.testnet --amount 1000000000000000000000000 \
  --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" --nonce 200 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
  fail "settlement polling: agent.sh exited $rc"
  printf '%s\n' "$out" | tail -8 >&2
elif printf '%s' "$out" | grep -q 'transaction' && printf '%s' "$out" | grep -q 'receipt 30'; then
  pass "settlement polling: transaction hash and new receipt reported"
else
  fail "settlement polling: expected transaction + receipt 30"
  printf '%s\n' "$out" | tail -10 >&2
fi

# ---- protocol_arm.sh: all six steps PASS ----
reset_state
note "protocol_arm.sh transcript (all six steps PASS)"
out=$(NEAR_BIN="$FAKE_NEAR" "$PROTOCOL_ARM_SH" bound-testnet-97685.testnet bound-agent.testnet \
  bound-vendor.testnet /tmp/no-such-key.json 2>&1)
rc=$?
passes=$(printf '%s\n' "$out" | grep -c '^PASS  ')
fails=$(printf '%s\n' "$out" | grep -c '^FAIL  ')
if [ "$rc" -eq 0 ] && [ "$passes" -eq 6 ] && [ "$fails" -eq 0 ]; then
  pass "protocol_arm.sh: $passes passed, $fails failed"
else
  fail "protocol_arm.sh: $passes passed, $fails failed, exit $rc"
  printf '%s\n' "$out" | tail -20 >&2
fi

# ---- protocol_arm.sh monotonic nonce increases ----
reset_state
note "monotonic nonce (protocol_arm.sh)"
pn1=$(NEAR_BIN="$FAKE_NEAR" "$PROTOCOL_ARM_SH" bound-testnet-97685.testnet bound-agent.testnet \
  bound-vendor.testnet /tmp/no-such-key.json 2>&1 \
  | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | tail -1)
pn2=$(NEAR_BIN="$FAKE_NEAR" "$PROTOCOL_ARM_SH" bound-testnet-97685.testnet bound-agent.testnet \
  bound-vendor.testnet /tmp/no-such-key.json 2>&1 \
  | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | tail -1)
if [ -z "$pn1" ] || [ -z "$pn2" ]; then
  fail "monotonic nonce: could not read nonce from protocol_arm.sh output"
elif [ "$pn2" -gt "$pn1" ] 2>/dev/null; then
  pass "monotonic nonce: $pn1 -> $pn2 (increased)"
else
  fail "monotonic nonce: $pn1 -> $pn2 (not increased)"
fi

echo
echo "fake-NEAR tests: $PASS passed, $FAIL failed"
test "$FAIL" -eq 0
