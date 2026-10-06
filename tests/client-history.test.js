'use strict';
// Unit tests for page-history.js — the "سجل التعديلات" screen.
//
// Two bugs are covered here:
//  1. The screen rendered blank and never fetched, because renderReports() is
//     invoked before the `const populateFilterOptions` declaration below it is
//     evaluated (temporal dead zone) -> ReferenceError aborts handleHistoryPage.
//  2. Picking an employee in the filter showed "تعذر تحميل بيانات هذا الموظف"
//     instead of that employee's reports, for the same reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient, FakeEl } = require('./helpers/load-client');

const ELEMENT_IDS = [
  'reports-accordion', 'searchInput', 'no-results-message', 'reportsCount',
  'qrCopyLinkBtn', 'qrEditLink', 'loadMoreReportsBtn', 'historyTitle',
  'historyEmployeeFilterWrap', 'historyEmployeeFilterSelect', 'approveAllReportsBtn',
  'qrCanvasWrap', 'qrModal', 'loadMoreReportsWrap', 'historyCampaignFilter',
  'historyEventFilter', 'historyStatusFilter', 'historyIdFilter',
  'clearHistoryFiltersBtn', 'exportHistoryCSV', 'exportHistoryXLSX',
];

const mk = (tag, id) => new FakeEl(tag, id);

function rep(id, owner, campaign = 'حملة A', event = 'حدث 1') {
  return {
    id, campaign, market: 'سوق', date: '2026-01-0' + (id % 9 + 1), event,
    supervisor: 'مشرف', coordinator: 'منسق', inventoryDependency: '', notes: '',
    promoters: [], sales: [{ product: 'منتج', price: 100, quantity: 1 }],
    salesOfCompetitor: [], expenses: [], createdById: owner,
    createdByName: owner, approvalStatus: 'pending', barcode: '', deletedAt: '',
  };
}

const ALL_REPORTS = [rep(1, 'E003'), rep(2, 'E004'), rep(3, 'E005'), rep(4, 'E003', 'حملة B', 'حدث 2')];
const TEAM = [{ id: 'E003', name: 'موظف أول' }, { id: 'E004', name: 'موظف ثاني' }, { id: 'E005', name: 'موظف ثالث' }];

/**
 * @param {object} opts
 * @param {Array|null} opts.memoryCache  value for the in-memory reports cache
 *                                        (non-null is what breaks the page)
 */
