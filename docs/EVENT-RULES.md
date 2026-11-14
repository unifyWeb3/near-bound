# Event rules and gates

This file records the rules that govern Certalyn's NEAR HACKATHON entry. It is the local source for event-compliance work. The owner authorized the push, the promotion of `master` and the testnet deployment on 2026-11-14. It does not authorize a submission or a public post.

## Event

| Item | Value |
| --- | --- |
| Event name | NEAR HACKATHON |
| Official URL | https://nearhackathon.com/HACKATHON.md |
| Sponsor / platform | NEAR Protocol |
| Prize structure | One grand prize plus first, second, and third place in each of 13 tracks. VERIFIED on 2026-11-13: $55,000 grand prize, then $10,000, $3,000, and $2,000 per track. |
| Submission opens | 2026-11-01T00:00:00Z. VERIFIED on 2026-11-13. |
| Deadline | 2026-11-14T23:59:00Z. VERIFIED on 2026-11-13, and read again on 2026-11-15. The window closed about seventeen hours before the packet was written. Nothing was submitted. The builder asks the organizers whether a late entry is possible. |
| Total time budget | The rules set the event window, not a builder-hour budget. This remediation is limited to local work. |
| Phase split derived from the budget | Event build through the deadline, then judging from 2026-11-16T00:00:00Z through 2026-11-18T23:59:00Z. VERIFIED on 2026-11-13. |
| Judging model | Human judging. Claude Code and Codex perform a reproducibility and feature-verification screen. A low screen score alone cannot reject an entry. VERIFIED on 2026-11-13, Q-017. |
| Screening before scoring | The screen checks that the project runs and does what the README says. VERIFIED on 2026-11-13, Q-017 and the publication procedure. |
| Submission order effect | No published weighting. One submission per project, and each public repository may be submitted once. VERIFIED on 2026-11-13. |
| Editable after submitting | No direct edits. A mistake goes through the organizer's request-changes flow. VERIFIED on 2026-11-13. |
| Required build tool or platform | No mandatory integration. A NEAR project that fits a track is enough. VERIFIED on 2026-11-13, Q-011. |
| Network | Testnet-only projects are eligible. VERIFIED on 2026-11-13, Q-010. |

Source: VERIFIED from official `HACKATHON.md`, fetched 2026-11-13. Fetch it again before submission.

## Rubric and gates

The official rules do not publish judging weights. They identify a grand prize and track prizes but do not define a weighted score. The prior-event criteria named in the audit are technical implementation, design, impact, originality, and sustainability. For local gap tracking, this build uses the workspace default benchmark below and labels it as a local benchmark, not an event-published rubric.

| Criterion | Weight used | Our plan | Evidence | Owner | Status |
| --- | ---: | --- | --- | --- | --- |
| Impact on the user | 30 | Enforce a spend ceiling and expose every decision. | Contract tests, console, limitations. | Builder | Done in the source, deployed on testnet |
| Technical execution | 20 | Fix authorization, accounting, nonce, settlement, migration, and pagination. | Rust regressions, build check, CI. | Builder | Done in the source, deployed on testnet |
| Innovation | 15 | Keep protocol key scoping and denial receipts as differentiators. | Capability table, artifact identity. | Builder | Done in the source, deployed on testnet |
| Demo and evidence | 15 | Make commands runnable and console state complete. | Shell harness, Node tests, claims. | Builder | Done in the source, deployed on testnet |
| Product and UX | 10 | Provide an actionable, role-aware request queue. | Browser journey, keyboard checks. | Builder | Done in the source. No browser run, so the visual check is still open |
| Sponsor technology use | 10 | Use NEAR keys, a contract, and final public-RPC reads. | Contract, deployment, verification commands. | Builder | Done in the source, deployed on testnet |
| **Total** | **100** |  |  |  |  |

### Track selection

Certalyn is submitted for `security` and `agents`.

- VERIFIED: the `security` track asks for spending limits, policy engines, sandboxed wallets, and function-call keys.
- VERIFIED: the `agents` track covers agents that pay for APIs, compute, or data.
- INFERRED: `security` is the primary fit. `agents` fits because the product controls an agent's payments. `business` is not selected until a paying customer or measurable payment flow exists.

## Required submission fields

The official API accepts exactly the fields below. Values are not a payload to send. The builder must confirm every personal or submission value before submission.

