'use strict';
// Unit tests for the team-entry notification feed in core.js.
//
// The interesting logic is deliberately pure (buildTeamEntryFeed /
// parseEntryTime / selectUnseenEntries), so it can be tested without a DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient } = require('./helpers/load-client');

function ctx() {
  return loadClient('core.js').sandbox;
}

const HOUR = 3600000;
const NOW = Date.parse('2026-01-10T12:00:00');

// ---------------------------------------------------------------- time parsing

test('parseEntryTime: accepts the sheet timestamp format', () => {
  const s = ctx();
  assert.equal(s.parseEntryTime('2026-01-10 09:30:00'), Date.parse('2026-01-10T09:30:00'));
});

test('parseEntryTime: accepts a Date, a number and a bare date', () => {
  const s = ctx();
  assert.equal(s.parseEntryTime(new Date(NOW)), NOW);
  assert.equal(s.parseEntryTime(1234), 1234);
  assert.equal(s.parseEntryTime('2026-01-10'), new Date(2026, 0, 10).getTime());
});

test('parseEntryTime: returns null instead of NaN for junk', () => {
  const s = ctx();
  ['', '   ', null, undefined, 'ط؛ظٹط± ظ…ط­ط¯ط¯', new Date('nope')].forEach(v => {
    const out = s.parseEntryTime(v);
    assert.ok(out === null, 'expected null for ' + JSON.stringify(v) + ', got ' + out);
  });
});

// ---------------------------------------------------------------- feed building

test('buildTeamEntryFeed: keeps other users and drops the current user', () => {
  const s = ctx();
  const feed = s.buildTeamEntryFeed({
    reports: [
      { id: 1, createdById: 'E003', createdByName: 'ظ…ظˆط¸ظپ ط¢ط®ط±', date: '2026-01-10 09:00:00', event: 'ط­ط¯ط«' },
      { id: 2, createdById: 'E002', createdByName: 'ط£ظ†ط§', date: '2026-01-10 09:30:00' },
    ],
  }, 'E002');
  assert.equal(feed.length, 1);
  assert.equal(feed[0].key, 'report:1');
  assert.equal(feed[0].who, 'ظ…ظˆط¸ظپ ط¢ط®ط±');
});

test('buildTeamEntryFeed: a deleted report never notifies', () => {
  const s = ctx();
  const feed = s.buildTeamEntryFeed({
    reports: [{ id: 7, createdById: 'E003', deletedAt: '2026-01-10 10:00:00' }],
  }, 'E002');
  assert.deepEqual(Array.from(feed), []);
});

test('buildTeamEntryFeed: covers all four entry types', () => {
  const s = ctx();
  const feed = s.buildTeamEntryFeed({
    reports: [{ id: 1, createdById: 'E003', date: '2026-01-10 09:00:00', event: 'ط­ط¯ط«' }],
    attendance: [{ timestamp: '2026-01-10 09:05:00', username: 'E003', status: 'ط­ط§ط¶ط±' }],
    movements: [{ item: 'ظƒط±طھظˆظ†', createdById: 'E003' }],
    advances: [{ date: '2026-01-10', employeeId: 'E003', type: 'ط¹ط§ط¯ظٹط©', amount: 50, createdAt: '2026-01-10 09:10:00' }],
  }, 'E002');
  const types = Array.from(feed.map(x => x.type)).sort();
  assert.deepEqual(types, ['advance', 'attendance', 'movement', 'report']);
});

test('buildTeamEntryFeed: one report counted once even if present twice', () => {
  const s = ctx();
  const row = { id: 5, createdById: 'E003', date: '2026-01-10 09:00:00' };
  const feed = s.buildTeamEntryFeed({ reports: [row, Object.assign({}, row)] }, 'E002');
  assert.equal(feed.length, 1);
});

test('buildTeamEntryFeed: attendance with the same timestamp by two users stays two', () => {
  const s = ctx();
  const feed = s.buildTeamEntryFeed({
    attendance: [
      { timestamp: '2026-01-10 09:00:00', username: 'E003' },
      { timestamp: '2026-01-10 09:00:00', username: 'E004' },
    ],
  }, 'E002');
  assert.equal(feed.length, 2, 'the key must include the username, not just the timestamp');
});

test('buildTeamEntryFeed: survives nulls and non-array sources', () => {
  const s = ctx();
  const feed = s.buildTeamEntryFeed({ reports: null, attendance: undefined, movements: [null], advances: 5 }, 'E002');
  assert.deepEqual(Array.from(feed), []);
});

