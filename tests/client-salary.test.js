'use strict';
// Unit tests for page-salary.js: the employee dropdown and form behaviour
// that the "employees do not show up" bug was about.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadClient, FakeEl } = require('./helpers/load-client');

/**
 * Build a page-salary.js context with the salary form elements present.
 */
function salaryCtx(user, teamOptions) {
  const form = new FakeEl('form', 'salaryForm');
  form.checkValidity = () => true;
  form.__resets = 0;
  form.reset = () => { form.__resets += 1; };
  const emp = new FakeEl('select', 'salEmployee');

  // الأنواع الثلاثة موجودة في HTML كما في الصفحة الحقيقية؛ التفويض يقرّر أيّها يظهر.
  const typeOptions = '<option value="advance">سلفة</option>' +
    '<option value="deduction">خصم</option>' +
    '<option value="loan">قرض</option>';

  const fixed = {
    salaryForm: form,
    salEmployee: emp,
    salDate: (() => { const e = new FakeEl('input', 'salDate'); e.value = '2026-01-15'; return e; })(),
    salAmount: (() => { const e = new FakeEl('input', 'salAmount'); e.value = '500'; return e; })(),
    salType: (() => { const e = new FakeEl('select', 'salType'); e.innerHTML = typeOptions; e.value = 'advance'; return e; })(),
    salInstallments: (() => { const e = new FakeEl('input', 'salInstallments'); e.value = ''; return e; })(),
    salInstallmentsWrap: new FakeEl('div', 'salInstallmentsWrap'),
    salNotes: (() => { const e = new FakeEl('input', 'salNotes'); e.value = ''; return e; })(),
    salHistoryBody: new FakeEl('tbody', 'salHistoryBody'),
    salTotalBody: new FakeEl('tbody', 'salTotalBody'),
    viewSalary: new FakeEl('section', 'view-salary'),
  };
  fixed['view-salary'] = fixed.viewSalary;

  const c = loadClient('page-salary.js', {
    setup(s, ctx) {
      s.__calls = [];
      s.__activator = null;
      s.__posts = 0;
      // core.js provides these in the real page; stub them here.
      s.registerView = (route, fn) => { s.__activator = fn; };
      s.getStoredUser = () => user;
      s.showToast = (msg) => { s.__toast = msg; };
      s.apiGet = async (action) => {
        s.__calls.push('GET ' + action);
        if (action === 'getTeamOptions') return { status: 'success', options: teamOptions || [] };
        if (action === 'getSalaryAdvances') return { status: 'success', advances: [] };
        return { status: 'success' };
      };
      s.apiPost = async (action, payload) => {
        s.__calls.push('POST ' + action);
        s.__posts += 1;
        s.__lastPayload = payload;
        return { status: 'success', message: 'تم الحفظ' };
      };
      s.__revisit = (route) => ctx.dispatchWindowEvent('spaViewRevisited', { route });
      s.document.getElementById = (id) => fixed[id] || null;
    },
  });

  return { s: c.sandbox, employeeSelect: emp, form, c, typeOptions };
}

// Let queued microtasks/promises settle so async handlers finish.
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function optionValues(select) {
  const m = String(select.innerHTML).match(/<option value="([^"]*)"/g) || [];
  return m.map(x => x.replace(/<option value="/, '').replace(/"$/, ''));
}

const EMPLOYEES = [
  { id: 'E003', name: 'موظف أول' },
  { id: 'E004', name: 'موظف ثاني' },
];

