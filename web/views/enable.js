/**
 * The steps to enable SpendGuard, with the account names filled in.
 *
 * The names are editable here, so a third party reads their own accounts in
 * every command and can copy each one without editing it.
 */

import { el, mount } from '../lib/dom.js';
import { copyButton } from '../components/copy.js';
import { field } from '../components/field.js';

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
 * The steps, with the names the reader typed.
 *
 * @param {{contract: string, agent: string, vendor: string}} names
 */
export function enableSteps(names) {
  const { contract, agent, vendor } = names;
  return [
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
}

/**
 * The enable view: the account names, then the steps.
 *
 * @param {object} state
 * @param {(names: object) => void} update
 */
export function renderEnable(state, update) {
  const names = state.enableNames ?? { ...state.deployment };
  state.enableNames = names;

  const form = document.getElementById('enable-names');
  if (form) {
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
  }

  const host = document.getElementById('steps');
  if (!host) return;
  const nodes = enableSteps(names).map((step, index) => {
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
    return li;
  });
  mount(host, ...nodes);
}
