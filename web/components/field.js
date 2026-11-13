/**
 * A labelled input.
 */

import { el } from '../lib/dom.js';

/**
 * @typedef {object} FieldProps
 * @property {string} label
 * @property {string} value
 * @property {string} [hint]
 * @property {string} [placeholder]
 * @property {(value: string) => void} [onChange] Fires on every keystroke.
 * @property {() => void} [onCommit] Fires when the reader leaves the field.
 */

/**
 * @param {FieldProps} props
 * @returns {HTMLInputElement}
 */
export function field({ label, value, hint, placeholder, onChange, onCommit }) {
  const id = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const wrapper = el('label', 'field');
  wrapper.setAttribute('for', id);
  wrapper.append(el('span', 'field-label', label));
  const input = el('input', 'field-input', undefined, { id, type: 'text', placeholder: placeholder ?? '' });
  input.value = value ?? '';
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (hint) {
    input.setAttribute('aria-describedby', `${id}-hint`);
    wrapper.append(el('span', 'field-hint', hint, { id: `${id}-hint` }));
  }
  if (onChange) input.addEventListener('input', () => onChange(input.value));
  if (onCommit) input.addEventListener('change', () => onCommit(input.value));
  wrapper.append(input);
  input.wrapper = wrapper;
  return input;
}