test('loadEmployees: a manager gets the team list in the dropdown', async () => {
  const { s, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  assert.ok(optionValues(employeeSelect).includes('E003'), 'expected E003 as an option');
  assert.ok(optionValues(employeeSelect).includes('E004'), 'expected E004 as an option');
  assert.equal(employeeSelect.disabled, false, 'manager must be able to pick');
});

test('loadEmployees: a regular employee is locked to themselves', async () => {
  const { s, employeeSelect } = salaryCtx({ id: 'E003', name: 'موظف أول', role: 'user' }, EMPLOYEES);
  await s.__activator();
  assert.deepEqual(optionValues(employeeSelect), ['E003']);
  assert.equal(employeeSelect.disabled, true);
  assert.ok(String(employeeSelect.innerHTML).includes('موظف أول'));
});

test('loadEmployees: systemRole is honoured when role is the job title', async () => {
  // In getInitialData, `role` holds the job position and `systemRole` the
  // permission. The page must not mistake a job title for a permission.
  const { s, employeeSelect } = salaryCtx(
    { id: 'E002', name: 'مدير الفرع', role: 'منسق نقاط', systemRole: 'manager' }, EMPLOYEES);
  await s.__activator();
  assert.equal(employeeSelect.disabled, false, 'systemRole=manager must unlock the list');
  assert.ok(optionValues(employeeSelect).includes('E003'));
});

test('loadEmployees: an unknown role is treated as a plain employee', async () => {
  const { s, employeeSelect } = salaryCtx({ id: 'E003', name: 'موظف', role: 'auditor' }, EMPLOYEES);
  await s.__activator();
  assert.equal(employeeSelect.disabled, true, 'auditor is not a manager for this purpose');
});

test('loadEmployees: an empty team shows a message, not a blank box', async () => {
  const { s, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, []);
  await s.__activator();
  assert.ok(String(employeeSelect.innerHTML).includes('لا يوجد موظفون'));
});

test('loadEmployees: a failing request does not leave a stale list', async () => {
  const { s, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  s.apiGet = async (action) => {
    if (action === 'getTeamOptions') throw new Error('network down');
    return { status: 'success', advances: [] };
  };
  await s.__activator();
  assert.ok(String(employeeSelect.innerHTML).includes('تعذر تحميل الموظف'),
    'expected an error state in the dropdown');
});

const submitEvent = { preventDefault() {}, stopPropagation() {} };

test('submit: a regular employee always files for themselves', async () => {
  const { s, form, employeeSelect } = salaryCtx({ id: 'E003', name: 'موظف أول', role: 'user' }, EMPLOYEES);
  await s.__activator();
  // Simulate tampering with the disabled select.
  employeeSelect.value = 'E004';
  await form.dispatch('submit', submitEvent);
  assert.equal(s.__lastPayload.employeeId, 'E003', 'must ignore the tampered value');
  assert.equal(s.__lastPayload.amount, 500);
});

test('submit: a manager files for the selected employee', async () => {
  const { s, form, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  employeeSelect.value = 'E004';
  await form.dispatch('submit', submitEvent);
  assert.equal(s.__lastPayload.employeeId, 'E004');
});

test('submit: a manager who picked nobody is blocked client-side', async () => {
  const { s, form, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  employeeSelect.value = '';
  await form.dispatch('submit', submitEvent);
  assert.equal(s.__lastPayload, undefined, 'must not post without an employee');
  assert.match(s.__toast, /اختر الموظف/);
});

test('submit: a non-positive amount is blocked client-side', async () => {
  const { s, form, c } = salaryCtx({ id: 'E003', name: 'موظف', role: 'user' }, EMPLOYEES);
  await s.__activator();
  c.sandbox.document.getElementById('salAmount').value = '0';
  await form.dispatch('submit', submitEvent);
  assert.equal(s.__lastPayload, undefined);
  assert.match(s.__toast, /مبلغ/);
});

test('submit: a missing date is blocked client-side', async () => {
  const { s, form, c } = salaryCtx({ id: 'E003', name: 'موظف', role: 'user' }, EMPLOYEES);
  await s.__activator();
  c.sandbox.document.getElementById('salDate').value = '';
  await form.dispatch('submit', submitEvent);
  assert.equal(s.__lastPayload, undefined);
  assert.match(s.__toast, /التاريخ/);
});

test('submit: a valid submission posts the expected payload', async () => {
  const { s, form, c } = salaryCtx({ id: 'E003', name: 'موظف', role: 'user' }, EMPLOYEES);
  await s.__activator();
  c.sandbox.document.getElementById('salNotes').value = 'بداية الشهر';
  await form.dispatch('submit', submitEvent);
  const p = JSON.parse(JSON.stringify(s.__lastPayload));
  assert.equal(p.employeeId, 'E003');
  assert.equal(p.amount, 500);
  assert.equal(p.type, 'advance');
  assert.equal(p.notes, 'بداية الشهر');
  assert.equal(p.date, '2026-01-15');
  assert.equal(p.installments, 0);
  assert.equal(typeof p.requestId, 'string');
  assert.ok(p.requestId.length > 0, 'a requestId is required for duplicate protection');
});

test('submit: each submission gets a fresh requestId', async () => {
  const { s, form } = salaryCtx({ id: 'E003', name: 'موظف', role: 'user' }, EMPLOYEES);
  await s.__activator();
  form.dispatch('submit', submitEvent);
  await flush();
  const first = s.__lastPayload.requestId;
  form.dispatch('submit', submitEvent);
  await flush();
  assert.notEqual(s.__lastPayload.requestId, first, 'a retry must not reuse the id');
});

test('page: registers itself on the salary route', () => {
  const { s } = salaryCtx({ id: 'E003', role: 'user' }, []);
  assert.equal(typeof s.__activator, 'function', 'registerView must capture an activator');
});

test('page: reloads data when the view is revisited', async () => {
  const { s } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  const before = s.__calls.filter(x => x === 'GET getTeamOptions').length;
  assert.equal(before, 1, 'initial load should fetch the team once');
  // core.js re-dispatches spaViewRevisited when an already-mounted view is reopened.
  s.__revisit('salary');
  const after = s.__calls.filter(x => x === 'GET getTeamOptions').length;
  assert.equal(after, 2, 'revisiting the view should refresh the team list');
});

test('page: escaping is applied to rendered values', async () => {
  const { s, employeeSelect } = salaryCtx(
    { id: 'E002', role: 'manager' }, [{ id: 'E009', name: '<img src=x onerror=1>' }]);
  await s.__activator();
  const html = String(employeeSelect.innerHTML);
  assert.ok(!html.includes('<img'), 'employee name must be escaped');
  assert.ok(html.includes('&lt;img'), 'expected escaped markup');
});

// ------------------------------------------------------------------ loan + installments

test('installments: the field is hidden unless the type is loan', async () => {
  const { s, c } = salaryCtx({ id: 'E003', role: 'user' }, EMPLOYEES);
  await s.__activator();
  const wrap = c.sandbox.document.getElementById('salInstallmentsWrap');
  assert.ok(wrap.classList.contains('d-none'), 'advance must hide the field');

  c.sandbox.document.getElementById('salType').value = 'loan';
  c.sandbox.document.getElementById('salType').dispatch('change', {});
  assert.ok(!wrap.classList.contains('d-none'), 'loan must reveal the field');

  c.sandbox.document.getElementById('salType').value = 'deduction';
  c.sandbox.document.getElementById('salType').dispatch('change', {});
  assert.ok(wrap.classList.contains('d-none'), 'deduction must hide it again');
});

test('submit: installments are sent for a loan', async () => {
  const { s, form, c } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  c.sandbox.document.getElementById('salEmployee').value = 'E004';
  c.sandbox.document.getElementById('salType').value = 'loan';
  c.sandbox.document.getElementById('salInstallments').value = '6';
  form.dispatch('submit', submitEvent);
  await flush();
  assert.equal(s.__lastPayload.type, 'loan');
  assert.equal(s.__lastPayload.installments, 6);
});

test('submit: installments are not sent for other types', async () => {
  const { s, form, c } = salaryCtx({ id: 'E003', role: 'user' }, EMPLOYEES);
  await s.__activator();
  c.sandbox.document.getElementById('salInstallments').value = '12';
  await form.dispatch('submit', submitEvent);
  assert.equal(s.__lastPayload.type, 'advance');
  assert.equal(s.__lastPayload.installments, 0);
});

test('submit: a loan with no installments is blocked client-side', async () => {
  const { s, form, c } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  c.sandbox.document.getElementById('salEmployee').value = 'E004';
  c.sandbox.document.getElementById('salType').value = 'loan';
  c.sandbox.document.getElementById('salInstallments').value = '';
  form.dispatch('submit', submitEvent);
  await flush();
  assert.equal(s.__lastPayload, undefined);
  assert.match(s.__toast, /عدد دفعات/);
});

test('submit: a loan above the installment bound is blocked client-side', async () => {
  const { s, form, c } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  c.sandbox.document.getElementById('salEmployee').value = 'E004';
  c.sandbox.document.getElementById('salType').value = 'loan';
  c.sandbox.document.getElementById('salInstallments').value = '11';
  form.dispatch('submit', submitEvent);
  await flush();
  assert.equal(s.__lastPayload, undefined, 'the server would reject it; do not send it');
  assert.match(s.__toast, /عدد دفعات/);
});

test('submit: the bound is quoted in the rejection message', async () => {
  const { s, form, c } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  c.sandbox.document.getElementById('salEmployee').value = 'E004';
  c.sandbox.document.getElementById('salType').value = 'loan';
  c.sandbox.document.getElementById('salInstallments').value = '99';
  form.dispatch('submit', submitEvent);
  await flush();
  assert.match(s.__toast, /1 إلى 10/, 'the user must be told the real limit: ' + s.__toast);
});

test('submit: the client bound matches the server bound and the HTML max', () => {
  // The bound lives in three files. Any drift means the field accepts a value
  // the server rejects, or silently caps the user below the real limit.
  const { c } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const field = html.match(/id="salInstallments"[^>]*>/)[0];
  const htmlMax = Number(field.match(/max="(\d+)"/)[1]);
  assert.equal(c.evalIn('SALARY_MAX_INSTALLMENTS'), htmlMax, 'client and HTML must agree');
  assert.equal(htmlMax, 10);
  // ...and the server. A stray edit to any of the three would otherwise only
  // surface as a rejected submission in production.
  const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  const serverMax = code.match(/SALARY_ADVANCE_MAX_INSTALLMENTS\s*=\s*(\d+)/);
  assert.ok(serverMax, 'Code.gs must define the server bound');
  assert.equal(Number(serverMax[1]), htmlMax, 'Code.gs and index.html must agree');

  // The example the user copies must be a value the server accepts, otherwise
  // the field advertises its own rejection.
  const ph = field.match(/placeholder="[^"]*?(\d+)/);
  assert.ok(ph, 'the installments input must show a numeric example');
  const example = Number(ph[1]);
  assert.ok(example >= 1 && example <= htmlMax,
    `the placeholder example (${example}) must be inside the accepted range 1-${htmlMax}`);

  // And the hint must state the range, so the limit is discoverable without
  // trial and error. Read the hint element itself, not a window that would
  // pick up unrelated digits further down the page.
  const after = html.slice(html.indexOf(field) + field.length);
  const hint = after.match(/class="form-text"[^>]*>([^<]+)</);
  assert.ok(hint, 'the installments field must have a hint element');
  assert.ok(hint[1].includes(String(htmlMax)),
    `the hint must state the limit ${htmlMax}: ${hint[1]}`);
});

test('render: a loan row shows the loan badge and its installment count', async () => {
  const { s, c } = salaryCtx({ id: 'E003', role: 'user' }, EMPLOYEES);
  s.apiGet = async (action) => {
    if (action === 'getSalaryAdvances') {
      return { status: 'success', advances: [
        { date: '2026-01-15', employeeName: 'موظف أول', type: 'loan', amount: 2400, installments: 8, notes: '', createdByName: 'مدير' },
        { date: '2026-01-16', employeeName: 'موظف أول', type: 'advance', amount: 500, installments: 0, notes: '', createdByName: 'مدير' },
      ] };
    }
    return { status: 'success', options: [] };
  };
  await s.__activator();
  const html = String(c.sandbox.document.getElementById('salHistoryBody').innerHTML);
  assert.ok(html.includes('قرض'), 'expected the loan badge');
  assert.ok(html.includes('>8<'), 'expected the installment count in its own cell');
  assert.ok(html.includes('سلفة'), 'expected the advance badge');
  assert.ok(html.includes('—'), 'a non-loan row must not show a count');
});

// --------------------------------------------------------- loan/deduction are privileged

test('permissions: a manager keeps loan and deduction in the type dropdown', async () => {
  const { s, c } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  const html = String(c.sandbox.document.getElementById('salType').innerHTML);
  assert.ok(html.includes('loan'), 'a manager must be able to pick a loan');
  assert.ok(html.includes('deduction'), 'a manager must be able to pick a deduction');
});

test('permissions: admin keeps all three types', async () => {
  const { s, c } = salaryCtx({ id: 'E001', role: 'admin' }, EMPLOYEES);
  await s.__activator();
  const html = String(c.sandbox.document.getElementById('salType').innerHTML);
  assert.ok(html.includes('loan') && html.includes('deduction') && html.includes('advance'));
});

test('permissions: a plain employee sees only the advance option', async () => {
  const { s, c } = salaryCtx({ id: 'E003', name: 'موظف', role: 'user' }, EMPLOYEES);
  await s.__activator();
  const html = String(c.sandbox.document.getElementById('salType').innerHTML);
  assert.deepEqual(optionValues(c.sandbox.document.getElementById('salType')), ['advance']);
  assert.ok(!html.includes('loan'), 'the loan option must not be rendered for a plain employee');
  assert.ok(!html.includes('deduction'), 'the deduction option must not be rendered');
});

test('permissions: systemRole=manager unlocks the types even when role is a job title', async () => {
  const { s, c } = salaryCtx({ id: 'E002', name: 'مدير الفرع', role: 'منسق نقاط', systemRole: 'manager' }, EMPLOYEES);
  await s.__activator();
  assert.ok(String(c.sandbox.document.getElementById('salType').innerHTML).includes('loan'));
});

test('permissions: a plain employee is forced back to advance if the select was tampered with', async () => {
  const { s, form, c } = salaryCtx({ id: 'E003', name: 'موظف', role: 'user' }, EMPLOYEES);
  await s.__activator();
  const sel = c.sandbox.document.getElementById('salType');
  sel.value = 'loan';
  c.sandbox.document.getElementById('salInstallments').value = '10';
  await form.dispatch('submit', submitEvent);
  assert.notEqual(s.__lastPayload, undefined);
  assert.equal(s.__lastPayload.type, 'advance', 'a tampered loan must not be submitted');
});

test('permissions: the installments field stays hidden for a plain employee', async () => {
  const { s, c } = salaryCtx({ id: 'E003', role: 'user' }, EMPLOYEES);
  await s.__activator();
  const wrap = c.sandbox.document.getElementById('salInstallmentsWrap');
  assert.ok(wrap.classList.contains('d-none'));
  assert.equal(c.sandbox.document.getElementById('salInstallments').required, false);
});

// ------------------------------------------------- no duplicate rows from a single click

test('duplicates: two rapid submits post only once', async () => {
  const { s, form, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  employeeSelect.value = 'E004';
  s.apiPost = async (action, payload) => {
    s.__calls.push('POST ' + action);
    s.__posts += 1;
    s.__lastPayload = payload;
    await new Promise(r => setTimeout(r, 5)); // شبكة بطيئة
    return { status: 'success', message: 'تم الحفظ' };
  };
  // نقرتان متتاليتان قبل انتهاء الطلب الأول.
  form.dispatch('submit', submitEvent);
  form.dispatch('submit', submitEvent);
  await flush();
  assert.equal(s.__posts, 1, 'the second submit must be ignored while one is in flight');
});

test('duplicates: a later submit works again once the first finishes', async () => {
  const { s, form, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  employeeSelect.value = 'E004';
  form.dispatch('submit', submitEvent);
  await flush();
  form.dispatch('submit', submitEvent);
  await flush();
  assert.equal(s.__posts, 2, 'the in-flight guard must release after the request settles');
});

test('duplicates: remounting the view does not stack submit listeners', async () => {
  const { s, form } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  const afterFirstMount = form._listeners.submit.length;
  assert.equal(afterFirstMount, 1, 'one mount binds exactly one submit handler');
  // دورة خروج/دخول: تُستدعى الدالة على نفس الفورم مرتين أخريين.
  await s.__activator();
  await s.__activator();
  assert.equal(form._listeners.submit.length, afterFirstMount,
    'the previous mount handlers must be detached, not accumulated');
  assert.equal(form._listeners.submit[0].name, 'submitHandler');
});

test('duplicates: one submit reloads the table once after a remount', async () => {
  const { s, form, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  await s.__activator();
  await s.__activator();
  employeeSelect.value = 'E004';
  const historyBefore = s.__calls.filter(x => x === 'GET getSalaryAdvances').length;
  form.dispatch('submit', submitEvent);
  await flush();
  assert.equal(s.__posts, 1);
  const reloads = s.__calls.filter(x => x === 'GET getSalaryAdvances').length - historyBefore;
  assert.equal(reloads, 1, 'a stale listener from an earlier mount would reload the table twice');
});

test('duplicates: remounting still refreshes the data', async () => {
  const { s } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  const before = s.__calls.filter(x => x === 'GET getTeamOptions').length;
  await s.__activator();
  const after = s.__calls.filter(x => x === 'GET getTeamOptions').length;
  assert.equal(after, before + 1, 'a remount must reload, not skip, the data');
});

test('duplicates: only the latest mount reacts to a revisit', async () => {
  const { s } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  await s.__activator();
  const before = s.__calls.filter(x => x === 'GET getTeamOptions').length;
  s.__revisit('salary');
  await flush();
  const after = s.__calls.filter(x => x === 'GET getTeamOptions').length;
  assert.equal(after, before + 1, 'a stale revisit listener would double-fetch');
});

// ------------------------------------------------------------ form reset + column span

test('submit: the form is reset after a manager saves', async () => {
  const { s, form, employeeSelect } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  await s.__activator();
  employeeSelect.value = 'E004';
  form.dispatch('submit', submitEvent);
  await flush();
  assert.equal(form.__resets, 1, 'a manager should get a clean form for the next entry');
});

test('submit: a plain employee keeps their form filled after saving', async () => {
  const { s, form } = salaryCtx({ id: 'E003', name: 'موظف', role: 'user' }, EMPLOYEES);
  await s.__activator();
  form.dispatch('submit', submitEvent);
  await flush();
  assert.equal(form.__resets, 0, 'reset is meant for managers filing several rows in a row');
});

test('submit: the empty and error rows span all seven columns', async () => {
  const { s, c } = salaryCtx({ id: 'E002', role: 'manager' }, EMPLOYEES);
  s.apiGet = async (action) => {
    if (action === 'getSalaryAdvances') throw new Error('offline');
    return { status: 'success', options: [] };
  };
  await s.__activator();
  const errHtml = String(c.sandbox.document.getElementById('salHistoryBody').innerHTML);
  assert.ok(errHtml.includes('colspan="7"'), 'the error row must span the whole table');
});
