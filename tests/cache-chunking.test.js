// Regression cover for the reason the site felt slow.
//
// `getInitialData` is the payload every single page load depends on: the login
// screen, the employee list, every product dropdown, every barcode lookup. It
// reads five sheets and caches the result in CacheService.
//
// CacheService allows ~100 KB per item and THROWS above that. At festival
// scale the payload is several hundred KB, so the cache write threw and every
// page load rebuilt all five sheets from scratch. Nothing looked broken; it was
// just permanently the slow path.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCode, DEFAULT_DATA } = require('./helpers/load-code');

const ROOT = path.resolve(__dirname, '..');

/** Rows shaped like the real sheets, big enough to blow the cache limit. */
function festivalSizedData() {
  const data = JSON.parse(JSON.stringify(DEFAULT_DATA));
  const rows = (n, headers, make) => {
    const out = [headers];
    for (let i = 0; i < n; i++) out.push(make(i));
    return out;
  };
  data.Products = rows(3000,
    ['campaign', 'name', 'price', 'company', 'barcode', 'category', 'cancelled'],
    (i) => ['حملة' + (i % 20), 'منتج ' + i, 100 + i, 'شركة', '1000' + i, 'تصنيف' + (i % 10), '']);
  data.ProductsOfCompetitor = rows(1000, ['name', 'price'],
    (i) => ['منتج منافس ' + i, 90 + i]);
  data.Employees = rows(400,
    ['id', 'name', 'username', 'password', 'role', 'jobPosition', 'mgr'],
    (i) => ['E' + i, 'موظف ' + i, 'u' + i, 'pw', i === 0 ? 'admin' : 'user', 'منسق', 'مدير']);
  data.Locations = rows(300, ['gov', 'region', 'market'],
    (i) => ['محافظة ' + (i % 10), 'منطقة ' + (i % 30), 'سوق ' + i]);
  data.ExpenseItems = rows(200, ['name'], (i) => ['بند ' + i]);
  return data;
}

function countSheetReads(env) {
  return (env._spreadsheet._reads || []).filter((n) =>
    ['Locations', 'Products', 'ProductsOfCompetitor', 'Employees', 'ExpenseItems'].includes(n)).length;
}

test('initial data over 100 KB is still cached, not thrown away', () => {
  const { code, env } = loadCode({ data: festivalSizedData() });
  const payload = JSON.stringify(code.getInitialData(false));
  assert.ok(payload.length > 100 * 1024,
    'fixture must actually exceed the cache limit, else this test proves nothing');

  // Must not throw, and must actually be there on the second read.
  const first = code.getInitialData(false);
  const second = code.getInitialData(false);
  assert.deepEqual(second, first, 'the cached copy must match the built copy');
});

test('a large first build is served from cache on the next call, with zero sheet reads', () => {
  const { code, env } = loadCode({ data: festivalSizedData() });

  code.getInitialData(false);
  const readsAfterBuild = countSheetReads(env);
  assert.ok(readsAfterBuild > 0, 'the first call must read the sheets');

  env._spreadsheet._reads.length = 0;
  const cached = code.getInitialData(false);

  assert.equal(countSheetReads(env), 0,
    'the second call must not touch a single sheet — that was the whole slowness');
  assert.ok(cached && cached.locations && cached.products,
    'and it must still return usable data');
});

test('the small case keeps working and stays a single cheap read', () => {
  const { code, env } = loadCode();
  code.getInitialData(false);
  env._spreadsheet._reads.length = 0;
  const second = code.getInitialData(false);
  assert.equal(countSheetReads(env), 0, 'the default fixture must be cached too');
  // Compared through JSON because that IS the cache round-trip: `undefined`
  // array slots become `null` on the way through the cache. Pre-existing,
  // harmless, and not what this file is about.
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(code.getInitialData(false))));
  assert.ok(second.employees && second.employees.length, 'employees must survive the round-trip');
});

test('no single cache entry ever exceeds the 100 KB service limit', () => {
  const { code, env } = loadCode({ data: festivalSizedData() });
  code.getInitialData(false);

  const cache = env._scriptCache._map;
  let biggest = 0;
  for (const [key, value] of cache) {
    if (!key.startsWith('initialData')) continue;
    biggest = Math.max(biggest, String(value).length);
  }
  assert.ok(biggest > 0, 'initial data must actually be in the cache');
  assert.ok(biggest <= 100 * 1024,
    'largest cache entry was ' + biggest + ' bytes, over the service limit');
});

