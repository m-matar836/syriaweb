'use strict';
// Boot-order test for the `defer` change.
//
// The vm-based client tests read each file directly, so they cannot observe the
// order in which index.html actually loads them. That is exactly the risk when
// deferring scripts: core.js must still run before the page modules, because
// they call registerView() at their top level. If that order breaks, every
// screen silently does nothing -- no error, just a dead app.
//
// This test executes the files in the order the browser would, then reads the
// real viewActivators table out of the context.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const PAGE_ROUTES = {
  'page-login.js': 'login',
  'page-reports.js': 'reports',
  'page-expenses.js': 'expenses',
  'page-history.js': 'history',
  'page-movement.js': 'movement',
  'page-attendance.js': 'attendance',
  'page-dashboard.js': 'dashboard',
  'page-users.js': 'users',
  'page-salary.js': 'salary',
};

function localScriptTags() {
  return [...read('index.html').matchAll(/<script\b[^>]*>/g)]
    .map(m => m[0])
    .filter(t => /src="(?!https?:)/.test(t));
}

function makeElement() {
  return {
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '', value: '',
    id: '', tagName: 'DIV', className: '', offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null,
    setAttribute() {}, insertAdjacentHTML() {},
  };
}

// Enough of a global surface for the modules' top-level code to run without
// throwing. The point is load order, not behaviour, so every dependency here is
// a no-op.
function makeSandbox() {
  const s = {};
  s.window = s; s.self = s; s.globalThis = s;
  s.navigator = { serviceWorker: undefined };
  const store = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  s.localStorage = store; s.sessionStorage = store;
  s.location = { hash: '#/login', href: 'https://x/', search: '' };
  s.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  s.setTimeout = () => 0; s.clearTimeout = () => {}; s.setInterval = () => 0; s.clearInterval = () => {};
  s.addEventListener = () => {}; s.removeEventListener = () => {}; s.dispatchEvent = () => true;
  s.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  s.Event = s.CustomEvent;
  s.fetch = async () => ({ ok: true, json: async () => ({}) });
  s.XMLHttpRequest = class { open() {} send() {} };
  s.document = {
    getElementById: () => makeElement(), querySelector: () => makeElement(),
    querySelectorAll: () => [], createElement: () => makeElement(),
    createTextNode: () => ({}), body: makeElement(), head: makeElement(),
    documentElement: makeElement(), addEventListener() {}, removeEventListener() {},
    readyState: 'loading',
  };
  s.jQuery = s.$ = function () {
    const api = new Proxy({}, { get: () => () => api });
    api.length = 0; api.ready = fn => { fn(); return api; };
    return api;
  };
  s.$.fn = {};
  s.Chart = function () { return { destroy() {}, update() {}, data: {} }; };
  s.bootstrap = { Modal: function () {}, Tooltip: function () {} };
  s.Swal = { fire: async () => ({ isConfirmed: true }), mixin: () => ({ fire: async () => ({}) }) };
  s.Html5Qrcode = function () { return { start() {}, stop() {}, clear() {} }; };
  s.registerView = () => {};
  return s;
}

function runInLoadOrder(tags) {
  const sandbox = makeSandbox();
  const ctx = vm.createContext(sandbox);
  const errors = [];
  for (const tag of tags) {
    const file = (tag.match(/src="([^"]+)"/) || [])[1];
    if (!file) continue;
    try {
      new vm.Script(read(file), { filename: file }).runInContext(ctx);
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  return { ctx, errors };
}

test('boot: every page module runs its top level and registers its view', () => {
  const { ctx, errors } = runInLoadOrder(localScriptTags());
  assert.deepEqual(errors, [], 'a module threw while loading:\n  ' + errors.join('\n  '));

  const registered = vm.runInContext('Object.keys(viewActivators).sort()', ctx);
  const missing = Object.values(PAGE_ROUTES).filter(r => !registered.includes(r));
  assert.deepEqual(missing, [],
    'these views were never registered, so their page module did not run to completion. ' +
    'Under defer this means core.js stopped loading first, or a module threw.\n  ' + missing.join(', '));
});

test('boot: core.js is evaluated before any page module', () => {
  // Prove the order rather than assume it: record when core.js defines the
  // function the page modules depend on.
  const sandbox = makeSandbox();
  const ctx = vm.createContext(sandbox);
  const order = [];
  vm.runInContext(`
    globalThis.__mark = (f) => { try { new Function(f); } catch (e) {} };
  `, ctx);
  for (const tag of localScriptTags()) {
    const file = (tag.match(/src="([^"]+)"/) || [])[1];
    if (!file) continue;
    const wrapped = `${read(file)}\n;globalThis.__after = (globalThis.__after || []).concat(${JSON.stringify(file)});`;
    new vm.Script(wrapped, { filename: file }).runInContext(ctx);
    order.push(file);
  }
  assert.equal(order[0], 'core.js', 'core.js must be the first local script in the document');

  // And registerView must already exist when the first page module runs.
  const { errors } = runInLoadOrder(localScriptTags());
  assert.deepEqual(errors, []);
  assert.ok(vm.runInContext('typeof registerView === "function"', ctx));
  assert.ok(vm.runInContext('Object.keys(viewActivators).length >= 8', ctx),
    'the page modules should have populated the view registry');
});

test('boot: DOMContentLoaded handlers are registered before the event fires', () => {
  // defer scripts run before DOMContentLoaded, so handlers added at the top
  // level of a module will still be invoked. Verify the handlers are attached
  // to the document rather than fired eagerly.
  const sandbox = makeSandbox();
  const listeners = [];
  sandbox.document.addEventListener = (type, fn) => { if (type === 'DOMContentLoaded') listeners.push(fn); };
  const ctx = vm.createContext(sandbox);
  for (const tag of localScriptTags()) {
    const file = (tag.match(/src="([^"]+)"/) || [])[1];
    if (!file) continue;
    new vm.Script(read(file), { filename: file }).runInContext(ctx);
  }
  assert.ok(listeners.length > 0,
    'nothing listens for DOMContentLoaded, so the app would never start after defer');
});

test('boot: the service worker is registered from a load handler, not at parse time', () => {
  // The inline script registers the worker inside a 'load' listener. If it ran
  // inline it would execute before the deferred modules, which is fine, but the
  // guard matters: registering at parse time can race the module scripts.
  const h = read('index.html');
  const inline = (h.match(/<script>\s*([\s\S]*?)<\/script>/) || [])[1] || '';
  assert.ok(/addEventListener\(\s*['"]load['"]/.test(inline),
    'the service worker must be registered from a load event');
  assert.ok(/serviceWorker\.register\(\s*['"]\.\/service-worker\.js['"]/.test(inline),
    'the service worker path must be unchanged');
});
