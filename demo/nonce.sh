#!/usr/bin/env bash
# The shared per-agent nonce counter.
#
# Both demo scripts source this file, so one agent has one counter and the
# two scripts cannot replay each other's nonce. The counter lives in a file
# under the state directory.
#
# The lock is held from the moment the nonce is taken until the transaction
# that uses it has been sent. That is what keeps the order of the nonces and
# the order of the requests the same: the contract refuses a nonce that is not
# higher than the last one it accepted, so a request that lands out of order
# would be turned away.
#
# The counter never goes backwards and never returns a number the chain has
# already seen: the next number is at least the clock and at least one more
# than the last number used. That matters after the upgrade, because the
# contract keeps the highest nonce it has accepted and refuses anything that
# is not higher.
#
# The functions are:
#   certalyn_nonce_file <agent> [file]   the path of the counter file
#   certalyn_lock_nonce <agent> [file]    take the lock and the next nonce
#   certalyn_save_nonce                   write the current NONCE back
#   certalyn_release_nonce                release the lock

# The directory the counters live in. A caller can move it, and the tests use
# it to keep the counters out of the developer's own state.
CERTALYN_STATE_DIR="${CERTALYN_STATE_DIR:-$HOME/.local/state/certalyn}"

# Whether the lock is held right now.
CERTALYN_NONCE_LOCKED="false"
CERTALYN_NONCE_FILE=""

# The path of the counter of one agent.
certalyn_nonce_file() {
  local agent="$1"
  local override="${2:-${NONCE_FILE:-}}"
  if [ -n "$override" ]; then
    printf '%s' "$override"
    return 0
  fi
  printf '%s' "$CERTALYN_STATE_DIR/nonce-${agent}.json"
}

# The next nonce for one agent, written to the counter file.
certalyn_next_nonce() {
  local file="$1"
  python3 - "$file" <<'PY'
import json, os, sys, time

path = sys.argv[1]
last = 0
try:
    with open(path, "r", encoding="utf-8") as handle:
        last = int(json.load(handle).get("nonce", 0))
except Exception:
    last = 0

# The number is at least the clock, so a counter that was left behind by an
# earlier version still lands above every nonce the chain has accepted, and
# it is at least one more than the last number this counter used.
next_nonce = max(last + 1, int(time.time()))
directory = os.path.dirname(os.path.abspath(path))
if directory:
    os.makedirs(directory, exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump({"nonce": next_nonce}, handle)
os.replace(tmp, path)
print(next_nonce)
PY
}

# Take the lock of the agent and the next nonce. The lock stays held until
# certalyn_release_nonce is called.
certalyn_lock_nonce() {
  local agent="$1"
  local override="${2:-}"
  local file next
  file="$(certalyn_nonce_file "$agent" "$override")"
  mkdir -p "$(dirname "$file")"
  exec 9>"${file}.lock"
  flock 9
  CERTALYN_NONCE_LOCKED="true"
  CERTALYN_NONCE_FILE="$file"
  next="$(certalyn_next_nonce "$file")"
  NONCE="$next"
  echo "using persistent nonce $NONCE for $agent (counter file $file)"
}

# Write the current NONCE back to the counter file, so a script that used
# several nonces leaves the counter above all of them. The lock is held.
certalyn_save_nonce() {
  if [ "$CERTALYN_NONCE_LOCKED" != "true" ]; then
    return 0
  fi
  python3 - "$CERTALYN_NONCE_FILE" "$NONCE" <<'PY'
import json, os, sys

path = sys.argv[1]
value = int(sys.argv[2] or 0)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump({"nonce": value}, handle)
os.replace(tmp, path)
PY
}

# Release the lock of the agent.
certalyn_release_nonce() {
  if [ "$CERTALYN_NONCE_LOCKED" != "true" ]; then
    return 0
  fi
  flock -u 9
  exec 9>&-
  CERTALYN_NONCE_LOCKED="false"
}
