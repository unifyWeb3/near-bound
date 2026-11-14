/**
 * The steps to enable Certalyn, with the account names filled in.
 *
 * The names are editable here, so a third party reads their own accounts in
 * every command and can copy each one without editing it. Values above 2^53
 * go in as base64 args so the CLI cannot turn them into floats.
 */

import { el, mount } from '../lib/dom.js';
import { copyButton } from '../components/copy.js';
import { field } from '../components/field.js';

/**
 * Fresh-looking names for the local enable walkthrough.
 *
 * They are deliberately separate from the selected deployment. A reader who
 * copies the commands must create these accounts, not try to recreate the
 * historical `bound-*` accounts. The fields stay editable because a NEAR
 * account id is a global namespace.
 */
export const DEFAULT_ENABLE_NAMES = Object.freeze({
  contract: 'certalyn-owner.testnet',
  agent: 'certalyn-agent.testnet',
  vendor: 'certalyn-vendor.testnet',
});

/**
 * A curl that reads the receipt count of a contract.
 *
 * @param {string} contract
 */
export function curlReceiptCount(contract) {
  const args = btoa('{}');
  return `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"${contract}","method_name":"get_receipt_count","args_base64":"${args}","finality":"final"}}'`;
}

/**
 * A curl that reads one receipt of a contract.
 *
 * @param {string} contract
 * @param {number} receiptId
 */
export function curlReceipt(contract, receiptId) {
  const args = btoa(JSON.stringify({ receipt_id: receiptId }));
  return `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"${contract}","method_name":"get_receipt","args_base64":"${args}","finality":"final"}}'`;
}

/**
 * A curl that reads the policy of an agent.
 *
 * @param {string} contract
 * @param {string} agent
 */
export function curlPolicy(contract, agent) {
  const args = btoa(JSON.stringify({ agent_id: agent }));
  return `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"${contract}","method_name":"get_policy","args_base64":"${args}","finality":"final"}}'`;
}

/**
 * The phases of the setup.
 *
 * Eight commands in one list is a wall. The phases give the screen one job
 * and one order: get the accounts, put the contract in place, give the agent
 * its key, make a decision, take the key back.
 */
export const SETUP_PHASES = Object.freeze([
  { id: 'accounts', title: 'Accounts', note: 'Three funded testnet accounts.' },
  { id: 'contract', title: 'Contract and policy', note: 'The contract, the agent and its limits.' },
  { id: 'access', title: 'Access', note: 'One scoped key, and nothing more.' },
  { id: 'decisions', title: 'Decisions', note: 'Ask, approve, read the receipt.' },
  { id: 'revoke', title: 'Revoke', note: 'Stop the agent with one transaction.' },
]);

/**
 * The steps, with the names the reader typed.
 *
 * @param {{contract: string, agent: string, vendor: string}} names
 * @returns {Array<{title: string, body: string, cmd: string, phase: string}>}
 */
export function enableSteps(names) {
  const { contract, agent, vendor } = names;
  return [
    {
      phase: 'accounts',
      title: 'Create three funded testnet accounts',
      body: 'The owner holds the money, the agent asks to spend it, the vendor gets paid. Testnet NEAR is free from the faucet. Use the three names shown above, or replace every name first if one is already taken. Replace YOUR_MAIN_ACCOUNT with an account that holds testnet NEAR.',
      cmd: [
        `near create-account ${contract} --use-account YOUR_MAIN_ACCOUNT --network-config testnet send`,
        `near create-account ${agent} --use-account YOUR_MAIN_ACCOUNT --network-config testnet send`,
        `near create-account ${vendor} --use-account YOUR_MAIN_ACCOUNT --network-config testnet send`,
      ].join('\n'),
    },
    {
      phase: 'contract',
      title: 'Build and deploy the policy contract',
      body: 'The build is pinned: the repository script uses Rust 1.99.1 and Binaryen 133, builds the contract twice and deploys only the artifact whose SHA-256 matches on both builds. The wasm path is that verified release build output.',
      cmd: [
        'scripts/build-wasm.sh',
        `near contract deploy ${contract} use-file contract/target/wasm32-unknown-unknown/release/bound_contract.wasm with-init-call new json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send`,
      ].join('\n'),
    },
    {
      phase: 'contract',
      title: 'Register the agent with a policy',
      body: 'Budget, single spend cap, rate limit per minute and the vendor allowlist. One command, one transaction, signed by the owner. The amounts go in as base64 args because they are above 2^53.',
      cmd: `near contract call-function as-transaction ${contract} register_agent base64-args "$(printf '{"agent_id":"${agent}","budget":5000000000000000000000000,"period_seconds":3600,"vendors":["${vendor}"],"max_single_spend":1000000000000000000000000,"rate_limit":5}' | base64 -w0)" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as ${contract} network-config testnet sign-with-legacy-keychain send`,
    },
    {
      phase: 'access',
      title: 'Give the agent a scoped key',
      body: 'One receiver, one method, a gas cap and a small allowance. The key cannot call the vendor, cannot carry a deposit, and cannot afford an expensive call. Give the agent a little NEAR for gas as well. This step prints the public key and the key-file path. Step 5 uses that path in place of KEY, and step 8 uses the public key in place of PUBLIC_KEY.',
      cmd: `near account add-key ${agent} grant-function-call-access --allowance 0.2near --contract-account-id ${contract} --function-names request_spend autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send`,
    },
    {
      phase: 'decisions',
      title: 'The agent asks to spend',
      body: 'Hard checks run inside the contract. A stranger, a budget breach or a rate breach is written as a denial with evidence, never silently accepted. The amount goes in as base64 args because it is above 2^53.',
      cmd: `near contract call-function as-transaction ${contract} request_spend base64-args "$(printf '{"agent_id":"${agent}","vendor":"${vendor}","amount":1000000000000000000000000,"nonce":1,"memo":"reference price lookup"}' | base64 -w0)" prepaid-gas '20.0 Tgas' attached-deposit '0 NEAR' sign-as ${agent} network-config testnet sign-with-access-key-file KEY send`,
    },
    {
      phase: 'decisions',
      title: 'The owner approves, money moves, receipt exists',
      body: 'A human or a runner decides. Use the request id returned by step 5; do not hardcode 0. The transfer is made by the contract as a plain NEAR transfer, and both outcomes are receipts with reason, rule and evidence.',
      cmd: `near contract call-function as-transaction ${contract} approve_request json-args '{"request_id":REQUEST_ID}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as ${contract} network-config testnet sign-with-legacy-keychain send`,
    },
    {
      phase: 'decisions',
      title: 'Watch the feed, read the receipts',
      body: 'Every decision appears in the ledger with the rule that blocked it. A denial is a legitimate outcome, not an error message.',
      cmd: curlReceiptCount(contract),
    },
    {
      phase: 'revoke',
      title: 'Revoke the agent instantly',
      body: 'Delete the scoped key. The agent cannot sign a request at all. Paste the public key printed by step 4 where PUBLIC_KEY appears.',
      cmd: `near account delete-keys ${agent} public-keys PUBLIC_KEY network-config testnet sign-with-legacy-keychain send`,
    },
  ];
}

