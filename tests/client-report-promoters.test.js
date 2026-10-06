'use strict';
// ===================================================================
// The «الأشخاص المتواجدين ضمن النقطة» field: it must be required, and
// the coordinator must land in it by default.
//
// Both rules are driven through the real DOM rather than through the
// module's internals, because everything from L127 down lives inside
// handleReportPage() and is rebuilt on every view activation. The only
// way to reach it is the same way a user reaches it: pick a coordinator,
// tick rows in the modal, press save, submit the form.
// ===================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient, FakeEl } = require('./helpers/load-client');

const EMPLOYEES = [
  { id: 'E1', name: 'أحمد المروج', role: 'مروج', mgr: 'المشرف أ' },
  { id: 'E2', name: 'سالم المروج', role: 'مروج', mgr: 'المشرف أ' },
  { id: 'E3', name: 'ليلى المنسقة', role: 'منسق نقطة', mgr: 'المشرف أ' },
  { id: 'E4', name: 'خالد منسق', role: 'منسق نقطة', mgr: 'المشرف أ' },
];

const DB = {
  employees: EMPLOYEES,
  locations: [{ gov: 'دمشق', region: 'الشام', market: 'البرزة' }],
  products: {},
  competitorProducts: [],
  expenseItems: {},
};

// The selects populateSelect() rebuilds from DB data, plus the two it fills
// from the employee list.
const PLACEHOLDER_SELECTS = [
  'governorate', 'region', 'market_name', 'campaign',
  'inventoryDependency', 'coordinator',
];

/** Names currently in the four hidden promoter inputs. */
const promoters = (els) => [1, 2, 3, 4]
  .map(n => els['promoter' + n].value)
  .filter(Boolean);

/**
 * Activate the reports view and return handles onto the live form.
 */
async function openReportsView() {
  const els = {};
  const memo = new Map();
  let activate = null;
  const posts = [];
  const focusCalls = [];

  const c = loadClient('page-reports.js', {
    setup(s) {
      s.registerView = (route, fn) => { if (route === 'reports') activate = fn; };
      // Without this the save path takes the offline branch and never calls
      // apiPost, so "was the submit allowed through?" could not be observed.
      s.navigator.onLine = true;
      // core.js globals page-reports.js reaches for. The cache keys are
      // owner-scoped in the real app so two users on one device do not share
      // them; the stub keeps that shape so a key collision cannot pass here.
      s.APP_DB_VERSION = 'test';
      s.ownerScopedKey = (name) => `${name}::boss`;
      s.reportsCacheOwnerId = () => 'boss';
      s.reportsScopeKey = () => 'reports::boss';
      s.appDbCacheKey = () => 'appDB::boss';
      s.appDbCacheTsKey = () => 'dbTs::boss';
      s.memoryDbCache = null;
      s.getDbData = async () => DB;
      s.cachedReportsFetch = async () => [];
      s.formStateKey = () => 'reportFormState::boss';
      s.reportToEditKey = () => 'reportToEdit::boss';
      s.queryFromHash = () => new URLSearchParams('');
      s.queueReportOffline = async () => ({ queued: true });
      s.invalidateReportsCache = () => {};
      s.refreshAppCache = async () => ({ ok: true });
      s.updateOfflineStatus = () => {};
      s.apiGet = async () => ({ status: 'success' });
      s.apiPost = async (action) => { posts.push(action); return { status: 'success', reportId: 1 }; };
      s.getStoredUser = () => ({ id: 'E9', role: 'admin', name: 'المشرف أ', username: 'boss' });
      s.navigateTo = () => {};
      s.showToast = () => {};
      s.isOnline = () => true;
      s.runPendingSyncIfNeeded = async () => {};

      // Every id the module asks for becomes a real stub element; ids the
      // module mutates are handed back so the test can read them.
      const originalGet = s.document.getElementById.bind(s.document);
      s.document.getElementById = (id) => {
        if (!els[id]) {
          els[id] = originalGet(id);
          if (id === 'reportForm') els[id].checkValidity = () => true;
          // populateSelect() reads the «اختر...» placeholder out of the markup
          // before it rewrites the options, so a bare stub select throws.
          if (PLACEHOLDER_SELECTS.includes(id)) {
            els[id].innerHTML = '<option value="" selected disabled>اختر...</option>';
          }
        }
        const el = els[id];
        el.focus = () => focusCalls.push(id);
        return el;
      };
      s.document.querySelector = (sel) => {
        const key = 'q:' + sel;
        if (!memo.has(key)) memo.set(key, new FakeEl('div', key));
        return memo.get(key);
      };
    },
  });

  assert.equal(typeof activate, 'function', 'page-reports.js must register the reports view');
  await activate();
  els.promotersTbody = memo.get('q:#promotersSelectionTable tbody');
  return { els, c, posts, focusCalls, memo };
}

/** Choose a coordinator the way the select does, and let listeners run. */
function chooseCoordinator(els, name) {
  els.coordinator.value = name;
  els.coordinator.dispatch('change');
}

