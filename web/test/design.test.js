import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDocument } from './dom-shim.js';
import { renderRequests } from '../views/requests.js';
import { receiptCard } from '../views/receipt-card.js';
import { enableSteps, renderEnable, SETUP_PHASES } from '../views/enable.js';

const document = makeDocument();
globalThis.document = document;
document.register('requests-view', document.createElement('div'));
document.register('requests-count', document.createElement('div'));
document.register('enable-names', document.createElement('div'));
document.register('setup-rail', document.createElement('div'));
document.register('steps', document.createElement('div'));

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf-8');

const now = Math.floor(Date.now() / 1000);

function findByTone(root, tone) {
  return root.children.find((child) => child.getAttribute?.('data-tone') === tone);
}

test('a request card carries the state as a colour and the badge carries the name', () => {
  const state = {
    requests: {
      items: [
        {
          request_id: 1,
          status: 'Pending',
          agent_id: 'bound-agent.testnet',
          vendor: 'vendor.testnet',
          amount: '1',
          nonce: 1,
          created_at: String(now - 10),
        },
        {
          request_id: 2,
          status: 'NeedsApproval',
          agent_id: 'bound-agent.testnet',
          vendor: 'vendor.testnet',
          amount: '1',
          nonce: 2,
          created_at: String(now - 10),
        },
      ],
      owner: 'owner.testnet',
      runner: 'runner.testnet',
      errors: 0,
      failedIds: [],
      complete: true,
      fallback: false,
    },
    wallet: { accountId: 'owner.testnet' },
    actions: {},
    owner: 'owner.testnet',
    runner: 'runner.testnet',
    deployment: { agent: 'bound-agent.testnet' },
  };
  renderRequests(state, () => {});
  const view = document.getElementById('requests-view');
  assert.ok(findByTone(view, 'pending'), 'the pending request has the pending tone');
  assert.ok(findByTone(view, 'flagged'), 'the flagged request has the flagged tone');
  assert.ok(
    view.textContent.includes('Waiting for the owner'),
    'the badge names the state, so the colour is never the only cue',
  );
});

test('a receipt card carries the outcome as a colour', () => {
  const card = receiptCard({
    receipt: {
      receipt_id: 5,
      request_id: 2,
      agent_id: 'bound-agent.testnet',
      vendor: 'vendor.testnet',
      amount: '1000000000000000000000000',
      nonce: 3,
      memo: 'memo',
      outcome: 'Denied',
      reason: 'BudgetExceeded',
      rule: 'the rule',
      evidence: [],
      created_at: '1700000000',
      spent_after: '0',
      period_start: '1700000000',
    },
    link: false,
  });
  assert.strictEqual(card.getAttribute('data-tone'), 'denied');
});

test('every tone the views can produce has a colour in the stylesheet', () => {
  for (const tone of ['approved', 'denied', 'failed', 'expired', 'pending', 'flagged', 'settling']) {
    assert.ok(
      css.includes(`.decision[data-tone="${tone}"]`),
      `the stylesheet has no colour for the ${tone} tone`,
    );
  }
});

test('the setup is grouped into the named phases and the rail names them', () => {
  const names = {
    contract: 'certalyn-owner.testnet',
    agent: 'certalyn-agent.testnet',
    vendor: 'certalyn-vendor.testnet',
  };
  const steps = enableSteps(names);
  assert.strictEqual(steps.length, 8);
  for (const step of steps) {
    assert.ok(
      SETUP_PHASES.some((phase) => phase.id === step.phase),
      `the step "${step.title}" has no phase`,
    );
  }

  renderEnable({ enableNames: names }, () => {});
  const rail = document.getElementById('setup-rail');
  assert.strictEqual(rail.children.length, SETUP_PHASES.length);
  assert.ok(rail.textContent.includes('Accounts'));
  assert.ok(rail.textContent.includes('Decisions'));

  const rendered = document.getElementById('steps');
  const headings = rendered.children.filter((child) => child.tagName === 'DIV' && child.getAttribute?.('id'));
  assert.strictEqual(headings.length, SETUP_PHASES.length);
  const lists = rendered.children.filter((child) => child.tagName === 'OL');
  assert.strictEqual(lists.length, SETUP_PHASES.length);
  const total = lists.reduce((sum, list) => sum + list.children.length, 0);
  assert.strictEqual(total, 8, 'every step is still there');
});

