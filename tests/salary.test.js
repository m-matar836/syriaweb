'use strict';
// Unit tests for the financial salary advances feature:
// validation, who may file for whom, and who can see which records.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCode, asUser } = require('./helpers/load-code');

function save(user, payload) {
  return user.post('saveSalaryAdvance', Object.assign({
    employeeId: 'E003', amount: 500, type: 'advance', date: '2026-01-15',
  }, payload));
}

test('save: a regular employee can file an advance for themselves', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = save(u, { employeeId: 'E003' });
  assert.equal(body.status, 'success');

  const list = u.get('getSalaryAdvances');
  assert.equal(list.advances.length, 1);
  assert.equal(list.advances[0].employeeId, 'E003');
  assert.equal(list.advances[0].amount, 500);
});

test('save: the sheet is created with the expected headers', () => {
  const r = loadCode();
  asUser(r, 'user1', 'pw-user1').post('saveSalaryAdvance', {
    employeeId: 'E003', amount: 10, type: 'advance', date: '2026-01-01',
  });
  const name = r.evalIn('SALARY_ADVANCES_SHEET_NAME');
  const headers = Array.from(r.evalIn('SALARY_ADVANCES_HEADERS'));
  const sh = r.env._spreadsheet.getSheetByName(name);
  assert.ok(sh, 'salary advances sheet should exist');
  const actual = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  assert.deepEqual(Array.from(actual), headers);
});

test('save: createdBy is taken from the session, not the payload', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  const body = u.post('saveSalaryAdvance', {
    employeeId: 'E003', amount: 250, type: 'advance', date: '2026-01-02',
    createdById: 'E001', createdByName: 'المدير العام',
  });
  assert.equal(body.status, 'success');
  const list = u.get('getSalaryAdvances');
  const rec = list.advances.find(a => a.employeeId === 'E003');
  assert.equal(rec.createdByName, 'مدير الفرع', 'must use the authenticated user');
});

test('save: a regular employee cannot file an advance for someone else', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = save(u, { employeeId: 'E004' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /لا يمكنك|اسم موظف آخر/);
});

test('save: a spoofed employeeId is overridden to the requester', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  // Omitting employeeId entirely must still record the requester.
  const body = u.post('saveSalaryAdvance', { amount: 100, type: 'advance', date: '2026-01-03' });
  assert.equal(body.status, 'success');
  const list = u.get('getSalaryAdvances');
  assert.equal(list.advances[0].employeeId, 'E003');
});

test('save: a manager cannot file for an employee outside their team', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  const body = save(u, { employeeId: 'E004' }); // E004 reports to E002, so this is allowed
  assert.equal(body.status, 'success');

  const admin = asUser(r, 'admin1', 'pw-admin');
  // Give the manager a user that does not report to them: create E999 with no mgr.
  const sh = r.env._spreadsheet.getSheetByName('Employees');
  sh.appendRow(['E999', 'موظف غريب', 'stranger', 'pw', 'user', 'موظف', '']);
  const bad = save(u, { employeeId: 'E999' });
  assert.equal(bad.status, 'error');
  assert.match(bad.message, /لا يتبعك/);
  assert.ok(admin);
});

test('save: admin may file for any employee', () => {
  const r = loadCode();
  const u = asUser(r, 'admin1', 'pw-admin');
  const body = save(u, { employeeId: 'E005' });
  assert.equal(body.status, 'success');
  const list = u.get('getSalaryAdvances');
  assert.equal(list.advances[0].employeeId, 'E005');
});

test('save: rejects non-positive and non-numeric amounts', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  assert.match(save(u, { amount: 0 }).message, /أكبر من صفر/);
  assert.match(save(u, { amount: -5 }).message, /أكبر من صفر/);
  assert.match(save(u, { amount: 'abc' }).message, /أكبر من صفر/);
});

test('save: rejects an unknown type', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = save(u, { type: 'salary' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /advance أو deduction/);
});

test('save: requires a date', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = save(u, { date: '' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /التاريخ/);
});

test('save: defaults the type to advance when omitted', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.post('saveSalaryAdvance', { employeeId: 'E003', amount: 75, date: '2026-02-01' });
  assert.equal(body.status, 'success');
  assert.equal(u.get('getSalaryAdvances').advances[0].type, 'advance');
});

test('save: resolves the employee name from the Employees sheet', () => {
  const r = loadCode();
  const u = asUser(r, 'admin1', 'pw-admin');
  save(u, { employeeId: 'E004' });
  const list = u.get('getSalaryAdvances');
  assert.equal(list.advances[0].employeeName, 'موظف ثاني');
});

