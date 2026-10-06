'use strict';
// ===================================================================
// V72 — a sheet edit must reach open browsers.
//
// The trigger runs on Google's servers and cannot push, so the server moves a
// counter and the client polls it. These tests cover both halves: the scope map
// that decides how much to re-download, and the client's decision to refresh —
// including the case that matters most in practice, a refresh landing while
// somebody is halfway through typing.
// ===================================================================

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient, ROOT } = require('./helpers/load-client');
const { loadCode, get, DEFAULT_DATA } = require('./helpers/load-code');

// These two run the REAL Code.gs. A static assertion cannot tell you that
// installDataSyncTrigger() calls warmInitialDataCache_() rather than
// warmInitialDataCache() — only executing it can, and the only person who found
// that out was running it by hand against Apps Script.

test('running: installDataSyncTrigger() completes and leaves one edit trigger', () => {
  const L = loadCode();
  const out = L.code.installDataSyncTrigger();
  assert.equal(out.status, 'success');
  assert.equal(out.removed, 0);
  const triggers = L.env._scriptTriggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].getHandlerFunction(), 'onEdit');
  assert.equal(triggers[0].getTriggerType(), 'spreadsheet',
    'an edit trigger on the spreadsheet is what Apps Script needs here');
  assert.equal(triggers[0].getEventType(), 'onEdit');
});

test('running: reinstalling replaces the trigger instead of adding a second', () => {
  const L = loadCode();
  L.code.installDataSyncTrigger();
  const second = L.code.installDataSyncTrigger();
  assert.equal(second.removed, 1);
  assert.equal(L.env._scriptTriggers.length, 1);
});

test('running: removing the trigger leaves none behind', () => {
  const L = loadCode();
  L.code.installDataSyncTrigger();
  assert.equal(L.code.removeDataSyncTrigger().removed, 1);
  assert.equal(L.code.getDataSyncStatus().installed, false);
});

test('running: the trigger moves the version when a sheet is edited', () => {
  const L = loadCode({
    data: Object.assign({}, DEFAULT_DATA, {
      sales: [['date', 'userId', 'amount'], ['2026-01-01', 'E003', 10]],
      festivalMovement: [['date', 'userId'], ['2026-01-01', 'E003']],
    }),
  });
  L.code.installDataSyncTrigger();
  assert.equal(L.code.getDataSyncStatus().version, 0);

  // Reports are edited.
  L.code.onEdit({ range: { getSheet: () => L.env._spreadsheet.getSheetByName('sales') } });
  const afterReports = L.code.getDataSyncStatus();
  assert.equal(afterReports.version, 1, 'a Reports-scope edit must move the counter');
  assert.equal(afterReports.scope, 'reports');

  // A master-data sheet is edited next. The version must still move, or the
  // edit is invisible — this is the whole feature.
  L.code.onEdit({ range: { getSheet: () => L.env._spreadsheet.getSheetByName('Products') } });
  assert.equal(L.code.getDataSyncStatus().version, 2);
});

test('running: every scope in the map is reachable and bumps the counter', () => {
  const names = Object.keys(sheetScopeMap());
  assert.ok(names.length >= 10, 'the map should cover every sheet the app reads');
  const L = loadCode({
    data: Object.assign({}, DEFAULT_DATA, Object.fromEntries(
      names.map(n => [n, [['col1', 'col2'], ['a', 'b']]]))),
  });
  L.code.installDataSyncTrigger();
  let expected = 0;
  for (const name of names) {
    expected++;
    L.code.onEdit({ range: { getSheet: () => L.env._spreadsheet.getSheetByName(name) } });
    assert.equal(L.code.getDataSyncStatus().version, expected,
      'editing ' + name + ' did not move the counter');
  }
});

test('running: a sheet not in the map is still handled, not dropped', () => {
  // Anything unknown is treated as master. Silently ignoring an unrecognised
  // sheet would mean editing it has no effect at all, with no clue why.
  const L = loadCode({
    data: Object.assign({}, DEFAULT_DATA, { SomeNewSheet: [['a'], ['b']] }),
  });
  L.code.installDataSyncTrigger();
  L.code.onEdit({ range: { getSheet: () => L.env._spreadsheet.getSheetByName('SomeNewSheet') } });
  assert.equal(L.code.getDataSyncStatus().version, 1);
  assert.equal(L.code.getDataSyncStatus().scope, 'master');
});

test('running: an event with no range does not throw', () => {
  const L = loadCode();
  L.code.installDataSyncTrigger();
  assert.doesNotThrow(() => L.code.onEdit({}));
  assert.doesNotThrow(() => L.code.onEdit(null));
  assert.equal(L.code.getDataSyncStatus().version, 0, 'a junk event must not bump the counter');
});

