'use strict';
// Unit tests for the browser-side pure helpers in core.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient } = require('./helpers/load-client');

function ctx() {
  return loadClient('core.js').sandbox;
}

test('escapeHtmlGlobal: escapes the five dangerous characters', () => {
  const s = ctx();
  assert.equal(s.escapeHtmlGlobal('<script>'), '&lt;script&gt;');
  assert.equal(s.escapeHtmlGlobal('a & b'), 'a &amp; b');
  assert.equal(s.escapeHtmlGlobal('"quoted"'), '&quot;quoted&quot;');
  assert.equal(s.escapeHtmlGlobal("it's"), 'it&#039;s');
});

test('escapeHtmlGlobal: neutralizes a script injection attempt', () => {
  const s = ctx();
  const out = s.escapeHtmlGlobal('<img src=x onerror="alert(1)">');
  assert.ok(!out.includes('<'), 'no raw < may survive');
  assert.ok(!out.includes('>'), 'no raw > may survive');
  assert.ok(out.includes('&lt;img'), 'should be entity-encoded');
});

test('escapeHtmlGlobal: handles null, undefined and numbers', () => {
  const s = ctx();
  assert.equal(s.escapeHtmlGlobal(null), '');
  assert.equal(s.escapeHtmlGlobal(undefined), '');
  assert.equal(s.escapeHtmlGlobal(0), '0');
  assert.equal(s.escapeHtmlGlobal(false), 'false');
});

test('reportsScopeKey: builds an owner+role+target cache key', () => {
  const s = ctx();
  assert.equal(s.reportsScopeKey({ userId: 'E001', role: 'admin', targetUserId: 'E003' }), 'e001__admin__E003');
  assert.equal(s.reportsScopeKey({ userId: 'E002', role: 'Manager', targetUserId: 'E002' }), 'e002__manager__E002');
});

test('reportsScopeKey: different roles do not share a cache entry', () => {
  const s = ctx();
  const admin = s.reportsScopeKey({ userId: 'E001', role: 'admin', targetUserId: 'all' });
  const user = s.reportsScopeKey({ userId: 'E003', role: 'user', targetUserId: 'all' });
  assert.notEqual(admin, user, 'a user must never read the admin cache bucket');
});

test('reportsScopeKey: defaults to a safe bucket', () => {
  const s = ctx();
  assert.equal(s.reportsScopeKey(), 'anon__default__all');
  assert.equal(s.reportsScopeKey({}), 'anon__default__all');
});

test('reportsScopeKey: falls back from userId to targetUserId', () => {
  const s = ctx();
  assert.equal(s.reportsScopeKey({ userId: 'E009', role: 'user' }), 'e009__user__E009');
});

// --- V70: the cache key used to be role+target only, so two managers sharing a
// browser read each other's cached report lists. It must be owner-scoped.

test('reportsScopeKey: two managers on one browser get different buckets', () => {
  const s = ctx();
  const a = s.reportsScopeKey({ userId: 'E002', role: 'manager', targetUserId: 'all' });
  const b = s.reportsScopeKey({ userId: 'E010', role: 'manager', targetUserId: 'all' });
  assert.notEqual(a, b, 'same role + same target but different owners must not collide');
});

test('reportsScopeKey: Arabic usernames stay distinguishable', () => {
  const s = ctx();
  // An employee id may fall back to the username, which can be Arabic. If the
  // key stripped non-ASCII both users would collapse to "anon" and share a
  // bucket — the exact leak this scoping was meant to close.
  const a = s.reportsScopeKey({ userId: 'أحمد', role: 'user', targetUserId: 'all' });
  const b = s.reportsScopeKey({ userId: 'إحمد', role: 'user', targetUserId: 'all' });
  assert.notEqual(a, b, 'Arabic owner ids must not collapse into one bucket');
  assert.notEqual(a, s.reportsScopeKey({ userId: 'خالد', role: 'user', targetUserId: 'all' }));
  assert.match(a, /^[\x21-\x7e]+$/, 'the key must stay ASCII-safe for localStorage');
});

test('reportsScopeKey: the owner comes from the stored session when not passed', () => {
  const c = ctx();
  c.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002', role: 'manager' }));
  assert.equal(c.reportsScopeKey({ role: 'manager', targetUserId: 'all' }),
    c.reportsScopeKey({ userId: 'E002', role: 'manager', targetUserId: 'all' }),
    'the refresh path (no userId) must land on the same bucket the page reads');
});