test('list: a regular employee sees only their own records', () => {
  const r = loadCode();
  const admin = asUser(r, 'admin1', 'pw-admin');
  admin.post('saveSalaryAdvance', { employeeId: 'E003', amount: 100, date: '2026-01-01' });
  admin.post('saveSalaryAdvance', { employeeId: 'E004', amount: 200, date: '2026-01-02' });
  admin.post('saveSalaryAdvance', { employeeId: 'E005', amount: 300, date: '2026-01-03' });

  const u = asUser(r, 'user1', 'pw-user1');
  const list = u.get('getSalaryAdvances');
  assert.equal(list.advances.length, 1);
  assert.equal(list.advances[0].employeeId, 'E003');
});

test('list: a manager sees their whole team, including indirect reports', () => {
  const r = loadCode();
  const admin = asUser(r, 'admin1', 'pw-admin');
  // E003 + E004 + E005 under E002; E006 under E003.
  admin.post('saveSalaryAdvance', { employeeId: 'E003', amount: 10, date: '2026-01-01' });
  admin.post('saveSalaryAdvance', { employeeId: 'E004', amount: 20, date: '2026-01-02' });
  admin.post('saveSalaryAdvance', { employeeId: 'E005', amount: 30, date: '2026-01-03' });
  admin.post('saveSalaryAdvance', { employeeId: 'E006', amount: 40, date: '2026-01-04' });
  admin.post('saveSalaryAdvance', { employeeId: 'E001', amount: 50, date: '2026-01-05' });

  const mgr = asUser(r, 'mgr1', 'pw-mgr');
  const list = mgr.get('getSalaryAdvances');
  const ids = list.advances.map(a => a.employeeId).sort();
  assert.deepEqual(ids, ['E003', 'E004', 'E005', 'E006']);
  assert.ok(!ids.includes('E001'), 'manager must not see records above their team');
});

test('list: admin sees every record', () => {
  const r = loadCode();
  const admin = asUser(r, 'admin1', 'pw-admin');
  admin.post('saveSalaryAdvance', { employeeId: 'E003', amount: 10, date: '2026-01-01' });
  admin.post('saveSalaryAdvance', { employeeId: 'E001', amount: 20, date: '2026-01-02' });
  const list = asUser(r, 'admin1', 'pw-admin').get('getSalaryAdvances');
  assert.equal(list.advances.length, 2);
});

test('list: returns newest first', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  u.post('saveSalaryAdvance', { employeeId: 'E003', amount: 1, date: '2026-01-01' });
  u.post('saveSalaryAdvance', { employeeId: 'E003', amount: 2, date: '2026-02-01' });
  u.post('saveSalaryAdvance', { employeeId: 'E003', amount: 3, date: '2026-03-01' });
  const list = u.get('getSalaryAdvances');
  assert.deepEqual(list.advances.map(a => a.amount), [3, 2, 1]);
});

test('list: empty sheet returns an empty array, not an error', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const list = u.get('getSalaryAdvances');
  assert.equal(list.status, 'success');
  assert.deepEqual(Array.from(list.advances), []);
});

test('list: deduction rows are returned with the right type', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  save(u, { type: 'deduction', amount: 50 });
  assert.equal(u.get('getSalaryAdvances').advances[0].type, 'deduction');
});

test('security: employeeId in the URL query cannot widen scope', () => {
  const r = loadCode();
  const admin = asUser(r, 'admin1', 'pw-admin');
  admin.post('saveSalaryAdvance', { employeeId: 'E004', amount: 100, date: '2026-01-01' });

  const u = asUser(r, 'user1', 'pw-user1');
  const list = u.get('getSalaryAdvances', { employeeId: 'E004' });
  assert.equal(list.advances.length, 0, 'query params must not change server-side scoping');
});

// ------------------------------------------------------------------ loan + installments
// القرض صلاحية إدارية، فهذه الحالات تُختبر عبر المدير لا عبر موظف عادي.

test('save: accepts the loan type', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  const body = save(u, { type: 'loan', amount: 1000, installments: 6 });
  assert.equal(body.status, 'success');
  const rec = u.get('getSalaryAdvances').advances[0];
  assert.equal(rec.type, 'loan');
  assert.equal(rec.installments, 6);
});

test('save: rejects a non-integer installment count', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  assert.match(save(u, { type: 'loan', installments: 2.5 }).message, /عدد الدفعات/);
  assert.match(save(u, { type: 'loan', installments: 0 }).message, /عدد الدفعات/);
  assert.match(save(u, { type: 'loan', installments: -3 }).message, /عدد الدفعات/);
  const max = r.evalIn('SALARY_ADVANCE_MAX_INSTALLMENTS');
  assert.match(save(u, { type: 'loan', installments: max + 1 }).message, /عدد الدفعات/);
});

