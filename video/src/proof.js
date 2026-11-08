import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { frame, text, rect, runningHead, easeOut, ledgerGlyph, line, PAPER, INK, MUTED, JADE } from './layout.js';

const FPS = 30;
const DUR = 6;
const W = 1280, H = 720;
const outDir = '/tmp/opencode/video-build/proof';

function scene(t) {
  const a = easeOut(Math.min(1, t / 1.2));
  const b = easeOut(Math.min(1, Math.max(0, t - 0.9) / 1.0));
  const c = easeOut(Math.min(1, Math.max(0, (t - 1.6) / 1.6)));
  const inner = [
    ledgerGlyph({ x: 480, y: 40, size: 34 }),
    text({ x: 640, y: 132, s: 'SpendGuard', size: 34, weight: 700, fill: INK, anchor: 'middle', opacity: a }),
    text({ x: 640, y: 268, s: 'The agent can be talked into paying.', size: 42, family: 'Liberation Serif', weight: 700, fill: INK, anchor: 'middle', opacity: b }),
    line({ x1: 512, y1: 306, x2: 768, y2: 306, color: JADE, sw: 5, opacity: b }),
    text({ x: 640, y: 372, s: 'And the money can leave the room before anyone reads the file.', size: 20, fill: MUTED, anchor: 'middle', family: 'Liberation Sans', opacity: c }),
  ].join('');
  return frame(runningHead(inner, null), W, H);
}

mkdirSync(outDir, { recursive: true });
for (let i = 0; i < DUR * FPS; i += 1) {
  const t = i / FPS;
  writeFileSync(join(outDir, `f${String(i).padStart(5, '0')}.svg`), scene(t));
}
console.log('wrote', DUR * FPS, 'frames');
