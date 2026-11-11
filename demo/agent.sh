#!/usr/bin/env bash
# Ask the contract to spend, the way an agent would.
#
#   demo/agent.sh --contract <account> --agent <account> --vendor <account> \
#                 --amount <yoctoNEAR> --nonce <n> --key <key file> [--memo <text>]
#
# The amount goes in as base64 encoded JSON. The NEAR CLI reads json-args into
# a JSON value, and a number bigger than 2^53 comes back as a float, so
# 5000000000000000000000000 would arrive as 5e+24 and the contract could not
# read it.
#
# The script prints the transaction, the receipt if the policy wrote one, and
# a link to the transaction. It needs the near CLI, base64 and python3, and
# nothing else.
set -uo pipefail

CONTRACT=""
AGENT=""
VENDOR=""
AMOUNT=""
NONCE=""
KEY=""
MEMO="a spend from the agent"

while [ $# -gt 0 ]; do
  case "$1" in
    --contract) CONTRACT="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --vendor) VENDOR="$2"; shift 2 ;;
    --amount) AMOUNT="$2"; shift 2 ;;
    --nonce) NONCE="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --memo) MEMO="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

for name in CONTRACT AGENT VENDOR AMOUNT NONCE KEY; do
  if [ -z "${!name}" ]; then
    echo "--${name,,} is required" >&2
    exit 2
  fi
done

if ! command -v near > /dev/null; then
  echo "the near CLI is required: https://github.com/near/near-cli-rs" >&2
  exit 2
fi

# The receipt count before the request, so the script can tell whether the
# policy wrote a receipt.
count_receipts() {
  near contract call-function as-read-only "$CONTRACT" get_receipt_count \
    json-args '{}' network-config testnet now 2>/dev/null \
    | python3 -c "
import json,sys
raw = sys.stdin.read()
start = raw.find('[')
end = raw.rfind(']')
try:
    print(json.loads(raw[start:end + 1])[0])
except Exception:
    print(0)
"
}

BEFORE=$(count_receipts)

ARGS=$(python3 -c "
import json,sys
print(json.dumps({
    'agent_id': sys.argv[1],
    'vendor': sys.argv[2],
    'amount': int(sys.argv[3]),
    'nonce': int(sys.argv[4]),
    'memo': sys.argv[5],
}))
" "$AGENT" "$VENDOR" "$AMOUNT" "$NONCE" "$MEMO")

echo "asking to spend $(python3 -c "print(int('$AMOUNT')/1e24)") NEAR to $VENDOR"
echo "  contract $CONTRACT"
echo "  agent    $AGENT"
echo "  nonce    $NONCE"

OUT=$(near contract call-function as-transaction "$CONTRACT" request_spend \
  base64-args "$(printf '%s' "$ARGS" | base64 -w0)" \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$AGENT" network-config testnet sign-with-access-key-file "$KEY" send 2>&1)

HASH=$(printf '%s' "$OUT" | sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | grep -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{40,60}' | awk '{print $3}')
REQUEST_ID=$(printf '%s' "$OUT" | sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | grep -oE '"request_id": [0-9]+' | head -1 | awk '{print $2}')

if [ -z "$HASH" ]; then
  echo "the call did not go through"
  printf '%s\n' "$OUT" | sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | grep -E 'Error|error|trap|not enough' | head -5
  exit 1
fi

echo
echo "transaction $HASH"
echo "  https://testnet.nearblocks.io/txs/$HASH"
echo "  https://explorer.testnet.near.org/transactions/$HASH"

if [ -n "$REQUEST_ID" ]; then
  echo
  echo "the request is number $REQUEST_ID and is waiting for the owner"
  echo "  no receipt yet, the policy writes one when the owner approves and the transfer settles"
  echo "  a refused request has a receipt straight away"
fi

sleep 3
AFTER=$(count_receipts)
if [ "$AFTER" -gt "$BEFORE" ] 2>/dev/null; then
  NEW=$((BEFORE))
  while [ "$NEW" -lt "$AFTER" ]; do
    NEW=$((NEW + 1))
    echo
    echo "receipt $NEW"
    near contract call-function as-read-only "$CONTRACT" get_receipt \
      json-args "{\"receipt_id\":$NEW}" network-config testnet now 2>/dev/null \
      | python3 -c "
import json,sys
raw = sys.stdin.read()
start = raw.find('{')
end = raw.rfind('}')
print(json.dumps(json.loads(raw[start:end + 1]), indent=2))
"
  done
fi