test('installments: the bound is 10 and matches the HTML max attribute', () => {
  const r = loadCode();
  const max = r.evalIn('SALARY_ADVANCE_MAX_INSTALLMENTS');
  assert.equal(max, 10, 'the server bound is the source of truth');
  // The number field would silently cap below what the server accepts, so the
  // two must agree. A stray edit to either one used to break this silently.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const field = html.match(/id="salInstallments"[^>]*>/);
  assert.ok(field, 'the installments input must exist in index.html');
  const attr = field[0].match(/max="(\d+)"/);
  assert.ok(attr, 'the installments input must declare a max attribute');
  assert.equal(Number(attr[1]), max, 'index.html max and the server bound must agree');
  assert.ok(/min="1"/.test(field[0]), 'the installments input must declare min="1"');
});

test('installments: a value above the bound is rejected with the bound in the message', () => {
  const r = loadCode();
  const m = asUser(r, 'mgr1', 'pw-mgr');
  const max = r.evalIn('SALARY_ADVANCE_MAX_INSTALLMENTS');
  const body = save(m, { type: 'loan', amount: 1000, installments: 11 });
  assert.equal(body.status, 'error');
  // The message must state the real bound, or the user cannot tell why it failed.
  assert.ok(body.message.includes('10'), 'the message should quote the actual limit: ' + body.message);
  // The last accepted value still works.
  assert.equal(save(m, { type: 'loan', amount: 1000, installments: max }).status, 'success');
});

test('save: ignores installments for non-loan types', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  save(u, { type: 'advance', amount: 100, installments: 6 });
  save(u, { type: 'deduction', amount: 50, installments: 6 });
  const list = u.get('getSalaryAdvances').advances;
  assert.equal(list.find(a => a.type === 'advance').installments, 0);
  assert.equal(list.find(a => a.type === 'deduction').installments, 0);
});

test('save: a loan without installments is still valid', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  const body = save(u, { type: 'loan', amount: 500 });
  assert.equal(body.status, 'success');
  assert.equal(u.get('getSalaryAdvances').advances[0].installments, 0);
});

test('migration: an existing sheet gains the installments column', () => {
  const r = loadCode();
  const name = r.evalIn('SALARY_ADVANCES_SHEET_NAME');
  // ورقة قديمة بلا عمود الدفعات — كما لو أُنشئت قبل هذا التغيير.
  r.env._spreadsheet.insertSheet(name);
  const sh = r.env._spreadsheet.getSheetByName(name);
  sh.getRange(1, 1, 1, 9).setValues([['date', 'employeeId', 'employeeName', 'type', 'amount', 'notes', 'createdById', 'createdByName', 'createdAt']]);
  sh.appendRow(['2026-01-01', 'E003', 'موظف', 'advance', 100, '', 'E003', 'موظف', '2026-01-01T00:00:00.000Z']);

  // استدعاء أي عملية قراءة يمرّ عبر ensureSalaryAdvancesSheet_ ويكمل العمود الناقص.
  const u = asUser(r, 'user1', 'pw-user1');
  u.get('getSalaryAdvances');

  const headers = Array.from(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
  assert.equal(headers[headers.length - 1], 'installments');
  // السطر القديم يبقى في مكانه ولا تنحرف الأعمدة بعده.
  assert.equal(sh.getRange(2, 1).getValue(), '2026-01-01');
  assert.equal(sh.getRange(2, 5).getValue(), 100);
});

test('list: installments survive a round trip through the sheet', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  save(u, { type: 'loan', amount: 2400, installments: 8 });
  const rec = u.get('getSalaryAdvances').advances.find(a => a.type === 'loan');
  assert.equal(rec.installments, 8);
});

// ---- صلاحيات نوع السلفة: القرض والخصم للمدير والإداري فقط ----

test('security: a regular employee cannot file a loan', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = save(u, { type: 'loan', amount: 1000, installments: 10 });
  assert.equal(body.status, 'error');
  assert.match(body.message, /متاحان للمدير أو الإداري/);
  assert.equal(u.get('getSalaryAdvances').advances.length, 0, 'لا يُكتب أي سجل');
});

test('security: a regular employee cannot file a deduction', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = save(u, { type: 'deduction', amount: 100 });
  assert.equal(body.status, 'error');
  assert.equal(u.get('getSalaryAdvances').advances.length, 0);
});

