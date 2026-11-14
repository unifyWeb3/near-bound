import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './dom-shim.js';
import { requestTiming, renderRequests } from '../views/requests.js';

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
