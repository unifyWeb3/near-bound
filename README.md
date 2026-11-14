# Certalyn

A spend limit for an agent that pays, enforced by a NEAR contract.

Certalyn holds the money in a contract. The owner sets a budget, a list of
allowed receivers, a cap on one payment, a rate limit and a kill switch. The
agent holds a function call key that can only ask the contract to spend. The
contract decides. Every decision, allowed or refused, is written as a receipt
that anyone can read from the chain.

The role NEAR plays is the enforcement point. A prompt can be argued with, an
API key cannot be capped, and a sandbox is only as strong as the host. A
contract on a shared ledger holds the money and the rules in the same place,
so an agent that cannot change the rules cannot get around them, and a reader
can check what happened without trusting the console.

- Repository: `unifyWeb3/near-bound`
- Live console: <https://near-bound.vercel.app/>
- Live contract on testnet: `bound-testnet-97685.testnet`
- Licence: MIT

## Try it in five minutes

Testnet NEAR is free. You need the `near` CLI and this repository.

1. Create three funded testnet accounts: one owner and treasury, one agent,
   one counterparty to pay.
2. Deploy the contract and register the agent with a policy.
3. Give the agent a scoped key that can call `request_spend` and nothing else.
4. Ask for a spend as the agent, approve it as the owner, and read the receipt.

The console builds every command for you. Open the **Set up** view, put your
own account names in the three fields, and copy each command as it is
printed. Nothing in this repository needs an account to read, so a judge can
reproduce every figure with the read-only calls in the **Evidence** view.

## What the agent key can and cannot do

The agent never holds the money and never holds a key that can move it. It
holds a function call access key with four limits, all enforced by the
protocol before the contract runs:

| Limit | Consequence |
| --- | --- |
| one method, `request_spend` | any other call is refused by the protocol |
| one receiver, the contract | the key cannot call a counterparty or itself |
| no deposit allowed | the key cannot attach NEAR to a call |
| a gas allowance | the key cannot afford a call the owner did not budget for |

`demo/protocol_arm.sh` runs those four refusals against the live deployment
and prints the protocol's own error for each one. The output of the recorded
run is in `demo/protocol_arm.out`.

## The contract interface

Arguments are JSON objects, the same shape the NEAR CLI sends with
`json-args`. The console signs the same bytes.

| Method | Who may call it | Arguments | What it does |
| --- | --- | --- | --- |
| `request_spend` | the agent, for itself | `agent_id, vendor, amount, nonce, memo` | runs the hard checks, then waits for the owner |
| `approve_request` | owner or runner | `request_id` | reserves the budget and moves the money |
| `owner_approve_request` | owner | `request_id` | approves a request that was flagged for a human |
| `flag_request` | owner or runner | `request_id, reasons` | sends a request to the owner |
| `reject_request` | owner or runner | `request_id, reason` | refuses a request and writes the receipt |
| `owner_reject_request` | owner | `request_id, reason` | refuses a flagged request |
| `expire_request` | owner or runner | `request_id, reason` | closes an open request, nothing moves |
| `reconcile_request` | owner | `request_id, moved` | settles a request whose callback never arrived |
| `set_budget`, `set_max_single_spend`, `set_rate_limit`, `set_vendors` | owner | `agent_id, ...` | change the limits, the counters stay |
| `set_revoked` | owner | `agent_id, revoked` | locks one agent out |
| `set_kill_switch` | owner | `on` | freezes every agent |
| `block_account`, `unblock_account` | owner | `account_id` | refuses one receiver |
| `register_agent` | owner | `agent_id, budget, period_seconds, vendors, max_single_spend, rate_limit` | creates one policy |
| `migrate` | owner | none | indexes the history written before the upgrade |

Views: `get_policy`, `get_request`, `get_request_view`, `get_requests`,
`get_open_requests`, `get_receipt`, `get_receipt_safe`, `get_agent_receipts`,
`get_agent_receipt_count`, `get_receipt_count`, `get_request_ids`,
`get_kill_switch`, `get_owner`, `get_runner`, `treasury_balance`.

## The rules and the order they run in

The rules live in the `bound-policy` crate as a pure function, so they can be
tested without a chain. The order is part of the design. A dangerous receiver
is refused before the budget is looked at, so a bad receiver is refused even
when money is left.

1. `AgentRevoked`, the owner locked this agent out
2. `InvalidAmount`, the amount is zero
3. `NonceReplay`, the nonce was already used by this agent
4. `CounterpartyBlocked`, the receiver is on the blocklist
5. `VendorNotAllowed`, the receiver is not on the allowlist
6. `SingleSpendExceeded`, the amount is above the cap
7. `RateLimited`, too many payments in the last minute
8. `BudgetExceeded`, the spend would pass the period budget
9. `KillSwitch`, the owner froze every agent

A denial is a receipt, not an error string. It carries the rule in plain
words and the facts behind it.

## How a payment settles

The budget is reserved at approval, not at settlement, so two approvals in the
same period cannot together go over the budget. The receipt is written in the
settlement callback, after the transfer has run, so a receipt never claims
the money moved when it did not.

| State | Receipt | The budget |
| --- | --- | --- |
| `Pending` | none yet | untouched |
| `NeedsApproval` | none yet | untouched |
| `ApprovedPending` | none yet, it comes when the transfer settles | reserved |
| `Approved` | `Approved` | spent |
| `SettlementFailed` | `Failed`, with the reason | given back |
| `Denied` | `Denied`, with the rule and the evidence | untouched |
| `Expired` | `Expired` | untouched |

