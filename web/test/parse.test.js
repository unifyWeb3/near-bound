import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBigJson, toBase64 } from '../lib/api.js';

test('parseBigJson keeps u128 amounts exact instead of losing them to floats', () => {
  const object = parseBigJson(
    '{"amount":5000000000000000000000000,"small":5,"exact":9007199254740993}',
  );
  assert.strictEqual(object.amount, '5000000000000000000000000');
  assert.strictEqual(object.small, 5);
  assert.strictEqual(object.exact, '9007199254740993');
});

test('parseBigJson handles nested objects and arrays', () => {
  const object = parseBigJson('{"receipts":[{"receipt_id":1,"amount":12345678901234567890123456}]}');
  assert.strictEqual(object.receipts[0].amount, '12345678901234567890123456');
});

test('parseBigJson does not touch a long number inside a string', () => {
  const object = parseBigJson('{"memo":"x:123456789012345678}","amount":5000000000000000000000000}');
  assert.strictEqual(object.memo, 'x:123456789012345678}');
  assert.strictEqual(object.amount, '5000000000000000000000000');
});

test('parseBigJson quotes a long number in an array', () => {
  const object = parseBigJson('{"ids":[12345678901234567890]}');
  assert.deepStrictEqual(object.ids, ['12345678901234567890']);
});

test('toBase64 encodes text outside Latin-1', () => {
  assert.strictEqual(toBase64('{}'), 'e30=');
  // The bytes are UTF-8, so a character outside Latin-1 takes two bytes.
  assert.strictEqual(toBase64('né'), 'bsOp');
  assert.strictEqual(
    Buffer.from(toBase64('{"reason":"café"}'), 'base64').toString(),
    '{"reason":"café"}',
  );
});
