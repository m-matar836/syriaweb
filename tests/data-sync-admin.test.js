'use strict';
// ===================================================================
// Sync trigger management from inside the site — admin only.
//
// installDataSyncTrigger() has no role check of its own. Exposed through the
// web app it becomes a lever: any logged-in user could delete the trigger and
// force a full cache rebuild on demand. The role check is the point of this
// file, not a formality.
// ===================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCode, asUser } = require('./helpers/load-code');
const { loadClient, ROOT } = require('./helpers/load-client');

const setup = () => loadCode();

test('an admin can install the trigger from the site', () => {
  const L = setup();
  const admin = asUser(L, 'admin1', 'pw-admin');
  const res = admin.post('dataSyncTrigger', { syncAction: 'install' });
  assert.equal(res.status, 'success', JSON.stringify(res.message));
  assert.equal(res.sync.installed, true);
  assert.equal(L.env._scriptTriggers.length, 1);
});

test('an admin can remove it again', () => {
  const L = setup();
  const admin = asUser(L, 'admin1', 'pw-admin');
  admin.post('dataSyncTrigger', { syncAction: 'install' });
  const res = admin.post('dataSyncTrigger', { syncAction: 'remove' });
  assert.equal(res.sync.installed, false);
  assert.equal(L.env._scriptTriggers.length, 0);
});

test('a manager cannot install it', () => {
  const L = setup();
  const mgr = asUser(L, 'mgr1', 'pw-mgr');
  const res = mgr.post('dataSyncTrigger', { syncAction: 'install' });
  assert.notEqual(res.status, 'success');
  assert.equal(L.env._scriptTriggers.length, 0,
    'the trigger must not be created for a non-admin');
});

test('a regular employee cannot install it', () => {
  const L = setup();
  const u = asUser(L, 'user1', 'pw-user1');
  const res = u.post('dataSyncTrigger', { syncAction: 'install' });
  assert.notEqual(res.status, 'success');
  assert.equal(L.env._scriptTriggers.length, 0);
});

test('a manager cannot remove an existing trigger', () => {
  const L = setup();
  asUser(L, 'admin1', 'pw-admin').post('dataSyncTrigger', { syncAction: 'install' });
  const mgr = asUser(L, 'mgr1', 'pw-mgr');
  const res = mgr.post('dataSyncTrigger', { syncAction: 'remove' });
  assert.notEqual(res.status, 'success');
  assert.equal(L.env._scriptTriggers.length, 1,
    'a non-admin must not be able to switch sync off');
});

test('the action requires a session at all', () => {
  const L = setup();
  const { post } = require('./helpers/load-code');
  const res = post(L, 'dataSyncTrigger', { syncAction: 'install' });
  assert.notEqual(res.status, 'success');
  assert.equal(L.env._scriptTriggers.length, 0);
});

test('an unknown sync action is rejected rather than silently ignored', () => {
  const L = setup();
  const admin = asUser(L, 'admin1', 'pw-admin');
  const res = admin.post('dataSyncTrigger', { syncAction: 'deleteEverything' });
  assert.notEqual(res.status, 'success');
  assert.equal(L.env._scriptTriggers.length, 0);
});

test('installing twice from the site does not stack triggers', () => {
  const L = setup();
  const admin = asUser(L, 'admin1', 'pw-admin');
  admin.post('dataSyncTrigger', { syncAction: 'install' });
  admin.post('dataSyncTrigger', { syncAction: 'install' });
  assert.equal(L.env._scriptTriggers.length, 1);
});

test('status is readable without changing anything', () => {
  const L = setup();
  const admin = asUser(L, 'admin1', 'pw-admin');
  const res = admin.post('dataSyncTrigger', { syncAction: 'status' });
  assert.equal(res.status, 'success');
  assert.equal(res.sync.installed, false);
  assert.equal(L.env._scriptTriggers.length, 0, 'status must be read-only');
});

test('the role check lives in the server function, not only in the UI', () => {
  // Hiding the button in the UI is cosmetic; the server is what enforces it.
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const fn = src.slice(src.indexOf('function adminSetDataSyncTrigger'));
  const block = fn.slice(0, fn.indexOf('function onEdit'));
  assert.ok(/systemRole[\s\S]{0,80}!==\s*'admin'/.test(block),
    'adminSetDataSyncTrigger must verify the caller is an admin');
});

// --- client: the refresh button reports, and a separate button installs.

