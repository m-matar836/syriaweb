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
  const persistenceEvents = [];
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
      s.queueReportOffline = async (reportData) => {
        persistenceEvents.push({ type: 'queued', reportData });
        return 'pending-report-test';
      };
      s.removePendingReport = async (localId) => {
        persistenceEvents.push({ type: 'removed', localId });
      };
      s.invalidateReportsCache = () => {};
      s.refreshAppCache = async () => ({ ok: true });
      s.updateOfflineStatus = () => {};
      s.apiGet = async () => ({ status: 'success' });
      s.apiPost = async (action) => {
        posts.push(action);
        persistenceEvents.push({ type: 'sent', action });
        return { status: 'success', reportId: 1 };
      };
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
          if (id === 'restoreLastPointBtn') els[id].classList.add('d-none');
          if (id === 'toast-notification') {
            const toastMessage = new FakeEl('span', 'toast-message');
            els[id].querySelector = (selector) => selector === '.toast-message' ? toastMessage : null;
          }
          if (['sales-table-body', 'competitor-sales-table-body', 'expenses-table-body'].includes(id)) {
            const queryClasses = els[id].querySelectorAll.bind(els[id]);
            els[id].querySelectorAll = (selector) => selector === 'tr' ? els[id].children : queryClasses(selector);
          }
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
      const originalDollar = s.$;
      s.$ = (target) => typeof target === 'string' && /^#[\w-]+$/.test(target)
        ? originalDollar(s.document.getElementById(target.slice(1)))
        : originalDollar(target);
      s.jQuery = s.$;
      s.document.querySelector = (sel) => {
        const key = 'q:' + sel;
        if (!memo.has(key)) memo.set(key, new FakeEl('div', key));
        return memo.get(key);
      };
      const originalQueryAll = s.document.querySelectorAll.bind(s.document);
      s.document.querySelectorAll = (sel) => sel === '#competitor-sales-table-body tr'
        ? (els['competitor-sales-table-body']?.children || [])
        : originalQueryAll(sel);
    },
  });

  assert.equal(typeof activate, 'function', 'page-reports.js must register the reports view');
  await activate();
  els.promotersTbody = memo.get('q:#promotersSelectionTable tbody');
  return { els, c, posts, persistenceEvents, focusCalls, memo };
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

test('last-point restore button is shown on the report screen for every employee', async () => {
  const { els } = await openReportsView();

  assert.ok(!els.restoreLastPointBtn.classList.contains('d-none'),
    'the restore action stays visible even before this account has saved its first point');

  els.campaign.value = 'حملة تجريبية';
  els.reportForm.dispatch('change');
  assert.ok(!els.restoreLastPointBtn.classList.contains('d-none'),
    'choosing a campaign must not hide the restore action');
});

test('last-point restore populates every point field and creates an option for a saved market', async () => {
  const { els, c } = await openReportsView();
  c.localStorage.setItem('lastReportPoint::boss', JSON.stringify({
    governorate: 'دمشق', region: 'الشام', market: 'متجر مضاف يدوياً',
    campaign: 'حملة آخر نقطة', event: 'حدث آخر نقطة', eventDays: '2',
    coordinator: 'ليلى المنسقة', inventoryDependency: 'أحمد المروج',
    supervisor: 'المشرف أ', phoneNumber: '70123456', latitude: '33.8938', longitude: '35.5018'
  }));

  els.restoreLastPointBtn.dispatch('click');
  // Legacy snapshots may need a quick history lookup before the final fields are applied.
  await new Promise(resolve => setTimeout(resolve, 10));

  for (const [id, expected] of Object.entries({
    governorate: 'دمشق', region: 'الشام', market_name: 'متجر مضاف يدوياً',
    campaign: 'حملة آخر نقطة', event: 'حدث آخر نقطة', eventDays: '2',
    coordinator: 'ليلى المنسقة', inventoryDependency: 'أحمد المروج',
    supervisor: 'المشرف أ', phoneNumber: '70123456', latitude: '33.8938', longitude: '35.5018'
  })) assert.equal(els[id].value, expected, `${id} should be restored`);
  assert.ok(els.market_name.children.some(option => option.value === 'متجر مضاف يدوياً'),
    'a saved direct-promotion market must be selectable even if it was never in Locations');
});