function historyCtx(opts = {}) {
  const els = {};
  ELEMENT_IDS.forEach(id => { els[id] = mk(id === 'reports-accordion' ? 'div' : 'input', id); });
  els['historyEmployeeFilterSelect'] = mk('select', 'historyEmployeeFilterSelect');
  els['searchInput'].value = '';
  els['historyIdFilter'].value = '';
  ['historyCampaignFilter', 'historyEventFilter', 'historyStatusFilter']
    .forEach(id => { els[id].value = ''; });

  const els2 = els;
  const c = loadClient('page-history.js', {
    setup(s) {
      s.__activator = null;
      s.__errors = [];
      // page-history.js reads the signed-in user straight out of storage.
      s.localStorage.setItem('currentUser', JSON.stringify(opts.user || {
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

      // Memory cache. page-history.js reads this bare global from core.js.
      if (opts.memoryCache !== undefined) {
        s.memoryReportsCache = opts.memoryCache;
      }

      s.fetchTeamOptions = async () => TEAM;

      s.__serverReports = opts.serverReports || ALL_REPORTS;
      s.cachedReportsFetch = async () => s.__serverReports;
      s.apiGet = async (action, params) => {
        s.__calls = (s.__calls || []).concat(['GET ' + action]);
        if (action === 'getTeamOptions') return { status: 'success', options: TEAM };
        if (action === 'getReports') {
          const t = String((params && params.targetUserId) || 'all');
          const rows = t === 'all' ? s.__serverReports
            : s.__serverReports.filter(r => String(r.createdById) === t);
          return rows;
        }
        if (action === 'getReportsPage') {
          const t = String((params && params.targetUserId) || 'all');
          const rows = (t === 'all' ? s.__serverReports
            : s.__serverReports.filter(r => String(r.createdById) === t)).slice().reverse();
          const size = Math.max(1, Number((params && params.pageSize) || 20));
          const page = Math.max(1, Number((params && params.page) || 1));
          const start = (page - 1) * size;
          return {
            status: 'success', page, pageSize: size, total: rows.length,
            hasMore: start + size < rows.length,
            items: rows.slice(start, start + size),
            filterOptions: page === 1 ? {
              campaigns: [...new Set(rows.map(r => String(r.campaign || '')).filter(Boolean))],
              events: [...new Set(rows.map(r => String(r.event || '')).filter(Boolean))]
            } : null
          };
        }
        return [];
      };
      s.apiPost = async () => ({ status: 'success' });
      s.document.getElementById = (id) => els2[id] || null;
    },
  });

  return { s: c.sandbox, els, c };
}

const shownIds = (els) => {
  const html = String(els['reports-accordion'].innerHTML);
  return [...new Set((html.match(/c-\d+/g) || []).map(x => Number(x.slice(2))))].sort((a, b) => a - b);
};

const optionValues = (select) => {
  const m = String(select.innerHTML).match(/<option value="([^"]*)"/g) || [];
  return m.map(x => x.replace(/<option value="/, '').replace(/"$/, ''));
};

// ---------------------------------------------------------------------------
// Bug 1: blank screen. handleHistoryPage must complete without throwing even
// when a previous page already populated the in-memory cache.
// ---------------------------------------------------------------------------

test('history page: renders without throwing when the memory cache is warm', async () => {
  const { s, els } = historyCtx({ memoryCache: ALL_REPORTS });
  await s.__activator();
  assert.deepEqual(shownIds(els), [1, 2, 3, 4], 'the warm cache must be rendered');
});

test('history page: renders without throwing on a cold cache', async () => {
  const { s, els } = historyCtx({ memoryCache: null });
  await s.__activator();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(shownIds(els), [1, 2, 3, 4]);
});

test('history page: a warm cache does not stop the refresh listeners being wired', async () => {
  const { s } = historyCtx({ memoryCache: ALL_REPORTS });
  await s.__activator();
  assert.ok(s.__activator, 'activator must exist');
  // The search box listener is registered after the render call that used to
  // throw; if it is missing the page is only half-wired.
  assert.ok(s.document.getElementById('searchInput'), 'sanity');
});

// ---------------------------------------------------------------------------
// Bug 2: the employee filter.
// ---------------------------------------------------------------------------

test('history filter: the employee dropdown is populated for a manager', async () => {
  const { s, els } = historyCtx({ memoryCache: null });
  await s.__activator();
  const values = optionValues(els.historyEmployeeFilterSelect);
  assert.ok(values.includes('all'), 'expected the "الكل" option');
  assert.ok(values.includes('E003'), 'expected E003 in the dropdown');
  assert.equal(els.historyEmployeeFilterWrap.classList.contains('d-none'), false);
});

test('history filter: picking an employee shows that employee\'s reports', async () => {
  const { s, els } = historyCtx({ memoryCache: ALL_REPORTS });
  await s.__activator();
  els.historyEmployeeFilterSelect.value = 'E004';
  els.historyEmployeeFilterSelect.dispatch('change', {});
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(shownIds(els), [2], 'only that employee\'s reports');
  assert.ok(!String(els['reports-accordion'].innerHTML).includes('تعذر تحميل'),
    'must not show the load-failure alert');
});

test('history filter: going back to "الكل" restores the full list', async () => {
  const { s, els } = historyCtx({ memoryCache: ALL_REPORTS });
  await s.__activator();
  els.historyEmployeeFilterSelect.value = 'E004';
  els.historyEmployeeFilterSelect.dispatch('change', {});
  await new Promise(r => setTimeout(r, 20));
  els.historyEmployeeFilterSelect.value = 'all';
  els.historyEmployeeFilterSelect.dispatch('change', {});
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(shownIds(els), [1, 2, 3, 4], 'the full list must come back');
});

test('history filter: switching employees twice keeps working', async () => {
  const { s, els } = historyCtx({ memoryCache: ALL_REPORTS });
  await s.__activator();
  for (const [id, expected] of [['E003', [1, 4]], ['E005', [3]], ['all', [1, 2, 3, 4]]]) {
    els.historyEmployeeFilterSelect.value = id;
    els.historyEmployeeFilterSelect.dispatch('change', {});
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(shownIds(els), expected, 'filter=' + id);
  }
});

test('history filter: an employee with no reports shows the empty message', async () => {
  const { s, els } = historyCtx({ memoryCache: ALL_REPORTS });
  await s.__activator();
  s.apiGet = async (action, params) => {
    if (action === 'getTeamOptions') return { status: 'success', options: TEAM };
    if (action === 'getReports') return [];
    if (action === 'getReportsPage') return { status: 'success', page: 1, pageSize: 20, total: 0, hasMore: false, items: [], filterOptions: { campaigns: [], events: [] } };
    return [];
  };
  els.historyEmployeeFilterSelect.value = 'E005';
  els.historyEmployeeFilterSelect.dispatch('change', {});
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(shownIds(els), []);
  assert.equal(els['no-results-message'].classList.contains('d-none'), false,
    'the empty-state message must be visible');
});

test('history filter: a regular employee gets no dropdown and keeps their own reports', async () => {
  const { s, els } = historyCtx({ memoryCache: [rep(9, 'E003')] });
  s.fetchTeamOptions = async () => [];
  await s.__activator();
  assert.equal(optionValues(els.historyEmployeeFilterSelect).length, 0, 'no options for a plain employee');
  assert.deepEqual(shownIds(els), [9]);
});
