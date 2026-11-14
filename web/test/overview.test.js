import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html is branded Certalyn with no spendguard left in the console', () => {
  assert.ok(html.includes('<title>Certalyn'));
  assert.ok(!html.toLowerCase().includes('spendguard'), 'spendguard must not remain in console copy');
  assert.ok(html.includes('aria-labelledby="budget-meter-label"'), 'budget meter needs an accessible name');
  assert.ok(html.includes('id="budget-meter-label"'), 'budget meter must be explicitly labelled Remaining');
  assert.ok(html.includes('plain NEAR transfer'));
  assert.ok(!html.includes('metered API'), 'must not claim the contract buys a metered API');
  assert.ok(html.includes('Testnet only, not audited'));
});
