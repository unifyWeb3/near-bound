/**
 * An accessible confirmation form for one action on one request.
 *
 * Replaces window.prompt. The dialog traps focus, closes on Escape, returns
 * focus to the button that opened it, and never submits from a single
 * unlabeled click: the reader types a reason (for rejection) and presses an
 * explicitly labelled button.
 *
 * @typedef {object} ConfirmProps
 * @property {string} title
 * @property {string} requestId
 * @property {string} amount
 * @property {string} vendor
 * @property {string} consequence What happens if the reader confirms.
 * @property {'approve'|'reject'} action
 * @property {string} [reasonPlaceholder]
 * @property {(reason: string) => void} onConfirm
 * @param {ConfirmProps} props
 */

import { el } from '../lib/dom.js';

/**
 * @returns {{ close: () => void }}
 */
export function openConfirm({
  title,
  requestId,
  amount,
  vendor,
  consequence,
  action,
  reasonPlaceholder,
  onConfirm,
}) {
  const previous = document.activeElement;

  const status = el('p', 'modal-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const heading = el('h2', 'modal-title', title, { id: 'confirm-title' });

  const fact = (label, value) => {
    const row = el('div', 'confirm-fact');
    row.append(el('span', 'confirm-label', label));
    row.append(el('span', 'confirm-value mono', value));
    return row;
  };

  const body = el('div', 'confirm-body');
  body.append(fact('Request', `#${requestId}`));
  body.append(fact('Amount', amount));
  body.append(fact('Vendor', vendor));
  body.append(fact('Consequence', consequence));

  let reasonInput = null;
  if (action === 'reject') {
    body.append(el('p', null, 'Why is this request refused?'));
    reasonInput = el('textarea', 'confirm-reason', undefined, {
      placeholder: reasonPlaceholder ?? 'the vendor is not on the allowlist',
      'aria-label': 'Rejection reason',
    });
    body.append(reasonInput);
  }

  const cancel = el('button', 'ghost-button', 'Cancel', { type: 'button' });
  const confirmLabel = action === 'reject' ? 'Reject request' : 'Approve request';
  const confirm = el('button', 'button primary', confirmLabel, { type: 'button' });
  confirm.disabled = action === 'reject'; // A rejection needs a reason first.

  if (reasonInput) {
    reasonInput.addEventListener('input', () => {
      confirm.disabled = reasonInput.value.trim().length === 0;
    });
  }

  const buttons = el('div', 'confirm-buttons');
  buttons.append(cancel);
  buttons.append(confirm);
  body.append(buttons);

  const panel = el(
    'div',
    'modal-panel',
    undefined,
    { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title' },
  );
  panel.append(heading);
  panel.append(body);

  const backdrop = el('div', 'modal-backdrop');
  backdrop.append(panel);

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (typeof HTMLElement !== 'undefined' && previous instanceof HTMLElement) previous.focus();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      finish();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...panel.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled])')];
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

  cancel.addEventListener('click', finish);
  confirm.addEventListener('click', (event) => {
    event.preventDefault();
    if (confirm.disabled) return;
    finish();
    onConfirm(action === 'reject' ? (reasonInput.value ?? '').trim() : '');
  });
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) finish();
  });
  document.addEventListener('keydown', onKey, true);

  document.body.append(backdrop);
  (reasonInput ?? confirm).focus();

  return { close: finish };
}
