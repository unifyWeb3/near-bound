# Console components

The Certalyn console is built from small DOM components with no framework. Text is always assigned as text, never injected as HTML from chain or user data.

## Primitives (`lib/dom.js`)

- `el(tag, className?, text?, attrs?) -> HTMLElement` creates an element. A string `text` becomes `textContent`; a Node is appended.
- `mount(node, ...children)` replaces children. `clear(node)` empties a node. `$ (id)` looks up by id.
- `focusables(node)` returns the focusable descendants (used by the modal).

## Components (`components/`)

### `button({ label, variant?, busy?, busyLabel?, onClick?, type?, disabled? })`
Returns a `<button>`. Sets `aria-busy` and disables while busy. `variant` is `primary`, `ghost`, or omitted.

### `stat({ label, value, note? })`
A metric card (`.stat`) with a label, a value and an optional note.

### `badge(text, tone)` and state helpers (`badge.js`)
`badge` renders a `.pill`. `outcomeLabel(outcome)` maps `Approved|Denied|Failed|Expired` to tones; `stateLabel`/`stateWords` map request states (`Pending`, `NeedsApproval`, `ApprovedPending`, `Approved`, `SettlementFailed`, `Denied`, `Expired`) to tones and human labels.

### `field({ label, value, hint?, placeholder?, onChange?, onCommit? })`
A labelled text input. Associates `<label>` and an optional hint via `aria-describedby`. `onChange` fires per keystroke, `onCommit` on change. Returns the `<input>` with a `.wrapper` property.

### `copyButton(command, label?)`
Copies `command` to the clipboard and shows `Copied` / a fallback message for 1.4s.

### `emptyState(message)` and `skeletons(count?)`
`emptyState` renders a muted paragraph. `skeletons` renders shimmering placeholders with `aria-busy="true"` and `aria-label="Reading the chain"` (animation disabled under `prefers-reduced-motion`).

### `alert(message, tone?)` and `setErrorBar(message|null)`
`alert` renders `role="alert"` (error) or `role="status"` (warning). `setErrorBar` toggles the page-level `#error-bar`.

### `openModal({ title, description?, render?, onClose?, closeLabel? })`
An accessible dialog: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`. Traps Tab focus, closes on Escape or backdrop click, restores focus on close. Returns `{ close(), body, setStatus(text) }`.

```js
import { openModal } from './components/modal.js';
const modal = openModal({
  title: 'Example',
  description: 'A short description.',
  render: (body) => { body.textContent = 'Hello'; },
});
modal.setStatus('Ready');
```

### `openWalletPicker({ onConnected, network? })`
Opens a modal listing NEAR wallets from the selector manifest. On testnet it applies the selector's own filter (`features.testnet === true`), offers only usable wallets, and shows unsupported wallets disabled in a "Not usable on testnet" section. Selecting a wallet calls the connector and invokes `onConnected({ accountId, walletId, error })`; the wallet's own connect UI (for example Meteor Web or a mobile QR) opens inside the modal and the reader completes the connection there. On manifest failure it offers the NEAR wallet site fallback.

```js
import { openWalletPicker } from './components/wallet-picker.js';
openWalletPicker({
  network: 'testnet',
  onConnected: ({ accountId }) => console.log('connected', accountId),
});
```

## View components (`views/`)

- `receiptCard({ receipt, link?, open? })` renders a decision with outcome, ids, amount, timestamp, memo, and expandable reason/rule/evidence. `link` makes the id a deep link; `open` expands the evidence.
- `renderLedger`/`renderFilters` page and filter the receipt list. `renderOverview` composes hero, stats, charts and recent decisions. `renderPolicy`, `renderRequests`, `renderReceipt`, `renderRequest`, `renderEnable`, `renderJudge` render their routes.
- `enableSteps(names)` returns the eight setup commands, each with the phase it belongs to. `SETUP_PHASES` names the five phases, and `renderEnable` groups the steps under them and fills the sticky rail. The rail is a button, not a hash link, because the hash belongs to the router.

## Accessibility and states

Native controls (`button`, `a`, `input`, `details/summary`), labelled inputs, `aria-current` on the active nav route, `aria-live` regions for loading/status/feed updates, focus-visible outlines, skip link, and reduced-motion support. Every view has an empty state; reads surface errors in the page bar and keep the last good data marked stale.

## The visual system

One paper ground, one green, and a hairline rule between things. The type has three roles: a serif for the statements, a grotesque for reading, and a mono for anything the chain produced. The display size follows the viewport, the reading column is one measure, and the page has one entrance that plays once with a delay per element. A decision carries its state twice, as a colour on the margin rule and as a word in the badge, so the colour is never the only cue. Every label is sentence case in the mono family, tight tracking is kept for the two display sizes only, and one easing curve runs across the screen.

Nothing on a loaded page loops. The console reads the chain when it opens and when it is refreshed, and it prints the time of the read, so no mark pretends to be a live connection. The loading skeleton is the only motion that repeats, and it repeats only while the chain is being read.