test('last-point restore fetches the latest report when the local snapshot is missing', async () => {
  const { els, c } = await openReportsView();
  c.sandbox.apiGet = async (action, params) => {
    assert.equal(action, 'getReportsPage');
    assert.equal(params.targetUserId, 'E9');
    assert.equal(params.pageSize, '1');
    return {
      status: 'success',
      items: [{
        id: 52, createdById: 'E9', governorate: 'دمشق', region: 'الشام', market: 'نقطة من السجل',
        campaign: 'حملة مستعادة', event: 'ترويج مولات', eventDays: 1,
        transactionDataVersion: 2,
        sales: [{ product: 'مبيع من السجل', price: 6, quantity: 2 }],
        salesOfCompetitor: [{ product: 'منافس من السجل', price: 4, quantity: 1 }],
        expenses: [{ item: 'مصروف من السجل', quantity: 3 }]
      }]
    };
  };
  c.localStorage.removeItem('lastReportPoint::boss');

  els.restoreLastPointBtn.dispatch('click');
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(els.market_name.value, 'نقطة من السجل', 'the latest point should be restored from report history');
  assert.equal(els['sales-table-body'].children.length, 1, 'sales from report history should be restored');
  assert.equal(els['competitor-sales-table-body'].children.length, 1, 'competitor sales should be restored');
  assert.equal(els['expenses-table-body'].children.length, 1, 'expenses should be restored');
  const saved = JSON.parse(c.localStorage.getItem('lastReportPoint::boss'));
  assert.equal(saved.market, 'نقطة من السجل', 'the fetched snapshot should be cached for the next click');
});

test('last-point restore also restores sales, competitor sales, and expenses', async () => {
  const { els, c } = await openReportsView();
  c.localStorage.setItem('lastReportPoint::boss', JSON.stringify({
    governorate: 'دمشق', region: 'الشام', market: 'البرزة',
    campaign: 'حملة آخر نقطة', event: 'ترويج مولات', eventDays: '1',
    coordinator: 'ليلى المنسقة', inventoryDependency: '', supervisor: 'المشرف أ',
    phoneNumber: '', latitude: '', longitude: '',
    transactionDataVersion: 2,
    sales: [{ product: 'منتج محفوظ غير موجود بالقائمة', price: 12.5, quantity: 3 }],
    salesOfCompetitor: [{ product: 'منافس محفوظ غير موجود بالقائمة', price: 8, quantity: 2 }],
    expenses: [{ item: 'مصاريف محفوظة', quantity: 4 }]
  }));

  els.restoreLastPointBtn.dispatch('click');

  const saleRows = els['sales-table-body'].children;
  const competitorRows = els['competitor-sales-table-body'].children;
  const expenseRows = els['expenses-table-body'].children;
  assert.equal(saleRows.length, 1, 'the saved sales row should be restored');
  assert.equal(saleRows[0].querySelector('.sale-product').value, 'منتج محفوظ غير موجود بالقائمة');
  assert.equal(saleRows[0].querySelector('.sale-price').value, '12.50');
  assert.equal(Number(saleRows[0].querySelector('.sale-quantity').value), 3);
  assert.equal(competitorRows.length, 1, 'the saved competitor row should be restored');
  assert.equal(competitorRows[0].querySelector('.competitor-product').value, 'منافس محفوظ غير موجود بالقائمة');
  assert.equal(competitorRows[0].querySelector('.competitor-price').value, '8.00');
  assert.equal(competitorRows[0].querySelector('.competitor-quantity').value, '2');
  assert.equal(expenseRows.length, 1, 'the saved expense row should be restored');
  assert.equal(expenseRows[0].querySelector('.expense-item').value, 'مصاريف محفوظة');
  assert.equal(Number(expenseRows[0].querySelector('.expense-quantity').value), 4);
});

test('restore waits for migration when a legacy point has empty transaction arrays', async () => {
  const { els, c } = await openReportsView();
  c.localStorage.setItem('lastReportPoint::boss', JSON.stringify({
    governorate: 'طرابلس', region: 'المدينة', market: 'نقطة قديمة',
    campaign: 'حملة قديمة', event: 'ترويج مولات', savedAt: 100,
    // بعض النسخ القديمة أنشأت المصفوفات فارغة، رغم وجود معاملات في التقرير الأصلي.
    sales: [], salesOfCompetitor: [], expenses: []
  }));
  c.sandbox.apiGet = async (action, params) => {
    assert.equal(action, 'getReportsPage');
    assert.equal(params.targetUserId, 'E9');
    return {
      status: 'success',
      items: [{
        id: 49, createdById: 'E9', governorate: 'دمشق', region: 'الشام', market: 'البرزة',
        campaign: 'حملة محفوظة', event: 'ترويج مولات', eventDays: 1,
        sales: [{ product: 'قهوة محفوظة', price: 12.5, quantity: 3 }],
        salesOfCompetitor: [{ product: 'منافس محفوظ', price: 8, quantity: 2 }],
        expenses: [{ item: 'تذوق محفوظ', quantity: 4 }]
      }]
    };
  };

  // اضغط فور فتح الصفحة: لا نعتمد على أن مؤقت التهيئة بدأ أولاً.
  els.restoreLastPointBtn.dispatch('click');
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(els.market_name.value, 'البرزة', 'restoration should use the migrated saved point');
  assert.equal(els['sales-table-body'].children.length, 1);
  assert.equal(els['sales-table-body'].children[0].querySelector('.sale-product').value, 'قهوة محفوظة');
  assert.equal(els['sales-table-body'].children[0].querySelector('.sale-price').value, '12.50');
  assert.equal(els['competitor-sales-table-body'].children.length, 1);
  assert.equal(els['competitor-sales-table-body'].children[0].querySelector('.competitor-product').value, 'منافس محفوظ');
  assert.equal(els['expenses-table-body'].children.length, 1);
  assert.equal(els['expenses-table-body'].children[0].querySelector('.expense-item').value, 'تذوق محفوظ');

  const migrated = JSON.parse(c.localStorage.getItem('lastReportPoint::boss'));
  assert.equal(migrated.transactionDataVersion, 2, 'the migrated snapshot should be marked complete');
});

