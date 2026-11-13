/**
 * The judge evidence: the curls that reproduce every number.
 *
 * The args are base64 encoded here, not in the page, because a shell does not
 * expand a substitution inside single quotes.
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
  const blocks = [
    ['1. The policy', 'The rules the contract holds for this agent.', curlPolicy(contract, agent)],
    [
      '2. A decision, with its evidence',
      'Receipt 18, the transfer that failed and gave the budget back.',
      curlReceipt(contract, 18),
    ],
    [
      '3. The treasury and the key',
      'The key list of the agent, scoped to one method on one contract.',
      `curl -s -X POST https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"view_access_key_list","account_id":"${agent}","finality":"final"}}'`,
    ],
    ['4. Count the decisions', 'How many receipts the contract holds.', curlReceiptCount(contract)],
  ];
  const nodes = [];
  for (const [title, note, cmd] of blocks) {
    nodes.push(el('h3', 'panel-title', title));
    nodes.push(el('p', 'muted small', note));
    nodes.push(el('pre', 'code-block', cmd));
    nodes.push(copyButton(cmd, 'Copy curl'));
  }
  const notes = el('ul', 'evidence-notes');
  notes.append(el('li', null, 'No database and no cache. The numbers this site prints come from these calls.'));
  notes.append(
    el(
      'li',
      null,
      'The receipts survive the redeploy in transaction Bb64yQtpRcu1yFJyRWeizXZMRJnJY4HBDCWwKxoJw7Ls, storage was untouched.',
    ),
  );
  notes.append(el('li', null, 'This repository is the evidence. The code is MIT.'));
  nodes.push(el('h3', 'panel-title', 'Why it is like this'));
  nodes.push(notes);
  mount(host, ...nodes);
}