A failed payment gives the budget back and gives the rate slot back. The
settlement accounting is constant time, so the callback cannot run out of gas
as the ledger grows. If a callback still never arrives, the owner closes the
request with `reconcile_request`, and the reservation is settled by hand.

## Evidence

Every number in this repository comes from a script that reads the chain.

```bash
python3 scripts/claims.py          # write docs/CLAIMS.md and docs/claims.json
python3 scripts/claims.py --check  # fail when the live deployment differs
```

The generated tables are in [docs/CLAIMS.md](docs/CLAIMS.md). The read-only
curl for every figure is in the console's **Evidence** view, and the
transactions behind the recorded run are in the evidence table of this
repository.

The wasm is built reproducibly. The build script compiles twice in separate
directories, compares the bytes, and writes a manifest. The expected hash is
committed in [docs/wasm-lock.json](docs/wasm-lock.json) and CI fails when the
build produces different bytes.

```bash
bash scripts/build-wasm.sh
```

## What is real and what is not

| Claim | State |
| --- | --- |
| The contract, the policy engine and the receipts | Real, on testnet, live |
| The refusal reasons on the receipts | Real, written by the contract |
| The console figures | Read live from the public testnet RPC when the page opens |
| The console on a failed read | The last good read, marked stale. Never a guessed number |
| What the contract buys | Nothing. It moves NEAR to the counterparty account with a plain transfer under the policy |
| Counterparty signals | The blocklist and the allowlist the owner sets. No risk feed, no account age, no code change watch |
| The browser writes | Approve, refuse, expire and reconcile, signed by the reader's own wallet |
| Audit | Not audited. Testnet only. No real money has moved |

A receipt proves the contract decided and the transfer settled. It does not
prove a service was delivered.

## What this branch changed

The audit of the previous revision found two broken flows and one defect that
could strand money. All three are fixed here, with tests.

| Finding | Fix | Test |
| --- | --- | --- |
| A flagged request could never be approved, because the owner path delegated to a method that only accepts `Pending` | `approve_request` accepts an open request, and a flagged one needs the owner | `the_owner_can_approve_a_flagged_request`, `the_runner_cannot_approve_a_flagged_request` |
| The console sent Borsh arguments to a contract that reads JSON, so no browser write could succeed | The arguments are a JSON object, signed as bytes | `wallet arguments are JSON argument objects, not Borsh arrays` |
| The settlement callback walked the whole request history, so it could run out of gas and leave the budget reserved with no way out | The reservation is held in a sidecar keyed by agent and period, and the owner can reconcile a request that never settled | `the_settlement_is_constant_time_with_a_long_history`, `the_owner_can_reconcile_a_request_that_never_settled` |
| A failed payment kept its rate slot | The slot comes back with the budget | `a_failed_payment_gives_the_rate_slot_back` |
| A nonce could be replayed while the first request was still undecided | The accepted nonce is tracked per agent | `an_accepted_nonce_cannot_be_replayed` |
| The console read the whole ledger of every agent to show one agent | The contract reads one agent's receipts in pages | `getLedger on a paged contract uses the agent page view` |
| The receipt cache could serve receipts from a state that no longer exists | Cached receipts the chain cannot have any more are dropped | `the cache drops receipts the chain cannot have` |
| The big number parser could corrupt a receipt whose memo held a long number | Numbers outside strings are quoted, strings are left alone | `parseBigJson does not touch a long number inside a string` |

The full table, with the checks that cover each line, is in
[docs/AUDIT-REMEDIATION.md](docs/AUDIT-REMEDIATION.md).

The live deployment still carries the previous artifact. The hash of the
deployed contract is in [docs/CLAIMS.md](docs/CLAIMS.md), and the hash of the
artifact this source builds is in [docs/wasm-lock.json](docs/wasm-lock.json).
They differ, because this source has not been deployed.

## Run it locally

```bash
make test          # the policy suite and the contract suite
make test-shell    # the demo scripts against a fake near CLI
cd web && node --test test/*.test.js   # the console unit tests
make fmt           # rustfmt
make clippy        # clippy with warnings denied
make verify-local  # build the wasm twice and compare the bytes
```

The console is a static folder with no build step. Serve it over HTTP, the
browser blocks module scripts on a `file://` page.

```bash
cd web && python3 -m http.server 8000
```

## Repository layout

```
contract/     the contract on chain, unit tested
policy/       the policy engine as a pure function, unit tested
web/          the console, a static page with no backend
demo/         the protocol arm, the agent script, the counterparty contract
scripts/      the claims generator and the reproducible wasm build
tests/        the shell tests against a fake near CLI
docs/         the generated claims, the decisions, the audit table
```

## Limits

- Testnet only. No mainnet deployment, no real money has moved.
- Not audited.
- The receipts are never pruned. The contract pays for the storage.
- The contract cannot be upgraded in place. A fix needs a redeploy that keeps
  the state. `migrate` indexes the history, it does not move it.
- The counterparty signals are local policy inputs, not live risk feeds.
- The agent's gas comes from its account. The key's allowance caps the gas it
  can burn, and adding NEAR to the agent account does not raise the
  allowance.

## Licence

MIT. See [LICENSE](LICENSE).
