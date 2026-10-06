'use strict';
// Unit tests for authentication, sessions, CSRF, and role/team scoping.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, loginAs, asUser, post, get, DEFAULT_DATA } = require('./helpers/load-code');

test('doLogin: valid credentials return token + user', () => {
  const r = loadCode();
  const body = post(r, 'doLogin', { username: 'user1', password: 'pw-user1' });
  assert.equal(body.status, 'success');
  assert.ok(body.token, 'expected a session token');
  assert.ok(body.csrfToken, 'expected a csrf token');
  assert.equal(body.user.id, 'E003');
  assert.equal(body.user.role, 'user');
});

test('doLogin: case-insensitive username', () => {
  const r = loadCode();
  const body = post(r, 'doLogin', { username: 'USER1', password: 'pw-user1' });
  assert.equal(body.status, 'success');
  assert.equal(body.user.username, 'user1');
});

test('doLogin: wrong password is rejected', () => {
  const r = loadCode();
  const body = post(r, 'doLogin', { username: 'user1', password: 'wrong' });
  assert.equal(body.status, 'error');
  assert.match(body.message, /Invalid credentials/i);
});

test('doLogin: unknown username is rejected', () => {
  const r = loadCode();
  const body = post(r, 'doLogin', { username: 'ghost', password: 'x' });
  assert.equal(body.status, 'error');
});

test('doLogin: empty password cannot match an empty stored value', () => {
  const data = {
    ...DEFAULT_DATA,
    Employees: [
      ['id', 'name', 'username', 'password', 'role', 'jobPosition', 'mgr'],
      ['E010', 'بلا كلمة', 'nopass', '', 'user', 'موظف', ''],
    ],
  };
  const r = loadCode({ data });
  const body = post(r, 'doLogin', { username: 'nopass', password: '' });
  assert.equal(body.status, 'error');
});

test('doLogin: plaintext password is upgraded to hash on success', () => {
  const r = loadCode();
  post(r, 'doLogin', { username: 'user1', password: 'pw-user1' });
  const sh = r.env._spreadsheet.getSheetByName('Employees');
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  const row = rows.find(x => x[2] === 'user1');
  assert.ok(String(row[3]).startsWith('pwd$'), 'password should be stored as pwd$salt$hash');
  // Old plaintext must no longer work as a stored value, but login still works.
  const again = post(r, 'doLogin', { username: 'user1', password: 'pw-user1' });
  assert.equal(again.status, 'success');
});

test('brute force: account locks after 5 failed attempts', () => {
  const r = loadCode();
  for (let i = 0; i < 5; i++) {
    post(r, 'doLogin', { username: 'user2', password: 'bad' });
  }
  const locked = post(r, 'doLogin', { username: 'user2', password: 'pw-user2' });
  assert.equal(locked.status, 'error');
  assert.match(locked.message, /مقفل|15/);
});

test('brute force: successful login resets the counter', () => {
  const r = loadCode();
  post(r, 'doLogin', { username: 'user2', password: 'bad' });
  post(r, 'doLogin', { username: 'user2', password: 'pw-user2' });
  const again = post(r, 'doLogin', { username: 'user2', password: 'pw-user2' });
  assert.equal(again.status, 'success');
});

test('session: GET without token is rejected as unauthorized', () => {
  const r = loadCode();
  const body = get(r, 'getInitialData');
  assert.equal(body.status, 'error');
  assert.equal(body.code, 'unauthorized');
});

test('session: POST without token is rejected', () => {
  const r = loadCode();
  const body = post(r, 'saveSalaryAdvance', { employeeId: 'E003', amount: 10, date: '2026-01-01' });
  assert.equal(body.status, 'error');
  assert.equal(body.code, 'unauthorized');
});

test('session: a forged token is rejected', () => {
  const r = loadCode();
  const body = get(r, 'getInitialData', { token: 'made-up-token' });
  assert.equal(body.status, 'error');
  assert.equal(body.code, 'unauthorized');
});

