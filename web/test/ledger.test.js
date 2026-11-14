import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './dom-shim.js';
import { renderLedger, renderFilters, ledgerErrorSummary } from '../views/ledger.js';

const document = makeDocument();
globalThis.document = document;

document.register('ledger-list', document.createElement('div'));
document.register('ledger-count', document.createElement('div'));
document.register('ledger-unread', document.createElement('div'));
document.register('ledger-more', document.createElement('button'));
document.register('ledger-filters', document.createElement('div'));

const receipt = (id, outcome, memo = '') => ({
  receipt_id: id,
  agent_id: 'bound-agent.testnet',
  vendor: 'vendor.testnet',
  amount: '1000000000000000000000000',
  memo,
  outcome,
  created_at: '0',
  nonce: 0,
  rule: 'the policy',
  evidence: [],
  spent_after: '0',
  period_start: '0',
});

test('renderLedger shows agent receipts against the global count, never N of N', () => {
  const state = {
    filter: { outcome: 'all', text: '' },
    ledger: {
      receipts: [receipt(5, 'Approved'), receipt(7, 'Denied', 'memo')],
      agentTotal: 2,
      globalTotal: 11,
      errors: 1,
      failedIds: [9],
      complete: false,
      fallback: false,
      pageSize: 25,
      offset: 0,
    },
  };
  renderLedger(state);
  assert.strictEqual(
    document.getElementById('ledger-count').textContent,
    '2 for this agent on this page, 11 receipts on chain',
  );
  assert.strictEqual(
    document.getElementById('ledger-unread').textContent,
    '1 receipt read could not complete',
  );
  assert.ok(document.getElementById('ledger-list').children.length >= 2);
});

test('ledgerErrorSummary lists the exact failed ids', () => {
  const summary = ledgerErrorSummary({ errors: 2, failedIds: [9, 41] });
  assert.ok(summary.textContent.includes('Could not read 2 receipts'));
  assert.ok(summary.textContent.includes('receipt #9'));
  assert.ok(summary.textContent.includes('receipt #41'));
  assert.strictEqual(ledgerErrorSummary({ errors: 0 }), null);
});

test('the historical fallback is labelled', () => {
  const state = {
    filter: { outcome: 'all', text: '' },
    ledger: {
      receipts: [],
      agentTotal: 0,
      globalTotal: 3,
      errors: 0,
      failedIds: [],
      complete: true,
      fallback: true,
      pageSize: 25,
      offset: 0,
    },
  };
  renderLedger(state);
  assert.ok(document.getElementById('ledger-count').textContent.includes('historical fallback'));
});

test('the filter row offers every outcome, including the expired one', () => {
  const host = document.getElementById('ledger-filters');
  host.children = [];
  renderFilters({ filter: { outcome: 'all', text: '' } }, () => {});
  const chips = host.children.filter((child) => child.tagName === 'BUTTON');
  const labels = chips.map((chip) => chip.textContent);
  assert.ok(labels.includes('Approved'));
  assert.ok(labels.includes('Denied'));
  assert.ok(labels.includes('Failed'));
  assert.ok(labels.includes('Expired'));
});

test('the search field is not remounted while the reader types', () => {
  const host = document.getElementById('ledger-filters');
  host.children = [];
  const state = { filter: { outcome: 'all', text: '' } };
  renderFilters(state, () => {});
  const search = host.querySelector('input.filter-input');
  assert.ok(search);

  renderFilters({ filter: { outcome: 'all', text: 'price' } }, () => {});
  const after = host.querySelector('input.filter-input');
  assert.strictEqual(after, search, 'the same field is still there');
  assert.strictEqual(after.value, 'price');
});

test('the expired receipts can be filtered on their own', () => {
  const state = {
    filter: { outcome: 'Expired', text: '' },
    ledger: {
      receipts: [receipt(5, 'Approved'), receipt(7, 'Expired', 'memo')],
      agentTotal: 2,
      globalTotal: 11,
      errors: 0,
      failedIds: [],
      complete: true,
      fallback: false,
      pageSize: 25,
      offset: 0,
    },
  };
  renderLedger(state);
  const list = document.getElementById('ledger-list');
  assert.strictEqual(list.children.length, 1);
  assert.ok(list.textContent.includes('Expired'));
});
