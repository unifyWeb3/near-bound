# SpendGuard: architecture, implementation, review and debugging

This document answers the four tasks requested for the NEAR Hackathon `security` submission (SpendGuard, `bound-testnet-97685.testnet`). It describes the system as it runs, the implementation in this repository, the review findings, the optimizations applied, the component library, and the debugging work for the wallet connection and the console layout.

Evidence in this document comes from tool runs in this session against the local console (`http://127.0.0.1:8098`) and the live chain state already recorded in `docs/claims.json` and the repository. The console reads the public NEAR testnet RPC; no secret and no mainnet transaction was used.

## Task 1: Senior systems architect

### Architecture

SpendGuard is a static, client side console over a NEAR smart contract. The chain is the database and the policy engine. The browser reads the chain through the public JSON-RPC endpoint and writes by asking the reader's NEAR wallet to sign a transaction. There is no application server, no session store, and no backend secret.

```
+------------------+        read (view calls)        +----------------------+
|  Browser console | ------------------------------> | NEAR testnet RPC     |
|  (static files)  | <------------------------------ | (public, no key)     |
+------------------+        JSON-RPC results         +----------+-----------+
        |                                                         |
        | sign (function call)                                    | view/call
        v                                                         v
+------------------+        signed tx / broadcast    +----------------------+
| NEAR wallet      | ------------------------------> | Bound contract       |
| (user's choice,  |                                 | bound-testnet-97685  |
|  via selector)   |                                 | policy, requests,    |
+------------------+                                 | receipts, treasury   |
                                                     +----------+-----------+
                                                                |
                                                                | transfer on approve
                                                                v
                                                     +----------------------+
                                                     | Counterparty account |
                                                     +----------------------+
```

Scalability characteristics (within the constraints of a static, testnet only product):
- Read scaling is bounded by RPC capacity and by client side paging/caching, not by a server the project runs. The console reads the full receipt set once and caches it in `localStorage`, so later visits read only missing ids.
- Write scaling is bounded by chain throughput and by the owner deciding requests. Each decision is one signed transaction.
- The static console scales horizontally by CDN replication (Vercel serves the files); there is no stateful process to scale.
- The contract is the scaling bottleneck for large ledgers: receipts and requests are stored per agent without a paged on-chain index. The console works around this by caching and by paging the display. A production evolution adds paged view methods and per-agent receipt indices (noted in review).

### Component structure

```
web/
  index.html                 routed shell, semantic landmarks, views
  style.css                  design tokens, layout, components, responsive, a11y
  app.js                     shell: store wiring, router, refresh, wallet actions
  vendor/
    hot-connect.iife.js      @hot-labs/near-connect 0.12.0 (MIT), wallet selector
  lib/
    dom.js                   element helpers (no innerHTML with data)
    format.js                NEAR amounts, counts, timestamps
    store.js                 tiny observable store
    router.js                hash router, active nav, view visibility
    deployment.js            deployment resolution (URL > storage > demo), receipt cache
    api.js                   JSON-RPC reads, big-integer parsing, ledger assembly
    wallet.js                wallet selector, connect/sign, Borsh args, tx broadcast
  components/
    modal.js                 accessible dialog (focus trap, Escape, restore focus)
    wallet-picker.js         wallet list from manifest, picker UI, connect flow
    button.js                button with busy/disabled/aria-busy
    badge.js                 outcome and request-state badges
    stat.js                  metric card
    field.js                 labelled input with hint and commit handling
    empty.js                 empty state and skeleton placeholders
    alert.js                 alert and page error bar
    copy.js                  copy-to-clipboard button with feedback
  views/
    overview.js              hero, stats, charts, recent decisions, protocol refusals
    ledger.js                filters, paged ledger list
    receipt.js               receipt and request detail, share link
    receipt-card.js          decision card used across views
    policy.js                policy table and kill switch state
    requests.js              pending requests with approve/refuse actions
    enable.js                editable account names and generated enable steps/curls
    judge.js                 generated judge-evidence curls
```

