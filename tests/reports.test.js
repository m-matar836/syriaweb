'use strict';
// Unit tests for the reports history scope: the employee filter on
// page-history.js and the getReports() narrowing it depends on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, asUser, DEFAULT_DATA } = require('./helpers/load-code');

const REPORT_HEADERS = ['id', 'campaign', 'market', 'date', 'event', 'supervisor',
  'coordinator', 'inventoryDependency', 'notes', 'createdById', 'createdByName',
  'approvalStatus', 'barcode', 'deletedAt'];

const report = (id, ownerId, ownerName, extra = {}) => [
  id, 'حملة-tests', 'سوق', '2026-01-0' + (id % 9 + 1), 'حدث', 'مشرف', 'منسق', '',
  'ملاحظة', ownerId, ownerName, 'pending', String(1000 + id), extra.deletedAt || '',
];

const DATA_WITH_REPORTS = Object.assign({}, DEFAULT_DATA, {
  Reports: [REPORT_HEADERS,
    report(1, 'E003', 'موظف أول'),
    report(2, 'E004', 'موظف ثاني'),
    report(3, 'E005', 'موظف ثالث'),
    report(4, 'E006', 'موظف رابع'),
    report(5, 'E001', 'المدير العام'),
  ],
  sales: [['id', 'product', 'price', 'quantity'], [1, 'منتج', 100, 2]],
  expenses: [['id', 'item', 'quantity'], [1, 'بند', 1]],
  promoters: [['id', 'name'], [1, 'مروج']],
});

const setup = () => loadCode({ data: DATA_WITH_REPORTS });
const ids = (rows) => rows.map(r => Number(r.id)).sort((a, b) => a - b);

test('getReports: a manager sees their own reports plus the whole team', () => {
  const u = asUser(setup(), 'mgr1', 'pw-mgr');
  // E001 is the manager's own boss — not part of their team, so report 5 is out of scope.
  assert.deepEqual(ids(u.get('getReports', { targetUserId: 'all' })), [1, 2, 3, 4]);
});

test('getReports: a regular employee sees only their own reports', () => {
  const u = asUser(setup(), 'user1', 'pw-user1');
  assert.deepEqual(ids(u.get('getReports', { targetUserId: 'all' })), [1]);
});

test('getReportsPage: returns newest-first pages with total and hasMore', () => {
  const u = asUser(setup(), 'admin1', 'pw-admin');
  const p1 = u.get('getReportsPage', { targetUserId: 'all', page: 1, pageSize: 2 });
  assert.equal(p1.status, 'success');
  assert.equal(p1.total, 5);
  assert.equal(p1.hasMore, true);
  assert.deepEqual(p1.items.map(r => Number(r.id)), [5, 4]);
  const p2 = u.get('getReportsPage', { targetUserId: 'all', page: 2, pageSize: 2 });
  assert.deepEqual(p2.items.map(r => Number(r.id)), [3, 2]);
});

test('getReportsPage: regular employee scope cannot be widened by targetUserId', () => {
  const u = asUser(setup(), 'user1', 'pw-user1');
  const page = u.get('getReportsPage', { targetUserId: 'E004', page: 1, pageSize: 20 });
  assert.equal(page.status, 'success');
  assert.deepEqual(ids(page.items), [1]);
});

test('getReports: an admin sees every report', () => {
  const u = asUser(setup(), 'admin1', 'pw-admin');
  assert.deepEqual(ids(u.get('getReports', { targetUserId: 'all' })), [1, 2, 3, 4, 5]);
});

test('getReports: selecting an employee narrows the list to their reports', () => {
  const u = asUser(setup(), 'mgr1', 'pw-mgr');
  assert.deepEqual(ids(u.get('getReports', { targetUserId: 'E004' })), [2]);
});

test('getReports: an admin can narrow to one employee', () => {
  const u = asUser(setup(), 'admin1', 'pw-admin');
  assert.deepEqual(ids(u.get('getReports', { targetUserId: 'E005' })), [3]);
});

