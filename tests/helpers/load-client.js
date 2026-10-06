'use strict';
// ===============================================================
// load-client.js
// Loads the browser-side scripts in a vm context with minimal DOM /
// storage / jQuery stubs, so the pure helpers can be unit tested.
// ===============================================================

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

/**
 * A localStorage/sessionStorage stand-in.
 *
 * Backed by a Proxy so it behaves like the real Storage object: stored keys are
 * visible to `Object.keys(localStorage)` / `for..in`, which core.js relies on
 * when it sweeps cache keys on logout. A plain object with only methods would
 * silently return an empty key list and hide real cleanup bugs.
 */
function makeStorage() {
  const map = new Map();
  const methods = {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => map.clear(),
    key: (i) => { const keys = [...map.keys()]; return i < keys.length ? keys[i] : null; },
    _dump: () => Object.fromEntries(map),
  };
  return new Proxy(methods, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && map.has(prop)) return map.get(prop);
      return undefined;
    },
    has(target, prop) {
      return (prop in target) || (typeof prop === 'string' && map.has(prop));
    },
    ownKeys() { return [...map.keys()]; },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop !== 'string' || !map.has(prop)) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
      return { value: map.get(prop), writable: true, enumerable: true, configurable: true };
    },
  });
}

/** A minimal element stub that records class/text mutations. */
class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this._classes = new Set();
    this._html = '';
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this._listeners = {};
    this._attrs = {};
    this._qCache = {};
  }
  classList = {
    add: (...c) => c.forEach(x => this._classes.add(x)),
    remove: (...c) => c.forEach(x => this._classes.delete(x)),
    toggle: (c, on) => (on ? this._classes.add(c) : this._classes.delete(c)),
    contains: (c) => this._classes.has(c),
  };
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; this._qCache = {}; }
  insertAdjacentHTML(_pos, html) { this._html = String(html) + this._html; this.children = []; this._qCache = {}; }
  scrollIntoView() {}
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  addEventListener(type, fn, opts) {
    // نحاكي حقيقي المتصفح: { signal } يفصل المستمع عند abort.
    if (opts && opts.signal) {
      if (opts.signal.aborted) return;
      opts.signal.addEventListener('abort', () => this.removeEventListener(type, fn), { once: true });
    }
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type]; if (!l) return;
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  }
  dispatch(type, ev = {}) { (this._listeners[type] || []).forEach(fn => fn(ev)); }
  /**
   * querySelector for a single `tag[attr]` pair, which is the shape
   * populateSelect() uses to read a select's placeholder option. Resolved
   * against `innerHTML` so a stub select only needs the placeholder markup it
   * would have in index.html.
   */
  querySelector(selector) {
    const m = /^([a-zA-Z][\w-]*)?(?:\[([\w-]+)\])?$/.exec(String(selector).trim());
    if (!m) return null;
    const [, tag, attr] = m;
    const html = String(this._html);
    for (const t of html.match(/<[a-zA-Z][^>]*>/g) || []) {
      if (tag && !new RegExp('^<' + tag + '\\b', 'i').test(t)) continue;
      if (attr && !new RegExp('\\s' + attr + '(?:\\s|=|>|$)', 'i').test(t)) continue;
      const el = new FakeEl(tag || 'div');
      // Text content of the matched tag, so a placeholder label survives.
      const after = html.slice(html.indexOf(t) + t.length);
      el.textContent = (after.match(/^[^<]*/) || [''])[0];
      return el;
    }
    return null;
  }
