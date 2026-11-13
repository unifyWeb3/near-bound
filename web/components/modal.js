/**
 * An accessible dialog.
 *
 * It is a plain div with the dialog role, so it works without a framework.
 * The keyboard is handled: Escape closes it, Tab stays inside, and the focus
 * goes back where it came from when it closes.
 */

import { el, focusables } from '../lib/dom.js';

/**
 * @typedef {object} ModalProps
 * @property {string} title The heading of the dialog.
 * @property {string} [description] A line under the heading.
 * @property {(node: HTMLElement) => void} [render] Fills the body.
 * @property {() => void} [onClose] Called when the reader closes it.
 * @property {string} [closeLabel] The label of the close button.
 */

/**
 * Open a dialog.
 *
 * @param {ModalProps} props
 * @returns {{ close: () => void, body: HTMLElement, setStatus: (text: string) => void }}
 */
export function openModal({ title, description, render, onClose, closeLabel = 'Close' }) {
  const previous = document.activeElement;

  const status = el('p', 'modal-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const body = el('div', 'modal-body');
  const close = el('button', 'ghost-button', closeLabel, { type: 'button' });
  const heading = el('h2', 'modal-title', title, { id: 'modal-title' });

  const panel = el(
    'div',
    'modal-panel',
    undefined,
    { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
  );
  panel.append(heading);
  if (description) panel.append(el('p', 'muted small', description));
  panel.append(body);
  panel.append(status);
  panel.append(close);

  const backdrop = el('div', 'modal-backdrop');
  backdrop.append(panel);

  const finish = () => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (previous instanceof HTMLElement) previous.focus();
    onClose?.();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      finish();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(panel);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  close.addEventListener('click', finish);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) finish();
  });
  document.addEventListener('keydown', onKey, true);

  document.body.append(backdrop);
  render?.(body);
  (focusables(panel)[0] ?? panel).focus();

  return {
    body,
    close: finish,
    setStatus(text) {
      status.textContent = text;
    },
  };
}
