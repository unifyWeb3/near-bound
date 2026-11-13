/**
 * The policy: the rules, and what the owner can change.
 */

import { el, mount } from '../lib/dom.js';
import { formatNear } from '../lib/format.js';
import { emptyState } from '../components/empty.js';

/**
 * @param {object} state
 */
export function renderPolicy(state) {
  const host = document.getElementById('policy-view');
  if (!host) return;
  const { policy } = state;
  if (!policy) {
    mount(host, emptyState('Reading the policy...'));
    return;
  }
  const rows = [
    ['Agent', policy.agent_id ?? state.deployment.agent, 'the account the policy governs'],
    ['Budget', formatNear(policy.budget), `per ${policy.period_seconds} seconds`],
    ['Spent this period', formatNear(policy.spent), `${formatNear(policy.remaining)} left`],
    ['Max per spend', formatNear(policy.max_single_spend), 'one payment'],
    ['Rate limit', `${policy.rate_limit} a minute`, 'requests per minute'],
    ['Vendors', policy.vendors.join(', ') || 'none', 'the allowlist'],
    ['Last nonce', String(policy.last_nonce), 'the next request must be higher'],
    ['Requests', String(policy.request_count), 'from this agent'],
    ['Revoked', policy.revoked ? 'yes' : 'no', 'a revoked agent cannot ask'],
  ];
  const table = el('div', 'policy-table');
  for (const [label, value, note] of rows) {
    const row = el('div', 'row');
    row.append(el('span', 'row-label', label));
    row.append(el('span', 'row-value mono', value));
    table.append(row);
    if (note) table.append(el('div', 'row-note', note));
  }
  const kill = el('div', 'policy-kill');
  kill.append(
    el(
      'p',
      null,
      state.killSwitch
        ? 'The kill switch is on. No agent can ask and no request can be approved.'
        : 'The kill switch is off.',
    ),
  );
  mount(host, table, kill);
}
