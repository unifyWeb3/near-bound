# Audit remediation

Traceability for the audit of 2026-11-14 and the earlier remediation of
2026-11-13. One row per finding, the implementation, the check that covers
it, and the status.

This document records local work only. The historical deployed artifact
(`bound-testnet-97685.testnet`, code hash
`HdgJrzYbWsQKWgxRvFG1yUD3UM9M89mRGUE7ESTfjE8d`, sha256
`f720587997a04f8bf9702aeeca3525867b321374e151fe26bfef9ec2ca955a7e`) is live
and separate from this branch. The artifact this source builds has the sha256
in [docs/wasm-lock.json](wasm-lock.json), and the two are not the same
artifact.

## The audit of 2026-11-14

| # | Finding | Severity | Implementation | Check | Status |
|---|---------|----------|----------------|-------|--------|
| 1 | A flagged request could never be approved. `owner_approve_request` delegated to `approve_request`, which requires `Pending`, and a flagged request is `NeedsApproval` | Critical | `approve_request` accepts an open request, and a flagged one requires the owner | `the_owner_can_approve_a_flagged_request`, `the_runner_cannot_approve_a_flagged_request` | Fixed |
| 2 | The console sent Borsh arguments to a contract that reads JSON, so every browser write failed with a deserialisation error | Critical | `lib/wallet.js` builds a JSON argument object and signs those bytes; the Borsh writer is gone | `wallet arguments are JSON argument objects, not Borsh arrays`, `values above 2^53 survive as strings in the JSON argument object` | Fixed |
| 3 | The settlement callback walked the whole request history, so it could run out of gas and leave the budget reserved with no way out | Critical | The reservations live in sidecars keyed by agent and period, so the callback is constant time | `the_settlement_is_constant_time_with_a_long_history` | Fixed |
| 4 | A request whose callback never arrived stayed `ApprovedPending` for good, with its reservation held | High | `reconcile_request` lets the owner settle it, from the transfer receipt | `the_owner_can_reconcile_a_request_that_never_settled`, `the_owner_can_reconcile_a_request_that_did_move` | Fixed |
| 5 | A failed payment kept its rate slot | High | The failure branch gives the slot back | `a_failed_payment_gives_the_rate_slot_back` | Fixed |
| 6 | A nonce could be replayed while the first request was still undecided | High | The accepted nonce is tracked per agent, next to the approved nonce | `an_accepted_nonce_cannot_be_replayed`, `an_accepted_nonce_cannot_be_replayed_before_it_is_approved` | Fixed |
| 7 | The receipt count was one higher than the number of receipts, because the count was read after the id moved | High | The count is read before the id moves | `a_transfer_that_settles_writes_an_approved_receipt` | Fixed |
| 8 | The console read the whole ledger of every contract to show one agent | High | The contract reads one agent's receipts in pages, and the console falls back to the historical scan when the deployment has no paged view | `getLedger on a paged contract uses the agent page view and reports real denominators` | Fixed |
| 9 | The receipt cache could show receipts from a state that no longer exists | High | Cached receipts the chain cannot have any more are dropped | `the cache drops receipts the chain cannot have` | Fixed |
| 10 | The big number parser could corrupt a receipt whose memo held a long number, and it left long numbers in arrays untouched | High | Numbers outside strings are quoted, strings are left alone | `parseBigJson does not touch a long number inside a string`, `parseBigJson quotes a long number in an array` | Fixed |
| 11 | A method the contract does not have came back as a successful result with an error inside it, so the console believed the method existed | High | `viewFunction` reads the error inside the result, and the capability check recognises a missing method | `getLedger on the historical contract falls back to per-receipt reads` | Fixed |
| 12 | The build script let the path of the build directory reach the bytes, so two builds produced two artifacts | High | The target directory is remapped as well | `bash scripts/build-wasm.sh` prints the same sha256 for both copies | Fixed |
| 13 | The expected Wasm hash was never checked, so the central claim was unfalsifiable | High | `docs/wasm-lock.json` holds the hash and CI fails when the build differs | CI step `the wasm matches the committed artifact hash` | Fixed |
| 14 | A memo, a reason or a vendor list could be any size, and the contract pays for the storage | Medium | Bounds on the memo, the reasons and the vendor list | `a_memo_that_is_too_long_is_refused`, `a_budget_above_the_allowed_range_is_refused` | Fixed |
| 15 | A request could sit open for ever | Medium | A request expires after thirty days, and the owner can close one at any time | `an_expired_request_cannot_be_approved`, `the_owner_can_expire_a_request` | Fixed |
| 16 | A receipt written before any request existed carried request id zero, which is also a real request id | Medium | The sentinel `u64::MAX` says that a receipt has no request behind it | `NO_REQUEST` in `contract/src/lib.rs` | Fixed |
| 17 | The console labelled a global count as the count of one agent | Medium | The card reads the agent count from the chain | `getLedger on a paged contract uses the agent page view and reports real denominators` | Fixed |
| 18 | Disconnecting cleared the page but left the wallet session signed in | Low | The selector session ends with the page state | `disconnectWallet` in `web/lib/wallet.js` | Fixed |
| 19 | The deployment was written to the address bar without the vendor, so a shared link showed the wrong counterparty | Low | The vendor travels with the deployment | `writeDeployment` in `web/lib/deployment.js` | Fixed |
| 20 | The judge view quoted one receipt id from the demo deployment for every deployment | Low | The evidence view quotes the newest receipt of the deployment being read | `web/views/judge.js` | Fixed |
| 21 | The console used `btoa` on JSON, which throws on a character outside Latin-1 | Low | The arguments are encoded from UTF-8 bytes | `toBase64 encodes text outside Latin-1` | Fixed |
| 22 | The filter callback re-rendered the filters inside their own callback | Low | One callback, used by the shell and by the route | `web/app.js` | Fixed |

