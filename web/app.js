import {
  CONFIG,
  PROTOCOL_CHECKS,
  formatNear,
  loadState,
  timestampSeconds,
} from './api.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function count(list, selector) {
  return list.filter(selector).length;
}

function sumYocto(list, selector) {
  return list.reduce((acc, item) => acc + BigInt(selector(item) ?? 0n), 0n);
}

/** Shorten a big integer count for display. */
function formatCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
}

/** Group receipts by day label. */
function byDay(receipts) {
  const groups = new Map();
  for (const r of receipts) {
    const key = new Date(timestampSeconds(r.created_at) * 1000).toISOString().slice(0, 10);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Group denials by reason. */
function byReason(receipts) {
  const groups = new Map();
  for (const r of receipts.filter((x) => x.outcome === 'Denied')) {
    const key = r.reason || 'Unlabelled';
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].sort(([, a], [, b]) => b - a);
}

/** The enable steps. */
const STEPS = [
  {
    title: 'Create three funded testnet accounts',
    body: 'You need an owner account (the treasury), an agent account, and a vendor account. Get testnet NEAR free from the faucet. The owner deploys the contracts.',
    cmd: 'near create-account bound-owner.testnet --use-account YOUR_MAIN_ACCOUNT --network-config testnet autogenerate-new-keypair save-to-legacy-keychain send',
  },
  {
    title: 'Deploy the policy contract and the vendor',
    body: 'Two wasm files, built from the repository. The contract holds the money and the rules. The vendor is a paid API stand in for the demo.',
    cmd: 'cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml\ncargo near build non-reproducible-wasm --manifest-path demo/vendor/Cargo.toml\nnear contract deploy OWNER use-file contract/target/near/bound_contract.wasm with-init-call new json-args \'{}\' prepaid-gas \'100.0 Tgas\' attached-deposit \'0 NEAR\' network-config testnet sign-with-legacy-keychain send',
  },
  {
    title: 'Register the agent with a policy',
    body: 'Budget, single spend cap, rate limit per minute and the vendor allowlist. One command, one transaction, signed by the owner.',
    cmd: 'near contract call-function as-transaction OWNER register_agent json-args \'{"agent_id":"AGENT","budget":50000000000000000,"period_seconds":3600,"vendors":["VENDOR"],"max_single_spend":20000000000000000,"rate_limit":5}\' prepaid-gas \'100.0 Tgas\' attached-deposit \'0 NEAR\' sign-as OWNER network-config testnet sign-with-legacy-keychain send',
  },
  {
    title: 'Give the agent a scoped key',
    body: 'One receiver, one method, a gas cap. The key cannot call the vendor, cannot carry a deposit, and cannot afford an expensive call.',
    cmd: 'near account add-key AGENT grant-function-call-access --allowance 0.2near --contract-account-id OWNER --function-names request_spend autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send',
  },
  {
    title: 'The agent asks to spend',
    body: 'Hard checks run inside the contract. A stranger, a budget breach or a rate breach is written as a denial with evidence, never silently accepted.',
    cmd: 'near contract call-function as-transaction OWNER request_spend json-args \'{"agent_id":"AGENT","vendor":"VENDOR","amount":20000000000000000,"nonce":1,"memo":"reference price lookup"}\' prepaid-gas \'20.0 Tgas\' attached-deposit \'0 NEAR\' sign-as AGENT network-config testnet sign-with-access-key-file KEY send',
  },
  {
    title: 'The owner approves, money moves, receipt exists',
    body: 'A human or a runner decides. The transfer is made by the contract, and both outcomes are receipts with reason, rule and evidence.',
    cmd: 'near contract call-function as-transaction OWNER approve_request json-args \'{"request_id":0}\' prepaid-gas \'100.0 Tgas\' attached-deposit \'0 NEAR\' sign-as OWNER network-config testnet sign-with-legacy-keychain send',
  },
  {
    title: 'Watch the feed, read the receipts',
    body: 'Every decision appears here with the rule that blocked it. A denial is a legitimate outcome, not an error message.',
    cmd: 'curl -s -X POST https://rpc.testnet.near.org/ -H \'Content-Type: application/json\' -d \'{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"OWNER","method_name":"get_receipt_count","args_base64":"e30=","finality":"optimistic"}}\'',
  },
  {
    title: 'Revoke the agent instantly',
    body: 'Delete the scoped key. The agent may still ask, but the protocol refuses every call before the contract sees it.',
    cmd: 'near account delete-key AGENT PUBLIC_KEY network-config testnet sign-with-legacy-keychain send',
  },
];

/** The four protocol refusals with the exact error text. */
const PROTOCOL_LIST = [
  { text: 'A different method', error: "Transaction method name <approve_request> isn't allowed by the access key." },
  { text: 'A different contract', error: "Transaction for <vendor> doesn't match the access key for <contract>." },
  { text: 'A deposit of one yoctoNEAR', error: 'Having a deposit with a function call action is not allowed with a function call access key.' },
  { text: 'A 100 Tgas call it cannot afford', error: 'Access Key ... does not have enough allowance ... to cover transaction cost ...' },
];

/** Render the hero panel from the live state. */
function renderHero(state) {
  const { policy } = state;
  $('hero-remaining').textContent = formatNear(policy.remaining);
  $('hero-budget').textContent = formatNear(policy.budget);
  $('hero-maxsingle').textContent = formatNear(policy.max_single_spend);
  $('hero-ratelimit').textContent = `${policy.rate_limit} per minute`;
  const budget = BigInt(policy.budget);
  const pct = budget === 0n ? 0 : Number((BigInt(policy.spent) * 10000n) / budget) / 100;
  $('hero-fill').style.width = `${Math.max(2, 100 - pct)}%`;
  const approved = state.receipts.filter((r) => r.outcome === 'Approved');
  const latest = approved[0];
  $('hero-receiptid').textContent = latest ? `№ ${latest.receipt_id}` : 'none yet';
}

/** Render the stat grid and the governed sentence. */
function renderStats(state) {
  const { policy, receipts, totalReceipts } = state;
  const denied = count(receipts, (r) => r.outcome === 'Denied');
  const approved = count(receipts, (r) => r.outcome === 'Approved');
  const allowedValue = sumYocto(receipts, (r) => (r.outcome === 'Approved' ? r.amount : 0n));
  const protectedValue = sumYocto(receipts, (r) => (r.outcome === 'Denied' ? r.amount : 0n));

  const buttons = [
    ['Under management', formatNear(state.treasury), 'held by the contract'],
    ['Approved', formatCount(approved), 'reads on chain'],
    ['Blocked', formatCount(denied), 'never paid out'],
    ['Allowed value', formatNear(allowedValue), 'total that settled'],
    ['Protected value', formatNear(protectedValue), 'refused by the policy'],
    ['Decisions', formatCount(totalReceipts), 'every one receipted'],
  ];

  const host = $('stats-grid');
  host.replaceChildren();
  for (const [label, value, note] of buttons) {
    const card = el('div', 'stat');
    card.append(el('div', 'stat-label', label));
    card.append(el('div', 'stat-value', value));
    card.append(el('div', 'stat-note', note));
    host.append(card);
  }

  const spent = BigInt(policy.spent);
  const sentence = el('p', 'governed');
  const frozen = state.killSwitch ? 'Kill switch on, every agent frozen.' : 'Kill switch off.';
  if (spent > 0n) {
    sentence.textContent = `${frozen} Governed since ${new Date(timestampSeconds(policy.period_start) * 1000).toLocaleDateString()}. ${formatNear(spent)} allowed through this hour.`;
  } else {
    sentence.textContent = `${frozen} Governed since ${new Date(timestampSeconds(policy.period_start) * 1000).toLocaleDateString()}. The current hour is clean.`;
  }
  host.append(sentence);
}

/** Render one labelled bar chart. */
function barChart(host, rows, total) {
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

/** Render the two charts. */
function renderCharts(state) {
  const denied = state.receipts.filter((r) => r.outcome === 'Denied');
  const reasons = byReason(state.receipts).slice(0, 6);
  const totalDenied = denied.length || 1;
  barChart($('chart-reasons'), reasons, totalDenied);

  const days = byDay(state.receipts);
  const totalDays = days.reduce((sum, [, n]) => sum + n, 0) || 1;
  barChart($('chart-timeline'), days.slice(-8), totalDays);
}

/** One receipt card. */
function receiptPill(outcome) {
  return outcome === 'Approved' ? 'pill approved' : 'pill denied';
}

function renderReceipt(receipt) {
  const item = el('article', 'decision');
  const head = el('div', 'decision-head');
  head.append(el('span', receiptPill(receipt.outcome), receipt.outcome));
  head.append(el('span', 'decision-id', `№ ${receipt.receipt_id}`));
  head.append(el('span', 'decision-vendor mono', receipt.vendor));
  head.append(el('span', 'decision-amount', formatNear(receipt.amount)));
  item.append(head);

  const meta = el('div', 'decision-meta');
  meta.append(el('span', null, `nonce ${receipt.nonce}`));
  if (Number(receipt.request_id) > 0) meta.append(el('span', null, `request #${receipt.request_id}`));
  meta.append(el('span', null, new Date(timestampSeconds(receipt.created_at) * 1000).toLocaleString()));
  if (receipt.memo) meta.append(el('span', 'memo', receipt.memo));
  item.append(meta);

  const body = el('details', 'receipt');
  const summary = el('summary', null, 'Why this happened');
  body.append(summary);
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
    for (const ev of receipt.evidence) evidence.append(el('li', 'mono', ev));
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

/** Render the feed list. */
function renderFeed(state) {
  $('feed-count').textContent = `${state.shown.length} of ${state.totalReceipts}`;
  const host = $('feed-list');
  host.replaceChildren();
  if (state.shown.length === 0) {
    host.append(el('p', 'empty-state', 'No decisions on chain yet. Enable the agent and try a spend.'));
    return;
  }
  for (const receipt of state.shown) host.append(renderReceipt(receipt));
}

/** Copy a step command. */
async function copyCommand(button, cmd) {
  try {
    await navigator.clipboard.writeText(cmd);
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = original;
    }, 1400);
  } catch {
    button.textContent = 'Not copyable here';
  }
}

/** Render the enable steps with copy buttons. */
function renderEnable() {
  const host = $('steps');
  host.replaceChildren();
  STEPS.forEach((step, index) => {
    const li = el('li', 'step');
    li.append(el('div', 'step-num', String(index + 1)));
    const body = el('div', 'step-body');
    body.append(el('h3', 'step-title', step.title));
    body.append(el('p', null, step.body));
    const pre = el('pre', 'step-code');
    pre.textContent = step.cmd;
    body.append(pre);
    const button = el('button', 'copy-button', 'Copy command');
    button.addEventListener('click', () => copyCommand(button, step.cmd));
    body.append(button);
    li.append(body);
    host.append(li);
  });
}

/** Render the protocol refusal list. */
function renderProtocolList() {
  const host = $('protocol-list');
  host.replaceChildren();
  for (const item of PROTOCOL_LIST) {
    const row = el('div', 'protocol-item');
    row.append(el('div', 'protocol-intent', item.text));
    row.append(el('div', 'protocol-error mono', item.error));
    host.append(row);
  }
}

/** Render an error into the feed. */
function renderError(error) {
  const host = $('feed-list');
  host.replaceChildren();
  const box = el('div', 'error');
  box.append(el('strong', null, 'Could not read the contract.'));
  box.append(el('p', null, String(error.message ?? error)));
  box.append(el('p', 'muted small', `RPC: ${CONFIG.rpc}`));
  host.append(box);
}

let timer = null;

async function refresh() {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = 'Reading...';
  try {
    const state = await loadState();
    renderHero(state);
    renderStats(state);
    renderCharts(state);
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
renderEnable();
renderProtocolList();
refresh();
