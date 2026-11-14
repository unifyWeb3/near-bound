import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReceiptCache,
  deploymentSame,
  isDeployment,
  isAccountId,
} from '../lib/deployment.js';

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  },
};

const deploymentA = { contract: 'a.testnet', agent: 'agent-a.testnet', vendor: 'vendor-a.testnet' };
const deploymentB = { contract: 'a.testnet', agent: 'agent-a.testnet', vendor: 'vendor-b.testnet' };

test('isDeployment validates all three accounts', () => {
  assert.ok(isDeployment(deploymentA));
  assert.ok(!isDeployment({ contract: 'a.testnet', agent: 'agent-a.testnet' }));
  assert.ok(!isDeployment(null));
  assert.ok(!isDeployment('a.testnet'));
});

test('deploymentSame needs all three accounts to match', () => {
  assert.ok(deploymentSame(deploymentA, { ...deploymentA }));
  assert.ok(!deploymentSame(deploymentA, deploymentB));
});

test('isAccountId accepts testnet accounts and rejects garbage', () => {
  assert.ok(isAccountId('bound-testnet-97685.testnet'));
  assert.ok(!isAccountId('NotAnAccount'));
  assert.ok(!isAccountId('a'));
  assert.ok(!isAccountId(null));
});

test('a cache holds receipts for one deployment only', () => {
  storage.clear();
  const cache = createReceiptCache();
  cache.load(deploymentA);
  cache.set(1, { receipt_id: 1, agent_id: 'agent-a.testnet' });
  cache.set(2, { receipt_id: 2, agent_id: 'agent-a.testnet' });
  cache.save(deploymentA);

  const other = createReceiptCache();
  other.load(deploymentB);
  assert.ok(!other.has(1));
  assert.deepStrictEqual([...other.values()], []);

  const again = createReceiptCache();
  again.load(deploymentA);
  assert.ok(again.has(1));
  assert.strictEqual(again.get(2).receipt_id, 2);
});

test('missing reports which ids are not cached', () => {
  const cache = createReceiptCache();
  cache.set(1, { receipt_id: 1 });
  assert.deepStrictEqual(cache.missing([1, 2, 3]), [2, 3]);
});

test('the cache drops receipts the chain cannot have', () => {
  storage.clear();
  const cache = createReceiptCache();
  cache.load(deploymentA);
  cache.set(0, { receipt_id: 0 });
  cache.set(1, { receipt_id: 1 });
  cache.set(29, { receipt_id: 29 });

  // A deployment that was wiped starts its receipt ids at zero again.
  const dropped = cache.pruneBeyond(3);
  assert.strictEqual(dropped, 1);
  assert.ok(!cache.has(29));
  assert.ok(cache.has(0));
  assert.ok(cache.has(1));
});
