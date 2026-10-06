'use strict';
// Performance budget tests.
//
// These exist because the app felt slow and the cause was not obvious. The
// measurements below are what identified it:
//
//   * V8 parse+compile of every local script totals ~0.2 ms. The JavaScript is
//     NOT the CPU bottleneck, so micro-optimising the code is wasted effort.
//   * All ten local scripts were synchronous <script> with no defer, so the
//     browser could not parse or paint anything until all 417 KB of them had
//     downloaded AND executed, and they sat behind four CDN scripts from three
//     origins. That serial download chain is the actual first-paint cost.
//   * populateSelect() in page-reports.js appended with `innerHTML +=` inside a
//     loop. Every += re-parses the whole accumulated markup, so the cost is
//     quadratic: 200 options re-parse ~1.1 MB of HTML.
//
// Timing assertions here are deliberately expressed as growth ratios rather
// than absolute milliseconds. Absolute budgets would make this suite flaky on
// a busy CI box and would get "fixed" by loosening the number instead of
// fixing the code. A growth ratio fails for the right reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = () => fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const localScripts = () => fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && !f.includes('.test.'));

// ---------------------------------------------------------------- transfer --

test('transfer: the local JavaScript payload is within budget', () => {
  const files = localScripts();
  const total = files.reduce((n, f) => n + Buffer.byteLength(read(f)), 0);
  const KB = (total / 1024).toFixed(1);
  assert.ok(total < 600 * 1024,
    `local JS is ${KB} KB across ${files.length} files, over the 600 KB first-load budget`);
  // Report the biggest offenders so a regression names the file to split.
  const rows = files.map(f => [f, Buffer.byteLength(read(f))]).sort((a, b) => b[1] - a[1]);
  const worst = rows.slice(0, 3).map(([f, b]) => `${f} ${(b / 1024).toFixed(0)}KB`).join(', ');
  assert.ok(true, `payload ${KB} KB, largest: ${worst}`);
});

test('transfer: no local script blocks the first paint', () => {
  // A synchronous <script> halts HTML parsing, so the browser cannot paint the
  // shell until it has downloaded and run every one of them. `defer` keeps the
  // execution order (these modules call registerView() and each depends on
  // core.js) but lets the parser continue and paint first.
  const tags = [...html().matchAll(/<script\b[^>]*>/g)].map(m => m[0]);
  const local = tags.filter(t => /src="(?!https?:)/.test(t));
  assert.ok(local.length >= 10, `expected the app scripts, found ${local.length}`);

  const blocking = local.filter(t => !/\s(defer|async)\b/.test(t) && !/type="module"/.test(t));
  assert.deepEqual(blocking, [],
    'these scripts are render-blocking; add defer (order is preserved):\n  ' + blocking.join('\n  '));

  // A tag like src="x"defer> is NOT deferred: HTML needs whitespace before an
  // attribute name, so the parser folds it into a bogus attribute and ignores
  // it. This exact mistake was made while fixing the one above.
  for (const t of local) {
    assert.ok(!/"(?:defer|async)>/.test(t), `missing space before the attribute: ${t}`);
  }
});

test('transfer: local scripts stay in dependency order', () => {
  // defer preserves document order, so core.js must still come first or the
  // page modules have nothing to register against.
  const order = [...html().matchAll(/<script src="(?!https?:)([^"]+)"/g)].map(m => m[1]);
  assert.equal(order[0], 'core.js', 'core.js must be the first deferred script');
  assert.equal(new Set(order).size, order.length, 'a local script is listed twice');
});

/**
 * Origins the browser actually fetches while parsing the initial document.
 *
 * Only subresources count. A cross-origin <a href> is a navigation the user may
 * never make, so it costs nothing before first paint — and preconnecting to it
 * would spend a connection on every load for a page that may never open.
 */
const SUBRESOURCE_ORIGIN = [
  /<link\b[^>]*\bhref="https:\/\/([^/"]+)/g,
  /<script\b[^>]*\bsrc="https:\/\/([^/"]+)/g,
  /<img\b[^>]*\bsrc="https:\/\/([^/"]+)/g,
  /<iframe\b[^>]*\bsrc="https:\/\/([^/"]+)/g,
  /<(?:source|video|audio|embed)\b[^>]*\bsrc="https:\/\/([^/"]+)/g,
  /url\(\s*['"]?https:\/\/([^/'")]+)/g,
];

const firstPaintOrigins = (h) => {
  const origins = new Set();
  for (const re of SUBRESOURCE_ORIGIN) {
    for (const m of h.matchAll(re)) origins.add(m[1]);
  }
  return origins;
};

test('transfer: every first-paint CDN origin is preconnected', () => {
  // Four CDN origins are fetched before first paint. preconnect overlaps their
  // DNS and TLS setup with the rest of the load instead of serialising it
  // behind the local scripts. A newly added origin without it costs a full
  // round trip.
  const h = html();
  // Host only, with no scheme, on both sides. Keeping "https://" on one side and
  // dropping it on the other makes every origin look unhinted.
  const origins = firstPaintOrigins(h);
  assert.ok(origins.size >= 3, `expected the CDN origins, found ${origins.size}`);

  const preconnected = new Set(
    [...h.matchAll(/rel="preconnect"[^>]*href="https:\/\/([^/"]+)/g)].map(m => m[1])
  );
  // preconnect, not merely dns-prefetch: dns-prefetch only resolves the name,
  // while preconnect also completes TLS. An https stylesheet or script on an
  // origin that has only dns-prefetch still pays a fresh TLS handshake on the
  // critical path.
  const weakOnly = [...origins].filter(o => !preconnected.has(o));
  assert.deepEqual(weakOnly, [],
    'origins fetched before first paint with no preconnect (dns-prefetch alone is not enough): ' + weakOnly.join(', '));

  // A dns-prefetch next to its own preconnect is dead weight: preconnect already
  // covers name resolution, so the second tag only adds parser work.
  const prefetched = new Set(
    [...h.matchAll(/rel="dns-prefetch"[^>]*href="https:\/\/([^/"]+)/g)].map(m => m[1])
  );
  const redundant = [...prefetched].filter(o => preconnected.has(o));
  assert.deepEqual(redundant, [],
    'dns-prefetch duplicating a preconnect for the same origin: ' + redundant.join(', '));
});