test('buildTeamEntryFeed: a movement with no timestamp is still notifyable', () => {
  // The server strips rawDate from the response, so movements carry no time.
  // They must not be dropped just because the time is unknown.
  const s = ctx();
  const feed = s.buildTeamEntryFeed({ movements: [{ item: 'ظƒط±طھظˆظ†', createdById: 'E003' }] }, 'E002');
  assert.equal(feed.length, 1);
  assert.equal(feed[0].time, null);
});

test('buildTeamEntryFeed: identifies the current user by name when there is no id', () => {
  const s = ctx();
  const feed = s.buildTeamEntryFeed({
    reports: [{ id: 1, createdByName: 'E002' }, { id: 2, createdByName: 'E003' }],
  }, 'E002');
  assert.equal(feed.length, 1);
  assert.equal(feed[0].key, 'report:2');
});

// ---------------------------------------------------------------- unseen filter

test('selectUnseenEntries: hides what the user already read', () => {
  const s = ctx();
  const entries = [
    { key: 'a', time: NOW - HOUR },
    { key: 'b', time: NOW - HOUR },
  ];
  assert.equal(s.selectUnseenEntries(entries, ['a'], NOW, 6, 72).length, 1);
  assert.equal(s.selectUnseenEntries(entries, [], NOW, 6, 72).length, 2);
});

test('selectUnseenEntries: drops entries older than the window', () => {
  const s = ctx();
  const entries = [
    { key: 'fresh', time: NOW - 2 * HOUR },
    { key: 'stale', time: NOW - 200 * HOUR },
  ];
  const out = s.selectUnseenEntries(entries, [], NOW, 6, 72);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'fresh');
});

test('selectUnseenEntries: honours the display cap', () => {
  const s = ctx();
  const entries = Array.from({ length: 20 }, (_, i) => ({ key: 'k' + i, time: NOW }));
  assert.equal(s.selectUnseenEntries(entries, [], NOW, 6, 72).length, 6);
});

test('selectUnseenEntries: a zero max is not mistaken for unlimited', () => {
  const s = ctx();
  const entries = [{ key: 'a', time: NOW }];
  assert.equal(s.selectUnseenEntries(entries, [], NOW, 0, 72).length, 0);
});

test('selectUnseenEntries: accepts a Set as well as an array', () => {
  const s = ctx();
  const entries = [{ key: 'a', time: NOW }, { key: 'b', time: NOW }];
  assert.equal(s.selectUnseenEntries(entries, new Set(['a']), NOW, 6, 72).length, 1);
});

// ---------------------------------------------------------------- seen bookkeeping

test('rememberSeenEntryKeys: the read list is per user', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  const kE002 = s.entryFeedSeenKey();
  s.rememberSeenEntryKeys([{ key: 'report:1' }]);
  assert.ok(s.localStorage.getItem(kE002), 'E002 must have a read list');

  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E010' }));
  const kE010 = s.entryFeedSeenKey();
  assert.notEqual(kE010, kE002, 'a second user must get their own list');
  assert.equal(s.localStorage.getItem(kE010), null, "E010 must not inherit E002's read list");
});

test('rememberSeenEntryKeys: merging is additive and deduplicated', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  s.rememberSeenEntryKeys([{ key: 'a' }]);
  s.rememberSeenEntryKeys([{ key: 'b' }, { key: 'a' }]);
  const stored = JSON.parse(s.localStorage.getItem(s.entryFeedSeenKey()));
  assert.deepEqual(Array.from(stored).sort(), ['a', 'b']);
});

test('rememberSeenEntryKeys: an empty list writes nothing', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  s.rememberSeenEntryKeys([]);
  assert.equal(s.localStorage.getItem(s.entryFeedSeenKey()), null);
});

test('loadSeenEntryKeys: survives a corrupted value', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002' }));
  s.localStorage.setItem(s.entryFeedSeenKey(), '{not json');
  assert.equal(s.loadSeenEntryKeys().size, 0);
});

// ---------------------------------------------------------------- role gate

test('userSystemRole: reads the auth role, not the job title', () => {
  const s = ctx();
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002', role: 'manager', jobPosition: 'منسق' }));
  assert.equal(s.userSystemRole(), 'manager');
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002', systemRole: 'admin', role: 'some job' }));
  assert.equal(s.userSystemRole(), 'admin');
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E002', role: 'MANAGER ' }));
  assert.equal(s.userSystemRole(), 'manager');
});

// ---------------------------------------------------------------- wiring guard
// The logic above is pure and would keep passing even if the banner were
// detached from the page, so the wiring itself is asserted on the source.

const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the banner container exists in the page', () => {
  assert.match(read('index.html'), /id="entry-feed-notices"/,
    'without this container renderEntryFeedBanner() silently renders nothing');
});

