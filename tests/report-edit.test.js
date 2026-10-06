'use strict';
// Regression tests for editing an existing report.
//
// The edit form only submits form fields. The server used to rebuild the whole
// row from the payload and write '' for every column the payload did not carry
// (Code.gs: `headers.map(header => reportData[header] === undefined ? '' : ...)`).
// Approval state, photo and signature are not form fields, so ANY edit silently
// wiped them — an approved report went back to "pending" with no visible error.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, asUser, DEFAULT_DATA } = require('./helpers/load-code');

const HEADERS = ['id', 'campaign', 'market', 'date', 'event', 'notes',
  'createdById', 'createdByName', 'approvalStatus', 'approvedBy', 'approvedAt',
  'rejectionReason', 'rejectionBy',
      'editedAt', 'editedBy', 'photo', 'signature', 'deletedAt', 'deletedBy'];

// Report 1 is owned by E003 (user1) and has already been approved.
const DATA = Object.assign({}, DEFAULT_DATA, {
  Reports: [HEADERS,
    ['R-1001', 'حملة', 'سوق', '2026-01-01', 'حدث', 'ملاحظة أولية',
      'E003', 'موظف أول', 'approved', 'المدير العام', '2026-01-02T10:00:00.000Z',
      '', '',
      '', '', 'data:image/png;base64,PHOTO', 'data:image/png;base64,SIGN', '', ''],
  ],
  sales: [['id', 'reportId', 'product', 'price', 'quantity']],
  expenses: [['id', 'reportId', 'item', 'quantity']],
  promoters: [['id', 'name']],
});

const setup = () => loadCode({ data: DATA });

/** Read one report row back out of the sheet as a header-keyed object. */
const readRow = (env, id) => {
  const sheet = env.env._spreadsheet.getSheetByName('Reports');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const ids = sheet.getRange('A2:A').getValues().flat().map(String);
  const idx = ids.indexOf(String(id));
  assert.notEqual(idx, -1, 'report row must still exist');
  const row = sheet.getRange(idx + 2, 1, 1, header.length).getValues()[0];
  return Object.fromEntries(header.map((h, i) => [h, row[i]]));
};

/**
 * The columns the edit form cannot possibly send — getFormState() in
 * page-reports.js only builds form fields. Each one is written by a separate
 * server endpoint, so submitReport must carry them over and ignore anything a
 * client sends for them.
 */
const PRESERVED = ['approvalStatus', 'approvedBy', 'approvedAt',
  'rejectionReason', 'rejectionBy', 'photo', 'signature', 'deletedAt', 'deletedBy'];

test('editing a report keeps the approval it already has', () => {
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');

  const res = u.post('submitReport', {
    id: 'R-1001', campaign: 'حملة', market: 'سوق', date: '2026-01-01',
    event: 'حدث', notes: 'ملاحظة معدّلة',
  });
  assert.equal(res.status, 'success', 'the edit itself must succeed');

  const row = readRow(env, 'R-1001');
  assert.equal(row.approvalStatus, 'approved',
    'editing a report must not reset its approval status');
  assert.equal(row.approvedBy, 'المدير العام', 'the approver must survive the edit');
  assert.equal(row.approvedAt, '2026-01-02T10:00:00.000Z', 'the approval time must survive the edit');
});

test('editing a report keeps its photo and signature', () => {
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');

  u.post('submitReport', {
    id: 'R-1001', campaign: 'حملة', market: 'سوق', date: '2026-01-01',
    event: 'حدث', notes: 'ملاحظة معدّلة',
  });

  const row = readRow(env, 'R-1001');
  assert.equal(row.photo, 'data:image/png;base64,PHOTO', 'the report photo must survive an edit');
  assert.equal(row.signature, 'data:image/png;base64,SIGN', 'the signature must survive an edit');
});

test('editing a report still applies the fields the form did send', () => {
  // The guard against "preserve everything" is that the edit is not a no-op:
  // if preserving columns ever swallows the real update, the user thinks they
  // saved and nothing changed.
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');

  u.post('submitReport', {
    id: 'R-1001', campaign: 'حملة', market: 'سوق', date: '2026-01-05',
    event: 'حدث جديد', notes: 'ملاحظة معدّلة',
  });

  const row = readRow(env, 'R-1001');
  assert.equal(row.date, '2026-01-05', 'the new date must be written');
  assert.equal(row.event, 'حدث جديد', 'the new event must be written');
  assert.equal(row.notes, 'ملاحظة معدّلة', 'the new notes must be written');
});

test('an edit cannot forge an approval by sending approvalStatus', () => {
  // This is the privilege escalation behind the data-loss bug. Preserving the
  // columns "when the key is absent" is not enough: a request that *does* send
  // `approvalStatus: 'approved'` used to be written straight through, letting
  // any user approve their own report through submitReport and skip
  // reviewReport() — including its auditor/manager role check entirely.
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');
  assert.equal(asUser(env, 'admin1', 'pw-admin').get('getReports')
    .find(r => String(r.id) === 'R-1001').approvalStatus, 'approved', 'precondition');

  u.post('submitReport', {
    id: 'R-1001', campaign: 'حملة', market: 'سوق', date: '2026-01-01',
    event: 'حدث', notes: 'ملاحظة',
    approvalStatus: 'approved', approvedBy: 'أنا نفسي', approvedAt: '2026-02-02T00:00:00.000Z',
  });

  const row = readRow(env, 'R-1001');
  assert.equal(row.approvedBy, 'المدير العام',
    'the stored approver must stand; a client-supplied one must be discarded');
  assert.equal(row.approvedAt, '2026-01-02T10:00:00.000Z',
    'the stored approval time must stand');
});

