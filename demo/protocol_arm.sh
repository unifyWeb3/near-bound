#!/usr/bin/env bash
# Protocol arm demo.
#
# Shows the four checks the NEAR protocol runs on a function call access key
# before the contract is even reached, and the two policy denials the contract
# returns to the agent.
#
# Usage:
#   demo/protocol_arm.sh <owner> <agent> <vendor> <agent-key-file> [nonce]
#
# The agent key file is the legacy keychain file for the restricted key, for
# example ~/.near-credentials/testnet/agent.testnet/ed25519_<key>.json. The
# key must already be scoped to request_spend on the owner contract. See the
# README for the add-key command.
#
# The nonce defaults to a persistent monotonic counter (atomic flock) so
# concurrent runs do not reuse a nonce. Pass a numeric nonce to override.
#
# All JSON is built with Python json.dumps and base64-encoded; amounts are
# validated as integers (including the u128 maximum) and account IDs are
# validated. The near CLI is invoked via $NEAR_BIN or `near` so the call is
# testable with a fake near executable.
#
# All commands here are local verification until executed against a real
# deployment; none of them is chain evidence.
set -uo pipefail

NEAR_BIN="${NEAR_BIN:-${NEAR:-near}}"

OWNER="${1:?owner account, the contract account}"
AGENT="${2:?agent account}"
VENDOR="${3:?vendor account}"
KEY="${4:?path to the restricted key file}"
NONCE="${5:-}"

PASS=0
FAIL=0

# Run a command and require its output to contain a string.
expect() {
  local label="$1"
  local needle="$2"
  shift 2
  local out
  out="$("$@" 2>&1 | sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | tr '\r' '\n')"
  if printf '%s' "$out" | grep -qiF "$needle"; then
    printf 'PASS  %s\n      %s\n' "$label" "$needle"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n      expected: %s\n' "$label" "$needle"
    printf '%s\n' "$out" | tail -6
    FAIL=$((FAIL + 1))
  fi
}

# Run a command and require it to succeed.
expect_ok() {
  local label="$1"
  shift
  local out
  out="$("$@" 2>&1 | sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | tr '\r' '\n')"
  if printf '%s' "$out" | grep -q "succeeded"; then
    printf 'PASS  %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s\n' "$label"
    printf '%s\n' "$out" | tail -8
    FAIL=$((FAIL + 1))
  fi
}

if ! command -v "$NEAR_BIN" >/dev/null; then
  echo "the near CLI ($NEAR_BIN) is required: https://github.com/near/near-cli-rs" >&2
  exit 2
fi
if ! command -v flock >/dev/null; then
  echo "flock is required for the atomic nonce counter" >&2
  exit 2
fi
if ! command -v python3 >/dev/null; then
  echo "python3 is required" >&2
  exit 2
fi

validate_account() {
  local acct="$1"
  python3 - "$acct" <<'PY'
import re, sys
acct = sys.argv[1]
if not acct:
    print("account id must not be empty", file=sys.stderr); sys.exit(2)
if len(acct) > 64:
    print("account id too long: " + acct, file=sys.stderr); sys.exit(2)
if re.fullmatch(r'([a-z0-9]([a-z0-9\-_]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9\-_]*[a-z0-9])?)*', acct) is None:
    print("invalid account id: " + acct, file=sys.stderr); sys.exit(2)
PY
}

validate_account "$OWNER"
validate_account "$AGENT"
validate_account "$VENDOR"

validate_amount() {
  local amt="$1"
  python3 - "$amt" <<'PY'
import re, sys
amt = sys.argv[1]
if not amt:
    print("amount must not be empty", file=sys.stderr); sys.exit(2)
if not re.fullmatch(r'[0-9]+', amt):
    print("amount must be a non-negative integer: " + amt, file=sys.stderr); sys.exit(2)
if amt == "0":
    print("amount must be more than zero", file=sys.stderr); sys.exit(2)
max128 = 340282366920938463463374607431768211455
if int(amt) > max128:
    print("amount exceeds u128 maximum: " + amt, file=sys.stderr); sys.exit(2)
PY
}