test('the feed runs on app open and on cache refresh', () => {
  const core = read('core.js');
  const onOpen = core.match(/DOMContentLoaded[\s\S]{0,600}?checkTeamEntryFeed\(\)/);
  assert.ok(onOpen, 'the feed must run when an existing session opens the app');
  const onRefresh = core.match(/async function refreshAppCache[\s\S]*?checkTeamEntryFeed\(\)/);
  assert.ok(onRefresh, 'the feed must run after a data refresh');
});

test('the feed is wired without force so a dismissed banner stays dismissed', () => {
  const core = read('core.js');
  assert.doesNotMatch(core, /checkTeamEntryFeed\(\{\s*force:\s*true\s*\}\)/,
    'force would re-show dismissed entries on every refresh');
});

test('the feed is gated to admin and manager', () => {
  const core = read('core.js');
  const gate = core.match(/async function loadTeamEntrySources\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(gate, 'loadTeamEntrySources must exist');
  assert.match(gate[0], /role !== 'admin' && role !== 'manager'/,
    'a plain employee must not query the team feed at all');
});

test('a single failing source does not blank the whole feed', () => {
  const core = read('core.js');
  const load = core.match(/async function loadTeamEntrySources\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(load, /Promise\.allSettled/,
    'a rejected request must not suppress notifications from the other three');
});

// ---------------------------------------------------------------- read on navigation

/**
 * Build a core.js context with enough DOM to drive activateRoute() and the feed.
 * `hash` is set on the sandbox location so routeFromHash() sees a real route.
 */
function routeCtx(hash, user) {
  const c = loadClient('core.js', {
    setup(s) {
      // core.js يعلن getStoredUser وisPromoterAccount بنفسه، فتغطّي تعريفاتُها
      // أي stub نضعه هنا. نكتب الجلسة في التخزين مباشرة بدل استبدال الدالة.
      s.localStorage.setItem('currentUser', JSON.stringify(user));
      s.location.hash = hash;
      s.apiGet = async () => ({ status: 'success', advances: [], movements: [] });
      s.apiPost = async () => ({ status: 'success' });
    },
  });
  return c;
}

const ADMIN = { id: 'E001', name: 'المدير العام', role: 'admin' };

function seedFeed(s) {
  s.renderEntryFeedBanner([
    { key: 'report:1', type: 'report', who: 'موظف', what: 'تقرير مبيعات', date: '2026-01-10' },
  ]);
}

test('markEntryFeedRead: remembers the keys and clears the banner', () => {
  const c = routeCtx('#/reports', ADMIN);
  const s = c.sandbox;
  seedFeed(s);
  assert.ok(String(c.document.getElementById('entry-feed-notices').innerHTML).includes('alert-info'));

  s.markEntryFeedRead();

  assert.equal(c.document.getElementById('entry-feed-notices').innerHTML, '', 'banner must be empty');
  const seen = JSON.parse(c.localStorage.getItem(s.entryFeedSeenKey()) || '[]');
  assert.ok(seen.includes('report:1'), 'the key must be remembered so it never returns');
});

test('activateRoute: navigating to another page clears the feed', () => {
  const c = routeCtx('#/reports', ADMIN);
  const s = c.sandbox;
  s.activateRoute();          // الإقلاع الأول — prevRoute فارغ
  seedFeed(s);
  assert.ok(String(c.document.getElementById('entry-feed-notices').innerHTML).includes('alert-info'));

  s.location.hash = '#/salary';
  s.activateRoute();          // تنقل فعلي بين الشاشات

  assert.equal(c.document.getElementById('entry-feed-notices').innerHTML, '');
  const seen = JSON.parse(c.localStorage.getItem(s.entryFeedSeenKey()) || '[]');
  assert.ok(seen.includes('report:1'));
});

test('activateRoute: the initial boot does not clear the feed', () => {
  const c = routeCtx('#/reports', ADMIN);
  const s = c.sandbox;
  seedFeed(s);
  s.activateRoute();          // أول تشغيل — لا سابق له
  assert.ok(String(c.document.getElementById('entry-feed-notices').innerHTML).includes('alert-info'),
    'the feed must survive the first activateRoute, or it would never be seen');
});

test('activateRoute: a route guard redirect does not clear the feed', () => {
  // مستخدم عادي يحاول فتح لوحة التحكم: activateRoute يعيده للرئيسية مبكراً.
  // لا نريد أن يمسح هذا التوجيه الإشعارات قبل أن تُرسم.
  const c = routeCtx('#/dashboard', { id: 'E003', name: 'موظف', role: 'user' });
  const s = c.sandbox;
  seedFeed(s);
  s.activateRoute();
  assert.equal(s.location.hash, '#/reports', 'a plain employee must be sent home');
  assert.ok(String(c.document.getElementById('entry-feed-notices').innerHTML).includes('alert-info'),
    'the early return must not mark the feed read');
});
