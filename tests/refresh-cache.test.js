// Regression tests for refreshAppCache() in core.js — the «تحديث البيانات» button.
//
// Four separate defects lived in this one function:
//   1. It posted CLEAR_APP_CACHE to the service worker without waiting for a
//      reply, so the very next request could still be answered from the cache
//      that was being cleared — the button reported success on stale data and
//      then wrote that stale data into the app's own cache.
//   2. page-reports.js calls it with `refreshReports: false` on every price
//      keystroke (120ms debounce), but the function never read that option, so
//      typing a price pulled the whole site again.
//   3. An unguarded localStorage.setItem could throw QuotaExceededError *after*
//      the data had already arrived, which reported "refresh failed" and skipped
//      every event the screens redraw on.
//   4. A silent, master-data-only refresh still did everything the real button
//      does: disabled the button, flashed «تم تحديث كل البيانات» over it, and
//      asked the browser to re-check every service worker registration. That is
//      the work the user feels while typing in the sales table.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient, FakeEl } = require('./helpers/load-client');

const MASTER = { status: 'success', products: [], employees: [], locations: [] };
const BUTTON_HTML = '<i class="fa-solid fa-arrows-rotate me-1"></i>تحديث البيانات';

/** Load core.js with a recording apiGet and the collaborators the function calls. */
function setup({
  localStorageThrows = false, online = true, serviceWorker = null,
  order = null, withButton = false,
} = {}) {
  const actions = [];
  const fired = [];
  const regUpdates = [];
  const button = new FakeEl('button');
  button.innerHTML = BUTTON_HTML;

  const s = loadClient('core.js', {
    setup(sandbox) {
      const real = sandbox.localStorage;
      sandbox.localStorage = {
        getItem: (k) => real.getItem(k),
        removeItem: (k) => real.removeItem(k),
        setItem(k, v) {
          if (localStorageThrows) {
            const e = new Error('The quota has been exceeded.');
            e.name = 'QuotaExceededError';
            throw e;
          }
          return real.setItem(k, v);
        },
      };
      sandbox.sessionStorage.setItem('currentUser',
        JSON.stringify({ id: 'E001', role: 'admin', name: 'Admin', username: 'admin1' }));

      sandbox.navigator = { userAgent: 'node-test', language: 'ar', onLine: online, serviceWorker };
      sandbox.document.querySelectorAll =
        (sel) => (withButton && sel === '[data-refresh-cache]' ? [button] : []);

      const origDispatch = sandbox.dispatchEvent;
      sandbox.dispatchEvent = (ev) => {
        fired.push(typeof ev === 'string' ? ev : ev && ev.type);
        return origDispatch(ev);
      };
    },
  });

  // core.js declares apiGet/checkRejections/checkTeamEntryFeed itself, so they
  // can only be replaced after the module has run.
  s.sandbox.apiGet = (action) => {
    actions.push(action);
    if (order) order.push('api:' + action);
    return Promise.resolve(action === 'getInitialData' ? MASTER : []);
  };
  // Keep the test hermetic: these two fire network work of their own.
  s.sandbox.checkRejections = () => { actions.push('sidecheck:rejections'); };
  s.sandbox.checkTeamEntryFeed = () => { actions.push('sidecheck:entryFeed'); };

  if (withButton) {
    s.sandbox.navigator.serviceWorker = Object.assign({
      getRegistrations: () => Promise.resolve([{ update: () => { regUpdates.push('update'); return Promise.resolve(); } }]),
    }, serviceWorker ? { controller: serviceWorker.controller } : {});
  }

  return { s, actions, fired, regUpdates, button };
}

/** A service worker controller that clears the cache asynchronously, like the real one. */
function slowController(order, delay = 5) {
  return {
    postMessage(msg, port) {
      order.push('post:' + msg.type);
      setTimeout(() => {
        order.push('cleared');
        if (port && port.postMessage) port.postMessage({ ok: true });
      }, delay);
    },
  };
}

test('refreshAppCache: no API request goes out before the cache clear finishes', async () => {
  // postMessage is fire-and-forget. Without awaiting a reply the six API calls
  // race the deletion and can be served from the cache being cleared.
  const order = [];
  const { s, actions } = setup({ serviceWorker: { controller: slowController(order) }, order });

  const res = await s.evalIn('refreshAppCache({ silent: true })');

  assert.equal(res.ok, true, 'the refresh itself should succeed: ' + (res.error && res.error.message));
  assert.ok(order.includes('post:CLEAR_APP_CACHE'), 'the worker must be asked to clear');
  assert.ok(order.includes('cleared'), 'the worker must have finished clearing');

  const clearedAt = order.indexOf('cleared');
  const firstApiAt = order.indexOf('api:getInitialData');
  assert.ok(firstApiAt !== -1, 'apiGet should have been called, order: ' + order.join(' -> '));
  assert.ok(clearedAt < firstApiAt,
    'no API request may be issued before the clear completes. order: ' + order.join(' -> '));
  assert.ok(actions.length > 0, 'the refresh must still fetch data');
});

test('refreshAppCache: works with no service worker at all', async () => {
  const { s } = setup({ serviceWorker: null });
  const res = await s.evalIn('refreshAppCache({ silent: true })');
  assert.equal(res.ok, true, 'a missing service worker must not fail the refresh');
});