/**
   * Every piece of markup this element exposes to selectors.
   *
   * Rows are rendered as `tr.innerHTML = ...; tbody.appendChild(tr)`, so the
   * markup lives on the children rather than on the parent. A selector that
   * only looked at `_html` would find nothing in a container that a real DOM
   * would happily walk into.
   */
  _markup() {
    return [this._html, ...this.children.map(child => (child && child._markup ? child._markup() : ''))].join('');
  }

  /**
   * querySelectorAll for a single `.class`, optionally `:checked`.
   *
   * `.foo` and `.foo:checked` must resolve to the SAME instances: page-reports.js
   * reads the checked boxes and the full list in two separate calls and then
   * compares them, so caching them separately would hand back two unrelated sets
   * of objects. The cache is therefore keyed on the class alone and the
   * pseudo-class filters the already-built instances.
   */
  querySelectorAll(selector) {
    const m = /^\.([\w-]+)(:checked)?$/.exec(String(selector).trim());
    if (!m) return [];
    const key = '.' + m[1];
    if (this._qCache[key]) {
      return m[2] ? this._qCache[key].filter(el => el.checked) : this._qCache[key];
    }
    const found = [];
    for (const tag of this._markup().match(/<[a-zA-Z][^>]*>/g) || []) {
      const classAttr = /class\s*=\s*"([^"]*)"/.exec(tag);
      if (!classAttr || !classAttr[1].split(/\s+/).includes(m[1])) continue;
      const el = new FakeEl((/^<([a-zA-Z0-9]+)/.exec(tag) || [])[1] || 'div');
      el._attrs = {};
      for (const a of tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) el._attrs[a[1]] = a[2];
      for (const a of Object.keys(el._attrs)) {
        if (a.startsWith('data-')) {
          el.dataset[a.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = el._attrs[a];
        }
      }
      // The `value` attribute is the element's value: page-reports.js reads
      // `checkbox.value` to know which promoter a tick belongs to, and without
      // this every box would answer "" and no name would ever match.
      if (el._attrs.value !== undefined) el.value = el._attrs.value;
      if (el._attrs.id !== undefined) el.id = el._attrs.id;
      // Honour the serialized `checked` attribute so a freshly rendered row is
      // already selected without the test having to re-tick it.
      if (/\schecked\b/.test(tag)) el.checked = true;
      found.push(el);
    }
    this._qCache[key] = found;
    return m[2] ? found.filter(el => el.checked) : found;
  }
  appendChild(c) { this.children.push(c); return c; }
  remove() {}
  focus() {}
  click() {}
  reset() {}
  closest() { return null; }
  getAttribute(name) {
    return this._attrs[name] !== undefined ? this._attrs[name] : null;
  }
  setAttribute() {}
  removeAttribute() {}
  contains() { return false; }
}

/**
 * Load a client script with browser globals stubbed.
 * @param {string} file  filename inside the project root
 * @returns {{ctx: object, sandbox: object, evalIn: Function, window: object, doc: object}}
 */
