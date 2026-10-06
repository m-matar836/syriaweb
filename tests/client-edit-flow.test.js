'use strict';
// Regression tests for the "تعديل" (edit) button in the history screen.
//
// The button was dead: clicking it threw `ReferenceError: EDIT_STATE_KEY is not
// defined` on the first line of the handler, so the two statements that actually
// do the work — handing the report to the reports screen and navigating there —
// never ran. The click produced no navigation, no edit mode and no visible
// error, which is why it looked like the button was simply disabled.
//
// The identifier was never declared anywhere in the project. Every other file
// spells the same sessionStorage key `reportToEditKey()` (core.js), which is what
// the reports screen reads back. So the test below also pins the key itself: a
// write to some other key would "work" and still lose the edit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadClient, FakeEl, ROOT } = require('./helpers/load-client');

const ELEMENT_IDS = [
  'reports-accordion', 'searchInput', 'no-results-message', 'reportsCount',
  'qrCopyLinkBtn', 'qrEditLink', 'loadMoreReportsBtn', 'historyTitle',
  'historyEmployeeFilterWrap', 'historyEmployeeFilterSelect', 'approveAllReportsBtn',
  'qrCanvasWrap', 'qrModal', 'loadMoreReportsWrap', 'historyCampaignFilter',
  'historyEventFilter', 'historyStatusFilter', 'historyIdFilter',
  'clearHistoryFiltersBtn', 'exportHistoryCSV', 'exportHistoryXLSX',
];

const rep = (id, owner) => ({
  id, campaign: 'حملة A', market: 'سوق', date: '2026-01-01', event: 'حدث 1',
  supervisor: 'مشرف', coordinator: 'منسق', inventoryDependency: '', notes: '',
  promoters: [], sales: [{ product: 'منتج', price: 100, quantity: 1 }],
  salesOfCompetitor: [], expenses: [], createdById: owner,
  createdByName: owner, approvalStatus: 'pending', barcode: '', deletedAt: '',
});

const ALL_REPORTS = [rep(1, 'E003'), rep(2, 'E004')];
const TEAM = [{ id: 'E003', name: 'موظف أول' }, { id: 'E004', name: 'موظف ثاني' }];

function historyCtx() {
  const els = {};
  ELEMENT_IDS.forEach(id => { els[id] = new FakeEl(id === 'reports-accordion' ? 'div' : 'input', id); });

  const c = loadClient('page-history.js', {
    setup(s) {
      s.__activator = null;
      s.memoryReportsCache = ALL_REPORTS;
      s.localStorage.setItem('currentUser', JSON.stringify({
        id: 'E002', name: 'مدير الفرع', role: 'manager', username: 'mgr1',
      }));
      s.registerView = (route, fn) => { if (route === 'history') s.__activator = fn; };
      s.esc = (v) => String(v ?? '');
      s.showToast = () => {};
      s.getDbData = async () => ({ products: {} });
      s.reportsToCSV = () => 'csv';
      s.downloadTextFile = () => {};
      s.loadXlsxLibrary = async () => null;
      s.confirm = () => true;
      s.alert = () => {};
      s.fetchTeamOptions = async () => TEAM;
      // core.js owns this key. The history screen must use the same one the
      // reports screen reads back, otherwise the edit is silently lost.
      s.ownerScopedKey = (k) => 'owner:E002:' + k;
      s.reportToEditKey = () => s.ownerScopedKey('reportToEdit');
      s.apiGet = async (action) => {
        if (action === 'getTeamOptions') return { status: 'success', options: TEAM };
        if (action === 'getReports') return ALL_REPORTS;
        return [];
      };
      s.apiPost = async () => ({ status: 'success' });
      s.__nav = [];
      s.navigateTo = (route) => { s.__nav.push(route); s.location.hash = '#/' + route; };
      s.document.getElementById = (id) => els[id] || null;
    },
  });
  return { s: c.sandbox, els, c };
}

const editButtons = (els) => els['reports-accordion'].querySelectorAll('.edit-report-btn');
const clickEdit = (btn) => btn.dispatch('click', { preventDefault() {} });

test('history edit button: clicking it does not throw', async () => {
  const { s, els } = historyCtx();
  await s.__activator();
  const btn = editButtons(els)[0];
  assert.ok(btn, 'the edit button must be rendered');
  assert.doesNotThrow(() => clickEdit(btn),
    'the click handler must run to completion — a throw here silently cancels the navigation');
});

test('history edit button: clicking it navigates to the reports screen', async () => {
  const { s, els } = historyCtx();
  await s.__activator();
  clickEdit(editButtons(els)[0]);
  assert.deepEqual(s.__nav, ['reports'],
    'the handler must reach navigateTo(); everything before it threw instead');
});