### Data flow

1. **Boot:** `app.js` resolves the deployment from the URL or storage, creates the store and receipt cache, wires routes and buttons, starts the router, and calls `refresh()`.
2. **Read:** `refresh()` runs `getPolicy`, `getTreasuryBalance`, `getKillSwitch`, `getLedger`, `getRequests` in parallel via `lib/api.js`. Each view call posts a JSON-RPC `query` with `finality: "final"` to the public RPC. `parseBigJson` preserves u128 values as strings.
3. **Ledger assembly:** `getLedger` fetches `get_receipt_count`, computes missing ids against the cache, reads missing receipts in batches, stores them, and returns the agent's receipts sorted newest first. Counts and totals are computed over the full set; the view pages the display.
4. **Render:** the store update triggers `paint()`. Views are pure renderers over state: they build DOM nodes with `lib/dom.js` helpers and `mount()` (no `innerHTML` with chain or user data). The router shows one view at a time and marks the active nav link.
5. **Write:** the owner clicks Connect wallet, picks a wallet in the modal (list from the selector manifest), and the selector's sandboxed executor signs in. Approve/refuse calls `signAndSend` in `lib/wallet.js`, which Borsh-encodes the method arguments, asks the connected wallet to `signAndSendTransaction`, then `refresh()` reads the resulting on-chain state.
6. **Deep links:** the route and the deployment live in the URL (`?contract=&agent=#/receipt/18`), so a decision link opens the same page anywhere.

### API design

The console talks to two external interfaces.

**NEAR JSON-RPC (read), public testnet:**
- Endpoint: `https://test.rpc.fastnear.com`
- Method: `query` with `request_type: "call_function"`
- Encoding: `args_base64` is base64(JSON(args)); result is decoded from UTF-8 bytes and parsed with big-integer preservation.
- Finality: `final` (matches the reproducible curls).

**Bound contract view methods:**

| Method | Args | Returns | Used by |
| --- | --- | --- | --- |
| `get_policy` | `{agent_id}` | policy (budget, spent, remaining, caps, vendors, nonce, flags) | overview, policy, enable |
| `get_receipt_count` | `{}` | number | ledger, judge |
| `get_receipt` | `{receipt_id}` | receipt (outcome, reason, rule, evidence, amounts, memo, ts) | ledger, receipt detail, judge |
| `get_request_ids` | `{agent_id}` | number[] | requests |
| `get_request` | `{request_id}` | request (status, vendor, amount, memo, receipt link) | requests, request detail |
| `treasury_balance` | `{}` | yoctoNEAR string/number | overview |
| `get_kill_switch` | `{}` | bool | overview, policy |

**Bound contract change methods (owner wallet):**

| Method | Args | Effect |
| --- | --- | --- |
| `approve_request` | `[request_id: u32]` | approves a pending request, transfers to counterparty, settles receipt |
| `reject_request` | `[request_id: u32, reason: string]` | refuses a pending request with a reason |

Arguments are Borsh-encoded in the client for the wallet call (`lib/wallet.js:encodeArgs`) to match the contract's parameter types.

### Database schema

There is no off-chain database. The contract storage is the schema:

| Entity | Key | Fields (selected) | Notes |
| --- | --- | --- | --- |
| Policy | `agent_id` | `agent_id, budget, spent, period_seconds, period_start, vendors[], max_single_spend, rate_limit, last_nonce, request_count, revoked, owner` | one per registered agent |
| Request | `request_id` (u32, global) | `request_id, agent_id, vendor, amount, nonce, memo, status, created_at, receipt_id?` | status: Pending/NeedsApproval/ApprovedPending/Approved/SettlementFailed/Denied |
| Receipt | `receipt_id` (u32, global) | `receipt_id, request_id, agent_id, vendor, amount, outcome, reason, rule, evidence[], spent_after, created_at, memo` | immutable decision record; written on deny or on settlement |
| Treasury | contract account balance | native NEAR balance | read via `treasury_balance` |
| Config | singleton | `kill_switch`, owner | global freeze |

