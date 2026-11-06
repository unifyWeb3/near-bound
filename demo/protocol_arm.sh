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

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

OWNER="${1:?owner account, the contract account}"
AGENT="${2:?agent account}"
VENDOR="${3:?vendor account}"
KEY="${4:?path to the restricted key file}"
NONCE="${5:-$(date +%s)}"

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

call_owner() {
  near contract call-function as-transaction "$OWNER" "$1" json-args "$2" \
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
expect_ok "request_spend is allowed" \
  near contract call-function as-transaction "$OWNER" request_spend \
  json-args "{\"agent_id\":\"$AGENT\",\"vendor\":\"$VENDOR\",\"amount\":20000000000000000,\"nonce\":$NONCE,\"memo\":\"protocol arm\"}" \
  prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send
NONCE=$((NONCE + 1))

echo
echo "2. The same key cannot approve its own request."
expect "method allowlist rejects approve_request" \
  "isn't allowed by the access key" \
  near contract call-function as-transaction "$OWNER" approve_request \
  json-args '{"request_id":0}' prepaid-gas '20.0 Tgas' \
  attached-deposit '0 NEAR' sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send

echo
echo "3. The same key cannot call the vendor directly."
expect "receiver scope rejects the vendor call" \
  "doesn't match the access key" \
  near contract call-function as-transaction "$VENDOR" call_paid_api \
  json-args '{"memo":"direct"}' prepaid-gas '20.0 Tgas' \
  attached-deposit '0 NEAR' sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send

echo
echo "4. The same key cannot carry a deposit."
expect "deposit is rejected on a function call key" \
  "Having a deposit with a function call action is not allowed" \
  near contract call-function as-transaction "$OWNER" request_spend \
  json-args "{\"agent_id\":\"$AGENT\",\"vendor\":\"$VENDOR\",\"amount\":20000000000000000,\"nonce\":$NONCE,\"memo\":\"deposit attempt\"}" \
  prepaid-gas '20.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send
NONCE=$((NONCE + 1))

echo
echo "5. The allowance caps the gas the key can spend."
expect "allowance rejects an expensive call" \
  "does not have enough allowance" \
  near contract call-function as-transaction "$OWNER" request_spend \
  json-args "{\"agent_id\":\"$AGENT\",\"vendor\":\"$VENDOR\",\"amount\":20000000000000000,\"nonce\":$NONCE,\"memo\":\"gas attempt\"}" \
  prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$KEY" send
NONCE=$((NONCE + 1))

echo
echo "6. The contract refuses a vendor outside the allowlist."
expect "policy rejects an unknown vendor" \
  "VendorNotAllowed" \
  call_owner request_spend \
  "{\"agent_id\":\"$AGENT\",\"vendor\":\"stranger.testnet\",\"amount\":1000000000000000,\"nonce\":$NONCE,\"memo\":\"stranger\"}"
NONCE=$((NONCE + 1))

echo
echo "$PASS passed, $FAIL failed"
test "$FAIL" -eq 0