test('refreshAppCache: refreshReports:false skips the per-user report traffic', async () => {
  // page-reports.js debounces price edits at 120ms and calls this on each one.
  // A price edit only changes master data; re-pulling reports, attendance and
  // movements for it is what made filling the sales table feel slow.
  const { s, actions } = setup();

  await s.evalIn('refreshAppCache({ silent: true, refreshReports: false })');

  assert.ok(actions.includes('getInitialData'), 'master data must still be pulled');
  for (const skipped of ['getReports', 'getAttendance', 'getUserFestivalMovements']) {
    assert.ok(!actions.includes(skipped),
      `${skipped} must be skipped when only master data changed, got: ${actions.join(', ')}`);
  }
  // getStatusOptions is the odd one out: its result is discarded by the caller,
  // so on a master-data-only refresh it is a request whose answer is thrown away.
  assert.ok(!actions.includes('getStatusOptions'),
    'a discarded response must not be re-fetched on every price keystroke');
  for (const sideCall of ['sidecheck:rejections', 'sidecheck:entryFeed']) {
    assert.ok(!actions.includes(sideCall),
      `${sideCall} is unrelated to a price edit and must not run, got: ${actions.join(', ')}`);
  }
});

test('refreshAppCache: without the option it still refreshes everything', async () => {
  // The guard above must not have narrowed the real button: pressing
  // «تحديث البيانات» has to keep pulling reports.
  const { s, actions } = setup();

  await s.evalIn('refreshAppCache({ silent: true })');

  for (const a of ['getInitialData', 'getReports', 'getTeamOptions',
    'getUserFestivalMovements', 'getAttendance', 'getStatusOptions']) {
    assert.ok(actions.includes(a), `${a} must be part of a full refresh, got: ${actions.join(', ')}`);
  }
});

test('refreshAppCache: a full localStorage quota does not fail the refresh', async () => {
  // By this point the data has already arrived. Reporting failure told the user
  // "تعذر تحديث كل البيانات" while the fresh payload was sitting in memory.
  const { s } = setup({ localStorageThrows: true });

  const res = await s.evalIn('refreshAppCache({ silent: true })');

  assert.equal(res.ok, true,
    'a storage quota error must not be reported as a refresh failure: '
    + (res.error && res.error.message));
  assert.ok(res.data, 'the freshly fetched data must still be handed back');
});

test('refreshAppCache: appDataRefreshed fires even when the cache write fails', async () => {
  // Every open screen redraws in response to this event, so swallowing it means
  // the user presses refresh and nothing visibly changes.
  const { s, fired } = setup({ localStorageThrows: true });

  await s.evalIn('refreshAppCache({ silent: true })');

  assert.ok(fired.includes('appDataRefreshed'),
    'appDataRefreshed must fire despite the failed cache write, got: ' + fired.join(', '));
});

test('refreshAppCache: offline short-circuits before any request', async () => {
  const { s, actions } = setup({ online: false });

  const res = await s.evalIn('refreshAppCache({ silent: true })');

  assert.equal(res.ok, false);
  assert.equal(res.offline, true);
  assert.equal(actions.length, 0, 'no request may be issued while offline');
});

test('refreshAppCache: a failed getInitialData is still reported as a failure', async () => {
  // The counterpart guard: swallowing every error would let the quota fix above
  // hide genuine outages.
  const s = loadClient('core.js', {
    setup(sandbox) {
      sandbox.navigator = { userAgent: 'node-test', onLine: true, serviceWorker: null };
    },
  });
  s.sandbox.apiGet = (action) => Promise.resolve(
    action === 'getInitialData' ? { status: 'error', message: 'ورقة مفقودة' } : []
  );
  s.sandbox.checkRejections = () => {};
  s.sandbox.checkTeamEntryFeed = () => {};

  const res = await s.evalIn('refreshAppCache({ silent: true })');

  assert.equal(res.ok, false, 'a failed master-data fetch must fail the refresh');
  assert.match(String(res.error && res.error.message), /ورقة مفقوبة|ورقة مفقودة/);
});

// --- The silent refresh must be invisible -----------------------------------

test('refreshAppCache: a silent master-data refresh leaves the button alone', async () => {
  // The button belongs to the user. A background refresh triggered by a price
  // keystroke disabled it, flashed «تم تحديث كل البيانات» across it, and then
  // swallowed whatever the user was doing — including any click already queued.
  const { s, button } = setup({ withButton: true });

  await s.evalIn('refreshAppCache({ silent: true, refreshReports: false })');

  assert.equal(button.innerHTML, BUTTON_HTML,
    'the button label must be untouched, got: ' + button.innerHTML);
  assert.equal(button.disabled, false, 'the button must stay clickable');
  assert.equal(button.dataset.originalHtml, undefined,
    'no originalHtml bookkeeping should be started for a background refresh');
});

test('refreshAppCache: a silent master-data refresh does not re-register the workers', async () => {
  // reg.update() asks the browser to fetch and install every service worker.
  // Doing that in the background on each keystroke competes with the requests
  // the user is actually waiting for.
  const { s, regUpdates } = setup({ withButton: true });

  await s.evalIn('refreshAppCache({ silent: true, refreshReports: false })');
  await new Promise(r => setTimeout(r, 20));

  assert.deepEqual(regUpdates, [], 'no worker re-check on a background refresh');
});

test('refreshAppCache: the real button still gets its spinner and confirmation', async () => {
  // The counterpart guard: a manual refresh has to be visible and has to leave
  // the button clickable again afterwards.
  const { s, button, regUpdates } = setup({ withButton: true });

  const res = await s.evalIn('refreshAppCache()');
  assert.equal(res.ok, true);
  assert.match(button.innerHTML, /تم تحديث كل البيانات/, 'the success state must show');
  assert.equal(button.disabled, true, 'the button stays disabled while showing the result');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(button.disabled, false, 'the button must be re-enabled afterwards');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(button.innerHTML, BUTTON_HTML, 'the original label must be restored, got: ' + button.innerHTML);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(regUpdates.length > 0, 'a manual refresh may still check for a worker update');
});
