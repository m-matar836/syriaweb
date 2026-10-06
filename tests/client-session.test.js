'use strict';
// ===================================================================
// Session lifetime and what survives a logout.
//
// «تذكرني» means the user asked to stay signed in, so the 8-hour idle
// timeout must not fire for them. Without it the checkbox was only choosing
// localStorage over sessionStorage — the timer ran either way, so a remembered
// session still got kicked out after 8 hours.
//
// Logging out has to leave nothing behind for whoever opens the app next. The
// page already cleared its own caches; the service worker's API cache was the
// one thing left holding the previous user's responses.
// ===================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient, FakeEl } = require('./helpers/load-client');

const HOUR = 60 * 60 * 1000;

/** A session that logged in `hoursAgo` hours ago and is still inside the window. */
function session(hoursAgo, remembered) {
  const r = loadClient('core.js');
  const s = r.sandbox;
  s.localStorage.setItem('currentUser', JSON.stringify({ id: 'E001', role: 'admin', name: 'المشرف' }));
  s.localStorage.setItem('loginTimestamp', String(Date.now() - hoursAgo * HOUR));
  if (remembered) s.setRememberedSession(true);
  return { r, s };
}

/** Give the sandbox a service worker that answers CLEAR_APP_CACHE immediately. */
function withServiceWorker(s) {
  const sent = [];
  s.navigator.serviceWorker = {
    controller: { postMessage: (msg) => sent.push(msg) },
  };
  s.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: () => setTimeout(() => this.port1.onmessage && this.port1.onmessage({ ok: true }), 0),
      };
    }
  };
  return sent;
}

// --- «تذكرني»: the session must survive past the idle timeout.

test('remember me: a remembered session arms no expiry timer', () => {
  const { r } = session(1, true);
  r.evalIn('startSessionTimeout()');
  assert.equal(r.evalIn('sessionTimer'), null,
    'no logout timer may be scheduled for a session that asked to be remembered');
  assert.equal(r.evalIn('sessionWarningTimer'), null,
    'and no «ستنتهي جلستك» banner either');
});

test('without remember me: the 8-hour timeout is still armed', () => {
  const { r } = session(1, false);
  r.evalIn('startSessionTimeout()');
  assert.notEqual(r.evalIn('sessionTimer'), null,
    'an ordinary session must still be logged out when it goes idle');
});

test('remember me: a session idle for months is not logged out', () => {
  const { r, s } = session(24 * 120, true);
  const logouts = [];
  s.alert = (m) => logouts.push(m);
  r.evalIn('startSessionTimeout()');
  assert.deepEqual(logouts, [], 'a remembered session must not expire');
  assert.ok(s.localStorage.getItem('currentUser'), 'and must stay signed in');
});

test('without remember me: a session past the timeout is logged out', () => {
  const { r, s } = session(24 * 120, false);
  const logouts = [];
  s.alert = (m) => logouts.push(m);
  r.evalIn('startSessionTimeout()');
  assert.equal(logouts.length, 1, 'an expired ordinary session must be logged out');
  assert.equal(s.localStorage.getItem('currentUser'), null);
});

test('remember me: unchecking the box at the next login re-arms the timeout', () => {
  const { r, s } = session(1, true);
  r.evalIn('startSessionTimeout()');
  s.setRememberedSession(false);
  r.evalIn('startSessionTimeout()');
  assert.notEqual(r.evalIn('sessionTimer'), null,
    'opting out has to take effect immediately, not only after the next reload');
});

// --- Logging out: nothing of this user may remain on the device.

test('logout: the service worker API cache is purged', async () => {
  const { s } = session(1, false);
  const sent = withServiceWorker(s);
  s.getAppToken = () => 'tok';
  s.apiPost = async () => ({ status: 'success' });

  s.bindShellUserControls();
  s.document.getElementById('logoutBtn').dispatch('click');
  // The purge is awaited before the app navigates, otherwise the next user can
  // log in while the deletion is still in flight and read the old responses.
  await new Promise(r2 => setTimeout(r2, 10));

  assert.ok(sent.some(m => m && m.type === 'CLEAR_APP_CACHE'),
    'logout must tell the service worker to drop its cached API responses, got: '
      + JSON.stringify(sent));
});

test('logout: the remember-me flag does not outlive the session', async () => {
  const { s } = session(1, true);
  withServiceWorker(s);
  s.getAppToken = () => '';
  s.apiPost = async () => ({ status: 'success' });

  s.bindShellUserControls();
  s.document.getElementById('logoutBtn').dispatch('click');
  await new Promise(r2 => setTimeout(r2, 10));

  assert.equal(s.localStorage.getItem('rememberSession'), null,
    'the next person must not inherit a never-expiring session');
});

test('session expiry: purges the API cache and forgets remember-me too', () => {
  const { r, s } = session(24 * 120, true);
  const sent = withServiceWorker(s);
  s.alert = () => {};

  r.evalIn('forceLogout("انتهت الجلسة")');
  // forceLogout is sync by contract; give the purge a turn to be issued.
  return new Promise(resolve => setTimeout(() => {
    assert.equal(s.localStorage.getItem('rememberSession'), null);
    resolve();
  }, 10));
});

// --- The login form has to actually record the choice.

async function submitLogin(rememberMe) {
  let activate = null;
  const remembered = [];
  let form = null;
  const r = loadClient('page-login.js', {
    setup(s) {
      s.registerView = (route, fn) => { if (route === 'login') activate = fn; };

      s.apiPost = async () => ({ status: 'success', token: 'tok', csrfToken: 'csrf', user: { id: 'E001', role: 'admin' } });
      s.storeAppToken = () => {};
      s.storeCsrfToken = () => {};
      s.sweepForeignUserCaches = () => {};
      s.recordLoginSession = () => false;
      s.navigateTo = () => {};
      s.isPromoterAccount = () => false;
      s.checkRejections = async () => {};
      s.checkTeamEntryFeed = async () => {};
      s.getDbData = async () => ({});
      s.setRememberedSession = (on) => { remembered.push(!!on); s.localStorage.setItem('rememberSession', on ? '1' : '0'); };

      form = new FakeEl('form', 'loginForm');
      form.username = { value: ' Boss ' };
      form.password = { value: 'pw' };
      form.rememberMe = { checked: rememberMe };
      form.querySelector = () => new FakeEl('button');
      s.document.getElementById = (id) => (id === 'loginForm' ? form : new FakeEl('div', id));
    },
  });
  const s = r.sandbox;

  await activate();
  form.dispatch('submit', { preventDefault() {}, target: form });
  await new Promise(r2 => setTimeout(r2, 5));
  return { s, remembered };
}

test('login: «تذكرني» checked keeps the session and marks it remembered', async () => {
  const { s, remembered } = await submitLogin(true);
  assert.deepEqual(remembered, [true], 'the checkbox must be recorded for the session');
  assert.ok(s.localStorage.getItem('currentUser'), 'must survive a browser restart');
});

test('login: «تذكرني» unchecked stores the session for this tab only', async () => {
  const { s, remembered } = await submitLogin(false);
  assert.deepEqual(remembered, [false], 'opting out must be recorded too');
  assert.equal(s.localStorage.getItem('currentUser'), null);
  assert.ok(s.sessionStorage.getItem('currentUser'), 'falls back to the tab session');
});