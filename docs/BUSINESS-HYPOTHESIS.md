# Business hypothesis

Date: 2026-11-13

This document records a hypothesis, not traction. It closes the audit gap where the entry named users but not a payer, price, or repeat event. No customer, revenue, price test, or market-size claim has been verified.

## Weakest part first

The weakest part of the product case is demand. The contract mechanics and evidence are real, but no buyer has agreed to pay. The next useful result is not another feature. It is one operator completing a paid pilot or rejecting the offer for a specific reason.

## User and trigger

HYPOTHESIS: the operator of a revenue-producing AI agent is the buyer.

The trigger is an agent receiving authority to spend on APIs, compute, data, or another service. The operator must set a ceiling, see exceptions, and prove what happened without trusting the agent or a private dashboard.

## Current alternatives

The buyer can use a platform wallet limit, ask a human to approve every payment, write a custom spending contract, keep the agent on prepaid credits, or do nothing until an incident makes the problem urgent.

These are substitutes with real costs. A custom contract has engineering and audit cost. Human approval has latency. Prepaid credits can leave unused value with the provider. Doing nothing accepts uncontrolled spend until it fails.

## Outcome that changes

The owner sets one policy. The agent asks. Certalyn admits, refuses, or routes the request. Every outcome leaves a public receipt. A failed transfer returns its reservation instead of consuming the budget.

## Payer, price, and frequency

- Buyer hypothesis: the operator who owns the agent and the budget.
- Price to test: USD 20 per active agent per month.
- Repeat event: monthly policy operation and receipt export.
- HYPOTHESIS: the operator pays because the cap limits downside and the receipts replace manual reconciliation.

The USD 20 figure is a test price, not a market fact. Test it with five operators. A pilot passes only if at least two use Certalyn for a second billing cycle without a manual spreadsheet replacing it.

## Non-goals

- No claim that Certalyn has customers or revenue.
- No consumer wallet, general banking, payroll, token launch, or trading product.
- No mainnet deployment while the contract remains testnet-only and unaudited.
- No paid API or hosted backend in the core product.

## Constraints

- Testnet only for this build.
- The contract must remain the source of truth for policy and decisions.
- The console must work without a private API key or backend.
- The remediation branch is not a live deployment until separately authorized.

## What would change the assessment

Stop or narrow the product if five qualified operators all prefer prepaid credits or platform-native limits, if none can name a payment they need controlled, or if receipt export is not part of their workflow. A claim that the policy prevents losses without measured incidents would also require stopping the impact claim.