test('running: getDataVersion() reports the live version without a session', () => {
  const L = loadCode();
  L.code.installDataSyncTrigger();
  const unauth = get(L, 'getDataVersion');
  assert.equal(unauth.status, 'success');
  assert.equal(unauth.version, 0);
  L.code.onEdit({ range: { getSheet: () => L.env._spreadsheet.getSheetByName('Products') } });
  const after = get(L, 'getDataVersion');
  assert.equal(after.version, 1);
  assert.equal(after.scope, 'master');
});

// --- server: the scope map, read straight out of Code.gs so the test cannot
// drift from the sheet names the real file uses.

function sheetScopeMap() {
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const block = /const SHEET_SCOPE_MAP = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'Code.gs must declare SHEET_SCOPE_MAP');
  const map = {};
  for (const line of block[1].split('\n')) {
    const m = /^\s*(\w+):\s*'(\w+)'\s*,?\s*$/.exec(line);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

test('server: master-data sheets are scoped as master', () => {
  const map = sheetScopeMap();
  for (const name of ['Products', 'ProductsOfCompetitor', 'Employees', 'Locations', 'ExpenseItems']) {
    assert.equal(map[name], 'master', name + ' must be master scope');
  }
});

test('server: transactional sheets are scoped as reports', () => {
  const map = sheetScopeMap();
  for (const name of ['Reports', 'sales', 'salesOfCompetitor', 'expenses', 'promoters', 'attendance', 'statusWT']) {
    assert.equal(map[name], 'reports', name + ' must be reports scope');
  }
});

test('server: the movement sheet is scoped on its own', () => {
  assert.equal(sheetScopeMap().festivalMovement, 'movements');
});

test('server: a broader scope wins so a stale-scope client still refreshes fully', () => {
  // The recorded scope is what the client acts on. If a 'master' edit recorded
  // 'master' and a later 'reports' edit kept it, a client that had already seen
  // the first one would keep pulling master data only and never see the report.
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const rank = /const SCOPE_RANK = \{([\s\S]*?)\};/.exec(src);
  assert.ok(rank, 'Code.gs must declare SCOPE_RANK');
  const ranks = {};
  for (const m of rank[1].matchAll(/(\w+):\s*(\d+)/g)) ranks[m[1]] = Number(m[2]);
  assert.ok(ranks.reports >= ranks.master, 'reports must outrank master');
  assert.ok(ranks.movements >= ranks.master, 'movements must outrank master');
});

test('server: the version probe is answered before authentication', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const probeAt = src.indexOf('if (action === "getDataVersion")');
  const authAt = src.indexOf('authenticateRequest_(e.parameter.token)');
  assert.ok(probeAt > -1, 'doGet must handle getDataVersion');
  assert.ok(probeAt < authAt,
    'the client has to learn the sheet changed before it holds a session, otherwise it logs in on stale data');
});

test('server: a trigger exists and invalidates the cache it bumps the version for', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  assert.ok(/function onEdit\s*\(e\)/.test(src), 'Code.gs must define onEdit');
  const fn = src.slice(src.indexOf('function onEdit'));
  assert.ok(fn.includes('invalidateCachesForScope_'), 'onEdit must drop the cache first');
  assert.ok(fn.includes('bumpDataVersion_'), 'onEdit must move the counter');
  assert.ok(/warmInitialDataCache_\(\)/.test(fn), 'onEdit must re-warm getInitialData so the next login is fast');
});