/** Open the picker, tick the given names, press «حفظ». */
function pickPromoters(els, names) {
  els.openPromotersBtn.dispatch('click');
  const tbody = els.promotersTbody;
  const boxes = tbody.querySelectorAll('.promoter-checkbox');
  boxes.forEach(cb => { cb.checked = names.includes(cb.value); });
  els.savePromotersBtn.dispatch('click');
}

test('promoters are required: an empty field blocks the submit', async () => {
  const { els, posts } = await openReportsView();

  els.reportForm.dispatch('submit', { preventDefault() {}, stopPropagation() {} });
  await new Promise(r => setTimeout(r, 0));

  assert.equal(posts.length, 0,
    'a report with nobody present at the point must not reach the server');
});

test('promoters are required: picking at least one person lets the submit through', async () => {
  const { els, posts } = await openReportsView();

  pickPromoters(els, ['أحمد المروج']);
  els.reportForm.dispatch('submit', { preventDefault() {}, stopPropagation() {} });
  await new Promise(r => setTimeout(r, 0));

  assert.ok(posts.includes('submitReport'),
    'a report naming who was present must be saveable, calls: ' + posts.join(', '));
});

test('the missing-people error points the user at the people button', async () => {
  const { els, focusCalls } = await openReportsView();

  els.reportForm.dispatch('submit', { preventDefault() {}, stopPropagation() {} });

  assert.ok(focusCalls.includes('openPromotersBtn'),
    'focus must move to the button that opens the people picker, got: ' + focusCalls.join(', '));
  assert.ok(els.openPromotersBtn.classList.contains('is-invalid'),
    'the button must be marked invalid so the failure is visible');
});

test('the error clears as soon as someone is present', async () => {
  const { els } = await openReportsView();

  els.reportForm.dispatch('submit', { preventDefault() {}, stopPropagation() {} });
  assert.ok(els.openPromotersBtn.classList.contains('is-invalid'), 'precondition: marked invalid');

  pickPromoters(els, ['أحمد المروج']);

  assert.ok(!els.openPromotersBtn.classList.contains('is-invalid'),
    'choosing a person must clear the invalid state');
});

test('choosing a coordinator puts them in the people list by default', async () => {
  const { els } = await openReportsView();

  chooseCoordinator(els, 'ليلى المنسقة');

  assert.deepEqual(promoters(els), ['ليلى المنسقة'],
    'the coordinator must default into «الأشخاص المتواجدين ضمن النقطة»');
});

test('the coordinator default keeps the people already chosen', async () => {
  const { els } = await openReportsView();

  pickPromoters(els, ['أحمد المروج', 'سالم المروج']);
  chooseCoordinator(els, 'ليلى المنسقة');

  assert.deepEqual(promoters(els).sort(), ['أحمد المروج', 'سالم المروج', 'ليلى المنسقة'].sort(),
    'adding the coordinator must not drop anyone the user ticked');
});

test('the coordinator is not listed twice when they are already ticked', async () => {
  const { els } = await openReportsView();

  pickPromoters(els, ['ليلى المنسقة']);
  chooseCoordinator(els, 'ليلى المنسقة');
  chooseCoordinator(els, 'ليلى المنسقة');

  assert.deepEqual(promoters(els), ['ليلى المنسقة'], 'no duplicates');
});

test('changing the coordinator makes sure the new one is present', async () => {
  const { els } = await openReportsView();

  chooseCoordinator(els, 'ليلى المنسقة');
  chooseCoordinator(els, 'خالد منسق');

  assert.ok(promoters(els).includes('خالد منسق'),
    'the coordinator currently on the form must be among the people present');
});

test('changing the coordinator does not silently delete anyone', async () => {
  // Deliberate: the default only ever *adds*. A coordinator can still be
  // present after being replaced, and quietly dropping a name the user ticked
  // would be worse than leaving a stale entry they can untick.
  const { els } = await openReportsView();

  pickPromoters(els, ['أحمد المروج']);
  chooseCoordinator(els, 'ليلى المنسقة');
  chooseCoordinator(els, 'خالد منسق');

  assert.ok(promoters(els).includes('أحمد المروج'),
    'a person the user ticked must survive the coordinator changing');
});

test('the coordinator is kept even when the list is already full', async () => {
  // promoter1..4 cap the list at four, so the coordinator has to displace the
  // last entry rather than being dropped itself. Pinned because the failure mode
  // is a silently missing coordinator, not a visible error.
  const { els } = await openReportsView();

  pickPromoters(els, ['أحمد المروج', 'سالم المروج', 'خالد منسق', 'ليلى المنسقة']);
  chooseCoordinator(els, 'أحمد المروج');

  const chosen = promoters(els);
  assert.equal(chosen.length, 4, 'the list must stay within its four slots: ' + chosen.join(', '));
  assert.ok(chosen.includes('أحمد المروج'),
    'the coordinator must be present after the overflow: ' + chosen.join(', '));
});

test('the coordinator can still be removed by hand', async () => {
  // The default is a default, not a lock. If it could not be removed then the
  // required rule could never fail on a coordinator-led report, which would
  // make the requirement meaningless.
  const { els } = await openReportsView();

  chooseCoordinator(els, 'ليلى المنسقة');
  pickPromoters(els, []); // open the picker, tick nothing, save

  assert.deepEqual(promoters(els), [], 'the user must be able to clear the list');
});