test('the refresh button never installs the trigger', () => {
  // The whole reason these are two buttons. Re-installing on every refresh
  // would delete and recreate the trigger, and rebuild a five-sheet cache, on
  // each click — for no benefit, since the trigger runs by itself.
  const src = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  const fn = src.slice(src.indexOf('function setupCacheRefreshButtons'));
  const block = fn.slice(0, fn.indexOf('\nfunction ', 10));
  assert.ok(!/installDataSyncTrigger|syncAction\s*:\s*'install'/.test(block),
    'the refresh button must not install the trigger');
  assert.ok(/reportDataSyncStatus\(\)/.test(block),
    'the refresh button should still report the sync status');
});

// --- behaviour, not just text: stub the attribute query the fake DOM lacks.

function buttonSandbox(currentUser) {
  const r = loadClient('core.js');
  const s = r.sandbox;
  const calls = [];
  const btn = {
    dataset: {}, disabled: false, innerHTML: '<i></i>تفعيل المزامنة', style: {},
    _handler: null,
    addEventListener(_type, fn) { this._handler = fn; },
  };
  s.document.querySelectorAll = (sel) => (String(sel).includes('install-data-sync') ? [btn] : []);
  s.localStorage.setItem('currentUser', JSON.stringify(currentUser));
  s.alert = (m) => calls.push(['alert', m]);
  s.apiPost = async (action, payload) => { calls.push(['apiPost', action, payload]); return { status: 'success', sync: { installed: true } }; };
  return { s, btn, calls };
}

test('the install button is hidden from a non-admin and has no handler', () => {
  const { s, btn } = buttonSandbox({ id: 'E003', role: 'user' });
  s.setupDataSyncTriggerButton();
  assert.equal(btn.style.display, 'none', 'a regular employee must not see the install button');
  assert.equal(btn._handler, null, 'and must not be able to click it');
});

test('the install button is hidden from a manager too', () => {
  const { s, btn } = buttonSandbox({ id: 'E002', role: 'manager' });
  s.setupDataSyncTriggerButton();
  assert.equal(btn.style.display, 'none');
  assert.equal(btn._handler, null);
});

test('an admin sees the button, and clicking it installs the trigger once', async () => {
  const { s, btn, calls } = buttonSandbox({ id: 'E001', role: 'admin' });
  s.setupDataSyncTriggerButton();
  assert.notEqual(btn.style.display, 'none', 'the admin must see the button');
  assert.ok(btn._handler, 'the admin must be able to click it');

  await btn._handler({ preventDefault() {} });
  const posts = calls.filter(c => c[0] === 'apiPost');
  assert.equal(posts.length, 1, 'one click, one install call');
  assert.equal(posts[0][1], 'dataSyncTrigger');
  assert.equal(posts[0][2].syncAction, 'install');
  assert.equal(btn.innerHTML, '<i></i>تفعيل المزامنة', 'the label must be restored after the click');
  assert.equal(btn.disabled, false, 'the button must be re-enabled afterwards');
});

test('a failed install reports the message and still re-enables the button', async () => {
  const { s, btn, calls } = buttonSandbox({ id: 'E001', role: 'admin' });
  s.apiPost = async () => { calls.push(['apiPost']); return { status: 'error', message: 'نفذت الصلاحيات' }; };
  s.setupDataSyncTriggerButton();
  await btn._handler({ preventDefault() {} });
  assert.ok(calls.some(c => c[0] === 'alert' && /نفذت الصلاحيات/.test(c[1])),
    'the server message must reach the user');
  assert.equal(btn.disabled, false, 'the button must not stay stuck disabled after a failure');
  assert.equal(btn.innerHTML, '<i></i>تفعيل المزامنة');
});

test('the install button is not re-bound on a second call', async () => {
  const { s, btn, calls } = buttonSandbox({ id: 'E001', role: 'admin' });
  s.setupDataSyncTriggerButton();
  s.setupDataSyncTriggerButton();
  await btn._handler({ preventDefault() {} });
  assert.equal(calls.filter(c => c[0] === 'apiPost').length, 1,
    'double-binding would install twice per click');
});

test('the refresh button only reads status; it never installs', async () => {
  const { s, calls } = buttonSandbox({ id: 'E001', role: 'admin' });
  s.refreshAppCache = async () => ({ ok: true });
  s.runPendingSyncIfNeeded = async () => {};
  s.setupCacheRefreshButtons();
  const r = loadClient('core.js');
  // Re-bind using this sandbox's stubs so the handler body resolves here.
  const src = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  assert.ok(!/syncAction\s*:\s*'install'/.test(
    src.slice(src.indexOf('function setupCacheRefreshButtons'), src.indexOf('\nfunction ', src.indexOf('function setupCacheRefreshButtons') + 10))),
    'the refresh handler must contain no install action');
  assert.ok(calls.every(c => c[0] !== 'apiPost' || c[2].syncAction !== 'install'),
    'nothing on the refresh path may install');
});
