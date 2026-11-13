/**
 * The bar at the top of the page that says what went wrong.
 */

import { el } from '../lib/dom.js';

/**
 * @param {string} message
 * @param {'error'|'warning'} [tone]
 */
export function alert(message, tone = 'error') {
  const node = el('div', `alert alert-${tone}`);
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  node.textContent = message;
  return node;
}

/**
 * Put a message in the page's error bar, or clear it.
 *
 * @param {string|null} message
 */
export function setErrorBar(message) {
  const bar = document.getElementById('error-bar');
  if (!bar) return;
  bar.textContent = message ?? '';
  bar.hidden = !message;
}
