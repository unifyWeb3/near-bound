#!/usr/bin/env bash
# Ask the contract to spend, the way an agent would.
#
#   demo/agent.sh --contract <account> --agent <account> --vendor <account> \
#                 --amount <yoctoNEAR> --key <key file> [--nonce <n>] \
#                 [--nonce-file <path>] [--memo <text>] [--near-bin <near>]
#
# The nonce is optional. When --nonce is not given, a persistent monotonic
# nonce counter is used, incremented atomically with flock so concurrent runs
# do not reuse a nonce. The default counter file is
#   $HOME/.local/state/certalyn/nonce-<agent>.json
# Pass --nonce to send a specific one.
#
# The amount goes in as base64 encoded JSON, built with Python json.dumps so
# shell interpolation can never break the encoding. The NEAR CLI reads
# json-args into a JSON value, and a number bigger than 2^53 comes back as a
# float, so a u128 amount has to go in as base64-args. Amounts at or above
# about 2^53 always use base64-args; smaller amounts may too.
#
# The script prints what the contract decided, the receipt if the policy wrote
# one, and a link to the transaction. It needs the near CLI (or NEAR_BIN),
# base64, flock, and python3, and nothing else.
#
# All commands here are local verification until executed against a real
# deployment; none of them is chain evidence.
set -uo pipefail

NEAR_BIN="${NEAR_BIN:-${NEAR:-near}}"
CONTRACT=""
AGENT=""
VENDOR=""
AMOUNT=""
NONCE=""
NONCE_FILE=""
KEY=""
MEMO="a spend from the agent"

while [ $# -gt 0 ]; do
  case "$1" in
    --contract) CONTRACT="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --vendor) VENDOR="$2"; shift 2 ;;
    --amount) AMOUNT="$2"; shift 2 ;;
    --nonce) NONCE="$2"; shift 2 ;;
    --nonce-file) NONCE_FILE="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --memo) MEMO="$2"; shift 2 ;;
    --near-bin) NEAR_BIN="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

for name in CONTRACT AGENT VENDOR AMOUNT KEY; do
  if [ -z "${!name}" ]; then
    echo "--${name,,} is required" >&2
    exit 2
  fi
done

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

# Maximum u128 value.
U128_MAX=340282366920938463463374607431768211455

# Validate an account ID: non-empty, lowercase, digits, dots, dashes,
# underscores only, and each dot-separated label starts and ends with
# alphanumeric.
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

validate_account "$CONTRACT"
validate_account "$AGENT"
validate_account "$VENDOR"

# Validate the amount: a non-negative integer, not zero, not above u128 max,
# no floats, no sign, no non-digits.
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

validate_amount "$AMOUNT"

clean() { sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g'; }

# Build the request JSON with Python json.dumps so quoting and escaping are
# always correct, then base64-encode it.
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

# The number of receipts the contract holds right now.
count_receipts() {
  "$NEAR_BIN" contract call-function as-read-only "$CONTRACT" get_receipt_count \
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

# Persistent monotonic nonce counter with atomic locking.
# Reads the last nonce from the counter file under flock, increments it, and
# writes it back, all inside the lock so concurrent runs cannot reuse a nonce.
pick_nonce() {
  local file="${NONCE_FILE:-$HOME/.local/state/certalyn/nonce-${AGENT}.json}"
  local dir last next
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  exec 9>"${file}.lock"
  flock 9
  last="$(python3 - "$file" <<'PY' 2>/dev/null || echo 0
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
  python3 - "$file" "$next" >/dev/null <<'PY'
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump({"nonce": int(sys.argv[2])}, f)
PY
  flock -u 9
  exec 9>&-
  NONCE="$next"
  echo "using persistent nonce $NONCE for $AGENT (counter file $file)"
}

if [ -z "$NONCE" ]; then
  pick_nonce
fi

BEFORE=$(count_receipts)
BEFORE=${BEFORE:-0}

echo "asking to spend $(near_of "$AMOUNT") NEAR to $VENDOR"
echo "  contract $CONTRACT"
echo "  agent    $AGENT"
echo "  nonce    $NONCE"

ARGS_B64="$(build_args)"

OUT=$("$NEAR_BIN" contract call-function as-transaction "$CONTRACT" request_spend \
  base64-args "$ARGS_B64" \
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

# Poll for settlement instead of a fixed sleep: read the receipt count until it
# changes, up to a bounded number of attempts, then read any new receipts.
POLL_ATTEMPTS=30
POLL_INTERVAL=1
TRIES=0
AFTER="$BEFORE"
while [ "$TRIES" -lt "$POLL_ATTEMPTS" ]; do
  TRIES=$((TRIES + 1))
  sleep "$POLL_INTERVAL"
  AFTER=$(count_receipts)
  AFTER=${AFTER:-0}
  [ "$AFTER" -gt "$BEFORE" ] 2>/dev/null && break
done

if [ "$AFTER" -gt "$BEFORE" ] 2>/dev/null; then
  NEW=$BEFORE
  while [ "$NEW" -lt "$AFTER" ]; do
    echo
    echo "receipt $NEW"
    "$NEAR_BIN" contract call-function as-read-only "$CONTRACT" get_receipt \
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
else
  echo "no new receipt settled within $((POLL_ATTEMPTS * POLL_INTERVAL)) seconds"
fi
