/**
 * The views of the console.
 *
 * Each view renders into the page from the store. Nothing here reads the chain
 * and nothing here writes it, so a view can be rendered again from the last
 * good state when a read fails.
 */

import {
  formatNear,
  formatYocto,
  getReceipt,
  getRequest,
  PROTOCOL_CHECKS,
  timestampSeconds,
} from './api.js';
import {
  $,
  barChart,
  byDay,
  byReason,
  count,
  copyButton,
  el,
  formatCount,
  outcomeClass,
  renderReceipt,
  requestState,
  sumYocto,
} from './ui.js';

/** The hero panel of the deployment the console is looking at. */
export function renderHero(state) {
  const { policy } = state;
  if (!policy) return;
  $('hero-remaining').textContent = formatNear(policy.remaining);
  $('hero-budget').textContent = formatNear(policy.budget);
  $('hero-maxsingle').textContent = formatNear(policy.max_single_spend);
  $('hero-ratelimit').textContent = `${policy.rate_limit} per minute`;
  $('hero-receivers').textContent = String(policy.vendors.length);
  const budget = BigInt(policy.budget);
  const pct = budget === 0n ? 0 : Number((BigInt(policy.spent) * 10000n) / budget) / 100;
  $('hero-fill').style.width = `${Math.max(2, 100 - pct)}%`;
  const approved = state.ledger.receipts.filter((receipt) => receipt.outcome === 'Approved');
  const latest = approved[0];
  $('hero-receiptid').textContent = latest ? `№ ${latest.receipt_id}` : 'none yet';
}

/** The stat grid and the sentence under it. */
export function renderStats(state) {
  const { policy, ledger } = state;
  if (!policy) return;
  const receipts = ledger.receipts;
  const denied = count(receipts, (receipt) => receipt.outcome === 'Denied');
  const failed = count(receipts, (receipt) => receipt.outcome === 'Failed');
  const approved = count(receipts, (receipt) => receipt.outcome === 'Approved');
  const allowedValue = sumYocto(receipts, (receipt) => (receipt.outcome === 'Approved' ? receipt.amount : 0n));
  const protectedValue = sumYocto(receipts, (receipt) => (receipt.outcome === 'Denied' ? receipt.amount : 0n));

  const cards = [
    ['Under management', formatNear(state.treasury ?? 0n), 'held by the contract'],
    ['Approved', formatCount(approved), 'reads on chain'],
    ['Blocked', formatCount(denied + failed), 'never paid out'],
    ['Allowed value', formatNear(allowedValue), 'moved to the counterparty'],
    ['Protected value', formatNear(protectedValue), 'refused by the policy'],
    ['Decisions', formatCount(ledger.total), 'for this agent'],
  ];

  const host = $('stats-grid');
  host.replaceChildren();
  for (const [label, value, note] of cards) {
    const card = el('div', 'stat');
    card.append(el('div', 'stat-label', label));
    card.append(el('div', 'stat-value', value));
    card.append(el('div', 'stat-note', note));
    host.append(card);
  }

  const spent = BigInt(policy.spent);
  const sentence = el('p', 'governed');
  const frozen = state.killSwitch ? 'Kill switch on, every agent frozen.' : 'Kill switch off.';
  const since = new Date(timestampSeconds(policy.period_start) * 1000).toLocaleDateString();
  if (spent > 0n) {
    sentence.textContent = `${frozen} Governed since ${since}. ${formatNear(spent)} allowed through this hour.`;
  } else {
    sentence.textContent = `${frozen} Governed since ${since}. The current hour is clean.`;
  }
  host.append(sentence);
}

/** The two charts. */
export function renderCharts(state) {
  const receipts = state.ledger.receipts;
  const denied = receipts.filter((receipt) => receipt.outcome === 'Denied');
  const reasons = byReason(receipts).slice(0, 6);
  barChart($('chart-reasons'), reasons, denied.length || 1);

  const days = byDay(receipts);
  const totalDays = days.reduce((sum, [, n]) => sum + n, 0) || 1;
  barChart($('chart-timeline'), days.slice(-8), totalDays);
}

