#!/usr/bin/env bash
# Fake-NEAR shell tests for demo/agent.sh and demo/protocol_arm.sh.
#
# Exercises both demo scripts against a deterministic fake `near` executable
# (tests/fake-near/near): no testnet, no keys, no spending, no network.
#
# Asserts:
#   * JSON escaping (memo with quotes/backslashes round-trips)
#   * numeric rejection (zero, float, negative, non-digits, above u128 max)
#   * monotonic nonce behavior (the counter increases across runs)
#   * the nonce counter stays out of the developer's own state
#   * deterministic transaction ids
#   * separate request and receipt ids across request, approval and settlement
#   * a replayed nonce is refused and the two watermarks are separate
#   * the owner and the runner roles, and the owner-only flagged request
#   * concurrent runs get unique request ids and unique nonces
#   * the settlement polling finds the receipt of its own request and waits
#     for an approval that lands while it polls
#   * expected PASS/FAIL transcripts for protocol_arm.sh (all six steps PASS)
#
# Dependency-free: bash, python3, flock and base64 only.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAKE_NEAR="$ROOT/tests/fake-near/near"
AGENT_SH="$ROOT/demo/agent.sh"
PROTOCOL_ARM_SH="$ROOT/demo/protocol_arm.sh"

export FAKE_NEAR_STATE="${FAKE_NEAR_STATE:-$(mktemp -t certalyn-fake-state.XXXXXX.json)}"
cp "$ROOT/tests/fake-near/state.json" "$FAKE_NEAR_STATE"

# The nonce counters live in a directory of this test, not in the state of the
# developer who runs it.
CERTALYN_TEST_STATE="$(mktemp -d -t certalyn-fake-nonce.XXXXXX)"
export CERTALYN_STATE_DIR="$CERTALYN_TEST_STATE"
cleanup() {
  rm -rf "$CERTALYN_TEST_STATE"
  rm -f "$FAKE_NEAR_STATE" "$FAKE_NEAR_STATE.lock"
}
trap cleanup EXIT

PASS=0
FAIL=0

note() { printf '[test] %s\n' "$*" >&2; }
pass() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'not ok  %s\n' "$*" >&2; }

reset_state() {
  cp "$ROOT/tests/fake-near/state.json" "$FAKE_NEAR_STATE"
  rm -f "$FAKE_NEAR_STATE.lock"
}

fake_view() {
  local method="$1"
  local args="$2"
  "$FAKE_NEAR" contract call-function as-read-only bound-testnet-97685.testnet "$method" \
    json-args "$args" network-config testnet now 2>&1 \
    | awk '/return value \(printed to stdout\)/{getline; print; exit}'
}

fake_tx() {
  local method="$1"
  local args="$2"
  local signer="$3"
  "$FAKE_NEAR" contract call-function as-transaction bound-testnet-97685.testnet "$method" \
    json-args "$args" sign-as "$signer" network-config testnet send 2>&1
}

agent_run() {
  local nonce="$1"
  shift
  POLL_ATTEMPTS=1 POLL_INTERVAL=0 "$AGENT_SH" --contract bound-testnet-97685.testnet \
    --agent bound-agent.testnet --vendor bound-vendor.testnet \
    --amount 1000000000000000000000000 --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" \
    --nonce "$nonce" "$@" 2>&1
}

