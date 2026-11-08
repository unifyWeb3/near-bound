import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scene, SHOTS } from './scenes.js';

const W = 1280, H = 720, FPS = 30, DUR = SHOTS[SHOTS.length - 1].t1;
const OUT = process.argv[2] ?? '/home/unify/near/bound/video/out/frames';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const total = DUR * FPS;
for (let i = 0; i < total; i += 1) {
  const t = i / FPS;
  writeFileSync(join(OUT, `f${String(i).padStart(5, '0')}.svg`), scene(t));
  if (i % 240 === 0) console.log(`f${i}/${total}`);
}
console.log('done', total, 'frames');
