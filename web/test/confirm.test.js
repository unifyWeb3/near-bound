import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './dom-shim.js';
import { openConfirm } from '../components/confirm.js';

const document = makeDocument();
globalThis.document = document;

function allElements(root) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

test('the confirm dialog shows request id, amount, vendor and consequence, and never submits an empty rejection', () => {
  let confirmed = null;
  const dialog = openConfirm({
    title: 'Reject this request?',
    requestId: '0',
    amount: '1 NEAR',
    vendor: 'vendor.testnet',
    consequence: 'The contract refuses the spend and writes a Denied receipt.',
    action: 'reject',
    reasonPlaceholder: 'the vendor is not on the allowlist',
    onConfirm: (reason) => {
      confirmed = reason;
    },
  });

  const panel = document.body.children[0];
  const texts = allElements(panel).map((el) => el._text);
  assert.ok(texts.includes('Request'));
  assert.ok(texts.includes('#0'));
  assert.ok(texts.includes('Amount'));
  assert.ok(texts.includes('1 NEAR'));
  assert.ok(texts.includes('Vendor'));
  assert.ok(texts.includes('vendor.testnet'));
  assert.ok(texts.includes('Consequence'));
  assert.ok(texts.includes('The contract refuses the spend and writes a Denied receipt.'));

  const confirm = allElements(panel).find((el) => el._text === 'Reject request');
  assert.ok(confirm.disabled, 'reject is disabled without a reason');

  const reason = allElements(panel).find((el) => el.tagName === 'TEXTAREA');
  reason.value = 'the vendor is not on the allowlist';
  for (const listener of reason.listeners.input || []) listener({});
  assert.ok(!confirm.disabled, 'reject enables once a reason is typed');

  confirm.click();
  assert.strictEqual(confirmed, 'the vendor is not on the allowlist');
  assert.strictEqual(document.body.children.length, 0);
  dialog.close();
});

test('Escape closes the dialog and returns focus', () => {
  const trigger = document.createElement('button');
  trigger._text = 'Approve';
  document.activeElement = trigger;
  openConfirm({
    title: 'Approve this request?',
    requestId: '0',
    amount: '1 NEAR',
    vendor: 'vendor.testnet',
    consequence: 'The contract pays the vendor and writes an Approved receipt.',
    action: 'approve',
    onConfirm: () => {},
  });
  const onKey = document.listeners.keydown[0];
  onKey({ key: 'Escape', stopPropagation: () => {} });
  assert.strictEqual(document.activeElement, trigger);
  assert.strictEqual(document.body.children.length, 0);
});
