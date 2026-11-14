/**
 * A tiny pretend DOM, just enough for the console's pure rendering functions.
 * The views only touch `document` when they paint, so swapping it in before a
 * render call is enough; nothing reads the DOM at import time.
 */

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this._set = new Set();
  }
  add(...cls) {
    for (const c of cls) this._set.add(c);
    this.owner._syncClassName();
  }
  remove(...cls) {
    for (const c of cls) this._set.delete(c);
    this.owner._syncClassName();
  }
  toggle(c) {
    if (this._set.has(c)) {
      this._set.delete(c);
      return false;
    }
    this._set.add(c);
    return true;
  }
  contains(c) {
    return this._set.has(c);
  }
  toString() {
    return [...this._set].join(' ');
  }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._text = '';
    this.attributes = {};
    this.classes = new FakeClassList(this);
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.value = '';
    this.readOnly = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
  }

  _syncClassName() {
    this.attributes.class = this.classes.toString();
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'class') this.classes._set = new Set(String(value).split(/\s+/).filter(Boolean));
    return this;
  }

  getAttribute(key) {
    return Object.prototype.hasOwnProperty.call(this.attributes, key)
      ? this.attributes[key]
      : null;
  }

  removeAttribute(key) {
    delete this.attributes[key];
    this.classes._set.clear();
    return this;
  }

  append(...nodes) {
    for (const node of nodes) this._adopt(node);
    return this;
  }

  appendChild(node) {
    this._adopt(node);
    return node;
  }

  _adopt(node) {
    if (node instanceof FakeElement || node instanceof FakeDocumentFragment) {
      node._parent = this;
      this.children.push(node);
    } else if (node != null) {
      const text = new FakeElement();
      text._text = String(node);
      this.children.push(text);
    }
  }

  replaceChildren(...nodes) {
    this.children = nodes.map((node) => {
      if (node instanceof FakeElement) {
        node._parent = this;
        return node;
      }
      const text = new FakeElement();
      text._text = String(node);
      return text;
    });
  }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  removeEventListener(type, handler) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler);
    }
  }

  click() {
    for (const handler of this.listeners.click || []) handler({ preventDefault: () => {} });
  }

  focus() {}
  blur() {}

  matches(selector) {
    return String(selector)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .some((part) => {
        // A selector this shim does not understand matches nothing, the way
        // an unknown selector behaves in the browser tests.
        if (/[:>\s]/.test(part)) return false;
        let rest = part;
        const tag = rest.match(/^[a-zA-Z][\w-]*/);
        if (tag) {
          if (this.tagName !== tag[0].toUpperCase()) return false;
          rest = rest.slice(tag[0].length);
        }
        const classes = rest.match(/\.[\w-]+/g) || [];
        if (rest.replace(/\.[\w-]+/g, '') !== '') return false;
        return classes.every((name) => this.classes.contains(name.slice(1)));
      });
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (typeof child.matches === 'function' && child.matches(selector)) return child;
      if (typeof child.querySelector === 'function') {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (typeof child.matches === 'function' && child.matches(selector)) found.push(child);
      if (typeof child.querySelectorAll === 'function') {
        found.push(...child.querySelectorAll(selector));
      }
    }
    return found;
  }

  remove() {
    const parent = this._parent;
    if (parent) parent.children = parent.children.filter((child) => child !== this);
    this._parent = undefined;
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }

  get className() {
    return this.attributes.class ?? '';
  }

  set className(value) {
    this.attributes.class = value;
    this.classes._set = new Set(String(value).split(/\s+/).filter(Boolean));
  }
}

class FakeDocumentFragment extends FakeElement {
  constructor() {
    super('#fragment');
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super('html');
    this.readyState = 'complete';
    this.body = new FakeElement('body');
    this._byId = {};
  }

  getElementById(id) {
    return this._byId[id] ?? null;
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  register(id, element) {
    this._byId[id] = element;
  }
}

export function makeDocument() {
  return new FakeDocument();
}