test('security: the role check runs even when the type comes from a crafted request', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  // التحقق يعتمد على systemRole من الجلسة، لا على أي حقل في الطلب.
  const body = save(u, { type: ' loan ', amount: 100, installments: 2 });
  assert.equal(body.status, 'error');
});

test('permissions: a manager may file a loan with installments for a team member', () => {
  const r = loadCode();
  const m = asUser(r, 'mgr1', 'pw-mgr');
  const body = save(m, { type: 'loan', amount: 3000, installments: 10 });
  assert.equal(body.status, 'success');
  const rec = m.get('getSalaryAdvances').advances[0];
  assert.equal(rec.type, 'loan');
  assert.equal(rec.installments, 10);
});

test('permissions: admin may file a loan and a deduction', () => {
  const r = loadCode();
  const a = asUser(r, 'admin1', 'pw-admin');
  assert.equal(save(a, { type: 'loan', amount: 500, installments: 5 }).status, 'success');
  assert.equal(save(a, { type: 'deduction', amount: 50 }).status, 'success');
  const list = a.get('getSalaryAdvances').advances;
  assert.equal(list.length, 2);
  assert.equal(list.filter(x => x.type === 'loan')[0].installments, 5);
});

test('permissions: a plain advance is still allowed for a regular employee', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  assert.equal(save(u, { type: 'advance', amount: 300 }).status, 'success');
});

// ---- منع الحفظ المزدوج ----

test('idempotency: the same requestId saves only one row', () => {
  const r = loadCode();
  const m = asUser(r, 'mgr1', 'pw-mgr');
  const payload = { employeeId: 'E003', amount: 1000, type: 'loan', installments: 10, date: '2026-01-15', requestId: 'req-abc-1' };
  assert.equal(m.post('saveSalaryAdvance', payload).status, 'success');
  const second = m.post('saveSalaryAdvance', payload);
  assert.equal(second.status, 'success');
  assert.equal(second.duplicate, true);
  // السجل يظهر مرة واحدة فقط — لا سطران لنفس الشخص.
  assert.equal(m.get('getSalaryAdvances').advances.length, 1);
});

test('idempotency: two different requestIds store two rows', () => {
  const r = loadCode();
  const m = asUser(r, 'mgr1', 'pw-mgr');
  const base = { employeeId: 'E003', amount: 1000, type: 'loan', installments: 10, date: '2026-01-15' };
  m.post('saveSalaryAdvance', Object.assign({ requestId: 'req-1' }, base));
  m.post('saveSalaryAdvance', Object.assign({ requestId: 'req-2' }, base));
  assert.equal(m.get('getSalaryAdvances').advances.length, 2);
});

test('idempotency: the same requestId from a different user is not blocked', () => {
  const r = loadCode();
  const m = asUser(r, 'mgr1', 'pw-mgr');
  const a = asUser(r, 'admin1', 'pw-admin');
  const payload = { amount: 100, date: '2026-01-15', requestId: 'shared-id' };
  assert.equal(m.post('saveSalaryAdvance', Object.assign({ employeeId: 'E003', type: 'advance' }, payload)).status, 'success');
  assert.equal(a.post('saveSalaryAdvance', Object.assign({ employeeId: 'E004', type: 'advance' }, payload)).status, 'success');
  assert.equal(a.get('getSalaryAdvances').advances.length, 2);
});

test('idempotency: a rejected save does not burn the requestId', () => {
  const r = loadCode();
  const m = asUser(r, 'mgr1', 'pw-mgr');
  // أول محاولة ترفض (بلا تاريخ)، والثانية تصحّح الخطأ بنفس requestId.
  assert.equal(m.post('saveSalaryAdvance', { employeeId: 'E003', amount: 10, type: 'advance', requestId: 'fix-me' }).status, 'error');
  const ok = m.post('saveSalaryAdvance', { employeeId: 'E003', amount: 10, type: 'advance', date: '2026-01-15', requestId: 'fix-me' });
  assert.equal(ok.status, 'success');
  assert.equal(m.get('getSalaryAdvances').advances.length, 1);
});

test('idempotency: a save without a requestId still works and is not deduplicated', () => {
  const r = loadCode();
  const m = asUser(r, 'mgr1', 'pw-mgr');
  const payload = { employeeId: 'E003', amount: 100, type: 'advance', date: '2026-01-15' };
  assert.equal(m.post('saveSalaryAdvance', payload).status, 'success');
  assert.equal(m.post('saveSalaryAdvance', payload).status, 'success');
  assert.equal(m.get('getSalaryAdvances').advances.length, 2);
});
