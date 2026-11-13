/**
 * One decision, as a card.
 *
 * The card is the same everywhere: the overview, the ledger and the receipt
 * page. The receipt id is a link, so a decision can be shared.
 */

import { el } from '../lib/dom.js';
import { formatNear, formatTimestamp } from '../lib/format.js';
import { badge, outcomeLabel } from '../components/badge.js';
import { href } from '../lib/router.js';

/**
 * @typedef {object} ReceiptCardProps
 * @property {object} receipt
 * @property {boolean} [link] Make the receipt id a link.
 * @property {boolean} [open] Start with the evidence open.
 */

/**
 * @param {ReceiptCardProps} props
 */
export function receiptCard({ receipt, link = true, open = false }) {
  const item = el('article', 'decision');
  const head = el('div', 'decision-head');
  head.append(badge(receipt.outcome, outcomeLabel(receipt.outcome)));
  if (link) {
    const id = el('a', 'decision-id', `№ ${receipt.receipt_id}`);
    id.href = href('receipt', receipt.receipt_id);
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
    request.href = href('request', receipt.request_id);
    meta.append(request);
  }
  meta.append(el('span', null, formatTimestamp(receipt.created_at)));
  if (receipt.memo) meta.append(el('span', 'memo', receipt.memo));
  item.append(meta);

  const body = el('details', 'receipt');
  body.open = open;
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
