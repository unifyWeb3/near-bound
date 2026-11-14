#!/usr/bin/env node
/**
 * The browser pass over the Certalyn console.
 *
 * It serves the console from disk, drives it in a real Chromium, and records
 * what a reader would see: a screenshot of every route at a wide and a narrow
 * width, the keyboard order with the visible focus ring, the reduced motion
 * behaviour, and every console error, page error or failed request.
 *
 * The console itself has no browser dependency. This pass needs a Chromium
 * and the `playwright-core` package, which are not part of the product:
 *
 *   mkdir -p /tmp/certalyn-browser && cd /tmp/certalyn-browser
 *   npm init -y && npm install playwright-core
 *   npx playwright install chromium
 *
 * Then, from the repository root:
 *
 *   PASS_OUT=/tmp/certalyn-browser/out \
 *   NODE_PATH=/tmp/certalyn-browser/node_modules \
 *   node tests/browser/pass.js
 *
 * The Chromium binary can be given with CHROME_PATH when the Playwright
 * cache holds one already.
 *
 * The pass reads the console from disk by default. CONSOLE_URL points it at
 * a deployed console instead, so the same checks can be run against what
 * the public sees:
 *
 *   CONSOLE_URL=https://near-bound.vercel.app/index.html node tests/browser/pass.js
 */
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..', '..', 'web');
const OUT = process.env.PASS_OUT || '/tmp/certalyn-browser/out';
const PORT = Number(process.env.PASS_PORT || 8123);
const LIVE = process.env.CONSOLE_URL || '';
const BASE = LIVE || `http://127.0.0.1:${PORT}/index.html`;
const CHROME =
  process.env.CHROME_PATH ||
  path.join(
    process.env.HOME || '/root',
    '.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
  );

const ROUTES = [
  { name: 'overview', hash: '#/overview' },
  { name: 'policy', hash: '#/policy' },
  { name: 'requests', hash: '#/requests' },
  { name: 'ledger', hash: '#/ledger' },
  { name: 'enable', hash: '#/enable' },
  { name: 'judge', hash: '#/judge' },
];

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };

fs.mkdirSync(OUT, { recursive: true });

function serve() {
  if (LIVE) return null;
  return spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: WEB,
    stdio: 'ignore',
  });
}