Client-side cache schema (`localStorage`, key `spendguard.receipts`): `{ deployment: "<contract>/<agent>", receipts: { "<id>": <receipt> } }`. The deployment selection is stored separately as `spendguard.deployment`.

### Caching strategy

| Layer | Strategy | Invalidation |
| --- | --- | --- |
| Receipt cache (browser) | Persistent map of receipt id to receipt per deployment. `getLedger` reads only ids missing from the cache. | New ids appear as `receipt_count` grows; a deployment/agent change loads a different cache key. The page can always re-read from chain. |
| Deployment selection | `localStorage` plus the URL query string. URL wins, so links are authoritative. | Overwritten on explicit change. |
| In-memory store | Single session store; views render from it. | Replaced on each `refresh()`. |
| RPC/manifest fetch | No service worker cache. The wallet manifest is fetched `cache: "no-cache"` for freshness; selector script is a static local file. | Browser HTTP cache for static assets; chain reads are always live. |
| Stale-while-error | If a refresh fails after a successful read, the last state stays visible with a stale warning. | Cleared on the next successful refresh. |

### Implementation code (minimal production version)

The implementation is the `web/` tree listed above (26 JS modules plus the vendored selector). Key production properties: no `innerHTML` with untrusted data, `finality: "final"` reads, Borsh-encoded write arguments, batched receipt reads, persistent receipt cache, accessible modal with focus management, keyboard-navigable controls, responsive layout, loading/skeleton/error states, and deep-linkable routes. The wallet connection uses `@hot-labs/near-connect` (MIT, vendored) so the reader chooses among the wallets in their browser rather than being redirected to a single wallet site.

## Task 2: Four collaborating agents

### Architect

- Designed the static-console-over-contract architecture: chain as source of truth, public RPC reads, wallet-signed writes, no backend.
- Defined the module boundaries (`lib` for I/O and state, `components` for reusable UI, `views` for route renderers, `app` as shell) so data flow is one way: read -> store -> render, action -> sign -> refresh.
- Specified the caching model (persistent receipt cache, URL-as-deployment, stale-on-error) and the deep-link contract.
- Identified the contract-side scaling limit (no paged/indexed receipt reads) and the client-side workaround.

### Engineer

- Implemented the module structure and replaced the monolithic console with `lib/`, `components/`, `views/`, and a vendored wallet selector.
- Built the wallet layer: manifest-driven picker modal, `@hot-labs/near-connect` integration, Borsh argument encoding, and `signAndSendTransaction` for owner actions.
- Implemented batched, cached ledger reads with big-integer preservation and `finality: "final"`.
- Added routes, filters, receipt/request deep links, generated enable steps and judge curls, and the deployment switcher.
- Added CSS for the modal, wallet grid, alerts, skeletons, responsive breakpoints, focus states, and reduced-motion handling.

### Reviewer

Findings (quality control):

| Severity | Finding | Status |
| --- | --- | --- |
| Fixed (this session) | Wallet connect redirected to a single wallet URL and did not prompt the reader to choose among wallets installed/available in the browser. | Fixed: manifest-driven picker using the NEAR wallet selector, same manifest source as the Porti reference. |
| Fixed (this session) | Console was a single undifferentiated page with weak hierarchy and mixed concerns; routes and components were not separated. | Fixed: routed views, split layout, componentized rendering, consistent nav and section structure. |
| Fixed (this session) | Ledger read every receipt on every refresh and computed stats from a partial page in an intermediate state. | Fixed: persistent receipt cache, full-set counts, display paging separate from reads. |
| Fixed (this session) | Judge curls embedded shell substitution inside single quotes and did not run as printed. | Fixed: curls generated with base64 args in code. |
| Fixed (this session) | `file://` open and optimistic/final mismatch in reads. | Fixed: README documents serving; reads use `final`. |
| Known (contract, frozen for submission) | No paged `get_receipts`, no per-agent receipt index, unbounded per-agent vectors, callback scans request history, nonce taken at request time, no request expiry, no `migrate`. A gas-heavy callback can leave a request approved-pending with budget reserved and no receipt. | Open risk. Requires contract change, redeploy, new code hash, new claims/tag/film; not changed here. |
| Known (product claim) | Contract performs a plain NEAR transfer to the counterparty; it does not call a metered service, so a receipt does not prove service delivery. | Documented plainly in README/console (no paid-API claim). |
| Known (wallet UX) | Some wallets complete signing in an external context; the selector sandbox handles each wallet's flow, but end-to-end signing cannot be fully automated in this headless environment. The picker, manifest load, and connect attempt are verified. | Verified to the limit of the environment. |

