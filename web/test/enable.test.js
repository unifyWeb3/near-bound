import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enableSteps,
  curlReceiptCount,
  curlReceipt,
  curlPolicy,
} from '../views/enable.js';

const names = {
  contract: 'bound-testnet-97685.testnet',
  agent: 'bound-agent.testnet',
  vendor: 'bound-vendor.testnet',
};

function curlPayload(text) {
  const match = text.match(/-d '([^']*)'$/);
  assert.ok(match, `no curl payload in: ${text}`);
  return JSON.parse(match[1]);
}

test('enableSteps names three concrete accounts and states the exact step and command count', () => {
  const steps = enableSteps(names);
  assert.strictEqual(steps.length, 8);
  let commands = 0;
  for (const step of steps) commands += (step.cmd.match(/\n/g) || []).length + 1;
  assert.strictEqual(commands, 12);
  const allCommands = steps.map((step) => step.cmd).join('\n');
  assert.ok(allCommands.includes(names.contract));
  assert.ok(allCommands.includes(names.agent));
  assert.ok(allCommands.includes(names.vendor));
});

test('the approval step uses the real request id from the previous request, never hardcoded 0', () => {
  const steps = enableSteps(names);
  const approve = steps.find((step) => step.title.startsWith('The owner approves'));
  assert.ok(approve);
  assert.ok(approve.cmd.includes('REQUEST_ID'), 'expects REQUEST_ID placeholder');
  assert.ok(!approve.cmd.includes('"request_id":0'), 'must not hardcode request id 0');
});

test('the revocation step only uses a placeholder where the user pastes a public key', () => {
  const steps = enableSteps(names);
  const revoke = steps.find((step) => step.title.startsWith('Revoke the agent'));
  assert.ok(revoke);
  assert.ok(revoke.cmd.includes('PUBLIC_KEY'));
});

test('values above 2^53 go in as base64 args', () => {
  const steps = enableSteps(names);
  const register = steps.find((step) => step.title.startsWith('Register the agent'));
  const ask = steps.find((step) => step.title.startsWith('The agent asks to spend'));
  assert.ok(register.cmd.includes('base64-args'));
  assert.ok(ask.cmd.includes('base64-args'));
  assert.ok(register.cmd.includes('5000000000000000000000000'));
  assert.ok(ask.cmd.includes('1000000000000000000000000'));
});

test('the historical redeploy is dated 2026-11-11', () => {
  const steps = enableSteps(names);
  const deploy = steps.find((step) => step.title.startsWith('Build and deploy'));
  assert.ok(deploy.body.includes('2026-11-11'));
  assert.ok(deploy.cmd.includes('contract/target/wasm32-unknown-unknown/release/bound_contract.wasm'));
});

test('judge curls use finality final and valid JSON', () => {
  for (const curl of [curlReceiptCount(names.contract), curlReceipt(names.contract, 7), curlPolicy(names.contract, names.agent)]) {
    assert.ok(curl.includes('"finality":"final"'), curl);
    const payload = curlPayload(curl);
    assert.strictEqual(payload.jsonrpc, '2.0');
    assert.strictEqual(payload.method, 'query');
  }
});
