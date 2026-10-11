'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadClient, ROOT } = require('./helpers/load-client');

const client = loadClient('page-reports.js', {
  setup(sandbox) {
    sandbox.registerView = () => {};
  },
});

test('direct promotion-and-sale event always reads the shared Products price', () => {
  assert.equal(client.evalIn("resolveReportSalePrice('ترويج وبيع مباشر', 100, 42)"), 100);
  assert.equal(client.evalIn("resolveReportSalePrice('ترويج وبيع مباشر', 0, 42)"), 0,
    'zero is a valid shared price and does not fall through to a personal price');
});

test('all other event types use personal price, falling back to Products for first use', () => {
  assert.equal(client.evalIn("resolveReportSalePrice('ترويج مولات', 100, 42)"), 42);
  assert.equal(client.evalIn("resolveReportSalePrice('ترويج مولات', 100, undefined)"), 100);
  assert.equal(client.evalIn("resolveReportSalePrice('حدث آخر', 100, 0)"), 0,
    'zero remains a valid personal price');
});

test('personal price network request does not block rendering the report page', () => {
  const source = fs.readFileSync(path.join(ROOT, 'page-reports.js'), 'utf8');
  assert.doesNotMatch(source, /await\s+userProductPricesRequest/);
  assert.match(source, /userProductPricesRequest\.then\(userPricesResponse\s*=>/,
    'server prices must apply after the form can render');
  assert.match(source, /refreshUneditedNewSaleRows\(\)/,
    'picker/scanner rows added while the request is pending get the resolved price');
});

test('direct-sale price edits are not posted as personal prices', () => {
  const source = fs.readFileSync(path.join(ROOT, 'page-reports.js'), 'utf8');
  const start = source.indexOf('const updateUserProductPrice = async (row) => {');
  assert.notEqual(start, -1);
  const block = source.slice(start, source.indexOf('const scheduleUserProductPriceUpdate', start));
  assert.match(block, /if\s*\(isDirectSaleEvent\(\)\s*\|\|/);
});