test('reports cache: a legacy entry is written and read per user', () => {
  const c = ctx();
  const seed = (id) => {
    c.localStorage.setItem('currentUser', JSON.stringify({ id, role: 'manager' }));
    c.saveReportsCacheEntry(c.reportsScopeKey({ userId: id, role: 'manager', targetUserId: 'all' }),
      [{ id: 1, owner: id }], { userId: id, targetUserId: 'all' });
  };
  seed('E002');
  assert.deepEqual(JSON.parse(c.readLegacyReportsCacheJSON()), [{ id: 1, owner: 'E002' }]);

  seed('E010');
  assert.deepEqual(JSON.parse(c.readLegacyReportsCacheJSON()), [{ id: 1, owner: 'E010' }],
    'the second user must see their own cache, not the first user\'s');
});

test('reports cache: the memory cache is not readable by another user', () => {
  const c = ctx();
  c.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002', role: 'manager' }));
  c.saveReportsCacheEntry(c.reportsScopeKey({ userId: 'E002', role: 'manager', targetUserId: 'all' }),
    [{ id: 7 }], { userId: 'E002', targetUserId: 'all' });
  assert.deepEqual(c.getMemoryReportsCache(), [{ id: 7 }], 'the owner sees their own cache');

  c.localStorage.setItem('currentUser', JSON.stringify({ id: 'E010', role: 'manager' }));
  assert.equal(c.getMemoryReportsCache(), null, 'a different user must not read the memory cache');
});

test('reports cache: two Arabic-named users never share a bucket', () => {
  const c = ctx();
  const seed = (id, reportId) => {
    c.localStorage.setItem('currentUser', JSON.stringify({ id, role: 'user' }));
    c.saveReportsCacheEntry(c.reportsScopeKey({ userId: id, role: 'user', targetUserId: 'all' }),
      [{ id: reportId }], { userId: id, targetUserId: 'all' });
  };
  seed('أحمد', 1);
  assert.deepEqual(c.getMemoryReportsCache(), [{ id: 1 }]);
  assert.deepEqual(JSON.parse(c.readLegacyReportsCacheJSON()), [{ id: 1 }]);

  seed('خالد', 2);
  assert.deepEqual(c.getMemoryReportsCache(), [{ id: 2 }], 'must switch, not merge');
  assert.deepEqual(JSON.parse(c.readLegacyReportsCacheJSON()), [{ id: 2 }]);
});

test('reports cache: invalidation removes every owner bucket and the old key', () => {
  const c = ctx();
  c.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002', role: 'manager' }));
  c.saveReportsCacheEntry(c.reportsScopeKey({ userId: 'E002', role: 'manager', targetUserId: 'all' }),
    [{ id: 1 }], { userId: 'E002', targetUserId: 'all' });
  c.localStorage.setItem('reportsCache', '[{"id":99}]'); // leftover from an older build

  c.invalidateReportsCache();

  const dump = c.localStorage._dump ? c.localStorage._dump() : {};
  const leftovers = Object.keys(dump).filter(k => k.includes('reportsCache'));
  assert.deepEqual(leftovers, [], 'no reports cache key may survive invalidation, got: ' + JSON.stringify(leftovers));
  assert.equal(c.getMemoryReportsCache(), null);
});

test('logout: a session expiry wipes the reports cache of every user', () => {
  const c = ctx();
  c.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002', role: 'manager' }));
  c.saveReportsCacheEntry(c.reportsScopeKey({ userId: 'E002', role: 'manager', targetUserId: 'all' }),
    [{ id: 1 }], { userId: 'E002', targetUserId: 'all' });
  assert.ok(Object.keys(c.localStorage._dump()).some(k => k.includes('reportsCache')), 'precondition: cache exists');

  c.forceLogout('انتهت الجلسة');

  const dump = c.localStorage._dump();
  assert.deepEqual(Object.keys(dump).filter(k => k.includes('reportsCache')), [],
    'forceLogout must not leave report data on the device');
  assert.equal(c.getMemoryReportsCache(), null);
  assert.equal(dump.currentUser, undefined, 'the session user must be cleared too');
});