test('an edit cannot rewrite a rejection reason or silently wipe an approval', () => {
  // The other direction: with a pending report, a client sending empty strings
  // for the approval columns must not be able to clear or forge them either.
  const pending = Object.assign({}, DATA, {
    Reports: [HEADERS,
      ['R-1003', 'حملة', 'سوق', '2026-01-01', 'حدث', 'ملاحظة',
        'E003', 'موظف أول', 'rejected', 'مدير', '2026-01-03T09:00:00.000Z',
        'السعر غير مبرر', 'مدير',
        '', '', '', '', '', ''],
    ],
  });
  const env = loadCode({ data: pending });
  const u = asUser(env, 'user1', 'pw-user1');

  u.post('submitReport', {
    id: 'R-1003', campaign: 'حملة', market: 'سوق', date: '2026-01-09',
    event: 'حدث', notes: 'بعد الرفض',
    approvalStatus: '', approvedBy: '', approvedAt: '',
    rejectionReason: '', rejectionBy: '',
  });

  const row = readRow(env, 'R-1003');
  assert.equal(row.approvalStatus, 'rejected', 'the rejection must not be clearable from the edit form');
  assert.equal(row.rejectionReason, 'السعر غير مبرر', 'the reason must survive');
  assert.equal(row.rejectionBy, 'مدير', 'the reviewer must survive');
});

test('a new report cannot be created pre-approved', () => {
  // Same escalation, other side of the sheet: appendRow writes whatever the
  // payload carries, so a create with approvalStatus: 'approved' arrived already
  // approved without ever reaching reviewReport().
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');

  const res = u.post('submitReport', {
    id: 'R-2001', campaign: 'حملة', market: 'سوق', date: '2026-01-05',
    event: 'حدث', notes: 'ملاحظة',
    approvalStatus: 'approved', approvedBy: 'أنا نفسي', approvedAt: '2026-02-02T00:00:00.000Z',
  });
  assert.equal(res.status, 'success', 'creating the report must still work');

  const row = readRow(env, 'R-2001');
  assert.equal(String(row.approvalStatus || ''), '',
    'a freshly submitted report must start unapproved');
  assert.equal(String(row.approvedBy || ''), '', 'no approver may be recorded');
  assert.equal(String(row.approvedAt || ''), '', 'no approval time may be recorded');
});

test('an edit records who changed it and when', () => {
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');

  u.post('submitReport', {
    id: 'R-1001', campaign: 'حملة', market: 'سوق', date: '2026-01-01',
    event: 'حدث', notes: 'ملاحظة',
  });

  const row = readRow(env, 'R-1001');
  assert.equal(row.editedBy, 'موظف أول', 'the editor must be recorded from the authenticated session');
  assert.ok(String(row.editedAt).length > 0, 'the edit must be timestamped');
});

test('a rejected report stays rejected after an unrelated edit', () => {
  const rejected = Object.assign({}, DATA, {
    Reports: [HEADERS,
      ['R-1002', 'حملة', 'سوق', '2026-01-01', 'حدث', 'ملاحظة',
        'E003', 'موظف أول', 'rejected', 'المدير العام', '2026-01-03T09:00:00.000Z',
        '', '', '', '', ''],
    ],
  });
  const env = loadCode({ data: rejected });
  const u = asUser(env, 'user1', 'pw-user1');

  u.post('submitReport', {
    id: 'R-1002', campaign: 'حملة', market: 'سوق', date: '2026-01-09',
    event: 'حدث', notes: 'بعد الرفض',
  });

  const row = readRow(env, 'R-1002');
  assert.equal(row.approvalStatus, 'rejected',
    'a rejection must not vanish because the user fixed the notes');
});

test('PRESERVED list stays in sync with what the edit form cannot send', () => {
  // If someone adds a new server-owned column, this list is the reminder to add
  // it to REPORT_SERVER_OWNED_COLUMNS in Code.gs. It reads the sheet headers on
  // purpose so a renamed column shows up as a diff rather than silently rotting.
  const env = setup();
  const sheet = env.env._spreadsheet.getSheetByName('Reports');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (const col of PRESERVED) {
    assert.ok(header.includes(col), `column ${col} must exist in the Reports sheet`);
  }
  // And the reverse direction: Code.gs must actually declare every column this
  // test asserts is preserved. A column added to the sheet but not to the server
  // list would still be wiped by an edit, and only this assertion catches it.
  const { CODE_GS } = require('./helpers/load-code');
  const source = require('fs').readFileSync(CODE_GS, 'utf8');
  const list = (source.match(/const REPORT_SERVER_OWNED_COLUMNS = \[([\s\S]*?)\]/) || [])[1] || '';
  assert.ok(list, 'REPORT_SERVER_OWNED_COLUMNS must be declared in Code.gs');
  for (const col of PRESERVED) {
    assert.ok(list.includes(`'${col}'`),
      `${col} must be in REPORT_SERVER_OWNED_COLUMNS, or an edit will erase it`);
  }
});