test('history edit button: it passes the report id to the reports screen', async () => {
  const { s, els } = historyCtx();
  await s.__activator();
  const btn = editButtons(els).find(b => b.getAttribute('data-report-id') === '2');
  clickEdit(btn);
  assert.equal(String(s.__spaPendingEditId), '2',
    'the pending edit id is what puts the reports screen into edit mode');
});

test('history edit button: it stores the report under the key the reports screen reads', async () => {
  const { s, els } = historyCtx();
  await s.__activator();
  clickEdit(editButtons(els).find(b => b.getAttribute('data-report-id') === '2'));

  const raw = s.sessionStorage.getItem('owner:E002:reportToEdit');
  assert.ok(raw, 'sessionStorage must hold the report under reportToEditKey()');
  assert.equal(JSON.parse(raw).id, 2);
});

// The reports screen clears the key after it consumes it (page-reports.js), so
// re-entering edit mode for the same report has to be able to write it again.
test('history edit button: the key is writable again after the reports screen consumed it', async () => {
  const { s, els } = historyCtx();
  await s.__activator();
  const btn = editButtons(els).find(b => b.getAttribute('data-report-id') === '2');

  clickEdit(btn);
  s.sessionStorage.removeItem('owner:E002:reportToEdit');
  clickEdit(editButtons(els).find(b => b.getAttribute('data-report-id') === '2'));
  assert.equal(JSON.parse(s.sessionStorage.getItem('owner:E002:reportToEdit')).id, 2);
});

// ---------------------------------------------------------------------------
// Project-wide guard for the same class of bug.
//
// A bare identifier that exists in no file is a ReferenceError waiting for the
// user to click something. The click above proves it can stay invisible, so the
// sweep is done statically over the whole client: comments and string literals
// are stripped first, otherwise `HTTP`, `PDF`, `CODE_128` and friends (all of
// which are string values here) drown the real finding in noise.
// ---------------------------------------------------------------------------

const CLIENT_FILES = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && f !== 'service-worker.js');

// Stripping must not shift line numbers, or every failure would point at the
// wrong line, so each removed span is replaced by spaces of the same length.
const blank = (src) => src.replace(/[^\n]/g, ' ');
const stripCommentsAndStrings = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, m => blank(m))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)))
  .replace(/`(?:\\.|[^`\\])*`/g, m => blank(m))
  .replace(/'(?:\\.|[^'\\\n])*'/g, m => blank(m))
  .replace(/"(?:\\.|[^"\\\n])*"/g, m => blank(m));

const declaredNames = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    m[1].split(',').forEach(p => {
      const n = p.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    });
  }
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)) names.add(m[1]);
  return names;
};

// Real platform/library globals, plus the third-party roots the sandbox stubs.
const AMBIENT = new Set([
  'JSON', 'URL', 'URLSearchParams', 'IS', 'AS', 'HTML', 'CSS', 'DOM', 'PDF', 'GET', 'POST',
  'Html5QrcodeSupportedFormats',
]);

test('no client file calls a constant that no file declares', () => {
  const sources = Object.fromEntries(
    CLIENT_FILES.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
  const declared = new Set();
  for (const src of Object.values(sources)) {
    for (const n of declaredNames(src)) declared.add(n);
  }

  const undeclared = [];
  for (const [file, src] of Object.entries(sources)) {
    stripCommentsAndStrings(src).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(\.)?\b([A-Z][A-Z0-9_]{2,})\b/g)) {
        if (m[1]) continue;            // member access: Html5QrcodeSupportedFormats.CODE_128
        if (!declared.has(m[2]) && !AMBIENT.has(m[2])) undeclared.push(`${file}:${i + 1}: ${m[2]}`);
      }
    });
  }
  assert.deepEqual(undeclared, [],
    'these identifiers are used as values but declared nowhere, so touching them throws at runtime: '
    + undeclared.join(', '));
});

test('the pending-edit handoff uses one key on both screens', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const history = read('page-history.js');
  const reports = read('page-reports.js');
  const core = read('core.js');

  // Written by the history screen, consumed by the reports screen.
  assert.match(history, /sessionStorage\.setItem\(\s*reportToEditKey\(\)/,
    'the history screen must store the report under reportToEditKey()');
  assert.match(reports, /sessionStorage\.getItem\(\s*reportToEditKey\(\)/,
    'the reports screen reads the same key');

  // 'spaEditReportId' was read in core.js and written by nothing at all, so the
  // branch could never fire — dead code that looks like the working path.
  const writers = [...`${history}\n${reports}\n${core}`.matchAll(/setItem\(\s*['"]spaEditReportId['"]/g)];
  assert.deepEqual(writers, [], 'spaEditReportId has no writer, so core.js reading it is dead code');
  assert.doesNotMatch(core, /getItem\(\s*['"]spaEditReportId['"]/,
    'core.js reads spaEditReportId but nothing sets it');
});