/** The protocol refusals, from the one list in api.js. */
export function renderProtocolList() {
  const host = $('protocol-list');
  host.replaceChildren();
  for (const item of PROTOCOL_CHECKS) {
    const row = el('div', 'protocol-item');
    row.append(el('div', 'protocol-intent', item.title));
    row.append(el('div', 'protocol-error mono', item.detail));
    host.append(row);
  }
}

/**
 * The decision ledger, with a filter and a load more button.
 */
export function renderLedger(state) {
  const host = $('ledger-list');
  host.replaceChildren();
  const filter = state.filter ?? {};
  const receipts = state.ledger.receipts.filter((receipt) => {
    if (filter.outcome && filter.outcome !== 'all' && receipt.outcome !== filter.outcome) return false;
    if (filter.reason && filter.reason !== 'all' && (receipt.reason ?? 'Unlabelled') !== filter.reason) return false;
    if (filter.text) {
      const haystack = `${receipt.memo} ${receipt.vendor} ${receipt.receipt_id}`.toLowerCase();
      if (!haystack.includes(filter.text.toLowerCase())) return false;
    }
    return true;
  });

  $('ledger-count').textContent = `${receipts.length} shown of ${state.ledger.total} on chain`;
  $('ledger-unread').textContent = state.ledger.unread
    ? `${state.ledger.unread} receipts of this agent are not read yet`
    : '';

  if (receipts.length === 0) {
    host.append(el('p', 'empty-state', 'No decisions match. Clear the filter, or point the console at another agent.'));
  }
  for (const receipt of receipts) host.append(renderReceipt(receipt));

  const more = $('ledger-more');
  more.hidden = state.ledger.unread === 0;
  more.textContent = state.ledger.unread
    ? `Read ${state.ledger.unread} more`
    : '';
}

/** The filters of the ledger. */
export function renderLedgerFilters(state) {
  const host = $('ledger-filters');
  host.replaceChildren();
  const outcomes = ['all', 'Approved', 'Denied', 'Failed'];
  for (const outcome of outcomes) {
    const button = el('button', 'chip-button', outcome === 'all' ? 'All outcomes' : outcome);
    if ((state.filter?.outcome ?? 'all') === outcome) button.setAttribute('aria-pressed', 'true');
    button.addEventListener('click', () => {
      state.filter = { ...(state.filter ?? {}), outcome };
      renderLedger(state);
      renderLedgerFilters(state);
    });
    host.append(button);
  }
  const search = el('input', 'filter-input');
  search.type = 'search';
  search.placeholder = 'Search memo, vendor or id';
  search.value = state.filter?.text ?? '';
  search.addEventListener('input', () => {
    state.filter = { ...(state.filter ?? {}), text: search.value };
    renderLedger(state);
  });
  host.append(search);
}

/**
 * One decision, with its evidence and a link that can be shared.
 */
export async function renderReceiptView(state, receiptId) {
  const host = $('receipt-view');
  host.replaceChildren();
  const found = state.ledger.receipts.find((receipt) => Number(receipt.receipt_id) === Number(receiptId));
  let receipt = found;
  if (!receipt) {
    try {
      receipt = await getReceipt(state.deployment, Number(receiptId));
    } catch (error) {
      host.append(el('p', 'empty-state', `Could not read receipt ${receiptId}: ${error.message}`));
      return;
    }
  }
  if (!receipt) {
    host.append(el('p', 'empty-state', `Receipt ${receiptId} does not exist.`));
    return;
  }
  const card = renderReceipt(receipt, { link: false });
  card.classList.add('single');
  host.append(card);
  const share = el('div', 'share-row');
  const link = el('input', 'share-link');
  link.readOnly = true;
  link.value = `${window.location.origin}${window.location.pathname}?contract=${state.deployment.contract}&agent=${state.deployment.agent}#/receipt/${receipt.receipt_id}`;
  share.append(link);
  share.append(copyButton(link.value, 'Copy link'));
  host.append(share);
}

