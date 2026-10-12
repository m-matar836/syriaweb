'use strict';
// V83: permanent login — a session must survive the 6-hour script-cache TTL.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, post, get } = require('./helpers/load-code');

function login(r, extra) {
  return post(r, 'doLogin', Object.assign({ username: 'user1', password: 'pw-user1' }, extra || {}));
}
test('persistent session: survives total cache loss (GET)', () => {
  const r = loadCode();
  const body = login(r);
  assert.equal(body.status, 'success');
  r.env.CacheService.getScriptCache()._reset();
  const res = get(r, 'getStatusOptions', { token: body.token });
  assert.notEqual(res.code, 'unauthorized', 'session must be restored from persistent storage');
});

test('persistent session: correct csrf still accepted after cache loss', () => {
  const r = loadCode();
  const body = login(r);
  r.env.CacheService.getScriptCache()._reset();
  const ok = post(r, 'noSuchAction', { token: body.token, csrfToken: body.csrfToken });
  assert.notEqual(ok.code, 'unauthorized', 'valid csrf must be restored from persistent storage');
  const bad = post(r, 'noSuchAction', { token: body.token, csrfToken: 'wrong' });
  assert.equal(bad.code, 'unauthorized', 'wrong csrf must still be rejected');
});

test('logout revokes the persistent session', () => {
  const r = loadCode();
  const body = login(r);
  post(r, 'logout', { token: body.token });
  r.env.CacheService.getScriptCache()._reset();
  const res = get(r, 'getStatusOptions', { token: body.token });
  assert.equal(res.code, 'unauthorized');
});

test('remember=false keeps the old 6h behaviour (not persisted)', () => {
  const r = loadCode();
  const body = login(r, { remember: false });
  r.env.CacheService.getScriptCache()._reset();
  const res = get(r, 'getStatusOptions', { token: body.token });
  assert.equal(res.code, 'unauthorized');
});

test('expired persistent session is rejected and removed', () => {
  const r = loadCode();
  const body = login(r);
  const props = r.env.PropertiesService.getScriptProperties();
  const key = 'psess_' + body.token;
  const rec = JSON.parse(props.getProperty(key));
  rec.e = Date.now() - 1000;
  props.setProperty(key, JSON.stringify(rec));
  r.env.CacheService.getScriptCache()._reset();
  const res = get(r, 'getStatusOptions', { token: body.token });
  assert.equal(res.code, 'unauthorized');
  assert.equal(props.getProperty(key), null);
});

test('unknown token is still rejected', () => {
  const r = loadCode();
  const res = get(r, 'getStatusOptions', { token: 'deadbeef' });
  assert.equal(res.code, 'unauthorized');
});