function loadClient(file, opts = {}) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');

  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const elements = new Map();

  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new FakeEl('div', id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (ns, tag) => new FakeEl(tag),
    createDocumentFragment: () => {
      const frag = new FakeEl('fragment');
      frag.childNodes = [];
      const appendChild = frag.appendChild.bind(frag);
      frag.appendChild = (node) => { frag.childNodes.push(node); return appendChild(node); };
      return frag;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    body: new FakeEl('body'),
    documentElement: new FakeEl('html'),
    cookie: '',
  };

  const noop = () => {};
  /**
   * jQuery, stubbed far enough to keep a chain intact.
   *
   * `.val(v)` has to return the wrapper, not the value: production does
   * `$(select).val(x).trigger('change.select2')`, and a stub that returns the
   * value there fails the test for a reason that cannot happen in a browser.
   * Reading `.val()` with no argument still answers with the element's value.
   */
  const jqStub = (el) => {
    const isEl = el && typeof el === 'object';
    const w = {
      // Real jQuery returns the wrapper from these, and the page modules chain
      // off them (`$('#campaign').on('change', fn).trigger('change')`).
      on() { return w; },
      off() { return w; },
      ready(fn) { if (typeof fn === 'function') fn(); return w; },
      trigger() { return w; },
      click() { return w; },
      val(v) {
        if (v === undefined) return (isEl && 'value' in el) ? el.value : '';
        if (isEl) el.value = v;
        return w;
      },
      html(v) { if (v !== undefined && isEl) el.innerHTML = v; return w; },
      text() { return (isEl && 'value' in el) ? el.value : ''; },
      addClass: noop, removeClass: noop, toggleClass: noop,
      attr: () => '', data: () => '', append: noop, prepend: noop, remove: noop,
      each: noop, css: noop, find: () => jqStub(),
      closest: () => jqStub(), parent: () => jqStub(), children: () => jqStub(),
      show: noop, hide: noop, prop: () => '', hasClass: () => false, length: 0,
    };
    return w;
  };

  // Real window-level event dispatch so page modules that listen for
  // events (e.g. core.js's spaViewRevisited) can be exercised.
  const winListeners = new Map();
  const addWinListener = (type, fn, opts) => {
    if (opts && opts.signal) {
      if (opts.signal.aborted) return;
      opts.signal.addEventListener('abort', () => removeWinListener(type, fn), { once: true });
    }
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  };
  const removeWinListener = (type, fn) => {
    const l = winListeners.get(type);
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  const dispatchWin = (type, detail) => {
    const ev = { type, detail };
    (winListeners.get(type) || []).slice().forEach(fn => fn(ev));
    return true;
  };

  const sandbox = {
    console,
    // Timers are stubbed so long-lived intervals in core.js cannot keep the
    // test process alive. Tests that need timing should use evalIn + promises.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 50)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Date, JSON, Math, Number, String, Object, Array, Boolean, RegExp,
    Error, TypeError, RangeError, Promise, Map, Set, WeakMap, Symbol,
    isNaN, isFinite, parseInt, parseFloat,
    AbortController, AbortSignal,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    URLSearchParams, URL, fetch: async () => { throw new Error('fetch not stubbed'); },
    localStorage, sessionStorage,
    document,
    navigator: { userAgent: 'node-test', language: 'ar', serviceWorker: null },
    location: { href: 'https://example.test/', origin: 'https://example.test', search: '', reload: noop },
    history: { pushState: noop, replaceState: noop },
    alert: noop, confirm: () => false, prompt: () => null,
    btoa: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    jQuery: jqStub, $: jqStub,
    // Bootstrap components are used as `new bootstrap.Modal(el).show()`, so an
    // instance has to expose the lifecycle methods. A bare constructor makes
    // every `.show()` throw and takes the whole handler down with it, which
    // looks like a bug in the page under test rather than a gap in the stub.
    bootstrap: (() => {
      const component = function () {
        return { show() {}, hide() {}, toggle() {}, dispose() {}, handleUpdate() {} };
      };
      return { Modal: component, Tooltip: component, Collapse: component, Offcanvas: component, Dropdown: component };
    })(),
    Chart: function () { return { destroy: noop, update: noop }; },
    Swal: { fire: async () => ({ isConfirmed: false }), mixin: () => ({ fire: async () => ({}) }) },
    localStorageReady: true,
    addEventListener: addWinListener,
    removeEventListener: removeWinListener,
    dispatchEvent: (ev) => {
      const type = typeof ev === 'string' ? ev : ev && ev.type;
      const detail = typeof ev === 'string' ? undefined : ev && ev.detail;
      return dispatchWin(type, detail);
    },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop }),
    innerWidth: 1280, innerHeight: 800,
    scrollTo: noop,
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    Event: function (type) { this.type = type; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  // Let callers install stubs (registerView, apiGet, ...) BEFORE the page
  // module runs its top-level registerView() call.
  if (typeof opts.setup === 'function') opts.setup(sandbox, { document, elements, dispatchWindowEvent: dispatchWin });
  new vm.Script(source, { filename: file }).runInContext(context);

  return {
    sandbox, context, document, elements,
    localStorage, sessionStorage,
    evalIn: (expr) => vm.runInContext(String(expr), context),
    dispatchWindowEvent: dispatchWin,
  };
}

module.exports = { loadClient, FakeEl, makeStorage, ROOT };
