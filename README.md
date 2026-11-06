# Bound

Give an agent a wallet and keep the leash.

Bound is a NEAR contract that holds an owner's money and lets an agent ask to
spend it. The agent never holds a key that can move value. Its key can call one
method on one contract, it cannot attach a deposit, and the contract checks
every request against a policy the agent cannot edit. Approved and denied
attempts both leave a receipt.

## The problem

An autonomous agent that buys API calls needs a credential with money behind
it. Today that credential is usually a secret in an environment variable or a
sentence in the system prompt. Both fail the same way: the agent reads a file
or a search result that says to pay a new vendor, and the credential or the
prompt does not know the difference between the owner's instruction and text
the agent picked up along the way.

Bound moves the decision out of the agent. The owner sets a budget, a per
spend limit, a rate limit, and a list of allowed receivers. The chain enforces
them. The agent can ask, and the owner or a runner can approve, but the agent
cannot pay anyone directly.

## What runs on NEAR

| Piece | Account | What it does |
| --- | --- | --- |
| Policy contract | `bound-testnet-97685.testnet` | Holds the treasury, stores one policy per agent, evaluates every request, writes a receipt for every decision |
| Paid API stand-in | `bound-vendor.testnet` | A `#[payable]` method used as the vendor in the demo |
| Agent | `bound-agent.testnet` | Holds a full access key for setup and a restricted function call key for spending |

The restricted key has this permission on chain:

```json
{
  "FunctionCall": {
    "receiver_id": "bound-testnet-97685.testnet",
    "method_names": ["request_spend"],
    "allowance": "200000000000000000000000"
  }
}
```

It can call `request_spend` on Bound and nothing else. It cannot call
`approve_request`, it cannot call the vendor, it cannot send NEAR, and the
protocol rejects any attempt to attach a deposit to it.

## Live testnet state

| Item | Value |
| --- | --- |
| Contract | `bound-testnet-97685.testnet` |
| Vendor | `bound-vendor.testnet` |
| Agent | `bound-agent.testnet` |
| Owner | `bound-testnet-97685.testnet` |
| Network | testnet |

Transaction evidence:

- Allowed request 3: `3st8i3jZAC3cg67BSwfYgfMLkzrQRaMuua42hiXiCUCN`
- Owner approval, vendor paid: `CtCvKvkbTar6NzRNqbE8uGMqVhNMHsVDP49Ki1bW6Yu2`
- Allowed request 4: `HHm7Zs9DTQW8T6Ru6nWYdrvCRje4qm79YVpUWFYzMp51`
- Owner approval, vendor paid: `836Sc8vJSmWimmh3GPgZxPnEkDVCaHjB3D76zGegzjCS`
- Dashboard release, adds `get_receipt_count`: `8zEZKh6ZQG3MWWMqhouCgzoECEvoRHyf5rey33Mig4BD`

Every decision, including the denials, is a receipt on chain. Denials do not
create a request, so `get_receipt_count` plus `get_receipt` is how a reader
finds them:

```bash
near contract call-function as-read-only bound-testnet-97685.testnet \
  get_receipt_count json-args '{}' network-config testnet now

near contract call-function as-read-only bound-testnet-97685.testnet \
  get_receipt json-args '{"receipt_id":10}' network-config testnet now
```

Receipt 10 is a `BudgetExceeded` denial with the evidence lines
`spent 40000000000000000 of 50000000000000000` and
`requested 20000000000000000`.

Explorer: `https://testnet.nearblocks.io/txns/<hash>`

## Try it: read the live state, no keys needed

Do this:

```bash
near contract call-function as-read-only bound-testnet-97685.testnet \
  get_policy json-args '{"agent_id":"bound-agent.testnet"}' \
  network-config testnet now
```

See this: the budget, the amount already spent, the remaining amount, the
vendor allowlist, the single spend limit, the rate limit, the last nonce, and
whether the agent is revoked.

Do this:

```bash
near contract call-function as-read-only bound-testnet-97685.testnet \
  get_request_ids json-args '{"agent_id":"bound-agent.testnet"}' \
  network-config testnet now
```

See this: the list of request ids for the agent. Each request is either
`Pending`, `Approved`, or `Denied`. A denied request still has a receipt.

Do this:

```bash
near contract call-function as-read-only bound-testnet-97685.testnet \
  get_request json-args '{"request_id":3}' \
  network-config testnet now
```

See this: the request status, the vendor, the amount, the nonce, and the
receipt id. Request 3 was approved after the owner checked it.

Do this:

```bash
near contract call-function as-read-only bound-vendor.testnet \
  get_taken json-args '{}' network-config testnet now
```

See this: the total the vendor has received. The vendor balance grew by
exactly `20000000000000000` yoctoNEAR between the two approvals in the evidence
list above.

