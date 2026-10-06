'use strict';
// Guard against the V70 regression coming back.
//
// The owner-scoping fix is easy to undo by accident: someone adds a cache to a
// page with a plain string literal and the cross-user leak returns silently,
// because no behavioural test touches that page's DOM. These tests read the
// page sources and fail if a sensitive cache stops being owner-scoped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('attendance cache keys are owner-scoped', () => {
  const src = read('page-attendance.js');
  assert.match(src, /attendanceCacheKey\s*=\s*\(\)\s*=>\s*ownerScopedKey\(/,
    'attendanceCacheKey must wrap the name in ownerScopedKey()');
  assert.match(src, /statusCacheKey\s*=\s*\(\)\s*=>\s*ownerScopedKey\(/,
    'the attendance status cache must be owner-scoped too');
  assert.doesNotMatch(src, /`attendanceCache::\$\{[^}]+\}`\s*;\s*$/m,
    'a raw attendanceCache:: template literal means someone dropped the owner');
});

test('the base-data cache is a function, not a const frozen before login', () => {
  for (const f of ['core.js', 'page-reports.js', 'page-login.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /localStorage\.(set|get)Item\(\s*APP_DB_(KEY|TS_KEY)\s*,/,
      f + ' still uses the pre-V70 APP_DB_* const');
  }
  const core = read('core.js');
  assert.doesNotMatch(core, /const APP_DB_KEY\s*=/, 'core.js must not keep the stale const declaration');
  assert.match(core, /function appDbCacheKey\(\)/);
  assert.match(core, /function appDbCacheTsKey\(\)/);
});

test('login sweeps foreign caches before any cache is read', () => {
  const src = read('page-login.js');
  const sweepAt = src.indexOf('sweepForeignUserCaches()');
  assert.ok(sweepAt !== -1, 'page-login.js must sweep foreign caches on login');
  const sessionAt = src.search(/setItem\('currentUser'/);
  const firstDbRead = src.search(/getDbData\(\)|loginResult\.db/);
  assert.ok(sweepAt > sessionAt, 'the sweep must run after the session is stored, or the owner is unknown');
  assert.ok(sweepAt < firstDbRead, 'the sweep must run before any cache/db read');
});

test('every sensitive cache prefix is listed in the sweep', () => {
  const core = read('core.js');
  const block = core.match(/USER_SCOPED_CACHE_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'USER_SCOPED_CACHE_PREFIXES must exist');
  // Every key that holds per-user or server data must be swept, or it becomes
  // a hole the moment a new page writes to it.
  ['reportsCache', 'attendanceCache', 'attendanceStatusCache', 'appDB_',
    'dbCacheTimestamp_', 'expensesDraft', 'lastReportPoint',
    'reportFormLastState', 'reportToEdit'].forEach(prefix => {
    assert.ok(block[1].includes(prefix), prefix + ' is missing from USER_SCOPED_CACHE_PREFIXES');
  });
});

test('device-level keys are not swept', () => {
  const core = read('core.js');
  const block = core.match(/USER_SCOPED_CACHE_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
  ['theme', 'installBannerShown', 'loginSessions', 'currentUser']
    .forEach(k => assert.ok(!block[1].includes(`'${k}'`),
      k + ' is device/session level and must not be swept'));
});

test('draft keys are owner-scoped and no longer literal constants', () => {
  const core = read('core.js');
  assert.match(core, /const formStateKey\s*=\s*\(\)\s*=>\s*ownerScopedKey\('reportFormLastState'\)/);
  assert.match(core, /const reportToEditKey\s*=\s*\(\)\s*=>\s*ownerScopedKey\('reportToEdit'\)/);
  // The old literal constants must be gone everywhere, or a page could keep
  // writing the unscoped key and the owner-scoped reader would never see it.
  for (const f of ['core.js', 'page-reports.js', 'page-expenses.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /FORM_STATE_KEY|EDIT_STATE_KEY|EXP_DRAFT_KEY|LAST_POINT_KEY/,
      f + ' still references a pre-V70 draft key constant');
  }
  assert.match(read('page-reports.js'), /const lastPointKey\s*=\s*\(\)\s*=>\s*ownerScopedKey\('lastReportPoint'\)/);
  assert.match(read('page-expenses.js'), /const expDraftKey\s*=\s*\(\)\s*=>\s*ownerScopedKey\('expensesDraft::v1'\)/);
});

test('the sweep clears sessionStorage, where reportToEdit lives', () => {
  const core = read('core.js');
  const body = core.match(/function sweepForeignUserCaches\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(body, 'sweepForeignUserCaches must exist');
  assert.match(body[1], /\[localStorage,\s*sessionStorage\]/,
    'reportToEdit lives in sessionStorage, so the sweep must cover it too');
});

test('the sweep does not touch session-only auth keys', () => {
  const core = read('core.js');
  const block = core.match(/USER_SCOPED_CACHE_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
  ['loginTimestamp', 'currentUser', 'appAuthToken', 'appCsrfToken']
    .forEach(k => assert.ok(!block[1].includes(`'${k}'`),
      k + ' must survive a sessionStorage sweep or the session breaks'));
});