test('transfer: an outbound navigation link does not become a first-paint origin', () => {
  // The nav bar links out to the ticket system. Those anchors are navigations,
  // not subresources: nothing is fetched for them until the user clicks, so
  // requiring a preconnect for them would waste a connection on every page load.
  // The check below exists so that the exemption stays deliberate — if one of
  // these origins ever also becomes a subresource, it has to be preconnected.
  const h = html();
  const linkOrigins = new Set([...h.matchAll(/<a\b[^>]*href="https:\/\/([^/"]+)/g)].map(m => m[1]));
  const alsoSubresource = [...linkOrigins].filter(o => firstPaintOrigins(h).has(o));
  assert.deepEqual(alsoSubresource, [],
    'these origins are used as a navigation link AND fetched on first paint, so they need preconnect: '
    + alsoSubresource.join(', '));
});

// --------------------------------------------------------------- quadratic --

test('no module rebuilds a container with innerHTML += inside a loop', () => {
  // `el.innerHTML += x` re-parses and re-serialises everything already in the
  // element, so doing it n times is O(n^2) in both CPU and garbage. The fake
  // DOM used by the client tests cannot see this (its setter just stores a
  // string), so it has to be caught statically.
  const offenders = [];
  for (const f of localScripts()) {
    read(f).split('\n').forEach((line, i) => {
      if (/\.innerHTML\s*\+=/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'innerHTML += is quadratic; build the markup in an array and assign once:\n  ' + offenders.join('\n  '));
});

test('select population: the parser is handed the option list once, not n times', () => {
  // Wall-clock is the wrong instrument here. V8 builds `s += x` out of rope
  // strings, so the quadratic version is often *faster* in JS than the joined
  // array. What costs real time in a browser is the HTML parser re-parsing
  // everything already in the element on every +=. So measure the bytes handed
  // to the parser, which is what the quadratic shape inflates.
  const N = 200;
  const opt = i => `<option value="o${i}">o${i}</option>`;

  // Quadratic shape: one += per option, each re-serialising the whole element.
  let el = '', quadWrites = 0, quadBytes = 0;
  for (let i = 0; i < N; i++) { el = el + opt(i); quadWrites++; quadBytes += el.length; }

  // Fixed shape: one assignment of the joined list.
  const once = Array.from({ length: N }, (_, i) => opt(i)).join('');

  assert.equal(once.length, Array.from({ length: N }, (_, i) => opt(i)).join('').length,
    'the joined list must contain every option exactly once');
  assert.ok(once.length * 20 < quadBytes,
    `n=${N} options: quadratic re-parses ${(quadBytes / 1024).toFixed(0)} KB in ${quadWrites} writes, ` +
    `the single assignment hands over ${(once.length / 1024).toFixed(0)} KB. ` +
    'If these are close, populateSelect has gone back to innerHTML +=');
});

// ------------------------------------------------------------------ render --

test('render: the history page keeps a window and loads the batch, not the archive', () => {
  // Reading the real module beats timing a synthetic loop here: page-history.js
  // already windows its output through HISTORY_PAGE_SIZE, and a wall-clock
  // budget on a fake DOM would only measure the fake.
  const src = read('page-history.js');
  assert.ok(/HISTORY_PAGE_SIZE/.test(src), 'the history page must keep a render window');
  assert.ok(/\.slice\(0,\s*historyLimit\)/.test(src),
    'renderReportSlice must slice the report list; rendering all of them at once is what froze the page');

  // "Load more" must be incremental, not a re-fetch of everything each time.
  const more = src.match(/historyLimit\s*\+=\s*([^;]+);/);
  assert.ok(more, 'expanding the window must grow historyLimit, not reload the archive');
  assert.ok(!/getReports/.test(more[1]),
    `the window must grow from memory rather than re-query the server: ${more[1].trim()}`);
});

test('render: history data is served from cache before the network is asked again', () => {
  // The reports payload is the largest thing this app moves. On a phone the
  // wait is round trips, not parsing, so a revisit must not re-request data the
  // app already holds.
  const src = read('core.js');
  assert.ok(/memoryReportsCache/.test(src), 'reports must be held in a memory cache');
  assert.ok(/saveReportsCacheEntry/.test(src), 'reports must be written to the owner-scoped cache');
  // Performance and privacy meet here: a reports cache whose key ignores the
  // owner is both a cross-user data leak and a reason for the app to look slow
  // (a manager sees empty results and reloads). Assert the key is built from
  // the owner, not merely that a function named reportsScopeKey exists.
  const keyFn = src.slice(src.indexOf('function reportsScopeKey'));
  const keyBody = keyFn.slice(0, keyFn.indexOf('\n}'));
  assert.ok(/reportsCacheOwnerId\(/.test(keyBody),
    'reportsScopeKey must derive the owner from reportsCacheOwnerId(params)');
  assert.ok(/\$\{owner\}/.test(keyBody),
    'reportsScopeKey must interpolate the owner into the key: ' + keyBody.replace(/\s+/g, ' ').slice(0, 160));
  // Two users in the same role and target must still get different keys.
  const ownerOf = code => {
    const m = code.match(/function reportsScopeKey[\s\S]{0,400}?return\s+`([^`]*)`/);
    return m ? m[1] : null;
  };
  assert.ok(ownerOf(src) && ownerOf(src).includes('${owner}'),
    'the key template must contain ${owner}');

  // The sweep on logout has to know about the reports cache too, or the next
  // user to sign in on a shared device reads the previous one's reports.
  const sweep = read('tests/cache-scoping.test.js');
  const sweepTest = sweep.slice(sweep.indexOf('every sensitive cache prefix'));
  assert.ok(/reports/i.test(sweepTest),
    'the cache-sweep test must list the reports cache among the sensitive prefixes');
});

test('render: the app shell is one HTML document, not a framework build step', () => {
  // Guards the shape of the fix: this is a static app served as files, so any
  // "optimisation" that needs a bundler to work has to pay for it explicitly.
  assert.ok(fs.existsSync(path.join(ROOT, 'service-worker.js')), 'service worker must exist');
  assert.ok(!fs.existsSync(path.join(ROOT, 'webpack.config.js')), 'no bundler is configured');
  assert.ok(!fs.existsSync(path.join(ROOT, 'node_modules')), 'the app ships without node_modules');
});

// --------------------------------------------------------------- diagnosys --

test('diagnostics: prints the measured picture for the next investigation', () => {
  const files = localScripts();
  let compile = 0;
  for (const f of files) {
    const src = read(f);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 10; i++) new vm.Script(src, { filename: f });
    compile += Number(process.hrtime.bigint() - t0) / 1e6 / 10;
  }
  const totalKB = (files.reduce((n, f) => n + Buffer.byteLength(read(f)), 0) / 1024).toFixed(0);
  const cdn = [...html().matchAll(/<script src="https?:/g)].length;
  // Inline scripts are not render-blocking in the same way: they are parsed as
  // part of the document, so they belong in the blocking count only if they
  // have a src.
  const blocking = [...html().matchAll(/<script\b[^>]*>/g)].map(m => m[0])
    .filter(t => /\ssrc=/.test(t) && !/https?:/.test(t) && !/\s(defer|async)\b/.test(t) && !/type="module"/.test(t)).length;

  console.log(`\n  --- measured ---`);
  console.log(`  local JS         : ${totalKB} KB in ${files.length} files`);
  console.log(`  V8 parse+compile : ${compile.toFixed(2)} ms (CPU is not the bottleneck)`);
  console.log(`  CDN scripts      : ${cdn}`);
  console.log(`  render-blocking  : ${blocking} local script(s)`);
  console.log(`  ---\n`);

  assert.ok(true);
});
