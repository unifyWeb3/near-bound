#!/usr/bin/env node
/**
 * Record the console for the demo post.
 *
 * It drives the live console in a real Chromium, walks the six routes with
 * a pause on each so a viewer can read, and writes a video file with
 * ffmpeg. Nothing is published: the file is written to the video directory,
 * which the repository ignores, and the builder attaches it to the post
 * themselves.
 *
 * The rules ask the human to publish the post, and the builder decides
 * whether the video should show the console as it is now or as it was when
 * the first one was recorded. This script records it as it is now.
 *
 *   mkdir -p /tmp/certalyn-browser && cd /tmp/certalyn-browser
 *   npm init -y && npm install playwright-core
 *   npx playwright install chromium
 *
 *   cd /path/to/near-bound
 *   NODE_PATH=/tmp/certalyn-browser/node_modules node tests/browser/record.js
 *
 * The Chromium binary can be given with CHROME_PATH, the console with
 * CONSOLE_URL, the output directory with VIDEO_OUT and the encoder with
 * FFMPEG.
 */
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONSOLE = process.env.CONSOLE_URL || 'https://near-bound.vercel.app/index.html';
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.env.VIDEO_OUT || path.join(ROOT, 'video');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CHROME =
  process.env.CHROME_PATH ||
  path.join(
    process.env.HOME || '/root',
    '.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
  );

// The walk. Each route holds for a while, and the page scrolls so the whole
// view is seen.
const WALK = [
  { hash: '#/overview', hold: 5200 },
  { hash: '#/requests', hold: 4200 },
  { hash: '#/ledger', hold: 4200 },
  { hash: '#/policy', hold: 3400 },
  { hash: '#/enable', hold: 5200 },
  { hash: '#/judge', hold: 4200 },
];

const FRAME_RATE = 12;
const WIDTH = 1440;
const HEIGHT = 900;

function run(args) {
  return execFileSync(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  const work = path.join(OUT, '.frames');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

  await page.goto(CONSOLE, { waitUntil: 'load' });
  // The console reads the chain when it opens. The stamp in the top bar says
  // the read is done.
  await page.waitForFunction(
    () => {
      const node = document.getElementById('loaded');
      return node && node.textContent && !node.textContent.includes('Reading the chain');
    },
    { timeout: 45000 },
  );
  await page.waitForTimeout(1200);

  const segments = [];
  let segment = 0;
  for (const step of WALK) {
    await page.evaluate((hash) => {
      window.location.hash = hash;
      window.scrollTo(0, 0);
    }, step.hash);
    await page.waitForTimeout(900);

    const frames = Math.max(2, Math.round(step.hold / 1000 / (1 / FRAME_RATE)));
    for (let index = 0; index < frames; index += 1) {
      const name = path.join(work, `seg${segment}-${String(index).padStart(3, '0')}.png`);
      await page.screenshot({ path: name });
      // A slow drift down the page, so the reader sees the whole view.
      await page.evaluate(() => {
        window.scrollBy(0, Math.round(window.innerHeight * 0.12));
      });
      await page.waitForTimeout(1000 / FRAME_RATE);
    }
    segments.push(segment);
    segment += 1;
  }
  await browser.close();

  // Each route becomes a short clip, and the clips are joined.
  const clips = [];
  for (const index of segments) {
    const pattern = path.join(work, `seg${index}-%03d.png`);
    const clip = path.join(work, `seg${index}.mp4`);
    const duration = (framesFor(index, work) / FRAME_RATE).toFixed(2);
    run([
      FFMPEG, '-y', '-framerate', String(FRAME_RATE), '-i', pattern,
      '-vf', `fade=t=in:st=0:d=0.35,fade=t=out:st=${Math.max(0, Number(duration) - 0.35)}:d=0.35,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '24', '-movflags', '+faststart', clip,
    ]);
    clips.push(clip);
  }

  const listFile = path.join(work, 'clips.txt');
  fs.writeFileSync(listFile, clips.map((clip) => `file '${clip}'`).join('\n') + '\n');
  const target = path.join(OUT, 'certalyn-console-demo.mp4');
  run([
    FFMPEG, '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', target,
  ]);
  fs.rmSync(work, { recursive: true, force: true });

  const duration = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target])
    .toString()
    .trim();
  console.log(`the recording is at ${target}`);
  console.log(`it runs for ${Number(duration).toFixed(1)} seconds`);
  console.log('it is not published. Attach it to the post yourself.');
})().catch((error) => {
  console.error('the recording failed:', error);
  process.exit(1);
});

function framesFor(index, work) {
  return fs.readdirSync(work).filter((name) => name.startsWith(`seg${index}-`)).length;
}
