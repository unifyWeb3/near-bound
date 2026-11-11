#!/usr/bin/env bash
# Ask the contract to spend, the way an agent would.
#
#   demo/agent.sh --contract <account> --agent <account> --vendor <account> \
#                 --amount <yoctoNEAR> --key <key file> [--nonce <n>] [--memo <text>]
#
# The nonce is optional. The contract refuses a nonce it has already seen, so
# the script reads the agent's last nonce from the policy and uses the next
# one. Pass --nonce to send a specific one.
#
# The amount goes in as base64 encoded JSON. The NEAR CLI reads json-args into
# a JSON value, and a number bigger than 2^53 comes back as a float, so
# 5000000000000000000000000 would arrive as 5e+24 and the contract could not
# read it.
#
# The script prints what the contract decided, the receipt if the policy wrote
# one, and a link to the transaction. It needs the near CLI, base64 and
# python3, and nothing else.
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
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

for name in CONTRACT AGENT VENDOR AMOUNT KEY; do
  if [ -z "${!name}" ]; then
    echo "--${name,,} is required" >&2
    exit 2
  fi
done

if ! command -v near > /dev/null; then
  echo "the near CLI is required: https://github.com/near/near-cli-rs" >&2
  exit 2
fi

clean() { sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g'; }

# The number the contract read, before and after the request.
count_receipts() {
  near contract call-function as-read-only "$CONTRACT" get_receipt_count \
    json-args '{}' network-config testnet now 2>&1 \
    | clean | awk '/return value \(printed to stdout\)/{getline; print; exit}'
}

# What the contract answered. The CLI pretty prints the return value, so the
# JSON block is read with a raw decoder rather than line by line.
return_value() {
  printf '%s' "$1" | clean | python3 -c "
import json, sys
raw = sys.stdin.read()
marker = 'return value (printed to stdout):'
at = raw.find(marker)
if at < 0:
    raise SystemExit(0)
try:
    value, _ = json.JSONDecoder().raw_decode(raw[at + len(marker):].strip())
except ValueError:
    raise SystemExit(0)
print(json.dumps(value))
"
}

near_of() {
  python3 -c "
value = int('$1')
whole = value // 10**24
frac = str(value % 10**24).zfill(24).rstrip('0')
print(f'{whole}.{frac}' if frac else whole)
"
}

# The nonce the agent used last. The contract refuses a nonce that is not
# above it, so the script reads it and asks for the next one.
last_nonce() {
  near contract call-function as-read-only "$CONTRACT" get_policy \
    json-args "{\"agent_id\":\"$AGENT\"}" network-config testnet now 2>&1 \
    | clean \
    | python3 -c "
import json, sys
raw = sys.stdin.read()
marker = 'return value (printed to stdout):'
at = raw.find(marker)
if at < 0:
    raise SystemExit(1)
value, _ = json.JSONDecoder().raw_decode(raw[at + len(marker):].strip())
print(int(value['last_nonce']))
"
}

if [ -z "$NONCE" ]; then
  LAST=$(last_nonce)
  if [ -z "$LAST" ]; then
    echo "could not read the agent's last nonce from $CONTRACT" >&2
    exit 2
  fi
  NONCE=$((LAST + 1))
  echo "the last nonce for $AGENT was $LAST, asking with $NONCE"
fi

BEFORE=$(count_receipts)
BEFORE=${BEFORE:-0}

echo "asking to spend $(near_of "$AMOUNT") NEAR to $VENDOR"
echo "  contract $CONTRACT"
echo "  agent    $AGENT"
echo "  nonce    $NONCE"

OUT=$(near contract call-function as-transaction "$CONTRACT" request_spend \
  base64-args "$(printf '{"agent_id":"%s","vendor":"%s","amount":%s,"nonce":%s,"memo":"%s"}' \
    "$AGENT" "$VENDOR" "$AMOUNT" "$NONCE" "$MEMO" | base64 -w0)" \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$AGENT" network-config testnet sign-with-access-key-file "$KEY" send 2>&1)

HASH=$(printf '%s' "$OUT" | clean | grep -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{40,60}' | awk '{print $3}')
if [ -z "$HASH" ]; then
  echo "the call did not go through"
  printf '%s' "$OUT" | clean | grep -E 'Error|error|trap|not enough' | head -5
  exit 1
fi

echo
echo "transaction $HASH"
echo "  https://testnet.nearblocks.io/txs/$HASH"
echo "  https://explorer.testnet.near.org/transactions/$HASH"

OUTCOME=$(return_value "$OUT")
if [ -n "$OUTCOME" ]; then
  echo
  printf '%s' "$OUTCOME" | python3 -c "
import json,sys
outcome = json.load(sys.stdin)
if outcome['reason']:
    print('the policy refused it:', outcome['reason'])
    print(' ', outcome['rule'])
    for line in outcome.get('evidence', []):
        print(' ', line)
else:
    print('every hard check passed, the request is waiting for the owner')
    print('  request number', outcome['request_id'])
    print('  no receipt yet, the policy writes one when the owner approves and the transfer settles')
"
fi

sleep 3
AFTER=$(count_receipts)
AFTER=${AFTER:-0}
if [ "$AFTER" -gt "$BEFORE" ] 2>/dev/null; then
  # The count is the number of receipts, so the first new one has the id the
  # count had before.
  NEW=$BEFORE
  while [ "$NEW" -lt "$AFTER" ]; do
    echo
    echo "receipt $NEW"
    near contract call-function as-read-only "$CONTRACT" get_receipt \
      json-args "{\"receipt_id\":$NEW}" network-config testnet now 2>&1 \
      | clean | python3 -c "
import json, sys
raw = sys.stdin.read()
marker = 'return value (printed to stdout):'
at = raw.find(marker)
if at < 0:
    raise SystemExit(0)
value, _ = json.JSONDecoder().raw_decode(raw[at + len(marker):].strip())
receipt = value
print('  outcome   ', receipt['outcome'])
if receipt['reason']:
    print('  reason    ', receipt['reason'])
print('  rule      ', receipt['rule'])
for line in receipt.get('evidence', []):
    print('  evidence  ', line)
"
    NEW=$((NEW + 1))
  done
fi
