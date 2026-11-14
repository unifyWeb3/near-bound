/**
 * The ledger: every decision, filtered, paged.
 *
 * The page shows a bounded newest-first page rather than every receipt, and
 * distinguishes the agent's receipts on the page from the global receipt
 * count on chain. No count is inferred from a filtered page size.
 */

import { el, mount } from '../lib/dom.js';
import { formatCount } from '../lib/format.js';
import { emptyState } from '../components/empty.js';
import { receiptCard } from './receipt-card.js';

export const PAGE_LIMIT = 25;

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

  // The filter row is built once and then updated in place. Remounting it on
  // every keystroke would take the caret away from the field being typed in.
  const existing = host.querySelector('input.filter-input');
  if (existing) {
    for (const chip of host.querySelectorAll('.chip-button')) {
      chip.setAttribute(
        'aria-pressed',
        chip.getAttribute('data-outcome') === filter.outcome ? 'true' : 'false',
      );
    }
    if (existing.value !== (filter.text ?? '')) {
      existing.value = filter.text ?? '';
    }
    return;
  }

  const chips = ['all', 'Approved', 'Denied', 'Failed', 'Expired'].map((outcome) => {
    const node = el(
      'button',
      'chip-button',
      outcome === 'all' ? 'All outcomes' : outcome,
      { type: 'button', 'aria-pressed': filter.outcome === outcome ? 'true' : 'false' },
    );
    node.setAttribute('data-outcome', outcome);
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
 * The decisions on this page.
 *
 * @param {object} state
 */
export function renderLedger(state) {
  const host = document.getElementById('ledger-list');
  if (!host) return;
  const filter = state.filter ?? { outcome: 'all', text: '' };
  const ledger = state.ledger ?? {};
  const receipts = ledger.receipts ?? [];
  const matched = receipts.filter((receipt) => {
    if (filter.outcome && filter.outcome !== 'all' && receipt.outcome !== filter.outcome) return false;
    if (filter.text) {
      const haystack = `${receipt.memo} ${receipt.vendor} ${receipt.receipt_id}`.toLowerCase();
      if (!haystack.includes(filter.text.toLowerCase())) return false;
    }
    return true;
  });

  const count = document.getElementById('ledger-count');
  if (count) {
    const agent = formatCount(matched.length);
    const global = ledger.globalTotal == null ? 'unknown' : formatCount(ledger.globalTotal);
    count.textContent =
      ledger.fallback
        ? `${agent} for this agent on this page (historical fallback), ${global} receipts on chain`
        : `${agent} for this agent on this page, ${global} receipts on chain`;
  }
  const unread = document.getElementById('ledger-unread');
  if (unread) {
    unread.textContent = ledger.errors
      ? `${ledger.errors} receipt read${ledger.errors === 1 ? '' : 's'} could not complete`
      : '';
  }

  const visible = state.visible ?? PAGE_LIMIT;
  if (matched.length === 0) {
    mount(host, emptyState('No decisions match. Clear the filter, or point the console at another agent.'));
  } else {
    mount(host, ...matched.slice(0, visible).map((receipt) => receiptCard({ receipt })));
  }

  const more = document.getElementById('ledger-more');
  if (more) {
    const moreAvailable = matched.length > visible;
    more.hidden = !moreAvailable;
    more.textContent = `Show ${Math.min(PAGE_LIMIT, matched.length - visible)} more`;
    more.disabled = Boolean(ledger.errors && !ledger.complete);
    if (ledger.errors && !ledger.complete) {
      more.title = 'Some receipts on this page could not be read.';
    }
  }
}

/**
 * A structured error summary for failed receipt reads, listing exact ids.
 *
 * @param {object} ledger
 * @returns {HTMLElement|null}
 */
export function ledgerErrorSummary(ledger) {
  if (!(ledger && ledger.errors > 0)) return null;
  const failed = (ledger.failedIds ?? []).slice(0, 10).map((id) => `receipt #${id}`).join(', ');
  const note = el('p', 'error-summary');
  note.textContent = `Could not read ${ledger.errors} receipt${ledger.errors === 1 ? '' : 's'}${
    failed ? ` (${failed})`
    : ''
  }. Showing what could be read, not a complete ledger.`;
  return note;
}