/**
 * The enable view: the account names, then the steps.
 *
 * @param {object} state
 * @param {(names: object) => void} update
 */
export function renderEnable(state, update) {
  const names = state.enableNames ?? { ...DEFAULT_ENABLE_NAMES };
  state.enableNames = names;

  const form = document.getElementById('enable-names');
  // The name fields are built once. Remounting them on every keystroke
  // would take the caret away from the field being typed in.
  if (form && !form.certalynNamesMounted) {
    const fields = [
      ['contract', 'Owner and treasury account'],
      ['agent', 'Agent account'],
      ['vendor', 'Vendor account'],
    ].map(([key, label]) =>
      field({
        label,
        value: names[key],
        onChange: (value) => {
          names[key] = value;
          update(names);
        },
      }).wrapper,
    );
    mount(form, ...fields);
    form.certalynNamesMounted = true;
  }

  const host = document.getElementById('steps');
  if (!host) return;
  const steps = enableSteps(names);

  // The rail names the phases and moves the reader to one. It does not use
  // a hash link, because the hash belongs to the router.
  const rail = document.getElementById('setup-rail');
  if (rail) {
    const items = SETUP_PHASES.map((phase, index) => {
      const button = el('button', 'rail-link', `${index + 1}. ${phase.title}`, {
        type: 'button',
      });
      button.addEventListener('click', () => {
        const target = document.getElementById(`phase-${phase.id}`);
        if (!target) return;
        const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        target.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
      });
      const wrapper = el('div', 'rail-item');
      wrapper.append(button, el('span', 'rail-note', phase.note));
      return wrapper;
    });
    mount(rail, ...items);
  }

  // The steps, grouped by phase, each phase with its own heading.
  const groups = [];
  for (const step of steps) {
    let group = groups[groups.length - 1];
    if (!group || group.phase !== step.phase) {
      group = { phase: step.phase, steps: [] };
      groups.push(group);
    }
    group.steps.push(step);
  }

  const nodes = [];
  let number = 0;
  for (const group of groups) {
    const phase = SETUP_PHASES.find((candidate) => candidate.id === group.phase);
    const heading = el('div', 'phase-head');
    heading.setAttribute('id', `phase-${group.phase}`);
    const title = el('h3', 'phase-title');
    title.textContent = phase ? phase.title : group.phase;
    const note = el('p', 'phase-note');
    note.textContent = phase ? phase.note : '';
    heading.append(title, note);
    nodes.push(heading);

    const list = el('ol', 'steps');
    for (const step of group.steps) {
      number += 1;
      const li = el('li', 'step');
      li.append(el('div', 'step-num', String(number)));
      const body = el('div', 'step-body');
      body.append(el('h3', 'step-title', step.title));
      body.append(el('p', null, step.body));
      const pre = el('pre', 'step-code');
      pre.textContent = step.cmd;
      body.append(pre);
      body.append(copyButton(step.cmd));
      li.append(body);
      list.append(li);
    }
    nodes.push(list);
  }

  const commandCount = steps.reduce((sum, step) => sum + (step.cmd.match(/\n/g)?.length ?? 0) + 1, 0);
  const summary = el('p', 'muted small');
  summary.textContent = `${steps.length} steps, ${commandCount} commands. Copy each command with the button beside it, and paste in the values marked like REQUEST_ID or PUBLIC_KEY.`;
  nodes.push(summary);
  mount(host, ...nodes);
}