# Persistent monotonic nonce counter with atomic locking.
nonce_file="${NONCE_FILE:-$HOME/.local/state/certalyn/protocol-nonce-${AGENT}.json}"
pick_nonce() {
  local dir last next
  dir="$(dirname "$nonce_file")"
  mkdir -p "$dir"
  exec 9>"${nonce_file}.lock"
  flock 9
  last="$(python3 - "$nonce_file" <<'PY' 2>/dev/null || echo 0
import json, sys
try:
    print(json.load(open(sys.argv[1], "r", encoding="utf-8")).get("nonce", 0))
except Exception:
    print(0)
PY
)"
  last="${last:-0}"
  case "$last" in
    ''|*[!0-9]*) last=0 ;;
  esac
  next=$((last + 1))
  python3 - "$nonce_file" "$next" >/dev/null <<'PY'
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump({"nonce": int(sys.argv[2])}, f)
PY
  flock -u 9
  exec 9>&-
  NONCE="$next"
  echo "using persistent nonce $NONCE for $AGENT (counter file $nonce_file)"
}

if [ -z "$NONCE" ]; then
  pick_nonce
elif ! printf '%s' "$NONCE" | grep -qE '^[0-9]+$'; then
  echo "nonce must be a non-negative integer, got: $NONCE" >&2
  exit 2
fi

next_nonce() {
  NONCE=$((NONCE + 1))
}

# Build request JSON via Python json.dumps and base64-encode it.
build_args() {
  python3 - "$AGENT" "$VENDOR" "$AMOUNT" "$NONCE" "$MEMO" <<'PY'
import base64, json, sys
agent, vendor, amount, nonce, memo = sys.argv[1:6]
obj = {
    "agent_id": agent,
    "vendor": vendor,
    "amount": int(amount),
    "nonce": int(nonce),
    "memo": memo,
}
sys.stdout.buffer.write(base64.b64encode(json.dumps(obj).encode()))
PY
}

call_owner() {
  "$NEAR_BIN" contract call-function as-transaction "$OWNER" "$1" json-args "$2" \
    prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' \
    sign-as "$AGENT" network-config testnet \
    sign-with-access-key-file "$KEY" send
}

echo "Bound protocol arm"
echo "owner  $OWNER"
echo "agent  $AGENT"
echo "vendor $VENDOR"
echo

echo "1. The restricted key can request a spend."
AMOUNT="20000000000000000"; MEMO="protocol arm"
expect_ok "request_spend is allowed" \
  "$NEAR_BIN" contract call-function as-transaction "$OWNER" request_spend \
  base64-args "$(build_args)" \
  prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send
next_nonce

echo
echo "2. The same key cannot approve its own request."
expect "method allowlist rejects approve_request" \
  "isn't allowed by the access key" \
  "$NEAR_BIN" contract call-function as-transaction "$OWNER" approve_request \
  json-args '{"request_id":0}' prepaid-gas '20.0 Tgas' \
  attached-deposit '0 NEAR' sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send

echo
echo "3. The same key cannot call the vendor directly."
expect "receiver scope rejects the vendor call" \
  "doesn't match the access key" \
  "$NEAR_BIN" contract call-function as-transaction "$VENDOR" call_paid_api \
  json-args '{"memo":"direct"}' prepaid-gas '20.0 Tgas' \
  attached-deposit '0 NEAR' sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send

echo
echo "4. The same key cannot carry a deposit."
AMOUNT="20000000000000000"; MEMO="deposit attempt"
expect "deposit is rejected on a function call key" \
  "Having a deposit with a function call action is not allowed" \
  "$NEAR_BIN" contract call-function as-transaction "$OWNER" request_spend \
  base64-args "$(build_args)" \
  prepaid-gas '20.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send
next_nonce

echo
echo "5. The allowance caps the gas the key can spend."
AMOUNT="20000000000000000"; MEMO="gas attempt"
expect "allowance rejects an expensive call" \
  "does not have enough allowance" \
  "$NEAR_BIN" contract call-function as-transaction "$OWNER" request_spend \
  base64-args "$(build_args)" \
  prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send
next_nonce

echo
echo "6. The contract refuses a vendor outside the allowlist."
AMOUNT="1000000000000000"; MEMO="stranger"
expect "policy rejects an unknown vendor" \
  "VendorNotAllowed" \
  "$NEAR_BIN" contract call-function as-transaction "$OWNER" request_spend \
  base64-args "$(python3 - "$AGENT" "stranger.testnet" "$AMOUNT" "$NONCE" "$MEMO" <<'PY'
import base64, json, sys
agent, vendor, amount, nonce, memo = sys.argv[1:6]
obj = {"agent_id": agent, "vendor": vendor, "amount": int(amount), "nonce": int(nonce), "memo": memo}
sys.stdout.buffer.write(base64.b64encode(json.dumps(obj).encode()))
PY
)" \
  prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send
next_nonce

echo
echo "$PASS passed, $FAIL failed"
test "$FAIL" -eq 0
