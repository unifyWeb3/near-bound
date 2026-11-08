/**
 * SVG layout helpers for the SpendGuard film.
 * Everything is deterministic in (t, shot). Units are px at 1280 x 720.
 */

export const FONT = {
  serif: 'Liberation Serif',
  sans: 'Liberation Sans',
  mono: 'Liberation Mono',
};

export const INK = '#1e1c17';
export const INK2 = '#45423a';
export const MUTED = '#6e6a5e';
export const PAPER = '#f5f2ea';
export const PANEL = '#fffdf8';
export const LINE = '#e1ddd0';
export const JADE = '#175e42';
export const JADE_STRONG = '#113f2d';
export const JADE_SOFT = '#e7efe8';
export const OX = '#93362c';
export const OX_SOFT = '#f3e6e2';

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function rect({ x, y, w, h, r = 0, fill = PANEL, stroke = 'none', sw = 1, opacity = 1 }) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
}

export function line({ x1, y1, x2, y2, color = LINE, sw = 1, opacity = 1 }) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}" opacity="${opacity}"/>`;
}

export function text({ x, y, s, size = 20, family = FONT.mono, weight = 400, fill = INK, anchor = 'start', opacity = 1, spacing = 0, style = '' }) {
  const ls = spacing ? ` letter-spacing="${spacing}"` : '';
  return `<text x="${x}" y="${y}" font-family="'${family}'" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls} opacity="${opacity}" style="${style}">${esc(s)}</text>`;
}

export function frame(inner, w = 1280, h = 720) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${PAPER}"/>${inner}</svg>`;
}

/** Ledger square glyph, same as the console favicon. */
export function ledgerGlyph({ x, y, size = 34, color = JADE, fg = PAPER, opacity = 1 }) {
  return [
    rect({ x, y, w: size, h: size, r: size * 0.18, fill: color, opacity }),
    rect({ x: x + size * 0.22, y: y + size * 0.31, w: size * 0.56, h: size * 0.075, fill: fg, opacity }),
    rect({ x: x + size * 0.22, y: y + size * 0.465, w: size * 0.56, h: size * 0.075, fill: fg, opacity }),
    rect({ x: x + size * 0.22, y: y + size * 0.62, w: size * 0.56, h: size * 0.075, fill: fg, opacity }),
  ].join('');
}

/** The running head used on every frame after the opening. */
export function runningHead(inner, pageNoOrNull) {
  const left = ledgerGlyph({ x: 34, y: 28, size: 16 }) + text({ x: 58, y: 41, s: 'SpendGuard', size: 14, weight: 700, fill: INK });
  const right = pageNoOrNull
    ? text({ x: 1246, y: 41, s: `№ ${pageNoOrNull}`, size: 13, fill: MUTED, anchor: 'end' })
    : text({ x: 1246, y: 41, s: 'testnet', size: 13, fill: JADE, anchor: 'end' });
  return `<g>${left}${right}${line({ x1: 34, y1: 50, x2: 1246, y2: 50, color: LINE, sw: 1 })}${inner}</g>`;
}

/** Eased progress between a and b across [t0, t1]. */
export function ease(t, t0, t1, fn = easeOut) {
  if (t <= t0) return 0;
  if (t >= t1) return 1;
  return fn((t - t0) / (t1 - t0));
}

export const easeOut = (x) => 1 - Math.pow(1 - x, 3);
export const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeBack = (x) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

/** Slide + fade + blur in, a la the console redesign. */
export function reveal(t, t0, t1, { dy = 48, tau = 0.9 } = {}) {
  if (t >= t1) return { dy: 0, opacity: 1, blur: 0 };
  const p = ease(t, t0, t1, easeInOut);
  return { dy: dy * (1 - p), opacity: p, blur: (1 - p) * 8 };
}

/** Type-on: how many characters of s are visible at t. */
export function typed(s, t, t0, t1, cps = 40) {
  if (t <= t0) return '';
  const p = Math.min(1, (t - t0) * (cps / s.length));
  return s.slice(0, Math.ceil(p * s.length * (t1 === t0 ? 1 : 1)));
}

/** Clamped typewriter with a fixed speed in characters per second. */
export function typeSpeed(s, t, t0, cps = 42) {
  if (t <= t0) return '';
  const n = Math.floor((t - t0) * cps);
  return s.slice(0, Math.max(0, Math.min(s.length, n)));
}

export function caret(t, blink = 0.53) {
  return Math.floor(t / blink) % 2 === 0;
}
