'use strict';
// ===================================================================
// What does the «تحديث البيانات» button actually refresh: the whole
// cache, or part of it?
//
// This suite answers that question by *running* refreshAppCache() and
// recording every endpoint it requests, rather than trusting the
// function's name or the «تم تحديث كل البيانات» label it flashes.
//
// The answer is: PART. The button requests six endpoints. Everything
// else the app can read is left untouched, so it can only stay
// correct if the screen holding it refetches when the refresh ends.
// refreshAppCache() fires `appDataRefreshed` for exactly that reason,
// and the dashboard/history/attendance/movement screens use it.
//
// The gaps this suite exists to catch are the screens that read a
// non-refreshed endpoint and do NOT listen for that event: they keep
// showing pre-refresh data while the button claims everything is up to
// date.
// ===================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadClient, ROOT } = require('./helpers/load-client');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const pageFiles = () =>
  fs.readdirSync(ROOT).filter(f => /^page-.*\.js$/.test(f)).sort();

/**
 * Endpoints that are safe even though the button never requests them.
 *
 * DERIVED_FROM_DB — the value arrives inside getInitialData, which the
 *   button *does* refresh, so the local copy is already current.
 *   page-reports.js falls back to a direct request only when that copy
 *   is empty.
 * SELF_REFETCH — fetched fresh from the server every time it is needed,
 *   so no cached copy can go stale behind the user's back.
 */
const DERIVED_FROM_DB = new Set(['getCompetitorProducts']);
const SELF_REFETCH = new Set(['getReportById', 'getReportsPage']);