/**
 * One request, with its state.
 */
export async function renderRequestView(state, requestId) {
  const host = $('receipt-view');
  host.replaceChildren();
  let request = state.requests.find((item) => Number(item.request_id) === Number(requestId));
  if (!request) {
    try {
      request = await getRequest(state.deployment, Number(requestId));
    } catch (error) {
      host.append(el('p', 'empty-state', `Could not read request ${requestId}: ${error.message}`));
      return;
    }
  }
  if (!request) {
    host.append(el('p', 'empty-state', `Request ${requestId} does not exist.`));
    return;
  }
  const info = requestState(request.status);
  const card = el('article', 'decision single');
  const head = el('div', 'decision-head');
  head.append(el('span', info.className, info.label));
  head.append(el('span', 'decision-id', `request #${request.request_id}`));
  head.append(el('span', 'decision-vendor mono', request.vendor));
  head.append(el('span', 'decision-amount', formatNear(request.amount)));
  card.append(head);
  const meta = el('div', 'decision-meta');
  meta.append(el('span', null, `nonce ${request.nonce}`));
  meta.append(el('span', null, new Date(timestampSeconds(request.created_at) * 1000).toLocaleString()));
  if (request.memo) meta.append(el('span', 'memo', request.memo));
  card.append(meta);
  if (request.receipt_id) {
    const link = el('a', null, `receipt № ${request.receipt_id}`);
    link.href = `#/receipt/${request.receipt_id}`;
    card.append(link);
  }
  host.append(card);
}

/**
 * The policy of the deployment, and the form that changes it.
 *
 * The form needs a wallet, so it is rendered as a read only summary until one
 * is connected. The write itself lives in wallet.js.
 */
