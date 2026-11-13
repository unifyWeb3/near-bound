/**
 * A button that copies a command to the clipboard.
 */

import { el } from '../lib/dom.js';

/**
 * @param {string} command
 * @param {string} [label]
 */
export function copyButton(command, label = 'Copy') {
  const node = el('button', 'copy-button', label, { type: 'button' });
  node.addEventListener('click', async () => {
    const original = label;
    try {
      await navigator.clipboard.writeText(command);
      node.textContent = 'Copied';
    } catch {
      node.textContent = 'Not copyable here';
    }
    node.setAttribute('aria-live', 'polite');
    setTimeout(() => {
      node.textContent = original;
      node.removeAttribute('aria-live');
    }, 1400);
  });
  return node;
}
