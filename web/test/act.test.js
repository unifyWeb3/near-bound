import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseWriteMethod, isActAllowed } from '../lib/act.js';

const OWNER = 'bound-testnet-97685.testnet';
const RUNNER = 'bound-runner.testnet';
const AGENT = 'bound-agent.testnet';
const STRANGER = 'stranger.testnet';

test('a pending request can be approved or rejected by the owner or the runner', () => {
  assert.strictEqual(chooseWriteMethod('approve', 'Pending', OWNER, OWNER, RUNNER, AGENT), 'approve_request');
  assert.strictEqual(chooseWriteMethod('reject', 'Pending', OWNER, OWNER, RUNNER, AGENT), 'reject_request');
  assert.strictEqual(chooseWriteMethod('approve', 'Pending', RUNNER, OWNER, RUNNER, AGENT), 'approve_request');
  assert.strictEqual(chooseWriteMethod('reject', 'Pending', RUNNER, OWNER, RUNNER, AGENT), 'reject_request');
  const allowed = isActAllowed('Pending', RUNNER, OWNER, RUNNER, AGENT);
  assert.deepStrictEqual(allowed, { approve: true, reject: true });
});

test('a flagged request can only be approved or rejected by the owner', () => {
  assert.strictEqual(
    chooseWriteMethod('approve', 'NeedsApproval', OWNER, OWNER, RUNNER, AGENT),
    'owner_approve_request',
  );
  assert.strictEqual(
    chooseWriteMethod('reject', 'NeedsApproval', OWNER, OWNER, RUNNER, AGENT),
    'owner_reject_request',
  );
  assert.strictEqual(chooseWriteMethod('approve', 'NeedsApproval', RUNNER, OWNER, RUNNER, AGENT), null);
  assert.strictEqual(chooseWriteMethod('reject', 'NeedsApproval', RUNNER, OWNER, RUNNER, AGENT), null);
  const allowed = isActAllowed('NeedsApproval', RUNNER, OWNER, RUNNER, AGENT);
  assert.deepStrictEqual(allowed, { approve: false, reject: false });
});

test('the agent must not approve its own request', () => {
  assert.strictEqual(chooseWriteMethod('approve', 'Pending', AGENT, OWNER, RUNNER, AGENT), null);
  assert.strictEqual(chooseWriteMethod('reject', 'Pending', AGENT, OWNER, RUNNER, AGENT), null);
  assert.strictEqual(chooseWriteMethod('approve', 'NeedsApproval', AGENT, OWNER, RUNNER, AGENT), null);
});

test('strangers and closed statuses are not offered any method', () => {
  assert.strictEqual(chooseWriteMethod('approve', 'Pending', STRANGER, OWNER, RUNNER, AGENT), null);
  assert.strictEqual(chooseWriteMethod('approve', 'Approved', OWNER, OWNER, RUNNER, AGENT), null);
  assert.strictEqual(chooseWriteMethod('reject', 'Denied', OWNER, OWNER, RUNNER, AGENT), null);
  assert.strictEqual(chooseWriteMethod('approve', null, OWNER, OWNER, RUNNER, AGENT), null);
  assert.strictEqual(chooseWriteMethod('approve', 'Pending', null, OWNER, RUNNER, AGENT), null);
  assert.strictEqual(chooseWriteMethod('approve', 'Pending', OWNER, null, RUNNER, AGENT), null);
});