### Optimizer

Performance and robustness improvements applied:

- **Receipt cache:** reads only missing receipt ids after the first load; `getLedger` batches RPC calls (`READ_BATCH = 6`) instead of issuing unbounded parallel reads.
- **Display paging:** the ledger renders `PAGE_SIZE` rows and reveals more from memory; the "show more" action no longer re-fetches the chain.
- **Single connector lifecycle:** `lib/wallet.js` now caches the `NearConnector` instance (`getConnector` memoized) so repeated actions do not rebuild the connector or re-trigger avoidable setup.
- **Stable rendering:** route visibility is computed once per navigation to avoid hiding a view that shares an element id; lists render through `mount()`/`replaceChildren()`.
- **Resilience:** RPC calls have a timeout and retry; a failed refresh preserves the last good state and marks it stale; unreadable requests are skipped rather than breaking the view.
- **CSS/UX:** reduced-motion guard for skeleton animation, focus-visible outlines, responsive grid collapse, and modal sizing for small screens.

### Final optimized version

The final version is the refactored `web/` console: modular read/write layers, cached and batched reads, a real multi-wallet picker, deep-linked routed views, generated reproducible evidence commands, accessible components, and honest product copy. Contract and chain state were not modified. The `submission-v1` tag and the payload identity fields remain builder actions (not taken here).

## Task 3: Senior frontend engineer

### Component architecture

- **Primitives (`lib/dom.js`, `components/`):** small, stateless builders that return DOM nodes and attach behavior. They do not fetch and do not own global state.
- **Views (`views/`):** renderers that take `(state, callbacks)` and mount into known containers. They compose primitives and components.
- **Shell (`app.js`):** owns the store, the router, data loading, and action handlers; passes state down.
- **Styling:** token-based (`:root` variables), BEM-like class names by role, no utility framework dependency, responsive and reduced-motion aware.

### Props design

| Component | Props | Notes |
| --- | --- | --- |
| `el(tag, className, text, attrs)` | tag, optional class/text/attrs | text is `textContent`; a Node child is appended, never injected as HTML |
| `button({label, variant, busy, busyLabel, onClick, type, disabled})` | visual/behavior options | sets `aria-busy` and disables while busy |
| `badge(text, tone)` / `outcomeLabel`, `stateLabel`, `stateWords` | outcome/status | maps domain states to tones and labels |
| `stat({label, value, note})` | metric triple | used for dashboard figures |
| `field({label, value, hint, placeholder, onChange, onCommit})` | input config | associates label/hint, exposes wrapper |
| `openModal({title, description, render, onClose, closeLabel})` | dialog content | returns `{close, body, setStatus}`; manages focus/Escape/Tab |
| `openWalletPicker({onConnected, network})` | connect callback | loads manifest, renders wallet grid, reports status |
| `copyButton(command, label)` | text to copy | async clipboard with fallback text and timed reset |
| `emptyState(message)` / `skeletons(count)` | placeholders | skeletons set `aria-busy` and hidden-from-AT decoration |
| `alert(message, tone)` / `setErrorBar(message)` | feedback | error bar uses `role=alert` semantics |
| `receiptCard({receipt, link, open})` | receipt + display opts | deep link to receipt/request, expandable evidence |

