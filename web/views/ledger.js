/**
 * The ledger: every decision, filtered, paged.
 */

import { el, mount } from '../lib/dom.js';
import { formatCount } from '../lib/format.js';
import { emptyState } from '../components/empty.js';
import { receiptCard } from './receipt-card.js';

export const PAGE_SIZE = 25;

/**
 * The filter row.
 *
 * @param {object} state
 * @param {(state: object) => void} update
 */
export function renderFilters(state, update) {
  const host = document.getElementById('ledger-filters');
  if (!host) return;
  const filter = state.filter ?? { outcome: 'all', text: '' };

  const chips = ['all', 'Approved', 'Denied', 'Failed'].map((outcome) => {
    const node = el(
      'button',
      'chip-button',
      outcome === 'all' ? 'All outcomes' : outcome,
      { type: 'button', 'aria-pressed': filter.outcome === outcome ? 'true' : 'false' },
    );
    node.addEventListener('click', () => update({ ...filter, outcome }));
    return node;
  });

  const search = el('input', 'filter-input', undefined, {
    type: 'search',
    placeholder: 'Search memo, vendor or id',
    'aria-label': 'Search the decisions',
  });
  search.value = filter.text ?? '';
  search.addEventListener('input', () => update({ ...filter, text: search.value }));
  search.addEventListener('change', () => update({ ...filter, text: search.value }));

  mount(host, ...chips, search);
}

/**
 * The decisions.
 *
 * @param {object} state
 */
export function renderLedger(state) {
  const host = document.getElementById('ledger-list');
  if (!host) return;
  const filter = state.filter ?? { outcome: 'all', text: '' };
  const matched = state.ledger.receipts.filter((receipt) => {
    if (filter.outcome && filter.outcome !== 'all' && receipt.outcome !== filter.outcome) return false;
    if (filter.text) {
      const haystack = `${receipt.memo} ${receipt.vendor} ${receipt.receipt_id}`.toLowerCase();
      if (!haystack.includes(filter.text.toLowerCase())) return false;
    }
    return true;
  });

  const count = document.getElementById('ledger-count');
  if (count) {
    count.textContent = `${formatCount(matched.length)} for this agent, of ${formatCount(state.ledger.total)} on chain`;
  }
  const unread = document.getElementById('ledger-unread');
  if (unread) {
    unread.textContent = state.ledger.unread
      ? `${state.ledger.unread} receipts of this agent are not read yet`
      : '';
  }

  const visible = state.visible ?? PAGE_SIZE;
  if (matched.length === 0) {
    mount(host, emptyState('No decisions match. Clear the filter, or point the console at another agent.'));
  } else {
    mount(host, ...matched.slice(0, visible).map((receipt) => receiptCard({ receipt })));
  }

  const more = document.getElementById('ledger-more');
  if (more) {
    more.hidden = matched.length <= visible;
    more.textContent = `Show ${Math.min(PAGE_SIZE, matched.length - visible)} more`;
  }
}