## The remediation of 2026-11-13

| # | Finding | Implementation | Check | Status |
|---|---------|----------------|-------|--------|
| 1 | The public product name collided with unrelated projects | The copy is Certalyn, the identifiers keep their technical names | [docs/NAMING.md](NAMING.md) | Complete |
| 2 | README figures did not match the chain | The figures are generated by `scripts/claims.py`, and the rolling fields are separated from the invariants | `python3 scripts/claims.py --check` | Complete |
| 3 | The Rust toolchain was not pinned | `rust-toolchain.toml` pins 1.99.1 with wasm32, rustfmt and clippy | `make fmt`, `make clippy` | Complete |
| 4 | Binaryen was not pinned | `scripts/build-wasm.sh` pins version 133 and its sha256 | the build script verifies the archive | Complete |
| 5 | The Wasm build was not reproducible | The script builds twice, compares the bytes and writes a manifest | `make verify-local` | Complete |
| 6 | The claims check treated rolling fields as invariants | Rolling fields are printed, invariants are checked | `python3 scripts/claims.py --check` | Complete |
| 7 | The demo scripts built JSON by interpolation and used a clock nonce | Both scripts build JSON with `python3` and base64, validate their input, keep a monotonic nonce and poll for the settlement | `make test-shell` | Complete |
| 8 | There were no offline shell tests | `tests/fake-near/` runs the scripts against a fake CLI | CI step `fake-NEAR shell tests` | Complete |
| 9 | There was no dependency vulnerability check | `scripts/dependency-check.sh` runs cargo-audit read-only | CI step `dependency vulnerability check` | Complete |
| 10 | There was no one local test path | `make test`, `make test-shell`, `make fmt`, `make clippy`, `make verify-local`, `make verify` | all targets run locally | Complete |

## Deliberately not done

- No deployment, no push, no submission and no public post. Those need a
  separate yes for that exact action.
- The contract keeps its receipts forever. The earlier plan to prune them was
  dropped: a receipt that disappears is a decision that cannot be audited, and
  the console pages around the problem instead.
- The console has no account, no session and no server. The chain is the
  database.