test('reports filter: narrowing to an employee then back to "all" is stable', () => {
  const u = asUser(setup(), 'mgr1', 'pw-mgr');
  const all = ids(u.get('getReports', { targetUserId: 'all' }));
  const one = ids(u.get('getReports', { targetUserId: 'E003' }));
  const allAgain = ids(u.get('getReports', { targetUserId: 'all' }));
  assert.deepEqual(one, [1], 'narrowed view must be that employee only');
  assert.deepEqual(allAgain, all, 'going back to "all" must restore the full list');
});

test('reports filter: a target outside the requester scope is ignored, not leaked', () => {
  const u = asUser(setup(), 'mgr1', 'pw-mgr');
  // E999 does not exist, so the scope must stay exactly as it was for "all".
  const bogus = ids(u.get('getReports', { targetUserId: 'E999' }));
  assert.deepEqual(bogus, [1, 2, 3, 4], 'out-of-scope target must not leak or clear the list');
});

test('reports filter: a regular employee cannot widen scope via targetUserId', () => {
  const u = asUser(setup(), 'user1', 'pw-user1');
  assert.deepEqual(ids(u.get('getReports', { targetUserId: 'E004' })), [1],
    'a plain employee must still only see their own reports');
});

test('getTeamOptions: manager gets the team, employee gets an empty list', () => {
  const r = setup();
  const mgr = asUser(r, 'mgr1', 'pw-mgr');
  const opts = mgr.get('getTeamOptions').options.map(o => o.id).sort();
  assert.deepEqual(opts, ['E003', 'E004', 'E005', 'E006']);
  const emp = asUser(r, 'user1', 'pw-user1');
  assert.deepEqual(emp.get('getTeamOptions').options, []);
});

test('getReports: every id offered by getTeamOptions is actually filterable', () => {
  const u = asUser(setup(), 'mgr1', 'pw-mgr');
  const options = u.get('getTeamOptions').options;
  assert.ok(options.length > 0, 'expected a non-empty team list');
  options.forEach(o => {
    const rows = u.get('getReports', { targetUserId: o.id });
    const expected = u.get('getReports', { targetUserId: 'all' })
      .filter(r => String(r.createdById) === o.id);
    assert.deepEqual(ids(rows), ids(expected),
      'filtering by ' + o.id + ' must return exactly that employee\'s reports');
  });
});

test('getReports: soft-deleted reports never appear, filtered or not', () => {
  const data = Object.assign({}, DATA_WITH_REPORTS, {
    Reports: [REPORT_HEADERS,
      report(1, 'E003', 'موظف أول'),
      report(2, 'E004', 'موظف ثاني', { deletedAt: '2026-01-05' }),
    ],
  });
  const u = asUser(loadCode({ data }), 'mgr1', 'pw-mgr');
  assert.deepEqual(ids(u.get('getReports', { targetUserId: 'all' })), [1]);
  assert.deepEqual(ids(u.get('getReports', { targetUserId: 'E004' })), [],
    'a deleted employee report must not resurface through the filter');
});

// A missing or renamed optional sheet must not take the whole history page
// down — it used to throw and the page rendered empty with no explanation.
for (const optional of ['sales', 'expenses', 'promoters', 'salesOfCompetitor']) {
  test('getReports: a missing "' + optional + '" sheet does not break the history page', () => {
    const data = Object.assign({}, DATA_WITH_REPORTS);
    delete data[optional];
    const u = asUser(loadCode({ data }), 'mgr1', 'pw-mgr');
    const rows = u.get('getReports', { targetUserId: 'all' });
    assert.ok(Array.isArray(rows), 'expected an array, got: ' + JSON.stringify(rows).slice(0, 120));
    assert.deepEqual(ids(rows), [1, 2, 3, 4], 'reports must still load without the optional sheet');
  });
}
