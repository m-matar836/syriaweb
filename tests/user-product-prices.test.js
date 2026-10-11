'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, asUser, DEFAULT_DATA } = require('./helpers/load-code');

const setup = () => loadCode({ data: DEFAULT_DATA });
const getPersonalPrices = user => {
  const result = user.get('getUserProductPrices');
  assert.equal(result.status, 'success');
  return result.prices;
};

const getPrice = (prices, campaign = 'حملة', product = 'منتج') =>
  prices.find(p => p.campaign === campaign && p.product === product)?.price;

test('first-time user price list is empty and uses Products defaults without creating shared overrides', () => {
  const runtime = setup();
  const user = asUser(runtime, 'user1', 'pw-user1');
  assert.deepEqual(getPersonalPrices(user), []);
  const master = runtime.env._spreadsheet.getSheetByName('Products').getRange(2, 3).getValue();
  assert.equal(master, 100);
  assert.equal(runtime.env._spreadsheet.getSheetByName('UserProductPrices'), null,
    'a read-only first visit should not create the personal-price sheet');
});

test('personal prices are isolated per authenticated user and do not change Products', () => {
  const runtime = setup();
  const userOne = asUser(runtime, 'user1', 'pw-user1');
  const userTwo = asUser(runtime, 'user2', 'pw-user2');

  const savedOne = userOne.post('saveUserProductPrice', {
    campaign: 'حملة', product: 'منتج', barcode: '111', price: 77,
  });
  assert.equal(savedOne.status, 'success');
  assert.equal(getPrice(getPersonalPrices(userOne)), 77);
  assert.deepEqual(getPersonalPrices(userTwo), []);

  const savedTwo = userTwo.post('saveUserProductPrice', {
    campaign: 'حملة', product: 'منتج', barcode: '111', price: 55,
  });
  assert.equal(savedTwo.status, 'success');
  assert.equal(getPrice(getPersonalPrices(userOne)), 77);
  assert.equal(getPrice(getPersonalPrices(userTwo)), 55);

  const master = runtime.env._spreadsheet.getSheetByName('Products').getRange(2, 3).getValue();
  assert.equal(master, 100, 'personal edits must never rewrite the shared master price');
});

test('submitting report prices seeds the authenticated user prices only', () => {
  const runtime = setup();
  const userOne = asUser(runtime, 'user1', 'pw-user1');
  const userTwo = asUser(runtime, 'user2', 'pw-user2');

  runtime.evalIn(`saveUserProductPricesFromReport_({campaign:'حملة',sales:[{product:'منتج',price:42,quantity:2}]}, 'E003')`);

  assert.equal(getPrice(getPersonalPrices(userOne)), 42);
  assert.deepEqual(getPersonalPrices(userTwo), []);
  assert.equal(runtime.env._spreadsheet.getSheetByName('Products').getRange(2, 3).getValue(), 100);
});

test('submitReport saves personal prices for the authenticated account, ignoring a spoofed userId', () => {
  const data = Object.assign({}, DEFAULT_DATA, {
    Reports: [['id', 'campaign', 'market', 'date', 'event', 'notes', 'createdById', 'createdByName']],
    sales: [['id', 'product', 'price', 'quantity']],
    salesOfCompetitor: [['id', 'product', 'price', 'quantity']],
    expenses: [['id', 'item', 'quantity']],
    promoters: [['id', 'name', 'reportId']],
  });
  const runtime = loadCode({ data });
  const userOne = asUser(runtime, 'user1', 'pw-user1');
  const userTwo = asUser(runtime, 'user2', 'pw-user2');

  const result = userOne.post('submitReport', {
    id: 'R-PRICE-OWNER', campaign: 'حملة', market: 'السوق', date: '2026-10-11',
    event: 'حدث', notes: '', userId: 'E004', createdById: 'E004',
    sales: [{ product: 'منتج', price: 64, quantity: 2 }],
    salesOfCompetitor: [], expenses: [], promoters: [],
  });

  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(getPrice(getPersonalPrices(userOne)), 64,
    'the price must be attached to the authenticated E003 account, not the spoofed E004');
  assert.deepEqual(getPersonalPrices(userTwo), []);
  assert.equal(runtime.env._spreadsheet.getSheetByName('Products').getRange(2, 3).getValue(), 100,
    'report submission must leave the shared default price unchanged');
});

test('different campaigns keep separate personal product prices', () => {
  const runtime = setup();
  const user = asUser(runtime, 'user1', 'pw-user1');
  user.post('saveUserProductPrice', { campaign: 'حملة', product: 'منتج', price: 25 });
  user.post('saveUserProductPrice', { campaign: 'حملة خاصة', product: 'منتج', price: 35 });

  const prices = getPersonalPrices(user);
  assert.equal(getPrice(prices, 'حملة', 'منتج'), 25);
  assert.equal(getPrice(prices, 'حملة خاصة', 'منتج'), 35);
});


test('direct promotion-and-sale report does not overwrite personal event prices', () => {
  const runtime = setup();
  const user = asUser(runtime, 'user1', 'pw-user1');

  const saved = runtime.evalIn(`saveUserProductPricesFromReport_({campaign:'حملة', event:'ترويج وبيع مباشر', sales:[{product:'منتج',price:42,quantity:2}]}, 'E003')`);

  assert.equal(saved, 0, 'direct sale amounts must stay in the report, not become personal defaults');
  assert.deepEqual(getPersonalPrices(user), []);
  assert.equal(runtime.env._spreadsheet.getSheetByName('Products').getRange(2, 3).getValue(), 100,
    'the shared Products price remains unchanged');
  assert.equal(runtime.env._spreadsheet.getSheetByName('UserProductPrices'), null,
    'a direct-sale-only report does not create personal pricing records');
});
