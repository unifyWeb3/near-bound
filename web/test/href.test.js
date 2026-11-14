import { test } from 'node:test';
import assert from 'node:assert/strict';
import { href } from '../lib/router.js';

test('id zero produces a valid route instead of being dropped by truthiness', () => {
  assert.strictEqual(href('receipt', 0), '#/receipt/0');
  assert.strictEqual(href('request', 0), '#/request/0');
  assert.strictEqual(href('receipt', 18), '#/receipt/18');
  assert.strictEqual(href('ledger'), '#/ledger');
});
