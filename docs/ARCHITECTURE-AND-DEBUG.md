# Certalyn architecture and debugging

Certalyn is a static browser console over a NEAR contract. The chain stores
the policy, requests, reservations and receipts. The browser reads through
the public testnet RPC and asks the reader's own wallet to sign writes. There
is no application server, account, session store or backend secret.

## Artifact boundary

This repository contains two artifacts that must not be conflated:

| Artifact | State |
| --- | --- |
| Historical deployment at `bound-testnet-97685.testnet` | Live on testnet, with the code hash and Wasm sha256 in `docs/claims.json` |
| Remediated source on `fix/audit-remediation` | Local and tested, not deployed, with its reproducible Wasm hash in `docs/wasm-lock.json` |

The remediated Wasm is not the historical Wasm. No redeployment, push,
submission or public post is authorized by this work.

## System shape

```text
+------------------+        read (view calls)        +----------------------+
|  Browser console | ------------------------------> | NEAR testnet RPC     |
|  static files    | <------------------------------ | public, no key       |
+------------------+        JSON-RPC results         +----------+-----------+
        |                                                         |
        | sign (function call)                                    | view/call
        v                                                         v
+------------------+        signed tx / broadcast    +----------------------+
| Reader's wallet | ------------------------------> | Bound contract       |
| user selected   |                                 | policy, requests,    |
+------------------+                                 | receipts, treasury   |
                                                      +----------+-----------+
                                                                 |
                                                                 | plain NEAR transfer
                                                                 v
                                                      +----------------------+
                                                      | Counterparty account |
                                                      +----------------------+
```

The counterparty transfer is a native NEAR transfer. A receipt proves that
the contract decided and that the transfer settled. It does not prove that a
metered service was delivered.

## Contract storage model

The historical state root is frozen. `Bound`, `Policy`, `Request` and
`Receipt` keep their field order and types, and existing enum variants keep
their Borsh discriminants. New enum variants are appended only.

New accounting facts therefore live in raw-storage sidecars. Their keys carry
a version and their values use Borsh.

| Sidecar | Purpose |
| --- | --- |
| `certalyn_nonce_v1:<agent>` | Highest accepted nonce and highest approved nonce, tracked separately |
| `certalyn_period_v1:<agent>:<period>` | Settled money and reserved money for one budget period |
| `certalyn_request_meta_v2:<request>` | Expiry, reservation period and approval rate-window start |
| `certalyn_receipt_index_v2` and receipt slots | Global retained-receipt index |
| `certalyn_agent_receipt_index_v2:<agent>` and slots | Per-agent receipt index |
| `certalyn_schema_v2` | Completion marker for the current sidecar schema |
| `certalyn_migration_v1` | Bounded migration stage and cursor |

The compatibility fields in `Policy` mirror the sidecar totals. They are not a
second accounting source.

### Bounded indexes and retention

The contract keeps the newest 256 request ids for each agent. Receipt pages
read through slot indexes instead of scanning every retained receipt. The
contract retains at most 10,000 receipts. A new receipt removes the oldest
one, and its global and per-agent index entries advance together.

Receipts are not a permanent archive. The historical deployment still has its
recorded receipts, but a remediated deployment would prune receipts older
than the retention window.

### Migration

A fresh `new` call writes the current schema marker. Historical state has no
marker and cannot process a request or approval until the owner completes
`migrate`.

The migration is owner-only, resumable and bounded to 100 historical ids per
call. It has separate request and receipt phases. The request phase rebuilds
nonce watermarks, request metadata and the bounded request index. The receipt
phase builds the global and per-agent indexes while enforcing the 10,000
receipt limit. The current marker is written only after both phases finish.

## Decision lifecycle

The full transition table is in [STATE-TRANSITIONS.md](STATE-TRANSITIONS.md).
The important boundaries are:

- The owner or runner may decide a `Pending` request.
- Only the owner may decide a `NeedsApproval` request.
- An approval reserves the amount in the current budget period.
- A successful transfer moves reserved money to settled money.
- A failed transfer releases the reservation and refunds the rate slot only
  in the rate window that reserved it.
