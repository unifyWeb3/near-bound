# Audit remediation

Traceability for the audit of 2026-11-14 and the earlier remediation of
2026-11-13. One row per finding, the implementation, the check that covers
it, and the status.

The remediated contract is the artifact on the chain. It replaced the earlier
one on `bound-testnet-97685.testnet` in place, without an init call, so every
receipt, request and policy carried over. The deployed code hash is
`GHpAjEa4j9KQD6jEXU18ku4TR9rAk3Efx9neyFzTbThs` and its sha256 is
`e32dedf79d4c244868f570426b43f93b88ee86375f8bbd26e45acdb087106efa`, the
same bytes as [docs/wasm-lock.json](wasm-lock.json). The earlier artifact
(code hash `HdgJrzYbWsQKWgxRvFG1yUD3UM9M89mRGUE7ESTfjE8d`, sha256
`f720587997a04f8bf9702aeeca3525867b321374e151fe26bfef9ec2ca955a7e`) wrote
the receipts that are still on the chain, and those receipts are kept byte for
byte.

## The audit of 2026-11-14

| # | Finding | Severity | Implementation | Check | Status |
|---|---------|----------|----------------|-------|--------|
| 1 | A flagged request could never be approved. `owner_approve_request` delegated to `approve_request`, which requires `Pending`, and a flagged request is `NeedsApproval` | Critical | `approve_request` accepts an open request, and a flagged one requires the owner | `the_owner_can_approve_a_flagged_request`, `the_runner_cannot_approve_a_flagged_request` | Fixed |
| 2 | The console sent Borsh arguments to a contract that reads JSON, so every browser write failed with a deserialisation error | Critical | `lib/wallet.js` builds a JSON argument object and signs those bytes; the Borsh writer is gone | `wallet arguments are JSON argument objects, not Borsh arrays`, `values above 2^53 survive as strings in the JSON argument object` | Fixed |
| 3 | The settlement callback walked the whole request history, so it could run out of gas and leave the budget reserved with no way out | Critical | Settled and reserved totals live in period sidecars and each request records its reservation period, so settlement is constant time | `the_settlement_is_constant_time_with_a_long_history`, `a_failed_reservation_is_reported_separately_from_settled_money` | Fixed |
| 4 | A request whose callback never arrived stayed `ApprovedPending` for good, with its reservation held | High | `reconcile_request` lets the owner settle it, from the transfer receipt | `the_owner_can_reconcile_a_request_that_never_settled`, `the_owner_can_reconcile_a_request_that_did_move` | Fixed |
| 5 | A failed payment kept its rate slot, and a late failure could remove a newer window's slot | High | Each request records its approval rate-window start; failure refunds only that exact window when it is still current | `a_failed_payment_gives_the_rate_slot_back`, `an_old_rate_window_failure_does_not_refund_a_new_window` | Fixed |
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

## Independent remediation review

A second read-only review of the remediated source found additional contract,
console, build and documentation defects. They are fixed, and the remediated
contract is the artifact that is on the chain.