test('the rail is a control, not a link into the router', () => {
  const names = {
    contract: 'certalyn-owner.testnet',
    agent: 'certalyn-agent.testnet',
    vendor: 'certalyn-vendor.testnet',
  };
  renderEnable({ enableNames: names }, () => {});
  const rail = document.getElementById('setup-rail');
  const button = rail.children[0].children[0];
  assert.strictEqual(button.tagName, 'BUTTON');
  assert.strictEqual(button.getAttribute('type'), 'button');
});

test('the page settles once when it opens and never moves on its own', () => {
  assert.ok(html.includes('class="enter"'), 'the entrance class is used');
  assert.ok(css.includes('@keyframes settle'), 'the entrance has one keyframe');
  assert.ok(css.includes('--ease-out'), 'the entrance has its own easing');
  assert.ok(
    css.includes('@media (prefers-reduced-motion: reduce)'),
    'the reduced motion preference is honoured',
  );
});

test('the live mark breathes and it is the only motion that repeats on a loaded page', () => {
  assert.ok(html.includes('dot small live'), 'the deployment mark is live');
  assert.ok(css.includes('@keyframes live-pulse'));

  // Every repeating animation has to say something: the live mark says the
  // page is reading a chain, the skeleton says the chain is still being read.
  const repeating = [...css.matchAll(/animation:\s*([^;]*infinite[^;]*);/g)].map((match) => match[1]);
  assert.strictEqual(repeating.length, 2, 'two repeating animations, and no more');
  assert.ok(repeating.some((value) => value.includes('live-pulse')));
  assert.ok(repeating.some((value) => value.includes('shimmer')));
});

test('the display type follows the viewport instead of jumping at a breakpoint', () => {
  assert.ok(css.includes('--display: clamp('), 'the display size is a clamp');
  assert.ok(css.includes('letter-spacing: -0.032em'), 'the display line is set tight');
  assert.ok(css.includes('--measure-text: 58ch'), 'the reading column has a measure');
});

test('the layout keeps the page from scrolling sideways on a phone', () => {
  // The three defects the browser pass found, each one guarded here so it
  // cannot come back without a browser to notice.
  assert.ok(
    /main\s*\{[^}]*overflow-wrap:\s*break-word/.test(css),
    'a long hash or address may break',
  );
  assert.ok(
    /\.sidebar\s*\{[^}]*min-width:\s*0/.test(css),
    'the navigation may shrink instead of widening the page',
  );
  assert.ok(
    /#deployment-label\s*\{[^}]*text-overflow:\s*ellipsis/.test(css),
    'the deployment name is cut, not wrapped',
  );
  assert.ok(
    /\.sidebar-nav\s*\{[^}]*overflow-x:\s*auto/.test(css),
    'the navigation scrolls inside itself',
  );
});

test('every element the console reads is in the page', async () => {
  const { readdirSync, readFileSync: read } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const files = [];
  for (const dir of ['', 'lib', 'views', 'components']) {
    const path = join(root, dir);
    for (const name of readdirSync(path)) {
      if (name.endsWith('.js')) files.push(join(path, name));
    }
  }
  const source = files.map((file) => read(file, 'utf-8')).join('\n');
  const used = new Set([...source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]));
  const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !present.has(id));
  assert.deepStrictEqual(missing, [], 'the console reads only elements that exist');
  assert.ok(used.size > 20, 'the check found the ids it is meant to check');
});
