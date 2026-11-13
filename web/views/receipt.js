/**
 * One decision, or one request, on its own page.
 */

import { el, mount } from '../lib/dom.js';
import { getReceipt, getRequest } from '../lib/api.js';
import { copyButton } from '../components/copy.js';
import { emptyState } from '../components/empty.js';
import { badge, outcomeLabel, stateLabel, stateWords } from '../components/badge.js';
import { href } from '../lib/router.js';
import { receiptCard } from './receipt-card.js';

/**
 * The shareable link to one receipt.
 *
 * @param {object} state
 * @param {number} receiptId
 */
function shareLink(state, receiptId) {
  const row = el('div', 'share-row');
  const link = el('input', 'share-link', undefined, {
    type: 'text',
    readonly: 'readonly',
    'aria-label': 'The link to this decision',
  });
  link.value = `${window.location.origin}${window.location.pathname}?contract=${state.deployment.contract}&agent=${state.deployment.agent}#/receipt/${receiptId}`;
  row.append(link);
  row.append(copyButton(link.value, 'Copy link'));
  return row;
}

/**
 * One receipt.
 *
 * @param {object} state
 * @param {string} id
 */
export async function renderReceipt(state, id) {
  const host = document.getElementById('receipt-view');
  if (!host) return;
  let receipt = state.ledger.receipts.find((item) => Number(item.receipt_id) === Number(id));
  if (!receipt) {
    try {
      receipt = await getReceipt(state.deployment, Number(id));
    } catch (error) {
      mount(host, emptyState(`Could not read receipt ${id}: ${error.message ?? error}`));
      return;
    }
  }
  if (!receipt) {
    mount(host, emptyState(`Receipt ${id} does not exist.`));
    return;
  }
  const card = receiptCard({ receipt, link: false, open: true });
  card.classList.add('single');
  mount(host, card, shareLink(state, receipt.receipt_id));
}

/**
 * One request.
 *
 * @param {object} state
 * @param {string} id
 */
export async function renderRequest(state, id) {
  const host = document.getElementById('receipt-view');
  if (!host) return;
  let request = state.requests.find((item) => Number(item.request_id) === Number(id));
  if (!request) {
    try {
      request = await getRequest(state.deployment, Number(id));
    } catch (error) {
      mount(host, emptyState(`Could not read request ${id}: ${error.message ?? error}`));
      return;
    }
  }
  if (!request) {
    mount(host, emptyState(`Request ${id} does not exist.`));
    return;
  }
  const card = el('article', 'decision single');
  const head = el('div', 'decision-head');
  head.append(badge(stateWords(request.status), stateLabel(request.status)));
  head.append(el('span', 'decision-id', `request #${request.request_id}`));
  head.append(el('span', 'decision-vendor mono', request.vendor));
  card.append(head);
  const meta = el('div', 'decision-meta');
  meta.append(el('span', null, `nonce ${request.nonce}`));
  if (request.memo) meta.append(el('span', 'memo', request.memo));
  card.append(meta);
  const nodes = [card];
  if (request.receipt_id) {
    const link = el('a', 'decision-link', `receipt № ${request.receipt_id}`);
    link.href = href('receipt', request.receipt_id);
    nodes.push(link);
  }
  mount(host, ...nodes);
}