async function waitForRead(page) {
  // The console stamps the time of the chain read in the top bar. It waits
  // for the chain, so the wait is the stamp, not a sleep.
  // The options are the third argument. The chain read is a dozen calls to
  // a public node, so the wait is generous.
  // The stamp has to be the successful one. A failed read also changes the
  // stamp, and a pass that counted a broken page as a good one would be
  // worthless.
  await page.waitForFunction(
    () => {
      const node = document.getElementById('loaded');
      return node && node.textContent && /Read at/.test(node.textContent);
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(600);
}

(async () => {
  const server = serve();
  if (server) await new Promise((resolve) => setTimeout(resolve, 900));
  const report = {
    generated_at: new Date().toISOString(),
    browser: CHROME,
    console: BASE,
    browser_mode: 'multi-process',
    routes: [],
    keyboard: [],
    reducedMotion: null,
    errors: [],
  };
  let browser;
  let context;
  let page;
  try {
    // A browser with one process for the renderer, for a machine that cannot
    // spare the memory a second process needs. The mode is only used when
    // the ordinary one cannot start a renderer at all.
    const MODES = [
      { name: 'multi-process', args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      {
        name: 'single-process',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
      },
    ];

    const open = async (mode) => {
      browser = await chromium.launch({ executablePath: CHROME, args: mode.args });
      context = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 1 });
      page = await context.newPage();
      page.on('console', (message) => {
        if (message.type() === 'error') report.errors.push({ kind: 'console', text: message.text() });
      });
      page.on('pageerror', (error) => report.errors.push({ kind: 'pageerror', text: String(error) }));
      page.on('requestfailed', (request) =>
        report.errors.push({
          kind: 'requestfailed',
          text: `${request.url()} ${request.failure()?.errorText}`,
        }),
      );
    };

    // The first route is the probe. If the renderer cannot start, the pass
    // relaunches the browser in the mode that fits the machine and starts
    // again, rather than reporting a layout failure that never happened.
    let started = false;
    for (const mode of MODES) {
      try {
        await open(mode);
        await page.goto(`${BASE}${ROUTES[0].hash}`, {
          waitUntil: 'load',
          timeout: 45000,
        });
        report.browser_mode = mode.name;
        started = true;
        break;
      } catch (error) {
        if (browser) await browser.close().catch(() => {});
        browser = null;
      }
    }
    if (!started) {
      throw new Error('the browser could not load the first route in any mode');
    }

    for (const route of ROUTES) {
      const entry = { name: route.name, hash: route.hash, shots: {}, facts: {} };
      if (!(route === ROUTES[0])) {
        await page.goto(`${BASE}${route.hash}`, { waitUntil: 'load' });
      }
      await waitForRead(page);
      await page.screenshot({ path: path.join(OUT, `${route.name}-wide.png`), fullPage: true });
      await page.screenshot({
        path: path.join(OUT, `${route.name}-wide.jpg`),
        fullPage: true,
        type: 'jpeg',
        quality: 78,
      });
      entry.shots.wide = `${route.name}-wide.png`;

      entry.facts = await page.evaluate(() => {
        const visible = (node) => {
          if (!node) return false;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        };
        return {
          title: document.title,
          visibleView: [...document.querySelectorAll('.view')].filter(visible).map((v) => v.id),
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          cards: document.querySelectorAll('.decision').length,
          tones: [...document.querySelectorAll('.decision[data-tone]')].map((n) =>
            n.getAttribute('data-tone'),
          ),
          railItems: document.querySelectorAll('#setup-rail .rail-link').length,
          phaseHeads: document.querySelectorAll('.phase-head').length,
          steps: document.querySelectorAll('.step').length,
        };
      });

      await page.setViewportSize(NARROW);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${route.name}-narrow.png`), fullPage: true });
      await page.screenshot({
        path: path.join(OUT, `${route.name}-narrow.jpg`),
        fullPage: true,
        type: 'jpeg',
        quality: 78,
      });
      entry.shots.narrow = `${route.name}-narrow.png`;
      entry.narrow = await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      await page.setViewportSize(WIDE);
      report.routes.push(entry);
    }

    // ---- The keyboard order and the focus ring --------------------------
    await page.goto(`${BASE}#/requests`, { waitUntil: 'load' });
    await waitForRead(page);
    for (let index = 0; index < 26; index += 1) {
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const node = document.activeElement;
        if (!node || node === document.body) return null;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return {
          tag: node.tagName.toLowerCase(),
          id: node.id || null,
          className: typeof node.className === 'string' ? node.className : null,
          label: (node.getAttribute('aria-label') || node.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 48),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          outlineOffset: style.outlineOffset,
          onScreen: box.top >= -4 && box.bottom <= window.innerHeight + 4,
          visible: box.width > 0 && box.height > 0,
        };
      });
      if (focus) report.keyboard.push(focus);
    }

    // ---- The reduced motion behaviour ----------------------------------
    // The same page, with the preference set on it. A second context would
    // be cleaner, but a browser in one process cannot hold two.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${BASE}#/overview`, { waitUntil: 'load' });
    await waitForRead(page);
    report.reducedMotion = await page.evaluate(() => {
      const read = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const style = getComputedStyle(node);
        return {
          animationDuration: style.animationDuration,
          animationName: style.animationName,
          transitionDuration: style.transitionDuration,
        };
      };
      return {
        entrance: read('.enter'),
        skeleton: read('.skeleton'),
        mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  // The summary is what the console of the pass prints, so a reader does not
  // have to open the report to know whether the pass was clean.
  const overflows = report.routes.filter(
    (route) => route.facts.horizontalOverflow || route.narrow.horizontalOverflow,
  );
  const invisible = report.keyboard.filter((stop) => !stop.visible);
  const noRing = report.keyboard.filter((stop) => stop.outlineStyle === 'none');
  console.log(`console           : ${BASE}`);
  console.log(`routes            : ${report.routes.length}`);
  console.log(`browser mode      : ${report.browser_mode}`);
  console.log(`overflow          : ${overflows.length ? overflows.map((r) => r.name).join(', ') : 'none'}`);
  console.log(`console errors    : ${report.errors.length}`);
  console.log(`keyboard stops    : ${report.keyboard.length}, without a visible focus ring: ${noRing.length}`);
  console.log(`reduced motion    : ${report.reducedMotion.mediaMatches}, entrance ${report.reducedMotion.entrance.animationDuration}`);
  console.log(`report            : ${path.join(OUT, 'report.json')}`);
  if (overflows.length || report.errors.length || noRing.length) process.exitCode = 1;
})().catch((error) => {
  console.error('browser pass failed:', error);
  process.exit(1);
});