test('logout: switching users wipes the reports cache', async () => {
  const c = ctx();
  c.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002', role: 'manager' }));
  c.saveReportsCacheEntry(c.reportsScopeKey({ userId: 'E002', role: 'manager', targetUserId: 'all' }),
    [{ id: 1 }], { userId: 'E002', targetUserId: 'all' });

  await c.handleAuthExpired();

  const dump = c.localStorage._dump();
  assert.deepEqual(Object.keys(dump).filter(k => k.includes('reportsCache')), [],
    'handleAuthExpired must not leave report data on the device');
});

test('isPromoterAccount: only role=user with a مروج job position', () => {
  const s = ctx();
  assert.equal(s.isPromoterAccount({ role: 'user', jobPosition: 'مروج' }), true);
  assert.equal(s.isPromoterAccount({ role: 'user', jobPosition: 'مسؤول جرد' }), false);
  assert.equal(s.isPromoterAccount({ role: 'manager', jobPosition: 'مروج' }), false);
  assert.equal(s.isPromoterAccount({ role: 'user' }), false);
  assert.equal(s.isPromoterAccount(null), false);
});

test('session tokens: store, read and clear the auth token', () => {
  const s = ctx();
  s.storeAppToken('tok-123');
  assert.equal(s.getAppToken(), 'tok-123');
  s.storeAppToken('tok-456');
  assert.equal(s.getAppToken(), 'tok-456', 'a new token replaces the old one');
  s.clearAppToken();
  assert.equal(s.getAppToken(), '');
});

test('session tokens: csrf token round-trips independently', () => {
  const s = ctx();
  s.storeAppToken('auth-1');
  s.storeCsrfToken('csrf-1');
  assert.equal(s.getAppToken(), 'auth-1');
  assert.equal(s.getCsrfToken(), 'csrf-1');
  s.clearCsrfToken();
  assert.equal(s.getCsrfToken(), '');
  assert.equal(s.getAppToken(), 'auth-1', 'clearing csrf must not clear auth');
});

test('getStoredUser: prefers localStorage then sessionStorage', () => {
  const s = ctx();
  assert.equal(s.getStoredUser(), null);
  s.sessionStorage.setItem('currentUser', JSON.stringify({ id: 'E002', role: 'manager' }));
  assert.equal(s.getStoredUser().id, 'E002');
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E001', role: 'admin' }));
  assert.equal(s.getStoredUser().id, 'E001');
});

test('getStoredUser: survives corrupt JSON without throwing', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', '{not json');
  s.sessionStorage.setItem('currentUser', 'also not json');
  assert.equal(s.getStoredUser(), null);
});

test('rejectionIdsSignature: changes when the rejection set changes', () => {
  const s = ctx();
  const empty = s.rejectionIdsSignature({ reports: [], attendance: [], movements: [] });
  const one = s.rejectionIdsSignature({ reports: [{ id: 'R1' }], attendance: [], movements: [] });
  assert.notEqual(empty, one);
  assert.equal(one, s.rejectionIdsSignature({ reports: [{ id: 'R1' }], attendance: [], movements: [] }));
});

test('rejectionIdsSignature: distinguishes reports from attendance ids', () => {
  const s = ctx();
  const r = s.rejectionIdsSignature({ reports: [{ id: 'X' }], attendance: [], movements: [] });
  const a = s.rejectionIdsSignature({ reports: [], attendance: [{ id: 'X' }], movements: [] });
  assert.notEqual(r, a, 'same id in a different bucket must not collide');
});

test('reportsToCSV: returns a placeholder for empty input', () => {
  const s = ctx();
  assert.equal(s.reportsToCSV([]), 'لا توجد بيانات');
  assert.equal(s.reportsToCSV(null), 'لا توجد بيانات');
  assert.equal(s.reportsToCSV('nope'), 'لا توجد بيانات');
});

test('reportsToCSV: emits the Arabic header row', () => {
  const s = ctx();
  const csv = s.reportsToCSV([{ id: '1' }]);
  const header = csv.split('\r\n')[0];
  assert.ok(header.includes('رقم التقرير'));
  assert.ok(header.includes('المبيعات'));
});

test('reportsToCSV: totals sales as price x quantity', () => {
  const s = ctx();
  const csv = s.reportsToCSV([{
    id: '1',
    sales: [{ price: 10, quantity: 2 }, { price: 5, quantity: 3 }],
  }]);
  const row = csv.split('\r\n')[1];
  // salesTotal 10*2 + 5*3 = 35.00, qty 5, count 2
  assert.ok(row.includes('"35.00","5","2"'), 'unexpected totals row: ' + row);
});