test('a context-only saved point is upgraded from this employee’s newest full report', async () => {
  const { c } = await openReportsView();
  c.localStorage.setItem('lastReportPoint::boss', JSON.stringify({
    governorate: 'طرابلس', region: 'المدينة', market: 'نقطة قديمة',
    campaign: 'حملة قديمة', event: 'حدث قديم', savedAt: 100
  }));
  c.sandbox.apiGet = async (action, params) => {
    assert.equal(action, 'getReportsPage');
    assert.equal(params.targetUserId, 'E9', 'the seed request must be scoped to the logged-in employee');
    assert.equal(params.pageSize, '1', 'only the latest report is needed');
    return {
      status: 'success',
      items: [{
        id: 48, createdById: 'E9', governorate: 'دمشق', region: 'الشام', market: 'البرزة',
        campaign: 'حملة قديمة', event: 'ترويج مباشر', eventDays: 1,
        coordinator: 'ليلى المنسقة', supervisor: 'المشرف أ', phoneNumber: '70123456',
        latitude: '33.89', longitude: '35.50',
        sales: [{ product: 'مبيعات', price: 2, quantity: 3 }],
        salesOfCompetitor: [{ product: 'منافس', price: 4, quantity: 1 }],
        expenses: [{ item: 'ضيافة', quantity: 5 }]
      }]
    };
  };

  await new Promise(resolve => setTimeout(resolve, 20));

  const saved = JSON.parse(c.localStorage.getItem('lastReportPoint::boss'));
  assert.equal(saved.market, 'البرزة');
  assert.equal(saved.campaign, 'حملة قديمة');
  assert.equal(saved.phoneNumber, '70123456');
  assert.equal(saved.latitude, '33.89');
  assert.equal(saved.sales.length, 1);
  assert.equal(saved.salesOfCompetitor.length, 1);
  assert.equal(saved.expenses.length, 1);
});

test('last-point migration prefers newer offline data from this employee, never another account', async () => {
  const { c } = await openReportsView();
  c.localStorage.setItem('lastReportPoint::boss', JSON.stringify({
    governorate: 'دمشق', region: 'الشام', market: 'نقطة قديمة', savedAt: 100
  }));
  const queued = {
    id: 99, createdById: 'E9', governorate: 'بيروت', region: 'الحمرا', market: 'نقطة غير مرسلة',
    campaign: 'حملة محلية', event: 'ترويج مولات',
    sales: [{ product: 'مبيع غير مرسل', price: 3, quantity: 4 }],
    salesOfCompetitor: [{ product: 'منافس غير مرسل', price: 5, quantity: 2 }],
    expenses: [{ item: 'مصروف غير مرسل', quantity: 6 }]
  };
  c.sandbox.getPendingReports = async () => [
    { createdAt: 900, reportData: { ...queued, createdById: 'OTHER' } },
    { createdAt: 800, reportData: queued }
  ];
  c.sandbox.apiGet = async () => { throw new Error('a newer local report should avoid the network'); };

  await new Promise(resolve => setTimeout(resolve, 20));

  const saved = JSON.parse(c.localStorage.getItem('lastReportPoint::boss'));
  assert.equal(saved.market, 'نقطة غير مرسلة');
  assert.deepEqual(saved.sales, queued.sales);
  assert.deepEqual(saved.salesOfCompetitor, queued.salesOfCompetitor);
  assert.deepEqual(saved.expenses, queued.expenses);
});

