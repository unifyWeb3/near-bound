/**
 * The DOM helpers and the pieces of the console that more than one view uses.
 */

import { formatNear, timestampSeconds } from './api.js';

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function count(list, selector) {
  return list.filter(selector).length;
}

export function sumYocto(list, selector) {
  return list.reduce((acc, item) => acc + BigInt(selector(item) ?? 0n), 0n);
}

/** Shorten a big integer count for display. */
export function formatCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
}

/** Group receipts by day label, in the reader's own timezone. */
export function byDay(receipts) {
  const groups = new Map();
  for (const receipt of receipts) {
    const date = new Date(timestampSeconds(receipt.created_at) * 1000);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Group denials by reason. */
export function byReason(receipts) {
  const groups = new Map();
  for (const receipt of receipts.filter((item) => item.outcome === 'Denied')) {
    const key = receipt.reason || 'Unlabelled';
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].sort(([, a], [, b]) => b - a);
}

/** The class of a receipt badge. */
export function outcomeClass(outcome) {
  if (outcome === 'Approved') return 'pill approved';
  if (outcome === 'Failed') return 'pill failed';
  return 'pill denied';
}

/** The state of a request, and the class that colours it. */
export function requestState(status) {
  switch (status) {
    case 'Pending':
      return { label: 'Waiting for the owner', className: 'pill pending' };
    case 'NeedsApproval':
      return { label: 'Flagged, the owner decides', className: 'pill flagged' };
    case 'ApprovedPending':
      return { label: 'Approved, the transfer is settling', className: 'pill settling' };
    case 'Approved':
      return { label: 'Paid out', className: 'pill approved' };
    case 'SettlementFailed':
      return { label: 'The transfer failed', className: 'pill failed' };
    case 'Denied':
      return { label: 'Refused by the policy', className: 'pill denied' };
    default:
      return { label: status, className: 'pill' };
  }
}

/** One receipt card. */
export function renderReceipt(receipt, { link = true } = {}) {
  const item = el('article', 'decision');
  const head = el('div', 'decision-head');
  head.append(el('span', outcomeClass(receipt.outcome), receipt.outcome));
  if (link) {
    const id = el('a', 'decision-id', `№ ${receipt.receipt_id}`);
    id.href = `#/receipt/${receipt.receipt_id}`;
    head.append(id);
  } else {
    head.append(el('span', 'decision-id', `№ ${receipt.receipt_id}`));
  }
  head.append(el('span', 'decision-vendor mono', receipt.vendor));
  head.append(el('span', 'decision-amount', formatNear(receipt.amount)));
  item.append(head);

  const meta = el('div', 'decision-meta');
  meta.append(el('span', null, `nonce ${receipt.nonce}`));
  if (Number(receipt.request_id) > 0) {
    const request = el('a', null, `request #${receipt.request_id}`);
    request.href = `#/request/${receipt.request_id}`;
    meta.append(request);
  }
  meta.append(el('span', null, new Date(timestampSeconds(receipt.created_at) * 1000).toLocaleString()));
  if (receipt.memo) meta.append(el('span', 'memo', receipt.memo));
  item.append(meta);

  const body = el('details', 'receipt');
  body.append(el('summary', null, 'Why this happened'));
  const receiptBody = el('div', 'receipt-body');
  if (receipt.reason) {
    const line = el('div', 'row');
    line.append(el('span', 'row-label', 'Reason'));
    line.append(el('span', 'row-value mono', receipt.reason));
    receiptBody.append(line);
  }
  const ruleLine = el('div', 'row');
  ruleLine.append(el('span', 'row-label', 'Rule'));
  ruleLine.append(el('span', 'row-value', receipt.rule));
  receiptBody.append(ruleLine);
  if (receipt.evidence?.length) {
    const evidence = el('ul', 'evidence');
    for (const item_ of receipt.evidence) evidence.append(el('li', 'mono', item_));
    receiptBody.append(evidence);
  }
  const spentLine = el('div', 'row');
  spentLine.append(el('span', 'row-label', 'Spent after'));
  spentLine.append(el('span', 'row-value', formatNear(receipt.spent_after)));
  receiptBody.append(spentLine);
  body.append(receiptBody);
  item.append(body);
  return item;
}

/** One labelled bar chart. */
export function barChart(host, rows, total) {
  host.replaceChildren();
  if (rows.length === 0) {
    host.append(el('p', 'empty-state', 'Nothing to chart yet.'));
    return;
  }
  for (const [label, value] of rows) {
    const row = el('div', 'bar-row');
    row.append(el('div', 'bar-label', String(label)));
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = total ? `${Math.round((value / total) * 100)}%` : '0%';
    track.append(fill);
    row.append(track);
    row.append(el('div', 'bar-value', String(value)));
    host.append(row);
  }
}

/** Copy a command to the clipboard. */
export async function copyCommand(button, cmd) {
  try {
    await navigator.clipboard.writeText(cmd);
    const original = button.textContent;
    button.textContent = 'Copied';
    button.setAttribute('aria-live', 'polite');
    setTimeout(() => {
      button.textContent = original;
      button.removeAttribute('aria-live');
    }, 1400);
  } catch {
    button.textContent = 'Not copyable here';
  }
}

/** A button that copies a command. */
export function copyButton(cmd, label = 'Copy command') {
  const button = el('button', 'copy-button', label);
  button.addEventListener('click', () => copyCommand(button, cmd));
  return button;
}
