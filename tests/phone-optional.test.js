'use strict';
// ===================================================================
// The shop phone number must be optional — permanently.
//
// It used to be required for one event type ("ترويج وبيع غير مباشر"), enforced
// server-side only. The client markup never asked for it, so the field looked
// optional, the browser let you submit it empty, and the save was then rejected
// with an error nobody could connect back to the field that caused it. Keeping it
// permanently optional means removing that hidden rule and leaving no path —
// client or server — that can quietly reintroduce it.
// ===================================================================

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, asUser, DEFAULT_DATA } = require('./helpers/load-code');
const { ROOT } = require('./helpers/load-client');

const DATA_WITH_REPORTS = Object.assign({}, DEFAULT_DATA, {
  Reports: [
    ['id', 'campaign', 'market', 'date', 'event', 'notes', 'createdById',
      'createdByName', 'approvalStatus', 'barcode', 'phoneNumber'],
    ['R-EXISTING', 'حملة', 'سوق', '2026-01-01', 'حدث', 'ملاحظة', 'E003',
      'موظف أول', 'pending', '1111', '0999999999'],
  ],
  sales: [['id', 'product', 'price', 'quantity'], [1, 'منتج', 100, 2]],
  expenses: [['id', 'item', 'quantity'], [1, 'بند', 1]],
  promoters: [['id', 'name'], [1, 'مروج']],
});

const setup = () => loadCode({ data: DATA_WITH_REPORTS });

const reportBody = (id, event, extra = {}) => Object.assign({
  id, campaign: 'حملة', market: 'سوق', date: '2026-03-01',
  event, notes: 'ملاحظة',
}, extra);

function readRow(L, id) {
  const sheet = L.env._spreadsheet.getSheetByName('Reports');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  const row = rows.find(r => String(r[0]) === String(id));
  assert.ok(row, 'report ' + id + ' must exist in the sheet');
  return Object.fromEntries(headers.map((h, i) => [String(h), row[i]]));
}

test('server: a report saves with no phone number for the event that used to require it', () => {
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');
  const res = u.post('submitReport', reportBody('R-NOPHONE-1', 'ترويج وبيع غير مباشر'));
  assert.equal(res.status, 'success',
    'phone must not be required: ' + JSON.stringify(res.message || res));
  assert.equal(String(readRow(env, 'R-NOPHONE-1').phoneNumber || ''), '',
    'an omitted phone is stored as empty, not as the word "undefined"');
});

test('server: it is optional for every event type, not just the relaxed one', () => {
  // A per-event rule is how this came back in the first place. Any event, no
  // phone, must save.
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');
  ['ترويج وبيع مباشر', 'ترويج وبيع غير مباشر', 'انشاء نقطة', 'جرد', 'حدث'].forEach((event, i) => {
    const res = u.post('submitReport', reportBody('R-EVT-' + i, event));
    assert.equal(res.status, 'success',
      '"' + event + '" must not require a phone: ' + JSON.stringify(res.message));
  });
});

test('server: no server-side code turns a missing phone number into an error', () => {
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const offending = src.split('\n').findIndex(line =>
    /phoneNumber/.test(line) && /throw|Error\(/.test(line));
  assert.equal(offending, -1,
    offending === -1 ? '' : 'Code.gs:' + (offending + 1) + ' throws on the phone: ' + src.split('\n')[offending].trim());
  assert.ok(!/!\s*phoneNumber\s*\)?\s*(\)|&&)?[^\n]*throw/.test(src),
    'a missing phoneNumber must never become a rejection');
});

test('server: a whitespace-only phone is treated as absent, not saved as junk', () => {
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');
  const res = u.post('submitReport', reportBody('R-WS-1', 'ترويج وبيع غير مباشر', { phoneNumber: '   ' }));
  assert.equal(res.status, 'success');
  assert.equal(String(readRow(env, 'R-WS-1').phoneNumber || ''), '',
    'spaces must not be stored as a phone number');
});

test('server: a phone number that WAS given is still stored', () => {
  // Optional must not become discarded.
  const env = setup();
  const u = asUser(env, 'user1', 'pw-user1');
  const res = u.post('submitReport', reportBody('R-PHONE-1', 'ترويج وبيع غير مباشر',
    { phoneNumber: '0912345678' }));
  assert.equal(res.status, 'success', JSON.stringify(res.message));
  assert.equal(String(readRow(env, 'R-PHONE-1').phoneNumber || ''), '0912345678',
    'a phone number that WAS given must survive the save');
});

test('server: the Reports sheet still has a phoneNumber column', () => {
  // Without the column the value would silently vanish, and "optional" would
  // quietly mean "discarded" instead.
  const L = setup();
  const sheet = L.env._spreadsheet.getSheetByName('Reports');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  assert.ok(headers.includes('phoneNumber'),
    'phoneNumber column missing from Reports: ' + headers.join(', '));
});

test('client: the input carries no required attribute', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tag = /<input[^>]*\bid="phoneNumber"[^>]*>/.exec(html);
  assert.ok(tag, 'index.html must still contain the phoneNumber input');
  assert.ok(!/\brequired\b/.test(tag[0]), 'the input must not be required: ' + tag[0]);
  assert.ok(!/aria-required\s*=\s*"true"/.test(tag[0]),
    'aria-required="true" would tell assistive tech it is mandatory');
});

test('client: no live code marks the field required or invalid', () => {
  const src = fs.readFileSync(path.join(ROOT, 'page-reports.js'), 'utf8');
  const live = src.replace(/^\s*\/\/.*$/gm, '');
  // The old helper was commented out rather than deleted. Commented-out code
  // still reads as intent, and it is one keystroke from coming back.
  assert.ok(!/updatePhoneNumberRequirement/.test(live),
    'a live phone-requirement helper is still present in page-reports.js');
  assert.ok(!/phoneInput\.required\s*=/.test(live),
    'page-reports.js must never set required on the phone input');
  assert.ok(!/phoneNumber[^\n]*setCustomValidity/.test(live),
    'the phone input must not carry custom validity');
  assert.ok(!/phoneNumber[^\n]*\.required\s*=\s*(true|required)/.test(live),
    'the phone input must never be flagged required');
});