| Field | Value we will submit | Verified link or artifact | Status |
| --- | --- | --- | --- |
| requestId | Generated once at submission time | Official submission procedure | Not created. A retry must reuse it. |
| projectName | Certalyn | Local decision, 2026-11-13 | Ready. |
| leadName | Builder-provided | Human-provided value | Open. The builder asked to fill it in themselves. |
| email | Builder-provided | Human-provided value | Open. The builder said they would type the exact address. |
| size | `1` | Team size is one | Ready. |
| tracks | `security`, `agents` | Official track table | Ready. |
| nearAddress | Builder-provided mainnet payout account | Human-provided value | Open. The builder asked to fill it in themselves. Never create or invent it. |
| projectUrl | `https://github.com/unifyWeb3/near-bound` | Public repository | Ready, but do not push without approval. |
| demoUrl | The post the builder publishes | `https://x.com/oxunify/status/2120085871852478803` | The draft post is in [docs/SUBMISSION.md](SUBMISSION.md) with the required tags and the question the rules ask for. The builder publishes it. The link above is the one the builder gave on 2026-11-15. |
| idea | Concise problem, product, and NEAR role | [docs/SUBMISSION.md](SUBMISSION.md), 985 characters | Ready. The copy is written and checked against the field rule. |
| consent | `true` only after the builder agrees to the contact notice | Official contact notice | Open. The notice is in [docs/SUBMISSION.md](SUBMISSION.md), to be read to the builder word for word. |

Official fields were VERIFIED on 2026-11-13. A payload must contain no extra fields. In particular, `website` is rejected when it is not empty.

## Eligibility

| Requirement | Met | Evidence |
| --- | --- | --- |
| Public repository | Yes | VERIFIED by the 2026-11-12 audit: `github.com/unifyWeb3/near-bound` was public. |
| Public before the deadline | Yes | VERIFIED by the 2026-11-12 audit. |
| Human demo post | The draft is written, the post is the builder's | The draft in [docs/SUBMISSION.md](SUBMISSION.md) says the project was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, shows one complete spend, explains the role of NEAR and asks a question. The builder publishes it. |
| Testnet-only project | Yes | Official Q-010. VERIFIED 2026-11-13. |
| Working project | Yes | Rust tests and live evidence in `docs/CLAIMS.md`. The remediated contract is deployed on testnet. |
| No mandatory integration | Yes | Official Q-011. VERIFIED 2026-11-13. |
| Independent sibling disclosed | Yes | `README.md` names `keyhalt`; the sibling names `near-bound`, per the 2026-11-12 audit. |
| One submission per project | Yes | No submission is authorized here. |
| License | Yes | MIT `LICENSE`. |

## Artifact identity

The live deployment and remediation branch stay separate.

| Field | Value |
| --- | --- |
| Historical toolchain | Rust 1.99.1 and Binaryen 133 |
| Historical source commit | `187fd92843d3a73702e19e95d13a06c36661c8a2` |
| Historical deployment transaction | `Bb64yQtpRcu1yFJyRWeizXZMRJnJY4HBDCWwKxoJw7Ls` |
| Historical Wasm SHA-256 | `f720587997a04f8bf9702aeeca3525867b321374e151fe26bfef9ec2ca955a7e` |
| Historical on-chain code hash | `HdgJrzYbWsQKWgxRvFG1yUD3UM9M89mRGUE7ESTfjE8d` |
| Remediation artifact | Built and deployed. The live code hash and the sha256 of the bytes are in `docs/claims.json`, and they are the artifact this source builds. |
| Comparison result | The live artifact matches the build. The build is byte identical in three clean environments, and the deployed code hash was read back from the chain. |

## Headline claim enforcement

| Assertion | Enforced by | Status |
| --- | --- | --- |
| The agent can ask but cannot move the contract's money. | Key scope and caller checks. | Covered by `only_the_agent_may_ask_for_a_spend` and the four protocol refusals in `demo/protocol_arm.sh`. |
| The owner controls every policy limit and the global stop. | Owner-only methods. | Covered by `only_the_owner_may_change_the_policy` and `the_kill_switch_stops_a_second_agent_too`. |
| Every request reaches an inspectable decision. | Lifecycle, expiry, and receipt. | Covered by `an_expired_request_cannot_be_approved`, `an_expired_request_is_not_open_any_more` and the receipt views. |
| Concurrent approvals cannot exceed the budget. | Settled and reserved totals. | Covered by `a_request_made_early_cannot_spend_a_reserved_budget` and `a_failed_reservation_is_reported_separately_from_settled_money`. |
| A failed transfer returns its reservation. | O(1) settlement accounting. | Covered by `a_failed_transfer_gives_the_budget_back` and `the_settlement_is_constant_time_with_a_long_history`. |
| The console matches final README reads. | One adapter with `finality: final`. | Covered by the console tests and by `scripts/claims.py --check`. |