test('server: the edit trigger must be installable, or it fails silently forever', () => {
  // The one that bites in production and nowhere else: a SIMPLE onEdit trigger
  // runs without authorization, and CacheService/PropertiesService throw inside
  // it. The handler then never bumps anything, no error reaches anyone, and the
  // feature looks installed while doing nothing. Hence an explicit installer.
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  assert.ok(/function installDataSyncTrigger\s*\(\)/.test(src),
    'Code.gs must offer a one-time installer for the edit trigger');
  assert.ok(/ScriptApp\.newTrigger\(\s*'onEdit'\s*\)\s*\.forSpreadsheet\(/.test(src),
    'the trigger must be created forSpreadsheet().onEdit() — installable, not a simple trigger');
  assert.ok(/function removeDataSyncTrigger\s*\(\)/.test(src),
    'an installer with no uninstaller cannot be undone by the owner');
});

test('server: reinstalling does not stack duplicate triggers', () => {
  // Duplicate triggers mean the version is bumped twice per keystroke and the
  // cache is invalidated twice, quietly doubling every Apps Script quota cost.
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const fn = src.slice(src.indexOf('function installDataSyncTrigger'));
  const block = fn.slice(0, fn.indexOf('function removeDataSyncTrigger'));
  assert.ok(/getHandlerFunction\(\)\s*===\s*'onEdit'[\s\S]*deleteTrigger/.test(block),
    'the installer must delete an existing onEdit trigger before creating one');
});

test('every bare call in Code.gs resolves to a function that exists', () => {
  // This is the check that would have caught the ReferenceError that shipped in
  // installDataSyncTrigger(): it called warmInitialDataCache() while the function
  // is warmInitialDataCache_(). Every test in this file passed at the time —
  // the error only appeared when a human ran the installer against Apps Script,
  // because nothing here executes that line.
  const raw = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');

  // Blank out comments and string/template literals, keeping line numbers intact
  // so a reported line number still points at the real call site.
  let src = '';
  for (let i = 0; i < raw.length;) {
    const c = raw[i], d = raw[i + 1];
    if (c === '/' && d === '/') { while (i < raw.length && raw[i] !== '\n') { src += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) { src += raw[i] === '\n' ? '\n' : ' '; i++; }
      src += '  '; i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; src += ' '; i++;
      while (i < raw.length) {
        if (raw[i] === '\\') { src += '  '; i += 2; continue; }
        if (raw[i] === q) { src += ' '; i++; break; }
        src += raw[i] === '\n' ? '\n' : ' '; i++;
      }
      continue;
    }
    src += c; i++;
  }

  const defined = new Set();
  for (const m of src.matchAll(/(?:^|[\n;{}])\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:^|[\n;{}])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);

  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new',
    'typeof', 'do', 'else', 'try', 'finally', 'case', 'await', 'delete', 'void', 'in', 'of',
    'instanceof', 'throw', 'yield']);
  const GLOBALS = new Set(['Date', 'Number', 'String', 'Boolean', 'JSON', 'Math', 'Object', 'Array',
    'Promise', 'Error', 'RegExp', 'Map', 'Set', 'WeakMap', 'parseInt', 'parseFloat', 'isNaN',
    'isFinite', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
    'encodeURIComponent', 'decodeURIComponent', 'Uint8Array', 'TextDecoder', 'TextEncoder',
    'globalThis', 'undefined', 'Symbol', 'Proxy', 'Reflect', 'BigInt', 'structuredClone']);

  const missing = [];
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name) || GLOBALS.has(name) || defined.has(name)) continue;
    missing.push(name + ' (Code.gs:' + src.slice(0, m.index).split('\n').length + ')');
  }
  assert.deepEqual(missing, [],
    'these calls name functions that Code.gs never defines — Apps Script only reports\n' +
    'the first one, when a human runs the function by hand:\n  ' + missing.join('\n  '));
});

// --- client

function client(overrides = {}) {
  const r = loadClient('core.js');
  const s = r.sandbox;
  const calls = [];
  s.apiGet = async (action) => {
    calls.push(action);
    if (action === 'getDataVersion') return s.__versionResponse;
    return { status: 'success' };
  };
  s.refreshAppCache = async (opts) => { calls.push(['refreshAppCache', opts]); return { ok: true }; };
  s.alert = () => {};
  // Default is a logged-in user. Tests about the logged-out path override it.
  s.getAppToken = () => 'tok';
  Object.assign(s, overrides);
  return { r, s, calls };
}

test('client: a first run adopts the server version instead of forcing a refresh', async () => {
  const { s, calls } = client();
  s.__versionResponse = { status: 'success', version: 7, scope: 'reports' };
  const out = await s.checkServerDataVersion();
  assert.equal(out.adopted, 7);
  assert.ok(!calls.some(c => Array.isArray(c) && c[0] === 'refreshAppCache'),
    'upgrading the app must not put every existing user into a full refresh');
  assert.equal(s.localStorage.getItem('serverDataVersion'), '7');
});

test('client: an unchanged version costs one request and no refresh', async () => {
  const { s, calls } = client();
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 7, scope: 'reports' };
  const out = await s.checkServerDataVersion();
  assert.equal(out.changed, false);
  assert.deepEqual(calls, ['getDataVersion']);
});

test('client: a master-data edit pulls master data only', async () => {
  const { s, calls } = client();
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 8, scope: 'master' };
  await s.checkServerDataVersion();
  const refresh = calls.find(c => Array.isArray(c) && c[0] === 'refreshAppCache');
  assert.ok(refresh, 'a sheet edit must refresh');
  assert.equal(refresh[1].refreshReports, false,
    're-downloading every report because someone edited a product price is not justified');
  assert.equal(refresh[1].silent, true, 'an automatic refresh must not hijack the user\'s button');
  assert.equal(s.localStorage.getItem('serverDataVersion'), '8');
});

test('client: a reports edit pulls everything', async () => {
  const { s, calls } = client();
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 8, scope: 'reports' };
  await s.checkServerDataVersion();
  const refresh = calls.find(c => Array.isArray(c) && c[0] === 'refreshAppCache');
  assert.equal(refresh[1].refreshReports, true, 'a report edit must reach the history and attendance screens');
});

