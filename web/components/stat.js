/**
 * A number with a label and a note.
 */

import { el } from '../lib/dom.js';

/**
 * @typedef {object} StatProps
 * @property {string} label
 * @property {string|number} value
 * @property {string} [note]
 */

/**
 * @param {StatProps} props
 */
export function stat({ label, value, note }) {
  const node = el('div', 'stat');
  node.append(el('div', 'stat-label', label));
  node.append(el('div', 'stat-value', String(value)));
  if (note) node.append(el('div', 'stat-note', note));
  return node;
}