## Limitations consistency

| Limitation | Negates the headline claim? | Action |
| --- | --- | --- |
| Testnet only | No, because testnet-only entries are eligible. | State it plainly. |
| Not audited | No, because the audit is an engineering review, not a security audit. | State it plainly. |
| The deployment carries testnet NEAR only | No, because testnet-only entries are eligible. | State it plainly. |
| The historical demo did not call a metered vendor service | It weakens any claim that the contract bought an API, but not the core policy claim. | Correct the copy or implement the real vendor path. |
| No production customer or revenue | No, but it limits the impact claim. | State the business hypothesis as a hypothesis. |

## Value-moving branch coverage

| Branch | Test | Target-network transaction | Status |
| --- | --- | --- | --- |
| Policy denial before a payment | Required | Historical denial receipts | Testnet only |
| Owner approval and successful settlement | Required | Historical approved receipts | Testnet only |
| Transfer failure and reservation refund | Required | Historical failed receipt 18 | Testnet only |
| Two approvals against one budget | Required | Historical receipts 19 and 20 | Testnet only |
| Settlement after a period rollover | Required | Contract test | Not on chain |
| Flagged request approved only by owner | Required | Contract test | Not on chain |
| Expired request cannot be approved | Required | Contract test | Not on chain |

## State transition table

The complete transition and guard table lives in `docs/STATE-TRANSITIONS.md`. It is a release gate.

## Claims registry

`docs/CLAIMS.md` and `docs/claims.json` remain the source for balances, hashes, counts, and transaction identifiers. README prose must not add an ungenerated factual number.

## Software surface

| Item | Value |
| --- | --- |
| Surface type | Contract CLI, public JSON-RPC reads, and a static console. |
| Commands | `make test`, `make wasm`, `make verify`, `node --test web/test/*.test.js`. |
| Environment | Rust 1.99.1, Python 3, Node 22 or newer. |
| Proof output | Contract tests, shell transcript, Node results, generated claims. |
| Live comparison | `scripts/claims.py --check` covers the historical deployment. The remediation needs a future deployment. |
| Clean checkout | Pass. `git clone`, `make test`, `make wasm` and `python3 scripts/claims.py --check` need no key. |

## Evidence table

| Step | Actor | Transaction | Link | Observed result |
| --- | --- | --- | --- | --- |
| Historical deployment | Builder | `Bb64yQtpRcu1yFJyRWeizXZMRJnJY4HBDCWwKxoJw7Ls` | Near explorer URL generated from the contract account | Contract code and state were replaced while state carried over. |
| Historical successful payment | Builder | `HBD7hJL9bv5Npir8T9TtNMzJ2DJf4hpbUDWNvBWU6bGW` | Near explorer URL generated from the contract account | Receipt 19 approved. |
| Historical budget denial | Builder | `6MKVUN9QoLd6y92nrgrRYfrVWR2DmgCpbRQnnfXb1JEv` | Near explorer URL generated from the contract account | Receipt 20 denied for `BudgetExceeded`. |
| Historical failed transfer | Builder | `4JTiK48kgmGwLJxjjtdDLEZn7gZhvGVKpqJgT7sXvQRm` | Near explorer URL generated from the contract account | Receipt 18 failed and returned the reservation. |

## Pre-submission gate results

