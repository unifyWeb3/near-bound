import {
  CONFIG,
  PROTOCOL_CHECKS,
  formatNear,
  loadState,
  timestampSeconds,
} from './api.js';

const $ = (id) => document.getElementById(id);

/** Build an element with optional class and text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** A labelled row. */
function row(label, value, mono = false) {
  const line = el('div', 'row');
  line.append(el('span', 'row-label', label));
  const cell = el('span', mono ? 'row-value mono' : 'row-value', value);
  line.append(cell);
  return line;
}

/** Status pill class. */
function pillClass(outcome) {
  return outcome === 'Approved' ? 'pill approved' : 'pill denied';
}

/** Render the stat cards. */
function renderStats(state) {
  const { policy, receipts } = state;
  const denied = receipts.filter((r) => r.outcome === 'Denied').length;
  const spent = BigInt(policy.spent);
  const budget = BigInt(policy.budget);
  const remaining = BigInt(policy.remaining);
  const used = budget === 0n ? 0 : Number((spent * 10000n) / budget) / 100;

  const cards = [
    ['Budget', formatNear(budget), 'resets every hour'],
    ['Spent', formatNear(spent), `${used.toFixed(1)}% used`],
    ['Remaining', formatNear(remaining), 'this period'],
    ['Decisions', String(state.totalReceipts), `${state.totalRequests} requests`],
    ['Denied', String(denied), 'attempts stopped'],
  ];

  const host = $('stats');
  host.replaceChildren();
  for (const [label, value, note] of cards) {
    const card = el('div', 'stat');
    card.append(el('div', 'stat-label', label));
    card.append(el('div', 'stat-value', value));
    card.append(el('div', 'stat-note', note));
    host.append(card);
  }
}

/** Render the policy panel. */
function renderPolicy(state) {
  const { policy } = state;
  const host = $('policy');
  host.replaceChildren(el('h2', null, 'Policy'));
  host.append(row('Agent', policy.agent_id, true));
  host.append(row('Budget', formatNear(policy.budget)));
  host.append(row('Spent', formatNear(policy.spent)));
  host.append(row('Remaining', formatNear(policy.remaining)));
  host.append(row('Max single spend', formatNear(policy.max_single_spend)));
  host.append(row('Rate limit', `${policy.rate_limit} per minute`));
  host.append(
    row(
      'Period started',
      new Date(timestampSeconds(policy.period_start) * 1000).toLocaleString(),
    ),
  );
  host.append(row('Last nonce', String(policy.last_nonce), true));
  host.append(row('Revoked', policy.revoked ? 'yes' : 'no'));

  const vendors = el('div', 'vendors');
  vendors.append(el('div', 'row-label', 'Allowed receivers'));
  for (const vendor of policy.vendors) {
    vendors.append(el('code', 'vendor', vendor));
  }
  host.append(vendors);
}

/** Render the key scope panel. */
function renderKey() {
  const host = $('key');
  host.replaceChildren(el('h2', null, 'Agent key on chain'));
  host.append(
    el(
      'p',
      'muted',
      'The agent holds a function call key, not a wallet key. The protocol checks the receiver, the method, the deposit, and the allowance before the contract runs.',
    ),
  );
  const code = el('pre', 'code-block');
  code.textContent = [
    'FunctionCall {',
    `  receiver_id: "${CONFIG.contract}",`,
    '  method_names: ["request_spend"],',
    '  allowance: "0.2 NEAR"',
    '}',
  ].join('\n');
  host.append(code);
}

/** Render one decision receipt. */
function renderReceipt(receipt) {
  const item = el('article', 'decision');

  const head = el('div', 'decision-head');
  head.append(el('span', pillClass(receipt.outcome), receipt.outcome));
  head.append(el('span', 'decision-id', `receipt #${receipt.receipt_id}`));
  head.append(el('span', 'decision-vendor mono', receipt.vendor));
  head.append(el('span', 'decision-amount', formatNear(receipt.amount)));
  item.append(head);

  const meta = el('div', 'decision-meta');
  meta.append(el('span', null, `nonce ${receipt.nonce}`));
  meta.append(
    el('span', null, new Date(timestampSeconds(receipt.created_at) * 1000).toLocaleString()),
  );
  if (Number(receipt.request_id) > 0) {
    meta.append(el('span', null, `request #${receipt.request_id}`));
  }
  if (receipt.memo) meta.append(el('span', 'memo', receipt.memo));
  item.append(meta);

  const body = el('div', 'receipt');
  if (receipt.reason) body.append(row('Reason', receipt.reason, true));
  body.append(row('Rule', receipt.rule));
  if (receipt.evidence?.length) {
    const evidence = el('ul', 'evidence');
    for (const line of receipt.evidence) evidence.append(el('li', 'mono', line));
    body.append(evidence);
  }
  body.append(row('Spent after', formatNear(receipt.spent_after)));
  body.append(row('Remaining after', formatNear(receipt.remaining_after)));
  item.append(body);

  return item;
}

/** Render the decision feed. */
function renderFeed(state) {
  const host = $('feed');
  host.replaceChildren();
  if (state.shown.length === 0) {
    host.append(el('p', 'muted', 'No decisions yet.'));
    return;
  }
  for (const receipt of state.shown) {
    host.append(renderReceipt(receipt));
  }
}

/** Render the protocol checks. */
function renderProtocol() {
  const host = $('protocol');
  host.replaceChildren(el('h2', null, 'What the protocol refuses'));
  host.append(
    el(
      'p',
      'muted',
      'Each line was produced on testnet by signing with the agent key. The contract was never reached.',
    ),
  );
  for (const check of PROTOCOL_CHECKS) {
    const item = el('div', 'check');
    item.append(el('div', 'check-title', check.title));
    item.append(el('div', 'check-detail mono', check.detail));
    host.append(item);
  }
}

/** Render an error. */
function renderError(error) {
  const host = $('feed');
  host.replaceChildren();
  const box = el('div', 'error');
  box.append(el('strong', null, 'Could not read the contract.'));
  box.append(el('p', null, String(error.message ?? error)));
  box.append(el('p', 'muted small', `RPC: ${CONFIG.rpc}`));
  host.append(box);
}

let timer = null;

/** Load and render everything. */
async function refresh() {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = 'Reading...';
  try {
    const state = await loadState();
    renderStats(state);
    renderPolicy(state);
    renderFeed(state);
    $('loaded').textContent = `Read at ${state.loadedAt.toLocaleTimeString()}`;
    $('error-bar').hidden = true;
  } catch (error) {
    renderError(error);
    $('error-bar').hidden = false;
    $('error-bar').textContent = String(error.message ?? error);
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh';
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 30000);
  }
}

$('refresh').addEventListener('click', refresh);
renderKey();
renderProtocol();
refresh();
