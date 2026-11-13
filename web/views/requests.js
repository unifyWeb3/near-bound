/**
 * The requests that are waiting for the owner.
 */

import { el, mount } from '../lib/dom.js';
import { formatNear } from '../lib/format.js';
import { badge, stateLabel, stateWords } from '../components/badge.js';
import { emptyState } from '../components/empty.js';
import { href } from '../lib/router.js';

/**
 * @param {object} state
 * @param {(requestId: number, method: string, args: Array) => void} act
 */
export function renderRequests(state, act) {
  const host = document.getElementById('requests-view');
  if (!host) return;
  const open = state.requests.filter(
    (request) => request.status === 'Pending' || request.status === 'NeedsApproval',
  );
  const count = document.getElementById('requests-count');
  if (count) count.textContent = `${open.length} waiting`;

  if (open.length === 0) {
    mount(host, emptyState('No request is waiting for the owner.'));
    return;
  }

  const nodes = open.map((request) => {
    const card = el('article', 'decision');
    const head = el('div', 'decision-head');
    head.append(badge(stateWords(request.status), stateLabel(request.status)));
    head.append(el('span', 'decision-id', `request #${request.request_id}`));
    head.append(el('span', 'decision-vendor mono', request.vendor));
    head.append(el('span', 'decision-amount', formatNear(request.amount)));
    card.append(head);

    const meta = el('div', 'decision-meta');
    meta.append(el('span', null, `nonce ${request.nonce}`));
    if (request.memo) meta.append(el('span', 'memo', request.memo));
    card.append(meta);

    const link = el('a', 'decision-link', 'open');
    link.href = href('request', request.request_id);
    card.append(link);

    const actions = el('div', 'decision-actions');
    const approve = el('button', 'ghost-button', 'Approve', { type: 'button' });
    approve.addEventListener('click', () => act(request.request_id, 'approve_request', [request.request_id]));
    const refuse = el('button', 'ghost-button', 'Refuse', { type: 'button' });
    refuse.addEventListener('click', () => {
      const reason = window.prompt('Why is this request refused?', 'the vendor is not on the allowlist');
      if (reason) act(request.request_id, 'reject_request', [request.request_id, reason]);
    });
    actions.append(approve);
    actions.append(refuse);
    card.append(actions);
    return card;
  });

  mount(host, ...nodes);
}