/** Every read-only endpoint a page can ask the server for. */
function readEndpoints(file) {
  const out = new Set();
  for (const m of read(file).matchAll(/api(?:Get|Post)\(\s*'([A-Za-z]+)'/g)) {
    if (/^(get|find)/.test(m[1])) out.add(m[1]);
  }
  return out;
}

/** Flattened across pages, so the two never clash as Sets in a diff. */
const allEndpoints = () => [...new Set(pageFiles().flatMap(f => [...readEndpoints(f)]))];

const listensForRefreshEvent = file =>
  /addEventListener\(\s*'appDataRefreshed'/.test(read(file));

/**
 * Press the button for real and record the endpoints it requests.
 *
 * Uses the real core.js and the real function, so this cannot drift from
 * the implementation the way a hardcoded list would.
 */
async function endpointsRefreshedByButton() {
  const actions = [];
  const s = loadClient('core.js', {
    setup(sandbox) {
      sandbox.navigator = { userAgent: 'node-test', onLine: true, serviceWorker: null };
    },
  });
  s.sandbox.sessionStorage.setItem('currentUser',
    JSON.stringify({ id: 'E001', role: 'admin', name: 'Admin', username: 'admin1' }));
  s.sandbox.apiGet = (action) => {
    actions.push(action);
    return Promise.resolve(
      action === 'getInitialData'
        ? { status: 'success', products: [], employees: [], locations: [] }
        : []);
  };
  s.sandbox.checkRejections = () => {};
  s.sandbox.checkTeamEntryFeed = () => {};

  const res = await s.evalIn('refreshAppCache({ silent: true })');
  assert.equal(res.ok, true,
    'the refresh itself must succeed for this question to mean anything: '
    + (res.error && res.error.message));
  return actions;
}

/** Screens left showing data the button did not refresh. */
function staleScreens(refreshed) {
  const stale = new Map();
  for (const f of pageFiles()) {
    const gap = [...readEndpoints(f)]
      .filter(a => !refreshed.has(a) && !DERIVED_FROM_DB.has(a) && !SELF_REFETCH.has(a));
    if (gap.length) stale.set(f, gap);
  }
  return stale;
}

// ------------------------------------------------------------------ the answer

test('the refresh button requests six endpoints, and no more', async () => {
  // Pinned deliberately. This is the documented boundary of what
  // «تحديث البيانات» covers; anything added or removed here is a change
  // to what the user is told the button did, so it must be a visible edit.
  const actions = await endpointsRefreshedByButton();

  assert.deepEqual([...new Set(actions)].sort(),
    ['getAttendance', 'getInitialData', 'getReports', 'getStatusOptions',
      'getTeamOptions', 'getUserFestivalMovements'],
    'the set of endpoints «تحديث البيانات» requests changed');
});

test('the refresh button covers part of the app, not all of it', async () => {
  // The finding this whole file documents. If this ever starts failing the
  // button became a genuinely full refresh and the rest of the suite can be
  // simplified — that would be an improvement, not a regression.
  const refreshed = new Set(await endpointsRefreshedByButton());

  const neverRefreshed = allEndpoints()
    .filter(a => !refreshed.has(a) && !DERIVED_FROM_DB.has(a) && !SELF_REFETCH.has(a))
    .sort();

  assert.ok(neverRefreshed.length > 0,
    'the button now refreshes every endpoint; drop the per-screen guard below');
  assert.deepEqual(neverRefreshed, [
    'getDashboardData', 'getExpensesByDate', 'getExpensesList', 'getExpensesOptions',
    'getPromoterGoals', 'getSalaryAdvances', 'getUsersAdmin',
  ], 'the set of endpoints the button leaves alone changed');
});

// ------------------------------------------------------------------ the guard

test('every screen left holding unrefreshed data refetches on appDataRefreshed', async () => {
  // The contract that makes a partial refresh safe. A screen whose data the
  // button does not touch must listen for the event the button fires, or the
  // user presses «تحديث كل البيانات» and keeps looking at the old numbers.
  const refreshed = new Set(await endpointsRefreshedByButton());
  const stale = staleScreens(refreshed);

  const deaf = [...stale.entries()].filter(([f]) => !listensForRefreshEvent(f));

  assert.deepEqual(deaf, [],
    'these screens read data «تحديث البيانات» never refreshes and never refetch when it ends:\n  '
    + deaf.map(([f, gap]) => `${f} → ${gap.join(', ')}`).join('\n  ')
    + '\nEach needs an appDataRefreshed listener, or the button has to request its endpoints too.');
});

test('a screen that keeps its own client-side cache may still need to refetch', async () => {
  // Why attendance/history/movement are not redundant for listening, even
  // though every endpoint they read is one the button already requested:
  // the button only writes the master DB and the reports memory cache. It
  // does NOT touch the per-screen localStorage keys, so those screens have
  // to refetch to rewrite their own copy. Pinned here because "these
  // listeners are redundant, drop them" is the tempting wrong fix for the
  // failure above.
  const refreshed = new Set(await endpointsRefreshedByButton());
  const fullyRefreshedButListening = pageFiles()
    .filter(listensForRefreshEvent)
    .filter(f => [...readEndpoints(f)].length > 0)
    .filter(f => [...readEndpoints(f)].every(a => refreshed.has(a) || DERIVED_FROM_DB.has(a) || SELF_REFETCH.has(a)));

  assert.deepEqual(fullyRefreshedButListening.sort(), [
    'page-attendance.js', 'page-history.js', 'page-movement.js',
  ], 'the set of screens that refetch purely to rewrite their own cache changed');
});

// ------------------------------------------------------- the silent variant

test('a background master-data refresh touches the master data and nothing else', async () => {
  // The price-keystroke path. It must not become a de-facto full refresh:
  // page-reports.js calls it on every debounced price edit, so anything extra
  // here is paid for on each keystroke.
  const actions = [];
  const s = loadClient('core.js', {
    setup(sandbox) {
      sandbox.navigator = { userAgent: 'node-test', onLine: true, serviceWorker: null };
    },
  });
  s.sandbox.sessionStorage.setItem('currentUser',
    JSON.stringify({ id: 'E001', role: 'admin', name: 'Admin', username: 'admin1' }));
  s.sandbox.apiGet = (action) => {
    actions.push(action);
    return Promise.resolve(
      action === 'getInitialData'
        ? { status: 'success', products: [], employees: [], locations: [] }
        : []);
  };
  s.sandbox.checkRejections = () => { actions.push('sidecheck:rejections'); };
  s.sandbox.checkTeamEntryFeed = () => { actions.push('sidecheck:entryFeed'); };

  await s.evalIn('refreshAppCache({ silent: true, refreshReports: false })');

  assert.deepEqual(actions, ['getInitialData'],
    'a master-data-only refresh must request exactly the master data, got: ' + actions.join(', '));
});

// ------------------------------------------------------------- the reporting

test('diagnostics: prints the split so the answer is readable without reading code', async () => {
  const refreshed = new Set(await endpointsRefreshedByButton());
  const never = allEndpoints()
    .filter(a => !refreshed.has(a) && !DERIVED_FROM_DB.has(a) && !SELF_REFETCH.has(a))
    .sort();
  const stale = staleScreens(refreshed);

  console.log('\n  --- «تحديث البيانات» coverage ---');
  console.log('  refreshed by the button : ' + [...refreshed].sort().join(', '));
  console.log('  never refreshed         : ' + never.join(', '));
  for (const [f, gap] of stale) {
    console.log(`    ${f.padEnd(22)} ${listensForRefreshEvent(f) ? 'refetches on refresh ✓' : 'STAYS STALE ✗ → ' + gap.join(', ')}`);
  }
  console.log('  ---\n');

  assert.ok(true);
});