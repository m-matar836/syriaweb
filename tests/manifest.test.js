'use strict';
// Guards on the PWA install surface: orientation, theme and what the
// service worker pre-caches. These are static config files, so nothing else
// in the suite would notice if they regressed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

// --------------------------------------------------------------- orientation

test('orientation: the manifest does not lock the app to portrait', () => {
  // "portrait" in a standalone PWA makes Android refuse to rotate, and it
  // overrides the user's own device rotation setting.
  const o = manifest.orientation;
  assert.ok(o === undefined || o === 'any' || o === 'natural',
    `orientation must be free to rotate, got ${JSON.stringify(o)}`);
});

test('orientation: the display mode does not force an orientation', () => {
  // fullscreen/standalone honour the manifest lock; the lock itself is what
  // matters, so just make sure the two are consistent.
  assert.ok(['standalone', 'fullscreen', 'minimal-ui', 'browser'].includes(manifest.display),
    `unexpected display mode: ${manifest.display}`);
});

test('orientation: no client script calls screen.orientation.lock', () => {
  // The API only works for fullscreen anyway, but an accidental call would
  // silently pin the page and is worth catching in review.
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'));
  const offenders = files.filter(f => /screen\.orientation\s*\.\s*lock|orientation\s*\.\s*lock\s*\(/.test(read(f)));
  assert.deepEqual(offenders, [], 'found an orientation lock call in: ' + offenders.join(', '));
});

test('orientation: the viewport meta does not block user zoom', () => {
  // Not strictly rotation, but the same family of "the app fights the device"
  // bugs, and a one-line regression if someone copies a boilerplate meta tag.
  const html = read('index.html');
  const meta = html.match(/<meta\s+name=["']viewport["'][^>]*>/i);
  assert.ok(meta, 'index.html must declare a viewport meta tag');
  assert.ok(!/user-scalable\s*=\s*no/i.test(meta[0]), 'pinch-zoom must stay enabled');
  assert.ok(!/maximum-scale\s*=\s*1\b/i.test(meta[0]), 'a maximum-scale of 1 caps zoom on iOS');
  assert.ok(/width\s*=\s*device-width/i.test(meta[0]), 'the layout must follow the device width');
});

test('orientation: the stylesheet keys off width, not a fixed orientation', () => {
  // A landscape phone is wide and short, so width-based breakpoints already
  // cover it. A hard-coded portrait assumption is what breaks rotation.
  const css = read('style.css');
  const orientationQueries = (css.match(/@media[^{]*orientation[^{]*{/g) || [])
    .filter(q => !/@media print/.test(q));
  assert.deepEqual(orientationQueries, [],
    'the layout should not branch on orientation; found: ' + orientationQueries.join(' | '));
  assert.ok(/@media print/.test(css), 'printing is the one place orientation is intentional');

  // A hard 100vh is the classic rotation bug. 100vh is the *largest* viewport,
  // so on a rotated phone the layout is sized for the portrait height it no
  // longer has: the page either overflows or leaves a dead band. dvh tracks the
  // real viewport height, so the layout follows the rotation.
  const hardVh = css.match(/min-height:\s*100vh/g) || [];
  assert.deepEqual(hardVh, [],
    'min-height: 100vh does not follow rotation. Use min-height: 100dvh so the ' +
    'layout matches the real viewport height in both portrait and landscape.');

  // Same for offsets computed from the viewport inside calc().
  const calcVh = css.match(/calc\(\s*100vh/g) || [];
  assert.deepEqual(calcVh, [],
    'calc(100vh ...) is sized for the portrait viewport and breaks when rotated. Use 100dvh.');

  assert.ok(/min-height:\s*100dvh/.test(css),
    'full-height containers must use min-height: 100dvh');
});

// ------------------------------------------------------------- service worker

test('pwa: the manifest is pre-cached so a version bump can retire the old one', () => {
  const sw = read('service-worker.js');
  assert.ok(/['"]\.\/manifest\.json['"]/.test(sw),
    'manifest.json must be in APP_SHELL, otherwise a stale copy keeps the old orientation lock');
});

test('pwa: every page script is pre-cached', () => {
  const sw = read('service-worker.js');
  const shell = (sw.match(/const APP_SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
  const scripts = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && f !== 'service-worker.js');
  const missing = scripts.filter(f => !shell.includes(f));
  assert.deepEqual(missing, [], 'not pre-cached: ' + missing.join(', '));
});

test('pwa: the non-script shell assets are pre-cached too', () => {
  // The script check above cannot catch these: it globs *.js, so dropping
  // style.css or the manifest from APP_SHELL still passes it. Losing style.css
  // means no layout on a cold or offline start, and losing the manifest means
  // the installed app keeps the orientation lock it was installed with.
  const sw = read('service-worker.js');
  const shell = (sw.match(/const APP_SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
  for (const asset of ['./index.html', './style.css', './manifest.json', './icons/icon.svg']) {
    assert.ok(shell.includes(`'${asset}'`), `${asset} must be in APP_SHELL`);
  }
});

test('pwa: the cache name is versioned so a deploy actually reaches installed apps', () => {
  const sw = read('service-worker.js');
  const name = (sw.match(/const CACHE_NAME = ['"]([^'"]+)['"]/) || [])[1];
  assert.ok(name, 'CACHE_NAME must be declared');
  assert.ok(/-v\d+/.test(name), `CACHE_NAME must carry a version, got ${name}`);
});

test('pwa: the version is not stale — every shell asset served from cache is revalidated', () => {
  // The failure this guards against is silent and invisible: publish a fix, the
  // installed app keeps serving the old file, and nobody sees the change until
  // they bump CACHE_NAME by hand. Version bumps get forgotten, so the fetch
  // strategy itself must not depend on one.
  //
  // Anything in APP_SHELL is by definition something we ship and change, so it
  // is served network-first and falls back to the cache only when the network
  // is gone. Cache-first is reserved for the CDN copies, which are pinned by
  // SRI and cannot change under us.
  const sw = read('service-worker.js');
  const shell = (sw.match(/const APP_SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
  const localAssets = [...shell.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
  assert.ok(localAssets.length > 0, 'APP_SHELL must list the local files');

  // The guard predicate has to cover every extension we actually ship, or a new
  // asset type silently falls back to cache-first.
  const guarded = (sw.match(/function isLocalShellUrl[\s\S]*?\n\}/) || [])[0] || '';
  const exts = ['js', 'css', 'html', 'json', 'svg'];
  for (const ext of exts) {
    assert.ok(new RegExp(ext).test(guarded),
      `isLocalShellUrl must treat .${ext} as network-first, or it silently becomes cache-first`);
  }

  // And the branch must actually be the one that reaches the network-first
  // handler rather than the cache-first tail below it.
  assert.match(sw, /if \(\s*isLocalShellUrl\(url\)\s*\|\|\s*request\.mode === 'navigate'\s*\)\s*\{\s*return await networkFirstHandler/,
    'local shell assets must take the network-first branch');
  assert.doesNotMatch(sw, /isLocalScriptUrl/,
    'the old .js-only predicate is what left style.css on cache-first');
});

// ------------------------------------------------- CLEAR_APP_CACHE handshake

/**
 * Run service-worker.js in a sandbox and hand back the listeners it registered.
 * A regex over the source cannot tell whether the reply is actually sent, or
 * sent before the deletion finished — which is the whole defect.
 */
function loadWorker() {
  const listeners = {};
  const store = new Map();
  const deleted = [];
  const sandbox = {
    console, URL, Promise, Set, Map, Object, Array, String, Number, Boolean, JSON,
    Request: class Request { constructor(url) { this.url = String(url); } },
    Response: class Response { constructor(body, init) { this.body = body; this.init = init; } },
    fetch: async () => { throw new Error('network disabled in the test'); },
    caches: {
      open: async () => ({
        // keys() hands back Request objects, as the real Cache does — the
        // handler reads req.url, so returning bare strings would hide the path.
        keys: async () => [...store.keys()].map(u => new sandbox.Request(u)),
        match: async () => undefined,
        put: async () => {},
        delete: async (req) => { deleted.push(req.url); return store.delete(req.url); },
      }),
      keys: async () => [],
      delete: async () => true,
    },
    self: {
      location: { origin: 'https://example.test' },
      skipWaiting: async () => {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
  };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  new vm.Script(read('service-worker.js'), { filename: 'service-worker.js' }).runInContext(sandbox);
  return { listeners, store, deleted };
}

test('pwa: CLEAR_APP_CACHE is acknowledged only after the deletion finished', async () => {
  // refreshAppCache() awaits this reply before issuing any API request. Without
  // it the requests race the clear, get served from the cache being emptied, and
  // the button reports success while writing that stale copy back to localStorage.
  const { listeners, store, deleted } = loadWorker();
  store.set('https://script.google.com/macros/s/Exec?action=getReports', {});
  store.set('https://example.test/style.css', {});

  const replies = [];
  let settled = null;
  listeners.message({
    data: { type: 'CLEAR_APP_CACHE' },
    ports: [{ postMessage: (m) => replies.push({ m, at: deleted.length }) }],
    waitUntil: (p) => { settled = p; },
  });
  await settled;

  assert.deepEqual(replies.map(r => r.m.ok), [true], 'the worker must reply');
  assert.deepEqual(deleted, ['https://script.google.com/macros/s/Exec?action=getReports'],
    'only cached API responses may be dropped, the app shell must survive');
  for (const r of replies) {
    assert.equal(r.at, deleted.length,
      'the reply must come after every deletion, not during or before it');
  }
});

test('pwa: CLEAR_APP_CACHE always answers, so a failure cannot look like a hang', async () => {
  // The page waits on this reply with a 3s timeout. A worker that stays silent
  // on error turns every failed clear into a visible stall, and one that answers
  // before the work is done reintroduces the stale-read race.
  const { listeners } = loadWorker();
  const replies = [];
  let settled = null;
  listeners.message({
    data: { type: 'CLEAR_APP_CACHE' },
    ports: [{ postMessage: (m) => replies.push(m) }],
    waitUntil: (p) => { settled = p; },
  });
  await settled.catch(() => {});

  assert.equal(replies.length, 1, 'exactly one reply per request');
  assert.ok('ok' in replies[0], 'the reply must carry an ok flag');
});

test('pwa: an unrelated postMessage is ignored', async () => {
  // The handler must not answer messages it does not own — a stray SYNC_PENDING
  // reply would resolve the page's wait for the cache clear.
  const { listeners } = loadWorker();
  const replies = [];
  let settled = null;
  listeners.message({
    data: { type: 'SOMETHING_ELSE' },
    ports: [{ postMessage: (m) => replies.push(m) }],
    waitUntil: (p) => { settled = p; },
  });
  assert.equal(replies.length, 0, 'no reply for a message we do not handle');
  assert.equal(settled, null, 'and nothing kept alive on its behalf');
});
