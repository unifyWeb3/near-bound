/**
 * A button that can show that it is working.
 */

import { el } from '../lib/dom.js';

/**
 * @typedef {object} ButtonProps
 * @property {string} label The label.
 * @property {string} [variant] `primary`, `ghost` or nothing.
 * @property {boolean} [busy] Show the working state.
 * @property {string} [busyLabel] The label while it works.
 * @property {() => void} [onClick]
 * @property {string} [type]
 * @property {boolean} [disabled]
 * @returns {HTMLButtonElement}
 */
export function button({
  label,
  variant,
  busy = false,
  busyLabel = 'Working...',
  onClick,
  type = 'button',
  disabled = false,
}) {
  const node = el('button', `button${variant ? ` ${variant}` : ''}`, busy ? busyLabel : label, { type });
  node.disabled = disabled || busy;
  node.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (onClick) node.addEventListener('click', onClick);
  return node;
}