test('CSRF: POST with a valid token but wrong csrfToken is rejected', () => {
  const r = loadCode();
  const s = loginAs(r, 'user1', 'pw-user1');
  const body = post(r, 'saveSalaryAdvance', {
    token: s.token, csrfToken: 'wrong-csrf',
    employeeId: 'E003', amount: 100, date: '2026-01-01',
  });
  assert.equal(body.status, 'error');
  assert.match(body.message, /CSRF/i);
});

test('CSRF: a missing csrfToken is rejected for authenticated POSTs', () => {
  const r = loadCode();
  const s = loginAs(r, 'user1', 'pw-user1');
  const body = post(r, 'saveSalaryAdvance', {
    token: s.token,
    employeeId: 'E003', amount: 100, date: '2026-01-01',
  });
  assert.equal(body.status, 'error');
  assert.match(body.message, /CSRF/i);
});

test('logout: revokes the token', () => {
  const r = loadCode();
  const s = loginAs(r, 'user1', 'pw-user1');
  const out = post(r, 'logout', { token: s.token });
  assert.equal(out.status, 'success');
  const after = get(r, 'getInitialData', { token: s.token });
  assert.equal(after.status, 'error');
  assert.equal(after.code, 'unauthorized');
});

test('expired session is rejected', () => {
  const r = loadCode();
  const s = loginAs(r, 'user1', 'pw-user1');
  // Force-expire the stored session entry (the mock cache is a Map).
  const store = r.env._scriptCache;
  const key = [...store._map.keys()]
    .find(k => k.startsWith('sess_') && String(store._map.get(k)).includes('|'));
  assert.ok(key, 'expected a session entry in the cache');
  const id = String(store._map.get(key)).split('|')[0];
  store._map.set(key, id + '|' + (Date.now() - 1000));
  const body = get(r, 'getInitialData', { token: s.token });
  assert.equal(body.status, 'error');
  assert.equal(body.code, 'unauthorized');
});

test('roles: login returns the role from the sheet, not from the client', () => {
  const r = loadCode();
  const body = post(r, 'doLogin', {
    username: 'mgr1', password: 'pw-mgr', role: 'admin', id: 'E001',
  });
  assert.equal(body.user.role, 'manager', 'client-supplied role must be ignored');
  assert.equal(body.user.id, 'E002');
});

test('getTeamOptions: regular user gets an empty list', () => {
  const r = loadCode();
  const u = asUser(r, 'user1', 'pw-user1');
  const body = u.get('getTeamOptions');
  assert.equal(body.status, 'success');
  assert.deepEqual(body.options, []);
});

test('getTeamOptions: manager sees his team (all levels) but not himself', () => {
  const r = loadCode();
  const u = asUser(r, 'mgr1', 'pw-mgr');
  const body = u.get('getTeamOptions');
  assert.equal(body.status, 'success');
  const ids = body.options.map(o => o.id).sort();
  // E003/E004/E005 report to E002; E006 reports to E003, so also in scope.
  assert.deepEqual(ids, ['E003', 'E004', 'E005', 'E006']);
  assert.ok(!ids.includes('E002'), 'manager must not list himself');
});

test('getTeamOptions: admin sees every employee except self', () => {
  const r = loadCode();
  const u = asUser(r, 'admin1', 'pw-admin');
  const body = u.get('getTeamOptions');
  const ids = body.options.map(o => o.id).sort();
  assert.deepEqual(ids, ['E002', 'E003', 'E004', 'E005', 'E006']);
});

test('getManagerTeamIds: includes self plus direct and indirect reports', () => {
  const r = loadCode();
  const ids = r.code.getManagerTeamIds('E002').map(String).sort();
  assert.deepEqual(ids, ['E002', 'E003', 'E004', 'E005', 'E006']);
});

test('getManagerTeamIds: leaf manager sees only self', () => {
  const r = loadCode();
  const ids = r.code.getManagerTeamIds('E003').map(String).sort();
  assert.deepEqual(ids, ['E003', 'E006']);
});

test('getTeamMemberIds: admin gets null (unscoped), user gets only self', () => {
  const r = loadCode();
  assert.equal(r.code.getTeamMemberIds('E001', 'admin'), null);
  // Arrays are built inside the VM realm, so compare a plain copy.
  assert.deepEqual(Array.from(r.code.getTeamMemberIds('E003', 'user')), ['E003']);
});