### Implementation

Implemented in `web/components/*.js`, `web/views/*.js`, `web/lib/dom.js`, and `web/style.css` (see component structure above). All dynamic text is assigned via `textContent`/DOM construction. Interactive elements are native `button`, `a`, `input`, and `details/summary` controls.

### Usage examples

```js
import { stat } from './components/stat.js';
import { openWalletPicker } from './components/wallet-picker.js';
import { receiptCard } from './views/receipt-card.js';
import { copyButton } from './components/copy.js';

// A metric card
document.getElementById('stats-grid').append(
  stat({ label: 'Approved', value: '8', note: 'reads on chain' }),
);

// The wallet picker (prompts the reader to choose a wallet)
openWalletPicker({
  onConnected: ({ accountId }) => console.log('connected', accountId),
});

// A receipt card with a deep link
document.getElementById('ledger-list').append(
  receiptCard({ receipt, link: true, open: false }),
);

// A copy button for a generated curl
panel.append(copyButton(curl, 'Copy curl'));
```

### Loading states, edge cases, responsive design, accessibility

- **Loading:** the refresh button shows `Reading...` and disables during fetch; the loaded stamp reports the read; skeleton styles and `aria-busy` placeholders are provided for pending regions.
- **Edge cases:** RPC timeout/retry, stale-on-error (last good data kept), missing/unreadable receipts skipped, empty ledger/requests/messages, unknown route falls back to overview, invalid deployment account ids rejected, clipboard failure falls back to a visible message, wallet list/connection failure reported in the modal status, u128 values preserved through `parseBigJson`.
- **Responsive:** grids collapse (`auto-fit`/media queries), the top bar wraps, the hero stacks, charts and panels go single-column under 960px, the modal becomes a bottom sheet on small screens, touch targets remain usable.
- **Accessibility:** skip link, landmarks (`header/nav/main/footer`), labelled controls, `aria-current` on active nav, `aria-live` for the feed and status regions, `role="alert"` for errors, dialog with `aria-modal`/`aria-labelledby`, focus trap and Escape to close, focus restored on close, focus-visible outlines, `details/summary` for expandable evidence, sufficient contrast via the token palette, and `prefers-reduced-motion` disabling shimmer/transition motion.

## Task 4: Senior debugging engineer

### Investigation: wallet connection did not prompt for other wallets

**Code functionality (expected):** clicking Connect wallet should let the reader choose among the NEAR wallets available to them (browser extensions, mobile, web wallets) and sign in with the chosen one, similar to the Porti reference (`https://porti-near.hoymick240.workers.dev/`).

**Observed problem:** the console redirected the browser to `https://wallet.testnet.near.org/login` (a single wallet site) instead of presenting a wallet chooser. There was no manifest, no selector, and no list of other wallets.

**Root cause (step by step):**
1. `web/wallet.js` (pre-refactor) hardcoded `const WALLET = 'https://wallet.testnet.near.org'` and implemented `connectWallet()` as `window.location.href = ${WALLET}/login?...` (a full navigation redirect).
2. `app.js`'s wallet button called that redirect directly. No wallet discovery ran and no in-page UI existed to choose a provider.
3. The first selector-based fix was still incomplete: it rendered every wallet in the manifest, including mainnet only or network undeclared wallets. On a testnet console, clicking one opened it and then failed with messages such as "HOT Wallet not supported on testnet". Verified in browser after the first fix.
4. The Porti reference uses the wallet selector and, critically, the selector itself filters wallets by network: in `src/NearConnector.ts`, `selectWallet` returns false for a wallet on testnet when `manifest.features.testnet` is not true. The picker must apply the same rule.

**Why it fails:** a single hardcoded redirect cannot enumerate or invoke other installed wallets; it only hands control to one web wallet. A reader with Meteor, HOT, Nightly, or a hardware wallet never receives a choice.