test('client: a refresh is deferred while the user is typing', async () => {
  // The failure this guards: an automatic refresh wiping a half-filled sales
  // table. This is the whole cost of having the feature on at all.
  const { s, calls } = client();
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 8, scope: 'reports' };
  s.document.activeElement = { tagName: 'INPUT', type: 'text', value: '12' };
  const out = await s.checkServerDataVersion();
  assert.equal(out.deferred, true);
  assert.ok(!calls.some(c => Array.isArray(c) && c[0] === 'refreshAppCache'));
});

test('client: a logged-out probe does not burn the version on a failed refresh', async () => {
  // The bug this pins: the poll starts at page load, which is before login.
  // refreshAppCache() needs a token, so it failed — but the version was still
  // recorded, so the stale cache was treated as current and the user's next
  // login read old data forever. Silence looked like working software.
  const { s, calls } = client();
  s.getAppToken = () => null;
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 8, scope: 'reports' };
  const out = await s.checkServerDataVersion();
  assert.equal(out.deferred, 'unauthenticated');
  assert.ok(!calls.some(c => Array.isArray(c) && c[0] === 'refreshAppCache'),
    'there is nothing to refresh without a session');
  assert.equal(s.localStorage.getItem('serverDataVersion'), '7',
    'recording the version here would silently drop the update after login');
});

test('client: the update lands as soon as a session exists', async () => {
  const { s, calls } = client();
  let token = null;
  s.getAppToken = () => token;
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 8, scope: 'master' };
  await s.checkServerDataVersion();
  token = 'tok';
  const out = await s.checkServerDataVersion();
  assert.equal(out.changed, true);
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'refreshAppCache'));
  assert.equal(s.localStorage.getItem('serverDataVersion'), '8');
});

test('client: a refresh that fails does not record the version as seen', async () => {
  const { s } = client();
  s.getAppToken = () => 'tok';
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 8, scope: 'master' };
  s.refreshAppCache = async () => ({ ok: false });
  const out = await s.checkServerDataVersion();
  assert.equal(out.refreshed, false);
  assert.equal(s.localStorage.getItem('serverDataVersion'), '7',
    'a failed download must stay retryable, otherwise the app is stale with no warning');
});

test('client: ticking a checkbox is not typing, so it does not defer', async () => {
  const { s, calls } = client();
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 8, scope: 'master' };
  s.document.activeElement = { tagName: 'INPUT', type: 'checkbox', checked: true };
  await s.checkServerDataVersion();
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'refreshAppCache'),
    'deferring on a checkbox would let the app sit stale forever');
});

test('client: a deferred check is not lost — it runs on the next pass', async () => {
  const { s } = client();
  s.localStorage.setItem('serverDataVersion', '7');
  s.__versionResponse = { status: 'success', version: 9, scope: 'master' };
  s.document.activeElement = { tagName: 'TEXTAREA', value: 'ملاحظة' };
  assert.equal((await s.checkServerDataVersion()).deferred, true);
  s.document.activeElement = null;
  const out = await s.checkServerDataVersion();
  assert.equal(out.changed, true, 'the update must land once the user stops typing');
});

test('client: an offline or failing probe is not fatal', async () => {
  const { s } = client();
  s.localStorage.setItem('serverDataVersion', '7');
  s.apiGet = async () => { throw new Error('failed to fetch'); };
  const out = await s.checkServerDataVersion();
  assert.equal(out.ok, false);
  assert.equal(s.localStorage.getItem('serverDataVersion'), '7', 'a failed probe must not move the known version');
});

test('client: the probe is never served from the service worker cache', () => {
  // If it were, the client would read back the version it already has and never
  // notice a change — the feature would look installed and do nothing.
  const src = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
  const set = /const CACHEABLE_API_ACTIONS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(set, 'service-worker.js must declare CACHEABLE_API_ACTIONS');
  assert.ok(!/getDataVersion/.test(set[1]),
    'getDataVersion must stay out of the cached set or a stale version is undetectable');
});

// --- the three screens the refresh used to skip entirely.

test('screens that cache their own data now listen for the refresh', () => {
  for (const f of ['page-expenses.js', 'page-salary.js', 'page-users.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(src.includes('appDataRefreshed'),
      f + ' must listen for appDataRefreshed, or a sheet edit never reaches it');
  }
});

test('the expenses day is not reloaded over an unsaved draft', () => {
  const src = fs.readFileSync(path.join(ROOT, 'page-expenses.js'), 'utf8');
  const i = src.indexOf("window.addEventListener('appDataRefreshed'");
  assert.ok(i > -1);
  const block = src.slice(i, i + 900);
  assert.ok(/hasDraft/.test(block),
    'setRows() would otherwise discard whatever the user had typed into the day');
});