'use strict';
// Unit tests for attendance submission/visibility, product lookup, and
// other cross-cutting business rules in Code.gs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, asUser, DEFAULT_DATA } = require('./helpers/load-code');

const ALLOWED = ['بداية دوام', 'نهاية دوام', 'عطلة أسبوعية', 'عطلة رسمية', 'اجازة إدارية', 'اجازة مرضية', 'حضور إضافي'];

test('submitAttendance: a valid entry is stored under the authenticated user', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.post('submitAttendance', { status: 'بداية دوام', statement: 'بدأت الدوام' });
  assert.equal(body.status, 'success');

  const rows = u.get('getAttendance');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, 'user1', 'username must come from the session');
  assert.equal(rows[0].status, 'بداية دوام');
});

test('submitAttendance: the client cannot report attendance for another user', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  u.post('submitAttendance', { username: 'user2', status: 'بداية دوام', statement: 'انتحال' });
  const rows = u.get('getAttendance');
  assert.equal(rows[0].username, 'user1', 'client-supplied username must be ignored');
});

test('submitAttendance: rejects a status outside the allowed list', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.post('submitAttendance', { status: 'اجازة بدون راتب', statement: 'x' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /حالة الدوام غير صحيحة/);
});

test('submitAttendance: requires a statement', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.post('submitAttendance', { status: 'بداية دوام', statement: '   ' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /بيان الدوام مطلوب/);
});

test('submitAttendance: sick leave requires a medical report', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.post('submitAttendance', { status: 'اجازة مرضية', statement: 'عذراً' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /التقرير الطبي/);
});

test('submitAttendance: sick leave with an attachment is accepted', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.post('submitAttendance', {
    status: 'اجازة مرضية',
    statement: 'تقرير طبي مرفق',
    medicalReportBase64: 'aGVsbG8=',
    medicalReportFileName: 'report.pdf',
    medicalReportMimeType: 'application/pdf',
  });
  assert.equal(body.status, 'success');
  const rows = u.get('getAttendance');
  assert.ok(rows[0].medicalReportUrl, 'expected a stored medical report url');
});

test('getAttendance: a regular user sees only their own records', () => {
  const r = loadCode();
  asUser(r, 'user1', 'pw-user1').post('submitAttendance', { status: 'بداية دوام', statement: 'a' });
  asUser(r, 'user2', 'pw-user2').post('submitAttendance', { status: 'بداية دوام', statement: 'b' });

  const mine = asUser(r, 'user1', 'pw-user1').get('getAttendance');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].username, 'user1');
});

test('getAttendance: a manager sees the whole team', () => {
  const r = loadCode();
  asUser(r, 'user1', 'pw-user1').post('submitAttendance', { status: 'بداية دوام', statement: 'a' });
  asUser(r, 'user2', 'pw-user2').post('submitAttendance', { status: 'بداية دوام', statement: 'b' });
  asUser(r, 'user3', 'pw-user3').post('submitAttendance', { status: 'بداية دوام', statement: 'c' });

  const mgr = asUser(r, 'mgr1', 'pw-mgr');
  const rows = mgr.get('getAttendance');
  const names = rows.map(x => x.username).sort();
  assert.deepEqual(names, ['user1', 'user2', 'user3']);
});

test('getAttendance: admin sees everyone', () => {
  const r = loadCode();
  asUser(r, 'user1', 'pw-user1').post('submitAttendance', { status: 'بداية دوام', statement: 'a' });
  asUser(r, 'admin1', 'pw-admin').post('submitAttendance', { status: 'بداية دوام', statement: 'b' });
  const rows = asUser(r, 'admin1', 'pw-admin').get('getAttendance');
  assert.equal(rows.length, 2);
});

test('getAttendance: manager cannot read a user outside their team', () => {
  const r = loadCode();
  const sh = r.env._spreadsheet.getSheetByName('Employees');
  sh.appendRow(['E900', 'خارج الفريق', 'outsider', 'pw', 'user', 'موظف', 'المدير العام']);
  asUser(r, 'outsider', 'pw').post('submitAttendance', { status: 'بداية دوام', statement: 'x' });

  const rows = asUser(r, 'mgr1', 'pw-mgr').get('getAttendance');
  assert.equal(rows.length, 0, 'outsider reports to the admin, not this manager');
});

test('getAttendance: rows come back newest first', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  u.post('submitAttendance', { status: 'بداية دوام', statement: 'first' });
  u.post('submitAttendance', { status: 'نهاية دوام', statement: 'second' });
  const rows = u.get('getAttendance');
  assert.deepEqual(rows.map(x => x.attendanceStatement), ['second', 'first']);
});

test('getStatusOptions: returns the default allowed statuses', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.get('getStatusOptions');
  assert.equal(body.status, 'success');
  assert.deepEqual(Array.from(body.options), ALLOWED);
});

test('getStatusOptions: mirrors a custom statusWT sheet when present', () => {
  const data = { ...DEFAULT_DATA, statusWT: [['حالة'], ['حالة مخصصة']] };
  const r = loadCode({ data });
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.get('getStatusOptions');
  assert.deepEqual(Array.from(body.options), ['حالة مخصصة']);
  // And the custom status is then accepted on submit.
  const sub = u.post('submitAttendance', { status: 'حالة مخصصة', statement: 'ok' });
  assert.equal(sub.status, 'success');
});

test('approveAttendance: a regular employee cannot approve', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.post('approveAttendance', { role: 'user', timestamp: 'x', action: 'approve' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /صلاحية الاعتماد/);
});