## Try it: run the whole loop on your own testnet accounts

You need three funded testnet accounts and the `near` CLI. Testnet NEAR is
free from `https://near-faucet.io` or the NEAR wallet faucet.

```bash
export OWNER=your-owner.testnet
export AGENT=your-agent.testnet
export VENDOR=your-vendor.testnet
```

Do this:

```bash
cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path demo/vendor/Cargo.toml

near contract deploy "$OWNER" use-file \
  contract/target/near/bound_contract.wasm with-init-call new \
  json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send

near contract deploy "$VENDOR" use-file \
  demo/vendor/target/near/bound_vendor.wasm with-init-call new \
  json-args '{"fee":"20000000000000000"}' prepaid-gas '100.0 Tgas' \
  attached-deposit '0 NEAR' network-config testnet \
  sign-with-legacy-keychain send
```

See this: two contract accounts with code deployed.

Do this:

```bash
near contract call-function as-transaction "$OWNER" register_agent \
  json-args "{\"agent_id\":\"$AGENT\",\"budget\":50000000000000000,\"period_seconds\":3600,\"vendors\":[\"$VENDOR\"],\"max_single_spend\":20000000000000000,\"rate_limit\":5}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" \
  network-config testnet sign-with-legacy-keychain send
```

See this: `AgentRegistered <agent>` in the logs. The owner has set the policy.
The agent had no say in it.

Do this:

```bash
near account add-key "$AGENT" grant-function-call-access \
  --allowance 0.2near --contract-account-id "$OWNER" \
  --function-names request_spend \
  autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain \
  network-config testnet sign-with-legacy-keychain send
```

See this: a new public key. The key is scoped to one receiver and one method.
Save the key file path:

```bash
export KEY=~/.near-credentials/testnet/$AGENT/<public-key>.json
```

Do this:

```bash
near contract call-function as-transaction "$OWNER" request_spend \
  json-args "{\"agent_id\":\"$AGENT\",\"vendor\":\"$VENDOR\",\"amount\":20000000000000000,\"nonce\":1,\"memo\":\"reference lookup\"}" \
  prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" \
  network-config testnet sign-with-access-key-file "$KEY" send
```

See this: `SpendRequested <agent> <vendor> 20000000000000000`, a request id, and
status `Pending`. The restricted key worked and the request passed every hard
check.

Do this, with the same restricted key:

```bash
near contract call-function as-transaction "$OWNER" approve_request \
  json-args '{"request_id":0}' prepaid-gas '20.0 Tgas' \
  attached-deposit '0 NEAR' sign-as "$AGENT" \
  network-config testnet sign-with-access-key-file "$KEY" send
```

See this: `Error: Transaction method name <approve_request> isn't allowed by
the access key.` The agent cannot approve its own request.

Do this, with the same restricted key:

```bash
near contract call-function as-transaction "$VENDOR" call_paid_api \
  json-args '{"memo":"direct"}' prepaid-gas '20.0 Tgas' \
  attached-deposit '0 NEAR' sign-as "$AGENT" \
  network-config testnet sign-with-access-key-file "$KEY" send
```

See this: `Error: Transaction for <vendor> doesn't match the access key for
<owner>.` The agent cannot call the vendor directly.

Do this, with the same restricted key:

```bash
near contract call-function as-transaction "$OWNER" request_spend \
  json-args "{\"agent_id\":\"$AGENT\",\"vendor\":\"$VENDOR\",\"amount\":20000000000000000,\"nonce\":2,\"memo\":\"deposit attempt\"}" \
  prepaid-gas '20.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$AGENT" \
  network-config testnet sign-with-access-key-file "$KEY" send
```

See this: `Error: Having a deposit with a function call action is not allowed
with a function call access key.` The key cannot carry value at all.

Do this, with the same restricted key:

```bash
near contract call-function as-transaction "$OWNER" request_spend \
  json-args "{\"agent_id\":\"$AGENT\",\"vendor\":\"$VENDOR\",\"amount\":20000000000000000,\"nonce\":2,\"memo\":\"gas attempt\"}" \
  prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" \
  network-config testnet sign-with-access-key-file "$KEY" send
```

See this: `Error: Access Key <key> for account <agent> does not have enough
allowance ... to cover transaction cost ...` The allowance caps the gas the key
can spend, so a stolen key cannot even run an expensive call.

Do this, as the owner:

```bash
near contract call-function as-transaction "$OWNER" approve_request \
  json-args '{"request_id":0}' prepaid-gas '100.0 Tgas' \
  attached-deposit '0 NEAR' sign-as "$OWNER" \
  network-config testnet sign-with-legacy-keychain send
```

See this: `SpendApproved <agent> <vendor> <amount>` and a receipt with
`"approved": true`, the rule that passed, and the remaining budget. The vendor
balance increases by the requested amount.

