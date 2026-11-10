# Decisions

One line per decision, with the reason and the date.

| Decision | Reason | Date |
| --- | --- | --- |
| The policy lives in the `bound-policy` crate as a pure function | The same rules are implemented in the paper harness in JavaScript, and both are tested against the same cases. A pure function can be tested without a chain. | 2026-11-05 |
| The contract writes a receipt for every decision, denials included | A reader should be able to find the refusals without guessing an id. `get_receipt_count` was added so the ids can be walked. | 2026-11-05 |
| The block timestamp is converted to seconds before the policy engine sees it | The engine compares seconds. A nanosecond value made every period look finished, which reset the budget on every call. | 2026-11-05 |
| The receipt is written when the transfer settles, not when the owner approves | The transfer can fail. A receipt written at approval would say the money moved when it did not. Writing it in the callback means a receipt never lies, and no receipt is ever rewritten. | 2026-11-10 |
| The approval reserves the budget and the failed settlement gives it back | Two approvals in the same period must not go over the budget together, and a payment that never happened must not eat into the period. | 2026-11-10 |
| The receipt ledger and the policy layout are frozen | The contract is live and its state is already stored. New enum variants are appended, never inserted, so the stored values keep their borsh discriminants. | 2026-11-10 |
| `register_agent` refuses an agent that already has a policy | Registering wrote a fresh policy over the old one, which wiped the spend, the nonce and the request count of a live agent. The limits change through `set_budget`, `set_max_single_spend` and `set_rate_limit`, which keep the counters. | 2026-11-10 |
| The live policy is 5 NEAR an hour and 1 NEAR a payment | The old figures were 0.00000005 NEAR against a treasury of 19.99 NEAR, so the two numbers on the page contradicted each other. | 2026-11-11 |
| The amounts go into the CLI as base64 encoded JSON | The CLI reads `json-args` into a JSON value, and a number bigger than 2^53 comes back as a float. `base64-args` carries the exact bytes. | 2026-11-11 |
| The contract is redeployed without an init call | An init call replaces the state. A deploy with no init call keeps every receipt, request and policy. | 2026-11-11 |
