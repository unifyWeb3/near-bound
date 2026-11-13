/**
 * The state when there is nothing to show.
 */

import { el } from '../lib/dom.js';

/**
 * @param {string} message
 */
export function emptyState(message) {
  return el('p', 'empty-state', message);
}

/**
 * The placeholders shown while the chain is being read.
 *
 * @param {number} count
 */
export function skeletons(count = 4) {
  const host = el('div', 'skeletons');
  for (let index = 0; index < count; index += 1) {
    const row = el('div', 'skeleton');
    row.setAttribute('aria-hidden', 'true');
    host.append(row);
  }
  host.setAttribute('aria-busy', 'true');
  host.setAttribute('aria-label', 'Reading the chain');
  return host;
}