Do this, with the restricted key, after the budget is nearly used:

```bash
near contract call-function as-transaction "$OWNER" request_spend \
  json-args "{\"agent_id\":\"$AGENT\",\"vendor\":\"$VENDOR\",\"amount\":20000000000000000,\"nonce\":3,\"memo\":\"over budget\"}" \
  prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" \
  network-config testnet sign-with-access-key-file "$KEY" send
```

See this: `SpendDenied <agent> <vendor> BudgetExceeded`, with evidence
`spent 40000000000000000 of 50000000000000000` and
`requested 20000000000000000`, and a receipt with `"executed": false`.

Do this, with the restricted key:

```bash
near contract call-function as-transaction "$OWNER" request_spend \
  json-args "{\"agent_id\":\"$AGENT\",\"vendor\":\"stranger.testnet\",\"amount\":1000000000000000,\"nonce\":4,\"memo\":\"stranger\"}" \
  prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" \
  network-config testnet sign-with-access-key-file "$KEY" send
```

See this: `SpendDenied <agent> stranger.testnet VendorNotAllowed`, with
evidence `allowed: <vendor>`.

## How the money is kept

The contract holds the treasury. `request_spend` runs the policy checks and, if
they pass, records a `Pending` request. `approve_request` re-runs the checks,
moves the money with a transfer to the vendor, and writes a receipt. The
restricted key cannot call `approve_request`, so the agent cannot complete a
payment on its own. The owner can approve, or the owner can set a runner that
approves small requests.

The policy engine is a separate Rust crate in `policy/` with no NEAR SDK
dependency. It is pure: policy and request in, decision out. The contract calls
it, and the paper harness in the sibling repository has a line by line port of
it, so the same rules can be tested against a model without a chain.

Denial reasons: `AgentRevoked`, `KillSwitch`, `InvalidAmount`, `NonceReplay`,
`CounterpartyBlocked`, `CounterpartyWarned`, `VendorNotAllowed`,
`SingleSpendExceeded`, `RateLimited`, `BudgetExceeded`.

## Repository layout

| Path | What it is |
| --- | --- |
| `contract/` | The Bound contract |
| `policy/` | Pure policy engine, no chain dependency, unit tested |
| `demo/vendor/` | The paid API stand-in used in the demo |
| `demo/protocol_arm.sh` | Script for the protocol rejection steps, all checks must print PASS |
| `web/` | SpendGuard console, a zero dependency static page that calls the RPC, no keys, no build step |

## Build and test

The policy engine is the only crate with unit tests. It has no cryptographic
dependencies and no NEAR SDK dependency, so it compiles and passes anywhere:

```bash
cd policy && cargo test
```

Build the contracts to NEAR's WebAssembly format:

```bash
cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path demo/vendor/Cargo.toml
```

The `bound` wasm is `contract/target/near/bound_contract.wasm`. There are no
contract-side unit tests to run; the policy engine is where the rules are
tested, and the contract is a thin shell around it. The NEAR SDK's host target
requires a C toolchain, so on minimal machines `cargo test` in `contract/`
cannot compile and that is expected.

## Limits

- Testnet only. The demo spends tiny amounts because the testnet accounts are
  faucet funded.
- Near Intents are out of scope. Intents have no testnet (NEAR HACKATHON.md
  Q-007), so a testnet demo cannot show them.
- The counterparty check in this version takes a blocklist and an explicit
  `blocked` flag. Richer signals (account age, code changes, prior
  interactions) are in the pure policy crate and the paper harness, but the
  demo does not wire a live indexer to them.
- `web/` is the SpendGuard console. It calls the public RPC and never signs a
  transaction. There is no browser wallet flow; the write path uses the NEAR
  CLI, as shown above. The counters on the page are derived from the chain,
  and every one of them can be reproduced with the curl commands in the
  Judge evidence section. To view the console:

  ```bash
  cd web && python3 -m http.server 8000
  # open http://localhost:8000
  ```

## Independence and disclosure

- This is one of two independent NEAR submissions by the same builder. The
  other project is `quorum`, a sealed bid group buying swarm at
  `https://github.com/unifyWeb3/near-quorum`. The two repositories share no
  code, no contract, and no package. They share a thesis and a builder.
- No code in this repository existed before 2026-11-01. The build window is
  2026-11-01 to 2026-11-14.
- The code was written with an AI coding agent (OpenCode). The policy design,
  the demo, and the tests were reviewed and run by the builder.
- The paper harness in `https://github.com/unifyWeb3/gemma4-agent-spend-cap`
  contains a JavaScript port of `policy/`. The port is Apache 2.0 and this
  repository is MIT. The Rust crate came first.

## Licence

MIT. See `LICENSE`.