| Gate | Result | Note |
| --- | --- | --- |
| A1 live runtime equals artifact | Pass | The live code hash is the base58 of the sha256 of the built artifact. |
| A2 verifier exits zero against live deployment | Pass | `python3 scripts/claims.py --check` reads the live deployment and exits zero. |
| A3 one toolchain and build config | Pass | Rust 1.99.1 and Binaryen 133 are pinned, and the build is byte identical in three clean environments. |
| A4 suite rerun on deployed config | Pass | The full suite runs green on the source of the deployed artifact. |
| A5 required form fields complete | Three values and one line open | The copy, the post draft, the repository link, the tracks and the size are ready. The lead name, the contact email, the mainnet payout account and the consent are the builder's. |
| A6 video public and complete | The video is public, and it predates the design pass | `https://youtu.be/MkUzLlyw50E`, titled "certalyn demo video". Its title frame shows the Certalyn console as it was before the design pass: the same product and the same flow, not the current typography, the phase rail or the state colours. A recording of the console as it is now has been made by `tests/browser/record.js` and checked frame by frame, and it is on the builder's machine. The builder decides which one the post carries, and attaches it themselves. The earlier video, `https://youtu.be/E9JbF9TlKs4`, is titled for the old name and is not used. |
| A7 headline claims enforced | Pass | Every headline claim names the test that enforces it. |
| A8 value branches tested and labelled | Pass | Every branch in the table has a named test. |
| A9 numbers come from claims registry | Pass | `scripts/claims.py` writes the numbers and the check compares them with the chain. |
| A10 evidence links prove their claim | Historical evidence | Recheck before submission. |
| A11 software surface runs clean | Pass | `make test`, `make fmt`, `make clippy` and ShellCheck are green. |
| A12 network labels correct | Pass | Every transaction row is labelled testnet only. |

## Competitive field

| Item | Value |
| --- | --- |
| Field | NEAR agent spending controls, including bounded wallets, scoped keys, policy engines, and receipt ledgers. |
| Common approach | Put a cap in the contract and show an agent-facing dashboard. |
| Open axis | Make the decision lifecycle complete and inspectable: denial receipts, role-separated approval, expiry, explicit reservations, bounded history, and a source-to-Wasm identity chain. |
| Position | Certalyn treats the agent's authority as a protocol-scoped capability and the owner's budget as an auditable state machine. |
| Structures used | Public proof surface, capability table, generated claims, and copyable verification commands. |
| Ideas, interfaces, and copy not used | No competitor implementation, branding, interface, or text was copied. |

## Deployment and cost

| Item | Value |
| --- | --- |
| Deployment target | NEAR testnet only. The contract is `bound-testnet-97685.testnet`. |
| Public URL | The console is `https://near-bound.vercel.app`. |
| Recurring cost | $0 for the static console and public RPC. No paid dependency is being added. |
| Environment variables | None are required by the contract, claims reader, or static console. |
| Restriction | A changed contract needs a new deployment. The remediated contract was deployed on testnet with the owner approval of 2026-11-14. |

## Benchmark and gap routing

The score will use the local default benchmark because the event publishes no weights. The final score comes from checked artifacts, not an event-published rubric.

| Gap | Lever | Cost | Applied? | Delta |
| --- | --- | ---: | --- | ---: |
| Contract correctness | Sidecars and regressions | High | Yes, local source | Implemented; deployment still pending |
| Broken enable flow | Runnable commands and truthful copy | Medium | Yes, local source | Implemented; deployment still pending |
| Wrong browser arguments | JSON objects and role-specific methods | Medium | Yes, local source | Implemented; deployment still pending |
| Unbounded history | Paged views and bounded index | Medium | Yes, local source | Implemented; deployment still pending |
| Weak operations | Pinned build, shell/Node tests, audit | Medium | Yes, local source | Implemented; deployment still pending |
| Name collision | Certalyn branding | Low | Yes, local source | Implemented; deployment still pending |

Deliberately left undone: no submission, no public post, and no X post edit. Those actions need separate authorization. The deployment, the push and the promotion of `master` were done on 2026-11-14 with the owner approval.

## Open questions

| Question | Owner | Needed by | Status |
| --- | --- | --- | --- |
| Does the published post carry the required phrase, the tags and the attachment? | Builder | Before submission | The draft does. The builder publishes it. |
| Does the video show the current console and a real transaction? | Builder | Before submission | The video predates the design pass. The builder decides whether to re-record it against the live console. |
| What are the lead name, contact email, and mainnet payout account? | Builder | Before submission | Open. The email is the one the builder said they would type. |
| When may the remediated contract be deployed to testnet? | Builder | After local verification | Answered on 2026-11-14. Deployed and migrated. |
| Can the entry still be submitted after the window closed? | Builder | Immediately | The API answers 403 outside the window and the rules say to tell the human. Nothing was submitted. |
