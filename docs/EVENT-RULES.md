# Event rules and gates

This file records the rules that govern Certalyn's NEAR HACKATHON entry. It is the local source for event-compliance work. It does not authorize a submission, a push, a deployment, or a public post.

## Event

| Item | Value |
| --- | --- |
| Event name | NEAR HACKATHON |
| Official URL | https://nearhackathon.com/HACKATHON.md |
| Sponsor / platform | NEAR Protocol |
| Prize structure | One grand prize plus first, second, and third place in each of 13 tracks. VERIFIED on 2026-11-13: $55,000 grand prize, then $10,000, $3,000, and $2,000 per track. |
| Submission opens | 2026-11-01T00:00:00Z. VERIFIED on 2026-11-13. |
| Deadline | 2026-11-14T23:59:00Z. VERIFIED on 2026-11-13. |
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
| Impact on the user | 30 | Enforce a spend ceiling and expose every decision. | Contract tests, console, limitations. | Builder | In progress |
| Technical execution | 20 | Fix authorization, accounting, nonce, settlement, migration, and pagination. | Rust regressions, build check, CI. | Builder | In progress |
| Innovation | 15 | Keep protocol key scoping and denial receipts as differentiators. | Capability table, artifact identity. | Builder | In progress |
| Demo and evidence | 15 | Make commands runnable and console state complete. | Shell harness, Node tests, claims. | Builder | In progress |
| Product and UX | 10 | Provide an actionable, role-aware request queue. | Browser journey, keyboard checks. | Builder | In progress |
| Sponsor technology use | 10 | Use NEAR keys, a contract, and final public-RPC reads. | Contract, deployment, verification commands. | Builder | In progress |
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
| leadName | Builder-provided | Human-provided value | Required from builder. |
| email | Builder-provided | Human-provided value | Required from builder. |
| size | `1` | Team size is one | Ready. |
| tracks | `security`, `agents` | Official track table | Ready. |
| nearAddress | Builder-provided mainnet payout account | Human-provided value | Required from builder. Never create or invent it. |
| projectUrl | `https://github.com/unifyWeb3/near-bound` | Public repository | Ready, but do not push without approval. |
| demoUrl | Existing post in README | `https://x.com/oxunify/status/2120085871852478803` | UNKNOWN. The URL is present, but its text, tags, and attachment still need human verification. |
| idea | Concise problem, product, and NEAR role | README and local remediation | Draft only. |
| consent | `true` only after the builder agrees to the contact notice | Official contact notice | Required from builder. |

Official fields were VERIFIED on 2026-11-13. A payload must contain no extra fields. In particular, `website` is rejected when it is not empty.

## Eligibility

| Requirement | Met | Evidence |
| --- | --- | --- |
| Public repository | Yes | VERIFIED by the 2026-11-12 audit: `github.com/unifyWeb3/near-bound` was public. |
| Public before the deadline | Yes | VERIFIED by the 2026-11-12 audit. |
| Human demo post | Unverified | The post text, required tags, and video content need a human check. |
| Testnet-only project | Yes | Official Q-010. VERIFIED 2026-11-13. |
| Working project | Yes, for audited source | Rust tests and live evidence in `docs/CLAIMS.md`. The remediation branch is not deployed. |
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
| Remediation artifact | Not built or deployed yet. It will differ from the historical Wasm. |
| Comparison result | Historical live artifact matches the historical registry. The remediation artifact has no live comparison until a deployment is authorized. |

## Headline claim enforcement

| Assertion | Enforced by | Status |
| --- | --- | --- |
| The agent can ask but cannot move the contract's money. | Key scope and caller checks. | Test pending. |
| The owner controls every policy limit and the global stop. | Owner-only methods. | Test pending. |
| Every request reaches an inspectable decision. | Lifecycle, expiry, and receipt. | Test pending. |
| Concurrent approvals cannot exceed the budget. | Settled and reserved totals. | Test pending. |
| A failed transfer returns its reservation. | O(1) settlement accounting. | Test pending. |
| The console matches final README reads. | One adapter with `finality: final`. | Test pending. |

## Limitations consistency

| Limitation | Negates the headline claim? | Action |
| --- | --- | --- |
| Testnet only | No, because testnet-only entries are eligible. | State it plainly. |
| Not audited | No, because the audit is an engineering review, not a security audit. | State it plainly. |
| The local remediation is not deployed | No, if live and local evidence stay separate. | Do not present the local branch as live. |
| The historical demo did not call a metered vendor service | It weakens any claim that the contract bought an API, but not the core policy claim. | Correct the copy or implement the real vendor path. |
| No production customer or revenue | No, but it limits the impact claim. | State the business hypothesis as a hypothesis. |

## Value-moving branch coverage

| Branch | Test | Target-network transaction | Status |
| --- | --- | --- | --- |
| Policy denial before a payment | Required | Historical denial receipts | Testnet only |
| Owner approval and successful settlement | Required | Historical approved receipts | Testnet only |
| Transfer failure and reservation refund | Required | Historical failed receipt 18 | Testnet only |
| Two approvals against one budget | Required | Historical receipts 19 and 20 | Testnet only |
| Settlement after a period rollover | Required | Not deployed | Not built on chain |
| Flagged request approved only by owner | Required | Not deployed | Not built on chain |
| Expired request cannot be approved | Required | Not deployed | Not built on chain |

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
| Clean checkout | Pending. |

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
| A1 live runtime equals artifact | Historical pass, remediation pending | No deployment authorized. |
| A2 verifier exits zero against live deployment | Historical evidence only | Rerun after any future deployment. |
| A3 one toolchain and build config | In progress | Pin Rust and Binaryen. |
| A4 suite rerun on deployed config | Pending | Not deployed. |
| A5 required form fields complete | Not met | Builder must supply personal fields. |
| A6 video public and complete | Unverified | Human check required. |
| A7 headline claims enforced | In progress | Contract and web tests. |
| A8 value branches tested and labelled | In progress | See branch table. |
| A9 numbers come from claims registry | In progress | Generated check required. |
| A10 evidence links prove their claim | Historical evidence | Recheck before submission. |
| A11 software surface runs clean | Pending | Required. |
| A12 network labels correct | In progress | No mainnet claim. |

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
| Deployment target | NEAR testnet only. |
| Public URL | The historical console is `https://near-bound.vercel.app`. |
| Recurring cost | $0 for the static console and public RPC. No paid dependency is being added. |
| Environment variables | None are required by the contract, claims reader, or static console. |
| Restriction | A changed contract needs a new deployment. No deployment is authorized in this work. |

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

Deliberately left undone: no deployment, submission, push, public post, or X post edit. Those actions need separate authorization.

## Open questions

| Question | Owner | Needed by | Status |
| --- | --- | --- | --- |
| Does the existing X post contain the required phrase, tags, and demo attachment? | Builder | Before submission | Open |
| Does the existing video show the current product and a real transaction? | Builder | Before submission | Open |
| What are the lead name, contact email, and mainnet payout account? | Builder | Before submission | Open |
| When may the remediated contract be deployed to testnet? | Builder | After local verification | Open |