test('last-point restore asks before replacing unsent transaction rows', async () => {
  const { els, c } = await openReportsView();
  els.campaign.value = 'حملة قائمة';
  els.event.value = 'حدث قائم';
  const fields = {
    '.sale-product': { value: 'قهوة' },
    '.sale-price': { value: '5' },
    '.sale-quantity': { value: '2' },
    '.row-total': { value: '10' }
  };
  const row = { querySelector: (selector) => fields[selector] || null };
  els['sales-table-body'].querySelectorAll = (selector) => selector === 'tr' ? [row] : [];
  c.localStorage.setItem('lastReportPoint::boss', JSON.stringify({
    governorate: 'دمشق', region: 'الشام', market: 'البرزة',
    campaign: 'حملة مختلفة', event: 'حدث مختلف', eventDays: '1',
    coordinator: 'ليلى المنسقة', inventoryDependency: '', supervisor: 'المشرف أ',
    phoneNumber: '', latitude: '', longitude: '', transactionDataVersion: 2,
    sales: [{ product: 'محفوظة', price: 7, quantity: 1 }],
    salesOfCompetitor: [], expenses: []
  }));
  c.sandbox.confirm = () => false;

  els.restoreLastPointBtn.dispatch('click');

  assert.equal(els.governorate.value, '', 'cancel must leave the entire current form unchanged');
  assert.equal(els.campaign.value, 'حملة قائمة', 'campaign must not change while a sale is pending');
  assert.equal(els.event.value, 'حدث قائم', 'event must not change while a sale is pending');
  assert.equal(els['sales-table-body'].querySelectorAll('tr').length, 1, 'unsent sale row must remain intact');
});

test('unsent report draft remains on-device until its IndexedDB write completes', async () => {
  const { els, c } = await openReportsView();
  els.market_name.value = 'البرزة';
  els.reportForm.dispatch('input');
  const draftKey = 'reportFormState::boss';
  assert.ok(c.localStorage.getItem(draftKey), 'typing must save a local draft immediately');

  let finishLocalWrite;
  let queuedReport;
  c.sandbox.queueReportOffline = (reportData) => {
    queuedReport = reportData;
    return new Promise(resolve => { finishLocalWrite = resolve; });
  };
  pickPromoters(els, ['أحمد المروج']);
  els.reportForm.dispatch('submit', { preventDefault() {}, stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(typeof finishLocalWrite, 'function', 'submission should be waiting for the local durable write');
  assert.ok(c.localStorage.getItem(draftKey), 'the draft must not be deleted before IndexedDB commits');

  finishLocalWrite('pending-report-test');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(queuedReport.market, 'البرزة',
    'the report payload written to the durable queue must contain the user’s unsent data');
});

test('the saved last-point snapshot includes all three transaction tables after submit', async () => {
  const { els, c } = await openReportsView();
  els.governorate.value = 'دمشق';
  els.region.value = 'الشام';
  els.market_name.value = 'البرزة';
  els.campaign.value = 'حملة محفوظة';
  els.event.value = 'ترويج مولات';

  const row = fields => ({ querySelector: selector => fields[selector] || null });
  els['sales-table-body'].appendChild(row({
    '.sale-product': { value: 'منتج' }, '.sale-price': { value: '2.5' },
    '.sale-quantity': { value: '3' }, '.row-total': { value: '7.5' }
  }));
  els['competitor-sales-table-body'].appendChild(row({
    '.competitor-product': { value: 'منافس' }, '.competitor-price': { value: '4' },
    '.competitor-quantity': { value: '2' }
  }));
  els['expenses-table-body'].appendChild(row({
    '.expense-item': { value: 'تذوق' }, '.expense-quantity': { value: '5' }
  }));
  els.reportForm.dispatch('input');
  pickPromoters(els, ['أحمد المروج']);
  els.reportForm.dispatch('submit', { preventDefault() {}, stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 20));

  const saved = JSON.parse(c.localStorage.getItem('lastReportPoint::boss'));
  assert.equal(saved.transactionDataVersion, 2);
  assert.deepEqual(saved.sales, [{ product: 'منتج', price: 2.5, quantity: 3, campaign: 'حملة محفوظة' }]);
  assert.deepEqual(saved.salesOfCompetitor, [{ product: 'منافس', price: 4, quantity: 2 }]);
  assert.deepEqual(saved.expenses, [{ item: 'تذوق', quantity: '5' }]);
});

test('promoters are required: picking at least one person lets the submit through', async () => {
  const { els, posts, persistenceEvents } = await openReportsView();

  pickPromoters(els, ['أحمد المروج']);
  els.reportForm.dispatch('submit', { preventDefault() {}, stopPropagation() {} });
  await new Promise(r => setTimeout(r, 0));

  assert.ok(posts.includes('submitReport'),
    'a report naming who was present must be saveable, calls: ' + posts.join(', '));
  assert.deepEqual(persistenceEvents.map(event => event.type), ['queued', 'sent', 'removed'],
    'the complete report must be durably queued before sending, and removed only after acknowledgement');
  assert.ok(persistenceEvents[0].reportData.id,
    'the durable copy includes the report id needed for safe retry');
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