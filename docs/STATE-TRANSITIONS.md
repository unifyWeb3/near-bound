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
- An approval is refused at or after its exact expiry instant. The request
  becomes `Expired` and no money moves.
- `Pending` can be decided by the owner or runner. `NeedsApproval` can be
  decided only by the owner.
- A policy denial at approval writes a `Denied` receipt and leaves the
  request decided.
- A missing policy at approval writes a `Denied` receipt with the missing
  policy as evidence.
- A missing policy at settlement cannot make a successful transfer fail. The
  receipt remains `Approved` and records the missing accounting evidence.
- A failed settlement reports zero settled money for the failed amount and
  reports any other reservation separately.
- A settlement callback is idempotent. A request that is no longer
  `ApprovedPending` is not settled again.

## Migration precondition

A fresh contract writes the current schema marker during `new`. Historical
state has no marker and cannot process a request or approval until the owner
completes the bounded `migrate` operation. The operation is resumable and
must reach the receipt phase before the schema marker is written.