export function renderPolicy(state) {
  const host = $('policy-view');
  host.replaceChildren();
  const { policy } = state;
  if (!policy) {
    host.append(el('p', 'empty-state', 'Reading the policy...'));
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
  host.append(table);

  const kill = el('div', 'policy-kill');
  kill.append(
    el('p', null, state.killSwitch ? 'The kill switch is on. No agent can ask and no request can be approved.' : 'The kill switch is off.'),
  );
  host.append(kill);
}

/**
 * The requests that are waiting, with the state the contract holds.
 */
export function renderRequests(state) {
  const host = $('requests-view');
  host.replaceChildren();
  const open = state.requests.filter((request) => request.status === 'Pending' || request.status === 'NeedsApproval');
  $('requests-count').textContent = `${open.length} waiting`;
  if (open.length === 0) {
    host.append(el('p', 'empty-state', 'No request is waiting for the owner.'));
    return;
  }
  for (const request of open) {
    const info = requestState(request.status);
    const card = el('article', 'decision');
    const head = el('div', 'decision-head');
    head.append(el('span', info.className, info.label));
    head.append(el('span', 'decision-id', `request #${request.request_id}`));
    head.append(el('span', 'decision-vendor mono', request.vendor));
    head.append(el('span', 'decision-amount', formatNear(request.amount)));
    card.append(head);
    const meta = el('div', 'decision-meta');
    meta.append(el('span', null, `nonce ${request.nonce}`));
    meta.append(el('span', null, new Date(timestampSeconds(request.created_at) * 1000).toLocaleString()));
    if (request.memo) meta.append(el('span', 'memo', request.memo));
    card.append(meta);
    const link = el('a', 'decision-link', 'open');
    link.href = `#/request/${request.request_id}`;
    card.append(link);
    const actions = el('div', 'decision-actions');
    const approve = el('button', 'ghost-button', 'Approve');
    approve.addEventListener('click', () => state.actions?.approve?.(request.request_id));
    const refuse = el('button', 'ghost-button', 'Refuse');
    refuse.addEventListener('click', () => {
      const reason = window.prompt('Why is this request refused?', 'the vendor is not on the allowlist');
      if (reason) state.actions?.reject?.(request.request_id, reason);
    });
    actions.append(approve);
    actions.append(refuse);
    card.append(actions);
    host.append(card);
  }
}

/**
 * The steps to enable SpendGuard, with the account names filled in.
 *
 * The names are editable here, so a third party reads their own accounts in
 * every command and can copy each one without editing it.
 */
export function renderEnable(state) {
  const host = $('steps');
  host.replaceChildren();
  const names = state.enableNames ?? { ...state.deployment };
  state.enableNames = names;

  const form = $('enable-names');
  form.replaceChildren();
  const fields = [
    ['contract', 'Owner and treasury account'],
    ['agent', 'Agent account'],
    ['vendor', 'Vendor account'],
  ];
  for (const [key, label] of fields) {
    const wrapper = el('label', 'field');
    wrapper.append(el('span', 'field-label', label));
    const input = el('input', 'field-input');
    input.type = 'text';
    input.value = names[key];
    input.spellcheck = false;
    input.addEventListener('input', () => {
      names[key] = input.value;
      renderEnable(state);
    });
    wrapper.append(input);
    form.append(wrapper);
  }

  const { contract, agent, vendor } = names;
  const steps = [
    {
      title: 'Create three funded testnet accounts',
      body: 'The owner holds the money, the agent asks to spend it, the vendor gets paid. Testnet NEAR is free from the faucet. One command per account.',
      cmd: [
        `near create-account ${contract} --use-account YOUR_MAIN_ACCOUNT --network-config testnet autogenerate-new-keypair save-to-legacy-keychain send`,
        `near create-account ${agent} --use-account YOUR_MAIN_ACCOUNT --network-config testnet autogenerate-new-keypair save-to-legacy-keychain send`,
        `near create-account ${vendor} --use-account YOUR_MAIN_ACCOUNT --network-config testnet autogenerate-new-keypair save-to-legacy-keychain send`,
      ].join('\n'),
    },
    {
      title: 'Build and deploy the policy contract',
      body: 'Two wasm files, built from the repository. The contract holds the money and the rules. The vendor is a counterparty account the demo pays.',
      cmd: `cargo near build --manifest-path contract/Cargo.toml\ncargo near build --manifest-path demo/vendor/Cargo.toml\nnear contract deploy ${contract} use-file contract/target/near/bound_contract.wasm with-init-call new json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send`,
    },
    {
      title: 'Register the agent with a policy',
      body: 'Budget, single spend cap, rate limit per minute and the vendor allowlist. One command, one transaction, signed by the owner. The amounts go in as base64 because the CLI turns a big JSON number into a float.',
      cmd: `near contract call-function as-transaction ${contract} register_agent base64-args "$(printf '{"agent_id":"${agent}","budget":5000000000000000000000000,"period_seconds":3600,"vendors":["${vendor}"],"max_single_spend":1000000000000000000000000,"rate_limit":5}' | base64 -w0)" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as ${contract} network-config testnet sign-with-legacy-keychain send`,
    },
    {
      title: 'Give the agent a scoped key',
      body: 'One receiver, one method, a gas cap. The key cannot call the vendor, cannot carry a deposit, and cannot afford an expensive call. Give the agent a little NEAR for gas as well, the CLI checks the balance before it sends.',
      cmd: `near account add-key ${agent} grant-function-call-access --allowance 0.2near --contract-account-id ${contract} --function-names request_spend autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send`,
    },
    {
      title: 'The agent asks to spend',
      body: 'Hard checks run inside the contract. A stranger, a budget breach or a rate breach is written as a denial with evidence, never silently accepted.',
      cmd: `near contract call-function as-transaction ${contract} request_spend base64-args "$(printf '{"agent_id":"${agent}","vendor":"${vendor}","amount":1000000000000000000000000,"nonce":1,"memo":"reference price lookup"}' | base64 -w0)" prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' sign-as ${agent} network-config testnet sign-with-access-key-file KEY send`,
    },
    {
      title: 'The owner approves, money moves, receipt exists',
      body: 'A human or a runner decides. The transfer is made by the contract, and both outcomes are receipts with reason, rule and evidence.',
      cmd: `near contract call-function as-transaction ${contract} approve_request json-args '{"request_id":0}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as ${contract} network-config testnet sign-with-legacy-keychain send`,
    },
    {
      title: 'Watch the feed, read the receipts',
      body: 'Every decision appears in the ledger with the rule that blocked it. A denial is a legitimate outcome, not an error message.',
      cmd: curlReceiptCount(contract),
    },
    {
      title: 'Revoke the agent instantly',
      body: 'Delete the scoped key. The agent cannot sign a request at all.',
      cmd: `near account delete-keys ${agent} public-keys PUBLIC_KEY network-config testnet sign-with-legacy-keychain send`,
    },
  ];

  steps.forEach((step, index) => {
    const li = el('li', 'step');
    li.append(el('div', 'step-num', String(index + 1)));
    const body = el('div', 'step-body');
    body.append(el('h3', 'step-title', step.title));
    body.append(el('p', null, step.body));
    const pre = el('pre', 'step-code');
    pre.textContent = step.cmd;
    body.append(pre);
    body.append(copyButton(step.cmd));
    li.append(body);
    host.append(li);
  });
}

/** The base64 of some text, without Node's Buffer. */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A curl that reads the receipt count of a contract. */
export function curlReceiptCount(contract) {
  const args = toBase64('{}');
  return `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"${contract}","method_name":"get_receipt_count","args_base64":"${args}","finality":"final"}}'`;
}

/** A curl that reads one receipt of a contract. */
export function curlReceipt(contract, receiptId) {
  const args = toBase64(JSON.stringify({ receipt_id: receiptId }));
  return `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"${contract}","method_name":"get_receipt","args_base64":"${args}","finality":"final"}}'`;
}

/** A curl that reads the policy of an agent. */
export function curlPolicy(contract, agent) {
  const args = toBase64(JSON.stringify({ agent_id: agent }));
  return `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"${contract}","method_name":"get_policy","args_base64":"${args}","finality":"final"}}'`;
}

/**
 * The judge evidence, with the curls that run as they are printed.
 *
 * The args are base64 encoded here, not in the page, because a shell does
 * not expand a substitution inside single quotes.
 */
export function renderJudge(state) {
  const host = $('judge-body');
  host.replaceChildren();
  const { contract, agent } = state.deployment;
  const blocks = [
    ['1. The policy', 'The rules the contract holds for this agent.', curlPolicy(contract, agent)],
    ['2. A decision, with its evidence', 'Receipt 18, the transfer that failed and gave the budget back.', curlReceipt(contract, 18)],
    ['3. The treasury and the key', 'The key list of the agent, scoped to one method on one contract.', `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"view_access_key_list","account_id":"${agent}","finality":"final"}}'`],
    ['4. Count the decisions', 'How many receipts the contract holds.', curlReceiptCount(contract)],
  ];
  for (const [title, note, cmd] of blocks) {
    host.append(el('h3', 'panel-title', title));
    host.append(el('p', 'muted small', note));
    const pre = el('pre', 'code-block', cmd);
    host.append(pre);
    host.append(copyButton(cmd, 'Copy curl'));
  }
  const notes = el('ul', 'evidence-notes');
  notes.append(el('li', null, 'No database and no cache. The numbers this site prints come from these calls.'));
  notes.append(el('li', null, 'The receipts survive the redeploy in transaction Bb64yQtpRcu1yFJyRWeizXZMRJnJY4HBDCWwKxoJw7Ls, storage was untouched.'));
  notes.append(el('li', null, 'This repository is the evidence. The code is MIT.'));
  host.append(el('h3', 'panel-title', 'Why it is like this'));
  host.append(notes);
}

/** The name of the owner account, taken from the contract's own name. */
function ownerName(contract) {
  return contract.replace(/-testnet\.testnet$/, '');
}

export { formatYocto, outcomeClass };