**Edge cases considered:** manifest fetch failure or offline (fall back to opening the NEAR wallet site with a clear message), a wallet that rejects or errors during connect (surface the error in the modal, keep the picker open), no account returned, popup/redirect wallets that navigate away, repeated connect attempts (connector instance cached), and environments where external wallet flows cannot complete (the picker and connect attempt are still exercised).

**Fix (production-ready):**
- Vendored `@hot-labs/near-connect` 0.12.0 (MIT, `web/vendor/hot-connect.iife.js`) and implemented `lib/wallet.js` to load the selector, fetch the wallet manifest, and connect via `NearConnector({ network: 'testnet', manifest: MANIFEST_URL })`. The connector instance is cached.
- Applied the selector's own network rule in `listWallets(network)`: on testnet only wallets with `features.testnet === true` are offered as available; mainnet only or undeclared wallets are shown disabled in a "Not usable on testnet" section instead of failing on click. The verified available testnet list is Meteor Wallet, Intear Wallet, Ledger, Nightly Wallet, Wallet Connect, Unity Wallet and Ethereum Wallets; HOT, MyNearWallet, OKX, NEAR Mobile, Trezu and Hana are disabled.
- Implemented `components/wallet-picker.js` as an accessible modal that lists available and unavailable wallets with icons/names/descriptions, reports progress/errors, keeps the picker usable on failure, and falls back to the NEAR wallet site if the manifest cannot be loaded.
- Wired the Connect wallet button to open the picker; on success the account is shown and owner actions (`approve_request`, `reject_request`) sign through the connected wallet via `signAndSendTransaction` with Borsh-encoded args.

**Verification after the network filter:** Playwright against the local console rendered the filtered picker with 7 available wallets and 6 disabled ones. Clicking Meteor opened Meteor's own connect surface inside the picker (Meteor Web / mobile QR "Code expires in 4:58"), as shown in `/home/unify/.audit-work/wallet_connected_test.png`, and the modal stayed open waiting for the reader's wallet action instead of erroring. Actual completion of the sign in requires the reader to use their own wallet in their browser.

**Verification (evidence):** a Playwright run against the local console (`http://127.0.0.1:8098`) clicked `#wallet-button`, loaded the manifest, and rendered the picker:

```json
{
 "hasPanel": true,
 "title": "Connect a NEAR wallet",
 "count": 13,
 "options": [
  "HOT Wallet ...", "Meteor Wallet ...", "Intear Wallet ...", "Ledger ...",
  "MyNearWallet ...", "OKX Wallet ...", "NEAR Mobile ...", "Trezu Wallet ..."
 ],
 "status": "13 wallets. The list comes from the NEAR wallet selector."
}
```

Observed requests included `manifest.json` and per-wallet icon assets, confirming multi-wallet discovery. The console overview rendered without JS errors and read live chain data (30 receipts, correct totals) across all routes.

### Investigation: disoriented UI

**Problem:** the console presented marketing copy, live figures, the feed, setup steps and evidence as one long, weakly separated page with inconsistent grouping, making it hard to scan compared with the Porti reference's clear sections and navigation.

**Root cause:** a monolithic template and render path mixed concerns in one view, with limited structural hierarchy and no route-level separation.

**Fix:** split the console into routed views (Overview, Policy, Requests, Ledger, Receipt, Enable, Judge), added a persistent top bar with active-route indication, grouped content into panels/cards with consistent spacing and stats grids, separated the hero from live metrics from the feed/charts, and added responsive and focus styles. The result is a navigable, sectioned console rather than a single undifferentiated scroll.

### Reproduction and test notes

- Serve locally: `cd web && python3 -m http.server 8000` (module scripts require HTTP, not `file://`).
- The contract tests remain `cd policy && cargo test --locked` and `cd contract && cargo test --locked` (unchanged; contract not modified).
- Wallet end-to-end signing depends on the reader's chosen wallet and browser context; the picker and connect flow are verified in-browser against the live manifest.
