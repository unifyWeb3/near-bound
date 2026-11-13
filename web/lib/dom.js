/**
 * The DOM helpers every component is built on.
 *
 * Nothing here sets innerHTML with data. Text goes in as text.
 */

/**
 * Make an element.
 *
 * @param {string} tag
 * @param {string} [className]
 * @param {string|Node} [text] A string becomes the text, a node is appended.
 * @param {Record<string, string>} [attrs]
 * @returns {HTMLElement}
 */
export function el(tag, className, text, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text instanceof Node) node.append(text);
  else if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === 'text') node.textContent = String(value);
      else node.setAttribute(key, String(value));
    }
  }
  return node;
}

/** Make an element with a class and a text. */
export function div(className, text) {
  return el('div', className, text);
}

/** Make a paragraph. */
export function p(className, text) {
  return el('p', className, text);
}

/** Remove every child of a node. */
export function clear(node) {
  if (node) node.replaceChildren();
  return node;
}

/** Replace the children of a node. */
export function mount(node, ...children) {
  if (!node) return node;
  node.replaceChildren(...children.flat().filter(Boolean));
  return node;
}

/** Get an element by id. */
export const $ = (id) => document.getElementById(id);

/**
 * A listener that can be removed.
 *
 * @param {EventTarget} target
 * @param {string} type
 * @param {(event: Event) => void} handler
 */
export function on(target, type, handler) {
  target.addEventListener(type, handler);
  return () => target.removeEventListener(type, handler);
}

/**
 * The elements that can hold the keyboard focus inside a node.
 *
 * @param {HTMLElement} node
 */
export function focusables(node) {
  return [
    ...node.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}