test('forcing a refresh re-reads the sheets once, then caches again', () => {
  const { code, env } = loadCode({ data: festivalSizedData() });
  code.getInitialData(false);

  env._spreadsheet._reads.length = 0;
  code.getInitialData(true);
  assert.ok(countSheetReads(env) > 0, 'forceRefresh must actually rebuild');

  env._spreadsheet._reads.length = 0;
  const again = code.getInitialData(false);
  assert.equal(countSheetReads(env), 0, 'and the rebuild must be cacheable again');
  assert.ok(again && again.locations);
});

test('stale chunks from a previous payload cannot leak into the new one', () => {
  const { code, env } = loadCode({ data: festivalSizedData() });
  code.getInitialData(false);

  const staleKeys = [...env._scriptCache._map.keys()].filter(k => k.startsWith('initialData'));
  assert.ok(staleKeys.length > 0);

  // Simulate a shrink, then a rebuild: fewer chunks must be written and the
  // leftovers purged, or a removed product comes back from the dead.
  env._spreadsheet._data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    const shrunk = code.getInitialData(true);
  assert.ok(shrunk && shrunk.locations, 'the small payload must still load');
  const keysAfter = [...env._scriptCache._map.keys()].filter(k => k.startsWith('initialData'));
  const manifest = keysAfter.find(k => /initialData.*chunk/i.test(k) && !/__\d+$/.test(k));
  if (manifest) {
    const count = Number(JSON.parse(env._scriptCache._map.get(manifest)));
    const chunks = keysAfter.filter(k => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '__\\d+$').test(k));
    assert.equal(chunks.length, count,
      'chunk count must match the manifest, no orphans');
  }
});


// --- the reports cache had the identical bug, and it is the one that grows
// without bound: every filed report adds rows to it, forever.

/** Many filed reports with line items, i.e. a real mid-festival spreadsheet. */
function heavyReportData() {
  const data = JSON.parse(JSON.stringify(DEFAULT_DATA));
  const N = 700;
  const headers = ['id', 'userName', 'campaign', 'market', 'date', 'deletedAt'];
  data.Reports = [headers];
  data.sales = [['id', 'product', 'price', 'quantity']];
  data.salesOfCompetitor = [['id', 'product', 'price', 'quantity']];
  data.expenses = [['id', 'item', 'quantity']];
  data.promoters = [['id', 'name']];
  for (let i = 0; i < N; i++) {
    data.Reports.push(['R' + i, 'موظف ' + (i % 40), 'حملة' + (i % 20), 'سوق' + (i % 30), '2026-06-01', '']);
    for (let k = 0; k < 4; k++) data.sales.push(['R' + i, 'منتج ' + k, 10 + k, 3]);
    for (let k = 0; k < 2; k++) data.salesOfCompetitor.push(['R' + i, 'منافس ' + k, 12 + k, 2]);
    for (let k = 0; k < 2; k++) data.expenses.push(['R' + i, 'بند ' + k, 1]);
    data.promoters.push(['R' + i, 'مروج ' + (i % 12)]);
  }
  return data;
}

test('a report history over 100 KB is still cached, and rebuilt zero times after', () => {
  const { code, env } = loadCode({ data: heavyReportData() });
  const first = code.getReports('E001', 'admin', 'ADMIN', '');
  assert.ok(first.length > 100, 'fixture must produce a real report list');

  const bytes = JSON.stringify(first).length;
  assert.ok(bytes > 100 * 1024,
    'payload must exceed the cache limit (' + bytes + ' bytes) or this proves nothing');

  env._spreadsheet._reads.length = 0;
  const second = code.getReports('E001', 'admin', 'ADMIN', '');
  assert.equal(env._spreadsheet._reads.length, 0,
    'the second read must not re-read Reports+sales+expenses+promoters');
  assert.equal(second.length, first.length, 'and must return the same history');
});

test('a deleted report is not resurrected from a stale reports cache', () => {
  const data = heavyReportData();
  const { code, env } = loadCode({ data });
  const before = code.getReports('E001', 'admin', 'ADMIN', '');
  assert.ok(before.length > 0);

  // Soft-delete one report, then let the cache be invalidated the way the app does.
  const sheet = env._spreadsheet.getSheetByName('Reports');
  sheet.getRange(2, 6, before.length, 1).setValues(before.map(r => [String(Date.now())]));
  code.refreshCache();

  const after = code.getReports('E001', 'admin', 'ADMIN', '');
  assert.equal(after.length, 0,
    'deleted reports must not come back out of the cache');
});
