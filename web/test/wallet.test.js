import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonArgs } from '../lib/wallet.js';

test('wallet arguments are JSON argument objects, not Borsh arrays', () => {
  const bytes = jsonArgs({ request_id: 7, reason: 'not on the allowlist' });
  assert.deepStrictEqual(
    [...bytes],
    [...new TextEncoder().encode(JSON.stringify({ request_id: 7, reason: 'not on the allowlist' }))],
  );
});

test('values above 2^53 survive as strings in the JSON argument object', () => {
  const bytes = jsonArgs({ budget: '5000000000000000000000000' });
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('5000000000000000000000000'));
  assert.strictEqual(JSON.parse(text).budget, '5000000000000000000000000');
});

test('jsonArgs rejects non-objects', () => {
  assert.throws(() => jsonArgs(null));
  assert.throws(() => jsonArgs([1, 2, 3]));
  assert.throws(() => jsonArgs('not an object'));
});
