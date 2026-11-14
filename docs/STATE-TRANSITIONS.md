# Request state transitions

The contract records each request in one of the states below. A receipt is
written for a final money decision, not for an open request.

| From | Action | Caller | To | Receipt | Budget effect |
| --- | --- | --- | --- | --- | --- |
| none | `request_spend` passes every hard check | agent, for itself | `Pending` | none | unchanged |
| none | `request_spend` fails a hard check | agent, for itself | no request | `Denied` | unchanged |
| `Pending` | `flag_request` | owner or runner | `NeedsApproval` | none | unchanged |
| `Pending` | `approve_request` | owner or runner | `ApprovedPending` | none | amount reserved in the approval period and rate slot used |
| `Pending` | `reject_request` | owner or runner | `Denied` | `Denied` | unchanged |
| `Pending` | `expire_request` | owner or runner | `Expired` | `Expired` | unchanged |
| `NeedsApproval` | `owner_approve_request` | owner | `ApprovedPending` | none | amount reserved in the approval period and rate slot used |
| `NeedsApproval` | `owner_reject_request` | owner | `Denied` | `Denied` | unchanged |
| `NeedsApproval` | `expire_request` | owner | `Expired` | `Expired` | unchanged |
| `ApprovedPending` | transfer callback succeeds | contract | `Approved` | `Approved` | reservation becomes settled money |
| `ApprovedPending` | transfer callback fails | contract | `SettlementFailed` | `Failed` | reservation is released; the original rate window is refunded if it is still current |
| `ApprovedPending` | `reconcile_request(request_id, true)` | owner | `Approved` | `Approved` | reservation becomes settled money |
| `ApprovedPending` | `reconcile_request(request_id, false)` | owner | `SettlementFailed` | `Failed` | reservation is released; the original rate window is refunded if it is still current |

## Rules that apply to every transition

- The request must be open when a decision method starts.
- The agent may not approve its own request, not even when the agent is also
  the owner or the runner.
- An approval is refused at or after its exact expiry instant. The request
  becomes `Expired` and no money moves.
- An expired request is not open. The request views apply the expiry, so a
  request that nobody decided does not sit in the queue for ever.
- `Pending` can be decided by the owner or runner. `NeedsApproval` can be
  decided only by the owner.
- A policy denial at approval writes a `Denied` receipt and leaves the
  request decided.
- A missing policy at approval writes a `Denied` receipt with the missing
  policy as evidence. A missing policy at a rejection or an expiry closes the
  request the same way, with a receipt that names the missing policy.
- A missing policy at settlement cannot make a successful transfer fail. The
  receipt remains `Approved` and records the missing accounting evidence.
- A failed settlement reports zero settled money for the failed amount and
  reports any other reservation separately.
- A settlement callback is idempotent. A request that is no longer
  `ApprovedPending` is not settled again.
- An approval needs a nonce above the highest nonce the agent has had
  approved. A historical request whose nonce is below that watermark is
  refused with `NonceReplay` and has to be closed and asked again. The nonce
  discipline is the anti replay rule, and it holds for old requests too.
- A settlement callback does not wait for the migration. A transfer that was
  in flight when the upgrade landed settles with the historical rules, and
  the money is placed in the historical period.

## Migration precondition

A fresh contract writes the current schema marker during `new`. Historical
state has no marker and cannot process a request or approval until the owner
completes the bounded `migrate` operation. The operation is resumable and
must reach the verification phase before the schema marker is written.

The historical layout kept one flat spend figure and did not record the period
a reservation belonged to. The migration records the money of such a
transfer and leaves the period to the owner, who names it with
`reconcile_legacy_transfer`. The migration does not finish while a historical
record is unplaced, and it refuses a state that carries the older, incompatible
schema marker instead of decoding it with the wrong assumptions.
