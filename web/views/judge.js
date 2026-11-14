/**
 * The judge evidence: the curls that reproduce the numbers of the selected
 * deployment, run against the public testnet RPC at finality `final`.
 *
 * Nothing here is hardcoded to the historical demo except the last section,
 * which is labelled historical evidence.
 */

import { el, mount } from '../lib/dom.js';
import { copyButton } from '../components/copy.js';
import { curlPolicy, curlReceipt, curlReceiptCount } from './enable.js';

/**
 * @param {object} state
 */
export function renderJudge(state) {
  const host = document.getElementById('judge-body');
  if (!host) return;
  const { contract, agent } = state.deployment;
  const receipts = (state.ledger && state.ledger.receipts) ?? [];
  const newest = receipts[0] ?? null;

  const blocks = [
    ['1. The policy', 'The rules the contract holds for this agent.', curlPolicy(contract, agent)],
    [
      '2. One decision, with its evidence',
      newest
        ? `Receipt ${newest.receipt_id}, the newest decision of this agent on this page.`
        : 'No receipt on this page to read. Pick a deployment with receipts, or read any receipt by id.',
      newest ? curlReceipt(contract, newest.receipt_id) : 'No receipt id to read.',
    ],
    [
      '3. The treasury and the key',
      'The contract balance and the key list of the agent, scoped to one method on one contract.',
      `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"view_access_key_list","account_id":"${agent}","finality":"final"}}'\n\ncurl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"2","method":"query","params":{"request_type":"call_function","account_id":"${contract}","method_name":"treasury_balance","args_base64":"${btoa('{}')}","finality":"final"}}'`,
    ],
    ['4. Count the decisions', 'How many receipts the contract holds, for every agent.', curlReceiptCount(contract)],
  ];
  const nodes = [];
  for (const [title, note, cmd] of blocks) {
    nodes.push(el('h3', 'panel-title', title));
    nodes.push(el('p', 'muted small', note));
    if (cmd) {
      nodes.push(el('pre', 'code-block', cmd));
      nodes.push(copyButton(cmd, 'Copy curl'));
    }
  }

  const history = el('div', 'judge-history');
  history.append(el('h3', 'panel-title', 'Historical evidence (the earlier artifact)'));
  history.append(
    el(
      'p',
      'muted small',
      'The receipts on chain survive the redeploy of 2026-11-11, transaction Bb64yQtpRcu1yFJyRWeizXZMRJnJY4HBDCWwKxoJw7Ls; storage was untouched. This is the historical deployment. The remediated contract is the one on the chain now.',
    ),
  );
  history.append(
    el(
      'p',
      'muted small',
      'Explorer: https://testnet.nearblocks.io/transactions/Bb64yQtpRcu1yFJyRWeizXZMRJnJY4HBDCWwKxoJw7Ls',
    ),
  );
  nodes.push(history);

  const notes = el('ul', 'evidence-notes');
  notes.append(
    el(
      'li',
      null,
      'No server database. The numbers this site prints come from these final chain calls. A small browser cache avoids repeating reads for the same deployment.',
    ),
  );
  notes.append(
    el('li', null, 'Every call uses finality `final`, so a judge sees the same final state from any machine.'));
  notes.append(el('li', null, 'This repository is the evidence. The code is MIT.'));
  nodes.push(el('h3', 'panel-title', 'Why it is like this'));
  nodes.push(notes);
  mount(host, ...nodes);
}