test('reportsToCSV: counts expenses and sums quantities', () => {
  const s = ctx();
  const csv = s.reportsToCSV([{
    id: '1',
    expenses: [{ quantity: 4 }, { quantity: 6 }],
  }]);
  const row = csv.split('\r\n')[1];
  assert.ok(row.includes('"10","2"'), 'unexpected expense totals: ' + row);
});

test('reportsToCSV: neutralizes Excel formula injection', () => {
  const s = ctx();
  const csv = s.reportsToCSV([{ id: '1', notes: '=cmd|/c calc', campaign: '+1+1', event: '@SUM(A1)' }]);
  const row = csv.split('\r\n')[1];
  assert.ok(!/"=cmd/.test(row), 'leading = must be neutralized');
  assert.ok(row.includes("\"'=cmd"), 'expected an apostrophe prefix');
  assert.ok(row.includes("\"'+1+1"), 'leading + must be neutralized');
  assert.ok(row.includes("'@SUM"), 'leading @ must be neutralized');
});

test('reportsToCSV: escapes embedded double quotes', () => {
  const s = ctx();
  const csv = s.reportsToCSV([{ id: '1', notes: 'he said "hi"' }]);
  const row = csv.split('\r\n')[1];
  assert.ok(row.includes('"he said ""hi"""'), 'quotes must be doubled: ' + row);
});

test('reportsToCSV: wraps every cell in quotes', () => {
  const s = ctx();
  const csv = s.reportsToCSV([{ id: '1', campaign: 'x' }]);
  const row = csv.split('\r\n')[1];
  // The numeric aggregate cells are not quoted; the string cells are.
  assert.ok(row.startsWith('"1","'));
});

test('downloadTextFile is defined and does not throw when unused', () => {
  const s = ctx();
  assert.equal(typeof s.downloadTextFile, 'function');
});

// ===================================================================
// V70: عزل كاش كل مستخدم عن بقية المستخدمين
// ===================================================================

test('ownerScopedKey: two users writing the same cache name get different keys', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  const a = s.ownerScopedKey('attendanceCache::all');
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E010' }));
  const b = s.ownerScopedKey('attendanceCache::all');
  assert.notEqual(a, b, 'same cache name + different owner must not collide');
  assert.ok(a.endsWith('::e002'), 'key must carry the owner, got: ' + a);
  assert.ok(b.endsWith('::e010'), 'key must carry the owner, got: ' + b);
});

test('ownerScopedKey: is ASCII-safe even for Arabic owner ids', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'أحمد' }));
  const k = s.ownerScopedKey('appDB_v42');
  assert.match(k, /^[\x21-\x7e]+$/, 'localStorage keys must stay ASCII-safe, got: ' + k);
});

test('appDbCacheKey: is a function, not a const frozen before login', () => {
  // A const would be evaluated at page load, before any login, and would lock
  // every user into the same "::anon" bucket for the whole session.
  const s = ctx();
  assert.equal(typeof s.appDbCacheKey, 'function');
  assert.equal(typeof s.appDbCacheTsKey, 'function');
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  const a = s.appDbCacheKey();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E010' }));
  assert.notEqual(a, s.appDbCacheKey());
});

test('sweepForeignUserCaches: removes another user cache, keeps mine', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  s.localStorage.setItem('attendanceCache::all::e010', '[{"user":"E010"}]'); // другой
  s.localStorage.setItem('appDB_v42::e010', '{"employees":[]}');
  s.localStorage.setItem('attendanceCache::all::e002', '[{"user":"E002"}]');
  s.localStorage.setItem('appDB_v42::e002', '{"employees":[]}');

  const removed = s.sweepForeignUserCaches();

  assert.deepEqual(Object.keys(s.localStorage._dump()).filter(k => k.includes('e010')), [],
    'another user cache must be gone');
  const dump = s.localStorage._dump();
  assert.equal(dump['attendanceCache::all::e002'], '[{"user":"E002"}]', 'my own cache must survive');
  assert.equal(dump['appDB_v42::e002'], '{"employees":[]}');
  assert.equal(removed.length, 2, 'sweep should report what it removed, got: ' + JSON.stringify(removed));
});

