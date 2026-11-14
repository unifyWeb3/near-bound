import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './dom-shim.js';
import { requestTiming, renderRequests } from '../views/requests.js';
import { renderRequest } from '../views/receipt.js';

const document = makeDocument();
globalThis.document = document;

const now = Math.floor(Date.now() / 1000);

test('requestTiming: a legacy request with no expiry is unknown, not zero', () => {
  const timing = requestTiming({ request_id: 3, created_at: now - 100 });
  assert.strictEqual(timing.expiryUnknown, true);
  assert.strictEqual(timing.expires, 'unknown');
  assert.strictEqual(timing.expired, false);
  assert.strictEqual(timing.countdown, null);
  assert.strictEqual(timing.age, '1 minute ago');
});

test('requestTiming: a past expiry is an expired request', () => {
  const timing = requestTiming({ request_id: 4, created_at: now - 2000, expires_at: now - 100 });
  assert.strictEqual(timing.expiryUnknown, false);
  assert.strictEqual(timing.expired, true);
  assert.strictEqual(timing.countdown, 'expired');
});

test('requestTiming: a future expiry shows a countdown', () => {
  const timing = requestTiming({ request_id: 4, created_at: now - 100, expires_at: now + 7200 }, now);
  assert.strictEqual(timing.expired, false);
  assert.strictEqual(timing.countdown, '2 hours');
});

document.register('requests-view', document.createElement('div'));
document.register('requests-count', document.createElement('div'));
document.register('receipt-view', document.createElement('div'));

test('renderRequests shows the open count and oldest age', () => {
  const state = {
    requests: {
      items: [{ request_id: 0, status: 'Pending', agent_id: 'a', vendor: 'v.testnet', amount: '1', nonce: 1, memo: 'm', created_at: String(now - 500) }],
      owner: 'owner.testnet',
      runner: 'runner.testnet',
      errors: 0,
      failedIds: [],
      complete: true,
      fallback: false,
    },
    wallet: { accountId: 'owner.testnet' },
    actions: {},
    deployment: { agent: 'bound-agent.testnet' },
  };
  renderRequests(state, () => {});
  assert.strictEqual(
    document.getElementById('requests-count').textContent,
    '1 open · oldest opened 8 minutes ago',
  );
});

test('renderRequests shows the available open count when the page is incomplete', () => {
  const state = {
    requests: {
      items: [{
        request_id: 0,
        status: 'Pending',
        agent_id: 'bound-agent.testnet',
        vendor: 'vendor.testnet',
        amount: '1',
        nonce: 1,
        created_at: String(now - 500),
      }],
      openCount: 51,
      errors: 0,
      failedIds: [],
      complete: false,
      fallback: false,
    },
    wallet: { accountId: null },
    actions: {},
    deployment: { agent: 'bound-agent.testnet' },
  };
  renderRequests(state, () => {});
  assert.ok(document.getElementById('requests-count').textContent.startsWith('51 open'));
  assert.ok(document.getElementById('requests-view').textContent.includes('cut off'));
});

test('a queue that was only partly read does not claim that nothing is waiting', () => {
  const state = {
    requests: {
      items: [],
      owner: 'owner.testnet',
      runner: 'runner.testnet',
      errors: 0,
      failedIds: [],
      complete: false,
      fallback: true,
      total: 0,
    },
    wallet: { accountId: 'owner.testnet' },
    actions: {},
    deployment: { agent: 'bound-agent.testnet' },
  };
  renderRequests(state, () => {});
  const text = document.getElementById('requests-view').textContent;
  assert.ok(
    !text.includes('No request is waiting for the owner.'),
    'an incomplete queue must not claim the queue is empty',
  );
  assert.ok(text.includes('Older requests were not read'));
});

test('a complete empty queue says so', () => {
  const state = {
    requests: {
      items: [],
      owner: 'owner.testnet',
      runner: 'runner.testnet',
      errors: 0,
      failedIds: [],
      complete: true,
      fallback: false,
    },
    wallet: { accountId: 'owner.testnet' },
    actions: {},
    deployment: { agent: 'bound-agent.testnet' },
  };
  renderRequests(state, () => {});
  assert.ok(
    document.getElementById('requests-view').textContent.includes('No request is waiting for the owner.'),
  );
});

test('renderRequests lists exact failed request ids', () => {
  const state = {
    requests: {
      items: [],
      owner: 'owner.testnet',
      runner: 'runner.testnet',
      errors: 1,
      failedIds: [3],
      complete: false,
      fallback: false,
    },
    wallet: { accountId: 'owner.testnet' },
    actions: {},
    deployment: { agent: 'bound-agent.testnet' },
  };
  renderRequests(state, () => {});
  assert.ok(document.getElementById('requests-view').textContent.includes('request #3'));
  assert.ok(document.getElementById('requests-view').textContent.includes('not a complete queue'));
});

test('renderRequest reads request id zero from state.requests.items', async () => {
  const state = {
    requests: {
      items: [{
        request_id: 0,
        status: 'Pending',
        agent_id: 'bound-agent.testnet',
        vendor: 'vendor.testnet',
        nonce: 1,
        memo: 'the first request',
      }],
    },
    deployment: { contract: 'contract.testnet', agent: 'bound-agent.testnet' },
  };

  await renderRequest(state, '0');

  const text = document.getElementById('receipt-view').textContent;
  assert.ok(text.includes('request #0'));
  assert.ok(text.includes('vendor.testnet'));
  assert.ok(text.includes('the first request'));
});

test('the approval confirmation does not promise a receipt before the transfer settles', () => {
  const state = {
    requests: {
      items: [{
        request_id: 7,
        status: 'Pending',
        agent_id: 'bound-agent.testnet',
        vendor: 'vendor.testnet',
        amount: '1',
        nonce: 1,
        created_at: String(now - 10),
      }],
      owner: 'owner.testnet',
      runner: 'runner.testnet',
      errors: 0,
      failedIds: [],
      complete: true,
      fallback: false,
    },
    wallet: { accountId: 'owner.testnet' },
    actions: {},
    owner: 'owner.testnet',
    runner: 'runner.testnet',
    deployment: { agent: 'bound-agent.testnet' },
  };
  renderRequests(state, () => {});

  const cards = document.getElementById('requests-view').children;
  const approve = cards
    .flatMap((card) => card.children)
    .flatMap((child) => child.children || [])
    .find((child) => child.tagName === 'BUTTON' && child._text === 'Approve');
  assert.ok(approve, 'the owner sees the approve button');

  approve.click();
  const panel = document.body.children[0];
  const text = panel.textContent;
  assert.ok(text.includes('reserves the budget'), text);
  assert.ok(
    !text.includes('writes an Approved receipt'),
    'the receipt is only written when the transfer settles',
  );
  assert.ok(text.includes('Approved if the money moved'), text);
});
