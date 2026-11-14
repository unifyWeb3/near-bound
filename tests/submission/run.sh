#!/usr/bin/env bash
# Failure-path checks for scripts/submission-payload.py.
#
# The event rules put the personal values, the consent and the sending in the
# human's hands. The script builds the payload and prints it. It must never
# guess a value, never print a payload without the consent, never accept a
# value that breaks a field rule, and never send anything.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/submission-payload.py"

PASS=0
FAIL=0

note() { printf '[test] %s\n' "$*" >&2; }
pass() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'not ok  %s\n' "$*" >&2; }

# expect_exit LABEL EXPECTED_CODE COMMAND...
expect_exit() {
  local label="$1"
  local expected="$2"
  shift 2
  local out rc
  out=$("$@" 2>&1)
  rc=$?
  if [ "$rc" -eq "$expected" ]; then
    pass "$label: exit $rc"
  else
    fail "$label: expected exit $expected, got $rc"
    printf '%s\n' "$out" | tail -6 >&2
  fi
  printf '%s' "$out"
}

# expect_text LABEL NEEDLE OUTPUT
expect_text() {
  local label="$1"
  local needle="$2"
  local out="$3"
  if printf '%s' "$out" | grep -Fq -- "$needle"; then
    pass "$label: said \"$needle\""
  else
    fail "$label: expected \"$needle\""
    printf '%s\n' "$out" | tail -6 >&2
  fi
}

note "submission payload: the static fields hold"
out=$(expect_exit "static check" 0 python3 "$SCRIPT" --check)
expect_text "static check" "the static fields hold" "$out"
expect_text "static check" "the builder's" "$out"

note "submission payload: the personal values are never guessed"
out=$(expect_exit "no personal values" 2 python3 "$SCRIPT")
expect_text "no personal values" "--lead-name" "$out"
expect_text "no personal values" "--email" "$out"
expect_text "no personal values" "--near-address" "$out"

note "submission payload: the consent has to be read to the builder"
out=$(expect_exit "no consent" 2 python3 "$SCRIPT" \
  --lead-name "Ada Lovelace" --email "ada@example.com" --near-address "ada.near")
expect_text "no consent" "I agree that the organizers may use these details" "$out"

note "submission payload: a value that breaks a field rule fails"
out=$(expect_exit "bad email" 1 python3 "$SCRIPT" \
  --lead-name "Ada Lovelace" --email "not-an-email" --near-address "ada.near" --consent)
expect_text "bad email" "email is not a valid address" "$out"

out=$(expect_exit "bad payout account" 1 python3 "$SCRIPT" \
  --lead-name "Ada Lovelace" --email "ada@example.com" --near-address "Ada.NEAR" --consent)
expect_text "bad payout account" "nearAddress is not a lowercase NEAR account name" "$out"

out=$(expect_exit "short lead name" 1 python3 "$SCRIPT" \
  --lead-name "A" --email "ada@example.com" --near-address "ada.near" --consent)
expect_text "short lead name" "leadName is 1 characters" "$out"

note "submission payload: a complete payload prints and sends nothing"
out=$(expect_exit "complete payload" 0 python3 "$SCRIPT" \
  --lead-name "Ada Lovelace" --email "ada@example.com" --near-address "ada.near" \
  --consent --request-id "11111111-2222-3333-4444-555555555555")
expect_text "complete payload" '"projectName": "Certalyn"' "$out"
expect_text "complete payload" '"requestId": "11111111-2222-3333-4444-555555555555"' "$out"
expect_text "complete payload" "nothing was sent" "$out"
expect_text "complete payload" "the API answers 403" "$out"

note "submission payload: the script has no way to send"
if grep -Eq '(^|[[:space:]])(import|from)[[:space:]]+(urllib|requests|socket|http|httpx)|urlopen|subprocess|os\.system' "$SCRIPT"; then
  fail "the script can reach the network"
else
  pass "the script cannot reach the network"
fi

printf '%s\n' "----------------------------------------"
printf 'submission payload tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
