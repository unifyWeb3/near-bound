import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './dom-shim.js';
import { outcomeLabel, stateLabel, stateWords } from '../components/badge.js';

test('every receipt outcome has a label', () => {
  assert.strictEqual(outcomeLabel('Approved'), 'approved');
  assert.strictEqual(outcomeLabel('Denied'), 'denied');
  assert.strictEqual(outcomeLabel('Failed'), 'failed');
  assert.strictEqual(outcomeLabel('Expired'), 'expired');
});

test('every request state has a label and words', () => {
  assert.strictEqual(stateLabel('Pending'), 'pending');
  assert.strictEqual(stateLabel('NeedsApproval'), 'flagged');
  assert.strictEqual(stateLabel('ApprovedPending'), 'settling');
  assert.strictEqual(stateLabel('Approved'), 'approved');
  assert.strictEqual(stateLabel('SettlementFailed'), 'failed');
  assert.strictEqual(stateLabel('Denied'), 'denied');
  assert.strictEqual(stateLabel('Expired'), 'expired');
  assert.strictEqual(stateWords('Expired'), 'Expired, nothing moved');
});
