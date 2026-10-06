'use strict';
// ===============================================================
// load-code.js
// Evaluates Code.gs inside a vm context wired to the Apps Script mocks,
// so tests can call the real server functions directly.
// ===============================================================

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createGasEnv } = require('./gas-mock');

const CODE_GS = path.join(__dirname, '..', '..', 'Code.gs');

// Default sheet fixtures. Override per-test by passing { data }.
const DEFAULT_DATA = {
  Employees: [
    ['id', 'name', 'username', 'password', 'role', 'jobPosition', 'mgr'],
    ['E001', 'المدير العام', 'admin1', 'pw-admin', 'admin', 'مدير عام', ''],
    ['E002', 'مدير الفرع', 'mgr1', 'pw-mgr', 'manager', 'منسق نقاط', 'المدير العام'],
    ['E003', 'موظف أول', 'user1', 'pw-user1', 'user', 'مسؤول جرد', 'مدير الفرع'],
    ['E004', 'موظف ثاني', 'user2', 'pw-user2', 'user', 'منسق نقطة', 'مدير الفرع'],
    ['E005', 'موظف ثالث', 'user3', 'pw-user3', 'user', 'مروج', 'مدير الفرع'],
    ['E006', 'موظف رابع', 'user4', 'pw-user4', 'user', 'مسؤول جرد', 'موظف أول'],
  ],
  Locations: [
    ['gov', 'region', 'market'],
    ['محافظة', 'المنطقة', 'السوق'],
  ],
  Products: [
    ['campaign', 'name', 'price', 'company', 'barcode', 'category', 'cancelled'],
    ['حملة', 'منتج', 100, 'شركة', '111', 'تصنيف', ''],
  ],
  ProductsOfCompetitor: [['name', 'price'], ['منتج منافس', 90]],
  ExpenseItems: [['name'], ['بند']],
};

const source = fs.readFileSync(CODE_GS, 'utf8');

/**
 * Load Code.gs with the given sheet fixtures.
 * @param {object} [opts]
 * @param {object} [opts.data]  sheet name -> 2D array
 * @param {object} [opts.now]   fixed timestamp for Date.now
 * @returns {{env: object, code: object, env_: object}}
 */
function loadCode(opts = {}) {
  const env = createGasEnv(opts.data || DEFAULT_DATA);
  const sandbox = Object.assign(Object.create(null), env, {
    console,
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Boolean,
    RegExp,
    Error,
    TypeError,
    RangeError,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    Lock: class Lock { lock() { return this; } tryLock() { return true; } releaseLock() {} },
  });

  if (opts.now) {
    const fixed = opts.now;
    const RealDate = Date;
    const MockDate = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixed);
        else super(...args);
      }
      static now() { return fixed; }
    };
    sandbox.Date = MockDate;
  }

  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: 'Code.gs' }).runInContext(context);

  // Top-level `const`/`let` live in the script's lexical scope and are NOT
  // exposed on the sandbox object, so provide an explicit evaluator.
  const evalIn = (expr) => vm.runInContext(String(expr), context);

  return { env, code: sandbox, context, evalIn };
}

/**
 * Call the real doPost entry point with a JSON body.
 * Note: Code.gs reads e.postData.contents.
 */
function post(loadResult, action, payload) {
  const res = loadResult.code.doPost({
    postData: { contents: JSON.stringify({ action, payload }) },
  });
  return JSON.parse(res.getContent());
}

/**
 * Call the real doGet entry point.
 */
function get(loadResult, action, params = {}) {
  const res = loadResult.code.doGet({ parameter: Object.assign({ action }, params) });
  return JSON.parse(res.getContent());
}

/**
 * Log in as a given username/password and return the parsed response.
 * Also returns the session token + csrf token for follow-up calls.
 */
function loginAs(loadResult, username, password) {
  const body = post(loadResult, 'doLogin', { username, password });
  if (body.status !== 'success') {
    throw new Error('login failed for ' + username + ': ' + body.message);
  }
  return { token: body.token, csrfToken: body.csrfToken, user: body.user, body };
}

/**
 * Log in and return an object with helpers bound to that session.
 */
function asUser(loadResult, username, password) {
  const session = loginAs(loadResult, username, password);
  return {
    ...session,
    get: (action, params = {}) => get(loadResult, action,
      Object.assign({ token: session.token, csrfToken: session.csrfToken }, params)),
    post: (action, payload = {}) => post(loadResult, action,
      Object.assign({ token: session.token, csrfToken: session.csrfToken }, payload)),
  };
}

module.exports = { loadCode, loginAs, asUser, get, post, DEFAULT_DATA, CODE_GS };