| Finding | Severity | Implementation | Check | Status |
| --- | --- | --- | --- | --- |
| Legacy state could transact before the new nonce and index sidecars existed | Critical | Fresh state writes a schema marker; request operations require the marker; `migrate` is owner-only, bounded and resumable | `the_migration_marks_the_schema_and_keeps_the_requests`, `the_legacy_migration_is_batched_and_resumable` | Fixed and deployed |
| Migration could exceed one transaction and had no genuine legacy fixture | High | The migration stores a versioned cursor and processes 100 ids per phase; tests use the frozen state layout without current sidecars | `the_legacy_migration_is_batched_and_resumable`, `the_migration_finishes_on_the_shape_of_the_live_contract` | Fixed and deployed |
| A failed reservation could be reported as settled money | Critical | Settlement reads explicit settled and reserved totals and reports them separately | `a_failed_reservation_is_reported_separately_from_settled_money`, `payments_that_settle_out_of_order_leave_the_right_figures` | Fixed and deployed |
| Receipt writes and per-agent counts could scan receipt history | High | Global and per-agent slot indexes make writes and counts independent of retained history | `the_settlement_is_constant_time_with_a_long_history`, `the_receipts_of_one_agent_are_read_in_pages` | Fixed and deployed |
| Historical migration did not enforce receipt retention | High | The migration retains the newest 10,000 receipts while building the index | `the_legacy_migration_enforces_the_receipt_retention_limit` | Fixed and deployed |
| A denial after period rollover could leave the stored period stale | Medium | The period helper persists the canonical rolled policy on every path | `a_denial_after_a_rollover_persists_the_current_period` | Fixed and deployed |
| The request deep link used the wrong state shape and did not cover id zero | High | The view reads `state.requests.items`; the regression covers request zero | `renderRequest reads request id zero from state.requests.items` | Fixed and deployed |
| A truncated request queue was reported as complete | Medium | The API preserves the available count and returns `complete: false` beyond the browser cap | `getOpenRequests reports truncation and preserves the available open count` | Fixed and deployed |
| The dependency gate could pass after an installation or advisory-fetch failure | Critical | The script fails closed, installs the pinned version with `--locked`, verifies the version and treats fetch failure as fatal | `tests/dependency-check/run.sh` | Fixed and deployed |
| The contract test-only VM dependency graph triggered `RUSTSEC-2026-0387` | High | The gate proves the affected crate is absent from the production Wasm graph, then ignores only that exact advisory ID. It does not suppress the crate or any other advisory | `affected crate in the production graph: failed closed`; real dependency gate | Contained and deployed |
| Ambient `RUSTFLAGS` and a malformed `CARGO_HOME` changed the Wasm bytes | High | The build script owns canonical flags, requires an absolute Cargo home and verifies the pinned optimizer | `bash scripts/build-wasm.sh`; CI Wasm hash gate | Fixed and deployed |
| A transfer that was in flight when the upgrade landed could not settle, because the callback waited for the migration | Critical | The callback does not wait for the schema marker. A historical request settles with the historical rules, and the money is placed in the historical period and checked against the historical figure | `a_transfer_that_was_in_flight_when_the_upgrade_landed_still_settles` | Fixed and deployed |
| The historical migration split the same amount twice, because it re-split every pending request on top of an already split figure | Critical | The migration places the settled money of a historical decision once, from the receipt that recorded it, and never re-splits a figure | `the_migration_counts_the_settled_money_of_a_historical_decision_once` | Fixed and deployed |
| The historical layout recorded no reservation period, and the migration invented the current one | Critical | The historical money is recorded as a legacy reservation with an unknown period. The owner names the period with `reconcile_legacy_transfer`, and the migration refuses to finish while a record is unplaced | `a_historical_transfer_waits_for_the_owner_to_name_its_period`, `a_reconciled_historical_transfer_settles_in_the_named_period` | Fixed and deployed |
| The historical state of the earlier, incompatible schema was decoded with the current assumptions | Critical | A state carrying the old `certalyn_schema` marker is refused instead of being migrated | `the_migration_is_owner_only_and_rejects_an_unknown_schema` | Fixed and deployed |
| An expired request stayed in the open request queue | Medium | The request views apply the expiry, and an expired request is not open and cannot be approved | `an_expired_request_is_not_open_any_more` | Fixed and deployed |
| A request whose agent had no policy panicked when it was rejected or expired | Medium | The request is closed with a receipt that says the policy was missing | `a_request_without_a_policy_can_be_rejected_and_expired` | Fixed and deployed |
| An agent that is also the owner or the runner could approve its own spend | Critical | The approval refuses the predecessor when it is the agent of the request | `the_owner_cannot_approve_a_request_of_its_own_agent_account`, `the_runner_cannot_approve_a_request_of_its_own_agent_account` | Fixed and deployed |
| The Wasm bytes depended on the registry directory of the machine that built them | High | Every registry source directory is remapped to one fixed name, and the registry protocol is pinned | Two clean Cargo homes build the same sha256 | Fixed and deployed |
| A legacy request queue that was only partly read was shown as empty | High | The console says how much of the queue it read and never claims that nothing is waiting | `a queue that was only partly read does not claim that nothing is waiting` | Fixed and deployed |
| The `Expired` outcome and state had no label and no filter | Medium | The label, the words and the ledger filter exist for the expired outcome and state | `every receipt outcome has a label`, `the filter row offers every outcome, including the expired one` | Fixed and deployed |
| The approval confirmation promised an `Approved` receipt before the transfer settled | Medium | The confirmation says the budget is reserved and that the receipt depends on the settlement | `the approval confirmation does not promise a receipt before the transfer settles` | Fixed and deployed |
| The enable flow deployed a second, differently optimized wasm file | High | The flow builds with the pinned script and deploys the artifact that build verified | `the deploy step builds the verified artifact and deploys that file` | Fixed and deployed |
| The enable and ledger fields were remounted on every keystroke, which took the caret away | Low | The fields are built once and updated in place | `the name fields are not remounted while the reader types`, `the search field is not remounted while the reader types` | Fixed and deployed |
| The README pointed at an evidence table that was not in the file, and the generator passed silently without it | High | The markers are back and the generator stops when they are missing | `python3 scripts/claims.py` writes the table | Fixed and deployed |
| The fake chain had one nonce, no roles, no accounting and no lock, so the shell tests could pass while the contract was wrong | High | The fake keeps the two nonce watermarks, the settled and reserved money, the roles, the flagged state and a lock over every transaction | `nonce replay: the second request with the same nonce is refused`, `policy accounting: the settled amount is in the spend`, `flagged request: the runner cannot approve it, the owner can`, `concurrent requests: 6 runs, 6 request ids, 6 nonces, all unique` | Fixed and deployed |
| The two demo scripts kept separate nonce counters, so one could replay the other's nonce | High | One counter per agent, shared by both scripts, seeded with the clock so it stays above every nonce the chain has accepted | `one counter per agent: agent.sh ..., protocol_arm.sh ...` | Fixed and deployed |
| The demo treated any new receipt as the settlement of its own request | High | The receipt is found by its request id and its agent | `the receipt of another agent is not reported as this request's settlement` | Fixed and deployed |
| The shell tests wrote their nonce counters into the developer's own state | Medium | The suite runs with its own counter directory and checks that the home directory is untouched | `nonce counter isolation: the counter in the home directory was not touched` | Fixed and deployed |
| The settlement polling had no regression | Medium | The suite approves while the script polls, and also runs the timeout case | `settlement polling: the receipt of this request was found`, `settlement polling timeout: the script says nothing settled` | Fixed and deployed |

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
- The remediated source retains a bounded receipt window of 10,000. It does
  not claim to be a permanent archive.
- The console has no account, no session and no server. The chain is the
  database.