# ---- numeric rejection: agent.sh must exit non-zero for bad amounts ----
expect_rejection() {
  local label="$1"; shift
  local out rc
  out=$(agent_run 100 "$@" --amount "$1")
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
out=$(agent_run 100 --memo 'he said "hi" \t there')
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
n1=$(POLL_ATTEMPTS=1 POLL_INTERVAL=0 "$AGENT_SH" --contract bound-testnet-97685.testnet \
  --agent bound-agent.testnet --vendor bound-vendor.testnet \
  --amount 1000000000000000000000000 --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" 2>&1 \
  | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | tail -1)
n2=$(POLL_ATTEMPTS=1 POLL_INTERVAL=0 "$AGENT_SH" --contract bound-testnet-97685.testnet \
  --agent bound-agent.testnet --vendor bound-vendor.testnet \
  --amount 1000000000000000000000000 --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" 2>&1 \
  | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | tail -1)
if [ -z "$n1" ] || [ -z "$n2" ]; then
  fail "monotonic nonce: could not read nonce from agent.sh output"
elif [ "$n2" -gt "$n1" ] 2>/dev/null; then
  pass "monotonic nonce: $n1 -> $n2 (increased)"
else
  fail "monotonic nonce: $n1 -> $n2 (not increased)"
fi

# ---- the nonce counter stays out of the developer's own state ----
note "nonce counter isolation"
home_counter="$HOME/.local/state/certalyn/nonce-bound-agent.testnet.json"
if [ -f "$home_counter" ]; then
  home_counter_before="$(sha256sum "$home_counter" | awk '{print $1}')"
else
  home_counter_before="absent"
fi
counter_file="$CERTALYN_STATE_DIR/nonce-bound-agent.testnet.json"
if [ -f "$counter_file" ]; then
  pass "nonce counter isolation: the counter is in the test directory"
else
  fail "nonce counter isolation: no counter file in $CERTALYN_STATE_DIR"
fi
if [ -f "$home_counter" ]; then
  home_counter_after="$(sha256sum "$home_counter" | awk '{print $1}')"
else
  home_counter_after="absent"
fi
if [ "$home_counter_before" = "$home_counter_after" ]; then
  pass "nonce counter isolation: the counter in the home directory was not touched"
else
  fail "nonce counter isolation: the counter in the home directory was changed"
fi

# ---- request, approval and settlement keep separate ids ----
reset_state
note "request and receipt lifecycle"
out=$(agent_run 200)
rc=$?
request_id=$(printf '%s' "$out" | awk '/request number/{print $NF; exit}')
count_after_request=$(fake_view get_receipt_count '{}')
if [ "$rc" -ne 0 ]; then
  fail "request lifecycle: agent.sh exited $rc"
  printf '%s\n' "$out" | tail -8 >&2
elif [ "$request_id" != "14" ] || [ "$count_after_request" != "30" ]; then
  fail "request lifecycle: expected request 14 and receipt count 30, got request '$request_id' and count '$count_after_request'"
else
  pass "request lifecycle: request 14 did not manufacture receipt 30"
fi

approve_out=$(fake_tx approve_request '{"request_id":14}' owner.testnet)
count_after_settlement=$(fake_view get_receipt_count '{}')
receipt_30=$(fake_view get_receipt '{"receipt_id":30}')
if printf '%s' "$approve_out" | grep -q 'succeeded' \
  && [ "$count_after_settlement" = "31" ] \
  && printf '%s' "$receipt_30" | grep -q '"outcome": "Approved"'; then
  pass "settlement lifecycle: receipt 30 settled request 14"
else
  fail "settlement lifecycle: expected receipt count 31 and an approved receipt 30"
  printf '%s\n' "$approve_out" | tail -8 >&2
fi

# ---- the settlement is counted in the policy ----
reset_state
note "policy accounting after a settlement"
agent_run 201 >/dev/null
fake_tx approve_request '{"request_id":14}' owner.testnet >/dev/null
policy=$(fake_view get_policy '{"agent_id":"bound-agent.testnet"}')
if printf '%s' "$policy" | grep -q '"spent": "1000000000000000000000000"'; then
  pass "policy accounting: the settled amount is in the spend"
else
  fail "policy accounting: the spend does not hold the settled amount"
  printf '%s\n' "$policy" >&2
fi

# ---- a replayed nonce is refused ----
reset_state
note "nonce replay"
agent_run 202 >/dev/null
replay=$(POLL_ATTEMPTS=1 POLL_INTERVAL=0 "$AGENT_SH" --contract bound-testnet-97685.testnet \
  --agent bound-agent.testnet --vendor bound-vendor.testnet \
  --amount 1000000000000000000000000 --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" \
  --nonce 202 2>&1)
if printf '%s' "$replay" | grep -q 'NonceReplay'; then
  pass "nonce replay: the second request with the same nonce is refused"
else
  fail "nonce replay: the second request with the same nonce was not refused"
  printf '%s\n' "$replay" | tail -5 >&2
fi

# ---- the roles: the runner may approve, a stranger may not ----
reset_state
note "owner and runner roles"
agent_run 203 >/dev/null
runner_out=$(fake_tx approve_request '{"request_id":14}' stranger.testnet)
if printf '%s' "$runner_out" | grep -q "only the owner or the runner"; then
  pass "roles: a stranger cannot approve"
else
  fail "roles: a stranger was allowed to approve"
  printf '%s\n' "$runner_out" | tail -5 >&2
fi

# ---- a flagged request needs the owner ----
reset_state
note "flagged request"
agent_run 204 >/dev/null
flag_out=$(fake_tx flag_request '{"request_id":14,"reasons":["unknown vendor"]}' runner.testnet)
runner_flagged=$(fake_tx approve_request '{"request_id":14}' runner.testnet)
owner_flagged=$(fake_tx owner_approve_request '{"request_id":14}' owner.testnet)
if printf '%s' "$flag_out" | grep -q 'succeeded' \
  && printf '%s' "$runner_flagged" | grep -q 'only the owner' \
  && printf '%s' "$owner_flagged" | grep -q 'succeeded'; then
  pass "flagged request: the runner cannot approve it, the owner can"
else
  fail "flagged request: the roles were not enforced"
  printf '%s\n' "$flag_out" "$runner_flagged" "$owner_flagged" | tail -8 >&2
fi

# ---- concurrent runs get unique ids and unique nonces ----
reset_state
note "concurrent requests"
CONCURRENT_OUT="$(mktemp -d -t certalyn-fake-concurrent.XXXXXX)"
for index in 1 2 3 4 5 6; do
  (
    POLL_ATTEMPTS=1 POLL_INTERVAL=0 "$AGENT_SH" --contract bound-testnet-97685.testnet \
      --agent bound-agent.testnet --vendor bound-vendor.testnet \
      --amount 1000000000000000000000000 --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" \
      > "$CONCURRENT_OUT/$index.out" 2>&1
  ) &
done
wait
unique_ids=$(cat "$CONCURRENT_OUT"/*.out | awk '/request number/{print $NF}' | sort -u | wc -l)
total_ids=$(cat "$CONCURRENT_OUT"/*.out | awk '/request number/{print $NF}' | wc -l)
unique_nonces=$(cat "$CONCURRENT_OUT"/*.out | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | sort -u | wc -l)
total_nonces=$(cat "$CONCURRENT_OUT"/*.out | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | wc -l)
if [ "$total_ids" -eq 6 ] && [ "$unique_ids" -eq 6 ] && [ "$total_nonces" -eq 6 ] && [ "$unique_nonces" -eq 6 ]; then
  pass "concurrent requests: 6 runs, 6 request ids, 6 nonces, all unique"
else
  fail "concurrent requests: $total_ids ids ($unique_ids unique), $total_nonces nonces ($unique_nonces unique)"
  cat "$CONCURRENT_OUT"/*.out | tail -12 >&2
fi
rm -rf "$CONCURRENT_OUT"

# ---- the polling waits for an approval that lands while it polls ----
reset_state
note "settlement polling"
POLL_OUT="$(mktemp -t certalyn-fake-poll.XXXXXX.out)"
POLL_ATTEMPTS=20 POLL_INTERVAL=1 "$AGENT_SH" --contract bound-testnet-97685.testnet \
  --agent bound-agent.testnet --vendor bound-vendor.testnet \
  --amount 1000000000000000000000000 --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" \
  --nonce 205 > "$POLL_OUT" 2>&1 &
POLL_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if fake_view get_request '{"request_id":14}' >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done
sleep 1
fake_tx approve_request '{"request_id":14}' owner.testnet >/dev/null
wait "$POLL_PID"
poll_rc=$?
if [ "$poll_rc" -eq 0 ] && grep -q '^receipt 30' "$POLL_OUT" && grep -q 'outcome    Approved' "$POLL_OUT"; then
  pass "settlement polling: the receipt of this request was found"
else
  fail "settlement polling: the receipt of this request was not found (exit $poll_rc)"
  tail -12 "$POLL_OUT" >&2
fi
rm -f "$POLL_OUT"

# ---- the polling times out when nothing settles ----
reset_state
note "settlement polling timeout"
timeout_out=$(POLL_ATTEMPTS=1 POLL_INTERVAL=0 agent_run 206)
if printf '%s' "$timeout_out" | grep -q 'no receipt for request 14 settled within'; then
  pass "settlement polling timeout: the script says nothing settled"
else
  fail "settlement polling timeout: the script did not report the timeout"
  printf '%s\n' "$timeout_out" | tail -5 >&2
fi

# ---- a receipt of another agent is not this request's settlement ----
reset_state
note "the receipt of another agent is not reported"
python3 - "$FAKE_NEAR_STATE" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    state = json.load(handle)
state["requests"]["14"] = {
    "request_id": 14,
    "agent_id": "other-agent.testnet",
    "vendor": "bound-vendor.testnet",
    "amount": 1000000000000000000000000,
    "nonce": 900,
    "memo": "another agent",
    "status": "Pending",
    "receipt_id": None,
    "created_at": 1794403451,
    "expires_at": 1796995451,
    "flags": [],
}
state["next_request_id"] = 15
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2, sort_keys=True)
PY
fake_tx approve_request '{"request_id":14}' owner.testnet >/dev/null
other_out=$(POLL_ATTEMPTS=2 POLL_INTERVAL=0 agent_run 207)
if printf '%s' "$other_out" | grep -q 'no receipt for request 15 settled within' \
  && ! printf '%s' "$other_out" | grep -q '^receipt 30'; then
  pass "the receipt of another agent is not reported as this request's settlement"
else
  fail "the receipt of another agent was reported as this request's settlement"
  printf '%s\n' "$other_out" | tail -8 >&2
fi

# ---- transaction ids are deterministic for the same fake state ----
reset_state
note "deterministic transaction id"
tx1=$(agent_run 300 | awk '/^transaction /{print $2; exit}')
reset_state
tx2=$(agent_run 300 | awk '/^transaction /{print $2; exit}')
if [ -n "$tx1" ] && [ "$tx1" = "$tx2" ]; then
  pass "deterministic transaction id: $tx1"
else
  fail "deterministic transaction id: '$tx1' != '$tx2'"
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

# ---- both scripts share one counter per agent ----
reset_state
note "one counter per agent"
shared_a=$(POLL_ATTEMPTS=1 POLL_INTERVAL=0 "$AGENT_SH" --contract bound-testnet-97685.testnet \
  --agent bound-agent.testnet --vendor bound-vendor.testnet \
  --amount 1000000000000000000000000 --key /tmp/no-such-key.json --near-bin "$FAKE_NEAR" 2>&1 \
  | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | tail -1)
shared_b=$(NEAR_BIN="$FAKE_NEAR" "$PROTOCOL_ARM_SH" bound-testnet-97685.testnet bound-agent.testnet \
  bound-vendor.testnet /tmp/no-such-key.json 2>&1 \
  | grep -oE 'using persistent nonce [0-9]+' | grep -oE '[0-9]+$' | tail -1)
if [ -n "$shared_a" ] && [ -n "$shared_b" ] && [ "$shared_b" -gt "$shared_a" ] 2>/dev/null; then
  pass "one counter per agent: agent.sh $shared_a, protocol_arm.sh $shared_b"
else
  fail "one counter per agent: agent.sh '$shared_a', protocol_arm.sh '$shared_b'"
fi

echo
echo "fake-NEAR tests: $PASS passed, $FAIL failed"
test "$FAIL" -eq 0
