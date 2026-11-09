# Bound

Bound is a NEAR contract that holds money for a paid AI agent and releases it only after an owner decides.

## The problem

An agent that buys API calls needs a credential with money behind it. An API key in an environment variable has no ceiling. A prompt instruction sits next to a poisoned README and loses. Bound removes the credential from the agent entirely. The agent can ask to spend. It cannot set the policy, cannot move value, and cannot keep the secret.

## What runs where

- `contract/`: the policy contract. Deployed at `bound-testnet-97685.testnet`.
- `policy/`: the rules engine, no chain dependency, unit tested.
- `demo/vendor/`: a paid API stand in used to prove the flow end to end.
- `web/`: the SpendGuard console, a static page that reads the public testnet RPC. No backend, no database, no build step.
- `video/`: the build for the 90 second demo film.

A registered owner sets the budget, the allowed receivers, the per-spend cap, and the rate limit. The agent holds one restricted function-call key that can call `request_spend` on the contract and nothing else. The agent asks. The owner decides. Exactly one rule evaluated before money can move.

## What is on chain

Testnet, permanent public evidence:

- Contract: `bound-testnet-97685.testnet`
- Vendor: `bound-vendor.testnet`
- Agent: `bound-agent.testnet`
- Denials and grants both leave receipts. Every decision, approved or refused, is a readable record.

Try the policy and the receipts from the command line:

```bash
near contract call-function as-read-only bound-testnet-97685.testnet \
  get_receipt_count json-args '{}' network-config testnet now

near contract call-function as-read-only bound-testnet-97685.testnet \
  get_receipt json-args '{"receipt_id":10}' network-config testnet now
```

Every number in the console can be checked with the same commands printed in the console's judge evidence panel.

## Try it

You need Rust and NEAR credentials set up with `near-cli-rs`. Then:

```bash
git clone https://github.com/unifyWeb3/near-bound.git
cd near-bound
cd policy && cargo test
```

The output shows all denial paths exercised, including vendors missing from the allowlist, over-budget requests, single-spend caps, rate limit exhaustion, and a revoked agent.

## What it does not do

- Testnet only. No real money moves.
- The counterparty signals in this version are policy inputs, not live risk feeds.
- No browser wallet. The write path is the NEAR CLI by design; the web console is read-only.

## Independence and disclosure

This is one of two independent NEAR submissions by the same builder. The other project is `keyhalt`, at `https://github.com/unifyWeb3/keyhalt`. They share a thesis and no code. The two repositories name each other in their READMEs and nowhere else in their content.

## Licence

MIT. See `LICENSE`.
