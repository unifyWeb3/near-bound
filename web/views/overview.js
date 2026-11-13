/**
 * The overview: what the deployment is, what it holds, what it decided.
 */

import { el, mount } from '../lib/dom.js';
import { formatCount, formatNear, formatTimestamp, dayLabel } from '../lib/format.js';
import { PROTOCOL_CHECKS } from '../lib/api.js';
import { stat } from '../components/stat.js';
import { receiptCard } from './receipt-card.js';

const PAGE = 8;

/**
 * The policy panel in the hero.
 *
 * @param {object} state
 */
export function renderHero(state) {
  const { policy } = state;
  if (!policy) return;
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  set('hero-remaining', formatNear(policy.remaining));
  set('hero-budget', formatNear(policy.budget));
  set('hero-maxsingle', formatNear(policy.max_single_spend));
  set('hero-ratelimit', `${policy.rate_limit} per minute`);
  set('hero-receivers', String(policy.vendors.length));
  const budget = BigInt(policy.budget);
  const pct = budget === 0n ? 0 : Number((BigInt(policy.spent) * 10000n) / budget) / 100;
  const fill = document.getElementById('hero-fill');
  if (fill) fill.style.width = `${Math.max(2, 100 - pct)}%`;
  const approved = state.ledger.receipts.filter((receipt) => receipt.outcome === 'Approved');
  set('hero-receiptid', approved[0] ? `№ ${approved[0].receipt_id}` : 'none yet');
  set('hero-agent', state.deployment.agent.replace(/\.testnet$/, ''));
}

/**
 * The numbers.
 *
 * @param {object} state
 */
export function renderStats(state) {
  const { policy, ledger } = state;
  if (!policy) return;
  const receipts = ledger.receipts;
  const denied = receipts.filter((receipt) => receipt.outcome === 'Denied').length;
  const failed = receipts.filter((receipt) => receipt.outcome === 'Failed').length;
  const approved = receipts.filter((receipt) => receipt.outcome === 'Approved').length;
  const allowed = receipts
    .filter((receipt) => receipt.outcome === 'Approved')
    .reduce((sum, receipt) => sum + BigInt(receipt.amount), 0n);
  const protectedValue = receipts
    .filter((receipt) => receipt.outcome === 'Denied')
    .reduce((sum, receipt) => sum + BigInt(receipt.amount), 0n);

  const cards = [
    stat({ label: 'Under management', value: formatNear(state.treasury ?? 0n), note: 'held by the contract' }),
    stat({ label: 'Approved', value: formatCount(approved), note: 'reads on chain' }),
    stat({ label: 'Blocked', value: formatCount(denied + failed), note: 'never paid out' }),
    stat({ label: 'Allowed value', value: formatNear(allowed), note: 'moved to the counterparty' }),
    stat({ label: 'Protected value', value: formatNear(protectedValue), note: 'refused by the policy' }),
    stat({ label: 'Decisions', value: formatCount(ledger.total), note: 'for this agent' }),
  ];
  const host = document.getElementById('stats-grid');
  mount(host, ...cards);

  const spent = BigInt(policy.spent);
  const sentence = el('p', 'governed');
  const frozen = state.killSwitch ? 'Kill switch on, every agent frozen.' : 'Kill switch off.';
  const since = new Date(Number(policy.period_start) * 1000).toLocaleDateString();
  sentence.textContent =
    spent > 0n
      ? `${frozen} Governed since ${since}. ${formatNear(spent)} allowed through this hour.`
      : `${frozen} Governed since ${since}. The current hour is clean.`;
  host.append(sentence);
}

/**
 * The two charts.
 *
 * @param {object} state
 */
export function renderCharts(state) {
  const receipts = state.ledger.receipts;
  const reasons = new Map();
  for (const receipt of receipts) {
    if (receipt.outcome !== 'Denied') continue;
    const key = receipt.reason || 'Unlabelled';
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  const deniedRows = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const days = new Map();
  for (const receipt of receipts) {
    const key = dayLabel(receipt.created_at);
    days.set(key, (days.get(key) ?? 0) + 1);
  }
  const dayRows = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-8);

  barChart(document.getElementById('chart-reasons'), deniedRows, deniedRows.reduce((sum, [, n]) => sum + n, 0) || 1);
  barChart(document.getElementById('chart-timeline'), dayRows, dayRows.reduce((sum, [, n]) => sum + n, 0) || 1);
}

/**
 * One labelled bar chart.
 *
 * @param {HTMLElement} host
 * @param {[string, number][]} rows
 * @param {number} total
 */
function barChart(host, rows, total) {
  if (!host) return;
  if (rows.length === 0) {
    mount(host, el('p', 'empty-state', 'Nothing to chart yet.'));
    return;
  }
  const nodes = rows.map(([label, value]) => {
    const row = el('div', 'bar-row');
    row.append(el('div', 'bar-label', String(label)));
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = total ? `${Math.round((value / total) * 100)}%` : '0%';
    track.append(fill);
    row.append(track);
    row.append(el('div', 'bar-value', String(value)));
    return row;
  });
  mount(host, ...nodes);
}

/**
 * The protocol refusals.
 */
export function renderProtocolList() {
  const host = document.getElementById('protocol-list');
  if (!host) return;
  const nodes = PROTOCOL_CHECKS.map((item) => {
    const row = el('div', 'protocol-item');
    row.append(el('div', 'protocol-intent', item.title));
    row.append(el('div', 'protocol-error mono', item.detail));
    return row;
  });
  mount(host, ...nodes);
}

/**
 * The newest decisions on the overview.
 *
 * @param {object} state
 */
export function renderRecent(state) {
  const host = document.getElementById('recent-list');
  if (!host) return;
  const receipts = state.ledger.receipts.slice(0, PAGE);
  if (receipts.length === 0) {
    mount(host, el('p', 'empty-state', 'No decisions on chain yet. Enable the agent and try a spend.'));
    return;
  }
  mount(host, ...receipts.map((receipt) => receiptCard({ receipt })));
}