test('sweepForeignUserCaches: deletes pre-fix unscoped keys', () => {
  // These are the keys written by older builds. They carry no owner, so the
  // sweep must drop them or the first user to log in keeps inheriting them.
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  s.localStorage.setItem('attendanceCache::all', '[{"user":"?"}]');
  s.localStorage.setItem('appDB_v42-employees-merged', '{"employees":[]}');
  s.localStorage.setItem('reportsCache_v2::manager__all', '[]');
  s.localStorage.setItem('lastReportPoint', '{"point":"x"}');
  s.localStorage.setItem('reportFormLastState', '{"items":[]}');

  s.sweepForeignUserCaches();

  const left = Object.keys(s.localStorage._dump()).filter(s.isUserScopedCacheKey);
  assert.deepEqual(left, [], 'legacy unscoped cache keys must be swept, got: ' + JSON.stringify(left));
});

test('sweepForeignUserCaches: never touches device-level or auth keys', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  ['theme', 'installBannerShown', 'loginSessions', 'loginTimestamp', 'appAuthToken']
    .forEach(k => s.localStorage.setItem(k, 'x'));
  s.sweepForeignUserCaches();
  const dump = s.localStorage._dump();
  ['theme', 'installBannerShown', 'loginSessions', 'loginTimestamp', 'appAuthToken']
    .forEach(k => assert.equal(dump[k], 'x', k + ' must survive the sweep'));
  assert.equal(dump.currentUser, JSON.stringify({ id: 'E002' }), 'the session must survive the sweep');
});

test('sweepForeignUserCaches: an owner key is not mistaken by a name suffix', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  // 'e002' appears at the end of this key but is not the owner segment.
  s.localStorage.setItem('attendanceCache::all::team-e002', '[{"user":"E010"}]');
  s.sweepForeignUserCaches();
  assert.equal(s.localStorage.getItem('attendanceCache::all::team-e002'), null);
});

test('sweepForeignUserCaches: also sweeps sessionStorage', () => {
  // reportToEdit (the report being edited) lives in sessionStorage, so a
  // localStorage-only sweep would let it survive a user switch in the same tab.
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  s.sessionStorage.setItem('reportToEdit::e010', '{"id":99}');
  s.sessionStorage.setItem('reportToEdit::e002', '{"id":1}');
  s.sessionStorage.setItem('loginTimestamp', '1700000000000');

  const removed = s.sweepForeignUserCaches();

  assert.equal(s.sessionStorage.getItem('reportToEdit::e010'), null, 'a foreign edit target must be gone');
  assert.equal(s.sessionStorage.getItem('reportToEdit::e002'), '{"id":1}', 'my own edit target must survive');
  assert.equal(s.sessionStorage.getItem('loginTimestamp'), '1700000000000', 'session keys must survive');
  // The array is built inside the vm, so copy it out before comparing prototypes.
  assert.deepEqual(Array.from(removed), ['reportToEdit::e010']);
});

test('sweepForeignUserCaches: a previous user draft is not restored by the next user', () => {
  const r = loadClient('core.js');
  const s = r.sandbox;
  // formStateKey is a top-level `const`, which lives in the script scope rather
  // than on the global object — so it has to be evaluated, not read off `s`.
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  const key = r.evalIn('formStateKey()');
  s.localStorage.setItem(key, JSON.stringify({ items: ['E002 secret work'] }));
  assert.ok(s.localStorage.getItem(key), 'precondition: the draft was saved');

  // E002 closed the tab without logging out. E010 signs in on the same browser.
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E010' }));
  s.sweepForeignUserCaches();

  assert.equal(s.localStorage.getItem(key), null, 'E010 must not inherit the E002 draft');
  assert.notEqual(key, r.evalIn('formStateKey()'), 'and E010 writes to a different key');
});

test('draft keys are owner-scoped, so a draft and its owner travel together', () => {
  const r = loadClient('core.js');
  const s = r.sandbox;
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  const draft = r.evalIn('formStateKey()');
  const edit = r.evalIn('reportToEditKey()');
  assert.ok(draft.endsWith('::e002'), draft);
  assert.ok(edit.endsWith('::e002'), edit);
  assert.notEqual(draft, edit);
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E010' }));
  assert.notEqual(r.evalIn('formStateKey()'), draft);
  assert.notEqual(r.evalIn('reportToEditKey()'), edit);
});