test('approveAttendance: the client-supplied role cannot escalate rights', () => {
  const r = loadCode();
  // A regular employee claims role=admin in the payload.
  const u = asUser(r, 'user1', 'pw-user1');
  u.post('submitAttendance', { status: 'بداية دوام', statement: 'x' });
  const rows = u.get('getAttendance');
  const body = u.post('approveAttendance', {
    role: 'admin', timestamp: rows[0].timestamp, action: 'approve',
  });
  // approveAttendance reads payload.role, so this currently depends on the
  // handler. Assert the record was NOT approved for a non-privileged role.
  if (body.status === 'success') {
    const after = u.get('getAttendance');
    assert.equal(after[0].approvalStatus, 'pending', 'must not self-approve as admin via payload');
  } else {
    assert.match(body.message, /صلاحية الاعتماد/);
  }
});

test('findProductByBarcode: finds a product inside a campaign', () => {
  const data = {
    ...DEFAULT_DATA,
    Products: [
      ['campaign', 'name', 'price', 'company', 'barcode', 'category', 'cancelled'],
      ['حملة', 'منتج', 100, 'شركة', '111', 'بيع', ''],
    ],
  };
  const r = loadCode({ data });
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.get('findProductByBarcode', { barcode: '111', campaign: 'حملة' });
  assert.ok(body, 'expected a result');
  const text = JSON.stringify(body);
  assert.match(text, /منتج/);
});

test('findProductByBarcode: a non-sale category is not sellable', () => {
  const data = {
    ...DEFAULT_DATA,
    Products: [
      ['campaign', 'name', 'price', 'company', 'barcode', 'category', 'cancelled'],
      ['حملة', 'منتج معاينة', 100, 'شركة', '111', 'تذوق', ''],
    ],
  };
  const r = loadCode({ data });
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.get('findProductByBarcode', { barcode: '111', campaign: 'حملة' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /not found/i);
});

test('isCancelledValue: accepts the Arabic/English cancellation words', () => {
  const r = loadCode();
  for (const v of [true, 'TRUE', '1', 'yes', 'نعم', 'ملغي', 'ملغية', 'ملغى', 'الغاء', 'cancelled', 'canceled', 'cancel']) {
    assert.equal(r.code.isCancelledValue(v), true, 'expected cancelled for: ' + v);
  }
  for (const v of ['', 'false', '0', 'no', 'لا', null, undefined]) {
    assert.equal(r.code.isCancelledValue(v), false, 'expected not cancelled for: ' + v);
  }
});

test('findProductByBarcode: unknown barcode yields no match', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.get('findProductByBarcode', { barcode: 'does-not-exist', campaign: 'حملة' });
  const found = Array.isArray(body) ? body.length
    : (body && Array.isArray(body.products) ? body.products.length : 0);
  assert.equal(found, 0);
});

test('getInitialData: employees expose systemRole and job title separately', () => {
  const r = loadCode();
  const u = asUser(r, 'admin1', 'pw-admin');
  const db = u.get('getInitialData');
  const mgr = db.employees.find(e => e.id === 'E002');
  assert.equal(mgr.systemRole, 'manager');
  assert.equal(mgr.role, 'منسق نقاط', 'role carries the job position, not the permission');
  assert.equal(mgr.mgr, 'المدير العام');
});

test('getInitialData: is cached, and forceRefresh rebuilds it', () => {
  const r = loadCode();
  const u = asUser(r, 'admin1', 'pw-admin');
  const first = u.get('getInitialData');
  const second = u.get('getInitialData');
  assert.equal(first.employees.length, second.employees.length);

  const sh = r.env._spreadsheet.getSheetByName('Employees');
  sh.appendRow(['E777', 'موظف جديد', 'newbie', 'pw', 'user', 'موظف', 'مدير الفرع']);
  const cached = u.get('getInitialData');
  assert.equal(cached.employees.length, first.employees.length, 'cache should still be warm');

  const fresh = u.get('getInitialData', { forceRefresh: '1' });
  assert.equal(fresh.employees.length, first.employees.length + 1);
});

test('getInitialData: cancelled products are excluded', () => {
  const data = {
    ...DEFAULT_DATA,
    Products: [
      ['campaign', 'name', 'price', 'company', 'barcode', 'category', 'cancelled'],
      ['حملة', 'منتج', 100, 'شركة', '111', 'بيع', ''],
      ['حملة', 'منتج ملغي', 50, 'شركة', '222', 'بيع', 'ملغي'],
      ['حملة', 'منتج ملغى', 60, 'شركة', '333', 'بيع', 'ملغى'],
      ['حملة', 'منتج canceled', 70, 'شركة', '444', 'بيع', 'canceled'],
    ],
  };
  const r = loadCode({ data });
  const db = asUser(r, 'admin1', 'pw-admin').get('getInitialData');
  const names = db.products['حملة'].map(p => p.name);
  assert.deepEqual(names, ['منتج']);
});

test('normalizeName_: trims, collapses whitespace and lowercases', () => {
  const r = loadCode();
  const n = (v) => r.code.normalizeName_(v);
  assert.equal(n('  Ahmed  '), 'ahmed');
  assert.equal(n('مدير   الفرع'), 'مدير الفرع');
  assert.equal(n(''), '');
  assert.equal(n(null), '');
  assert.notEqual(n('مدير الفرع'), n('مدير عام'));
  // KNOWN LIMITATION (documented, not enforced): hamza forms are NOT folded,
  // so 'أحمد' !== 'احمد'. Manager/employee name matching in getManagerTeamIds
  // depends on the sheet using a consistent spelling.
  assert.notEqual(n('أحمد'), n('احمد'));
});

test('unknown GET action returns an error', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.get('thisActionDoesNotExist');
  assert.equal(body.status, 'error');
  assert.match(body.message, /Invalid GET Action/);
});

test('unknown POST action returns an error', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.post('thisActionDoesNotExist', {});
  assert.equal(body.status, 'error');
  assert.match(body.message, /Invalid POST Action/);
});