- Settlement receipts report settled money and reserved money separately.
- A missing policy cannot make a successful transfer fail. The receipt records
  the missing accounting evidence instead.

## Accounting and policy checks

The `bound-policy` crate is a pure function. The contract and policy tests
use the same rule order:

1. revoked agent
2. invalid amount
3. nonce replay
4. blocked receiver
5. receiver outside the allowlist
6. single-spend cap
7. rate limit
8. period budget
9. kill switch

Budget arithmetic uses checked addition in the policy crate. The contract's
totals use saturating operations at explicit accounting boundaries. Memo,
reason, vendor, budget and page sizes have fixed bounds.

The policy period and the rate window are different clocks. A settlement after
either boundary does not corrupt the newer period, and an old rate-window
failure cannot remove a newer window's slot.

## Console read path

The console resolves the selected contract and agent from the URL or local
storage. It then reads the policy, treasury, kill switch, receipt page and
open-request page in parallel.

- View arguments are JSON objects encoded as base64 for `call_function`.
- Large integer values remain strings through the JSON parser.
- Reads use finality `final`.
- The remediated contract's paged receipt views are feature-detected. The
  historical deployment falls back to reading known receipt ids.
- A request page larger than the browser cap reports `complete: false` and
  keeps the available open count. The UI does not present a truncated queue
  as complete.
- Receipt and request deep links work for request id zero.
- A failed refresh keeps the last good state and marks it stale.

The browser cache is scoped to the selected contract and agent. It drops
cached receipt ids that the selected chain can no longer have.

## Console write path

The browser sends JSON argument objects, not positional Borsh arrays. It
selects a status-specific method:

- `Pending` can be approved or refused by the owner or runner.
- `NeedsApproval` uses `owner_approve_request` or `owner_reject_request`.
- Expiry and manual reconciliation remain owner operations exposed by the
  contract, although the current browser action surface is limited to approve
  and refuse.

The reader chooses a wallet through the vendored NEAR selector. The console
never holds a private key. It signs the exact JSON bytes and asks the wallet
to broadcast the transaction.

## Build and operational checks

The repository pins Rust 1.99.1 and Binaryen 133. `scripts/build-wasm.sh`
requires an absolute `CARGO_HOME`, owns the canonical `RUSTFLAGS`, verifies
the Binaryen archive and optimizer checksums, builds twice in separate target
directories and compares the artifact bytes.

CI uses immutable action commit SHAs, a checksum-verified ShellCheck release,
locked Rust and npm dependencies, a fail-closed cargo-audit gate, fake-NEAR
shell tests, Node tests, contract and policy tests, formatting, Clippy, and
the reproducible Wasm hash check.

The dependency gate fails closed if cargo-audit cannot be installed, the
RustSec advisory database cannot be fetched, or a known vulnerability is
reported. The claims check reads the historical testnet deployment and uses
public network access, but no keys or spending.

## Historical debugging record

The historical console work addressed three concrete problems:

1. A single hardcoded wallet redirect prevented readers from choosing among
   installed testnet wallets. The current console vendors the NEAR selector,
   filters the wallet manifest by testnet support and keeps the picker inside
   an accessible modal.
2. A monolithic page mixed setup, evidence and live figures. The current
   console uses routed views, semantic landmarks, responsive layouts, visible
   loading and error states, and keyboard-accessible controls.
3. The historical contract had no per-agent receipt index, request expiry or
   migration path. The remediated source adds those capabilities without
   changing the frozen state root. This source is not deployed.

The recorded wallet and UI checks are local evidence from the historical
session. A human still has to complete wallet authentication and confirm the
current public post or video before any external submission.

## Known limits

- Testnet only. No mainnet deployment and no real money.
- The product has not received an external audit.
- The historical deployment and the remediated source expose different method
  sets until an authorized redeployment.
- The counterparty signals are owner-set policy inputs, not a live risk feed.
- Receipt retention is bounded at 10,000 in the remediated source.
