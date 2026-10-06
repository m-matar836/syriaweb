'use strict';
// ===============================================================
// gas-mock.js
// A dependency-free in-memory implementation of the Google Apps Script
// services used by Code.gs. Enough surface to unit test business logic
// (permissions, salary advances, attendance) without network or Sheets.
// ===============================================================

const crypto = require('node:crypto');

class GasRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  _clone(v) {
    return v instanceof Date ? new Date(v.getTime()) : v;
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        row.push(this._clone(this.sheet._cell(this.row + r, this.col + c)));
      }
      out.push(row);
    }
    return out;
  }

  getDisplayValues() {
    return this.getValues().map(r => r.map(v => (v === null || v === undefined ? '' : String(v))));
  }

  getValue() {
    return this.sheet._cell(this.row, this.col);
  }

  setValue(v) {
    this.sheet._set(this.row, this.col, v);
    return this;
  }

  setValues(values) {
    for (let r = 0; r < values.length; r++) {
      const row = values[r] || [];
      for (let c = 0; c < row.length; c++) {
        this.sheet._set(this.row + r, this.col + c, row[c]);
      }
    }
    return this;
  }

  getLastRow() {
    return this.sheet.getLastRow();
  }

  clear() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.sheet._set(this.row + r, this.col + c, '');
    }
    return this;
  }

  clearContent() {
    return this.clear();
  }

  // Apps Script spells it both ways depending on which object is used, so the
  // mock has to answer both or a real code path looks broken under test.
  clearContents() {
    return this.clear();
  }

  setNumberFormat(fmt) {
    this.sheet._numberFormat = fmt;
    return this;
  }

  getNumberFormat() {
    return this.sheet._numberFormat || 'General';
  }

  setFont() { return this; }
  setBackground() { return this; }
  setHorizontalAlignment() { return this; }
  setVerticalAlignment() { return this; }
  setWrap() { return this; }
  setBorder() { return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  merge() { return this; }
  setFormula() { return this; }
  clearFormat() { return this; }
  sort() { return this; }
  setNotes() { return this; }
}

class GasSheet {
  constructor(spreadsheet, name, data) {
    this.spreadsheet = spreadsheet;
    this._name = name;
    this._data = Array.isArray(data) ? data.map(r => (Array.isArray(r) ? r.slice() : [r])) : [];
    this._frozenRows = 0;
    this._numberFormat = 'General';
    this._columnWidths = {};
  }

  getName() { return this._name; }
  getSheetId() { return this.spreadsheet._nextSheetId++; }
  setFrozenRows(n) { this._frozenRows = n; return this; }
  getFrozenRows() { return this._frozenRows; }
  setColumnWidth() { return this; }
  autoResizeColumns() { return this; }
  setTabColor() { return this; }
  hideColumn() { return this; }
  showColumn() { return this; }
  moveColumn() { return this; }
  setName(n) { this._name = n; return this; }

  _ensure(r, c) {
    while (this._data.length < r) this._data.push([]);
    const row = this._data[r - 1];
    while (row.length < c) row.push('');
  }

  _cell(r, c) {
    if (r < 1 || c < 1) return '';
    const row = this._data[r - 1];
    if (!row) return '';
    const v = row[c - 1];
    return v === undefined ? '' : v;
  }

  _set(r, c, v) {
    this._ensure(r, c);
    this._data[r - 1][c - 1] = v;
  }

  getLastRow() {
    for (let i = this._data.length - 1; i >= 0; i--) {
      const row = this._data[i] || [];
      for (let j = row.length - 1; j >= 0; j--) {
        const v = row[j];
        if (v !== '' && v !== null && v !== undefined) return i + 1;
      }
    }
    return 0;
  }

  getLastColumn() {
    let max = 0;
    for (const row of this._data) {
      for (let j = row.length - 1; j >= 0; j--) {
        const v = row[j];
        if (v !== '' && v !== null && v !== undefined) { max = Math.max(max, j + 1); break; }
      }
    }
    return max;
  }

  getMaxRows() { return Math.max(this._data.length, 1); }
  getMaxColumns() { return Math.max(this.getLastColumn(), 1); }
  getDataRange() {
    // Read tracking. Apps Script read latency is the whole cost model of
    // `getInitialData`, so a test has to be able to prove a payload came from
    // cache rather than from five sheet reads. Recorded on the spreadsheet
    // because that is the single object a test always has a handle on.
    if (!this.spreadsheet._reads) this.spreadsheet._reads = [];
    this.spreadsheet._reads.push(this._name);
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }

  getRange(row, col, numRows, numCols) {
    if (typeof row === 'string') return this._a1(row);
    if (numRows === undefined) return new GasRange(this, row, col, 1, 1);
    if (numCols === undefined) return new GasRange(this, row, col, numRows, 1);
    return new GasRange(this, row, col, numRows, numCols);
  }

  /**
   * Resolve a plain A1 range with no sheet prefix.
   *
   * Code.gs relies on this constantly — `getRange('A2:A').getValues()` to scan the
   * id column is how handleReportSubmission locates a report. Without A1 support
   * the mock silently returned the whole data range instead, so every id lookup
   * failed and the server took the "create new row" path.
   */
  _a1(a1) {
    const text = String(a1).trim().replace(/\$/g, '');
    const colNum = (letters) => {
      let n = 0;
      for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
      return n;
    };
    // Split on ':' FIRST, then parse each end independently. A single regex over
    // the whole string cannot express `A2:A`, where the second end has a column
    // but no row — and that is exactly the range Code.gs uses to find a report.
    const ends = text.split(':');
    const parts = ends.map((end) => {
      const m = /^([A-Za-z]*)(\d*)$/.exec(end);
      if (!m || (!m[1] && !m[2])) return null;
      return { col: m[1] ? colNum(m[1]) : null, row: m[2] ? Number(m[2]) : null };
    });
    if (parts.some((p) => p === null)) return this.getDataRange();

    const first = parts[0];
    const last = parts.length > 1 ? parts[1] : first;
    // An open end means "to the edge of the sheet", which is what A2:A means on
    // the real service. Falling back to the *other* end's row instead made A2:A
    // resolve to the single row A2 — an id scan that only ever saw the first
    // report, so appendRow hid behind it looked like a lost row.
    const lastRow = Math.max(1, this.getLastRow());
    const lastCol = Math.max(1, this.getLastColumn());
    const resolveCol = (p, q) => (p.col !== null ? p.col : (q && q.col !== null ? q.col : 1)) || lastCol;
    const resolveRow = (p) => (p.row !== null ? p.row : lastRow);
    const left = Math.min(resolveCol(first, last), resolveCol(last, first));
    const right = Math.max(resolveCol(first, last), resolveCol(last, first));
    const top = Math.min(resolveRow(first, last), resolveRow(last, first));
    const bottom = Math.max(resolveRow(first, last), resolveRow(last, first));
    return new GasRange(this, top, left, bottom - top + 1, right - left + 1);
  }

  getRangeByA1() { return this.getDataRange(); }

  appendRow(values) {
    this._data.push((values || []).slice());
    return this;
  }

  insertRowAfter() { this._data.push([]); return this; }
  insertRow() { this._data.push([]); return this; }
  deleteRow(index) { this._data.splice(index - 1, 1); return this; }
  deleteRows(start, count) { this._data.splice(start - 1, count); return this; }
  clear() { this._data = []; return this; }
  // Both spellings exist on the real Spreadsheet sheet; addReportDetails calls
  // clearContents(), so a mock missing it makes an unrelated path look broken.
  clearContents() { this._data = []; return this; }
  clearContent() { return this.clearContents(); }
  sort() { return this; }
  setColumnWidths() { return this; }
  getRangeList() { return { clear: () => {} }; }
  duplicate() { return new GasSheet(this.spreadsheet, this._name + ' copy', this._data); }
}

class GasSpreadsheet {
  constructor(data) {
    this._sheets = new Map();
    this._nextSheetId = 1;
    for (const [name, rows] of Object.entries(data || {})) {
      this._sheets.set(name, new GasSheet(this, name, rows));
    }
  }

  getSheetByName(name) { return this._sheets.get(String(name)) || null; }

  getSheets() { return Array.from(this._sheets.values()); }

  insertSheet(name) {
    if (this._sheets.has(name)) throw new Error('Sheet already exists: ' + name);
    const s = new GasSheet(this, name, []);
    this._sheets.set(name, s);
    return s;
  }

  deleteSheet(name) { return this._sheets.delete(String(name)); }
  getName() { return 'MockSpreadsheet'; }
  getId() { return 'mock-spreadsheet-id'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/mock'; }
  setSpreadsheetTimeZone() {}
  getSpreadsheetTimeZone() { return 'Asia/Amman'; }
}

/**
 * Faithful to the real service in the one way that matters: `put` THROWS when
 * the value is over the 100 KB per-item limit. An over-large put is not a
 * silent no-op — the app crashes and nothing is cached. Without this the mock
 * happily stored a 450 KB blob, so `getInitialData` looked perfectly cached in
 * every test while failing to cache in production on every single page load.
 */
class GasCache {
  constructor() { this._map = new Map(); }
  get(key) { return this._map.has(key) ? this._map.get(key) : null; }
  put(key, value, seconds) {
    const size = String(value == null ? '' : value).length;
    if (size > GasCache.MAX_VALUE_BYTES) {
      const err = new Error(
        'CacheService.put() failed: value is ' + size
        + ' bytes, over the ' + GasCache.MAX_VALUE_BYTES + ' byte limit');
      err.name = 'InvalidArgumentError';
      throw err;
    }
    this._map.set(key, value);
    if (seconds) this._map.set(key + ':__exp', Date.now() + seconds * 1000);
    return this;
  }
  remove(key) { this._map.delete(key); this._map.delete(key + ':__exp'); return this; }
  removeAll(keys) { (keys || []).forEach(k => this.remove(k)); return this; }
  _reset() { this._map.clear(); }
}
GasCache.MAX_VALUE_BYTES = 100 * 1024;

class GasProperties {
  constructor() { this._map = new Map(); }
  getProperty(k) { return this._map.has(k) ? this._map.get(k) : null; }
  setProperty(k, v) { this._map.set(k, String(v)); return this; }
  // Real PropertiesService accepts a bulk object. Without it, any code using
  // setProperties() threw here and was swallowed by a caller's try/catch — which
  // is exactly how a version counter can silently never advance in tests.
  setProperties(obj) {
    for (const [k, v] of Object.entries(obj || {})) this._map.set(k, String(v));
    return this;
  }
  deleteProperty(k) { this._map.delete(k); return this; }
  deleteAllProperties() { this._map.clear(); return this; }
  getProperties() { return Object.fromEntries(this._map); }
}

class GasFile {
  constructor(id, name) { this.id = id; this._name = name; this._sharing = null; }
  getName() { return this._name; }
  setName(n) { this._name = n; return this; }
  getId() { return this.id; }
  getUrl() { return 'https://drive.google.com/file/d/' + this.id + '/view'; }
  setSharing(perm, role) { this._sharing = { perm, role }; return this; }
  getSharing() { return this._sharing; }
  makeCopy() { return new GasFile(this.id + '-copy', this._name + ' copy'); }
  getAs() { return { setMimeType: () => {} }; }
}

// The shared environment instance. Tests call createGasEnv() to get a fresh one.
function createGasEnv(initialData) {
  const spreadsheet = new GasSpreadsheet(initialData || {});
  const scriptCache = new GasCache();
  const docCache = new GasCache();
  const props = new GasProperties();
  const files = new Map();
  let triggerId = 0;
  let triggerHandler = null;

  const env = {
    // ---- state handles used by tests ----
    _spreadsheet: spreadsheet,
    _scriptCache: scriptCache,
    _driveFiles: files,
    _scriptTriggers: [],
    _setTriggerHandler(fn) { triggerHandler = fn; },
    _getTriggerHandler() { return triggerHandler; },

    reset: () => { scriptCache._reset(); docCache._reset(); },

    // ---- SpreadsheetApp ----
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getActive: () => spreadsheet,
      getUi: () => ({
        alert: () => {},
        showSidebar: () => {},
        createSidebar: () => ({ setTitle: () => ({ setContentHtml: () => ({}) }) }),
      }),
      flush: () => {},
      newSpreadsheet: () => new GasSpreadsheet({}),
    },

    // ---- CacheService ----
    CacheService: {
      getScriptCache: () => scriptCache,
      getDocumentCache: () => docCache,
    },

    // ---- PropertiesService ----
    PropertiesService: {
      getScriptProperties: () => props,
      getDocumentProperties: () => props,
      getUserProperties: () => props,
    },

    // ---- Utilities ----
    Utilities: {
      base64Encode: (input) => Buffer.from(String(input), 'utf8').toString('base64'),
      base64Decode: (input) => Buffer.from(String(input), 'base64').toString('utf8'),
      base64EncodeWebSafe: (input) => Buffer.from(String(input), 'utf8').toString('base64url'),
      base64DecodeWebSafe: (input) => Buffer.from(String(input), 'base64url').toString('utf8'),
      getUuid: () => 'uuid-' + crypto.randomUUID(),
      // Apps Script returns a SIGNED byte array, not base64.
      computeHmacSha256Signature: (value, key) => {
        const digest = crypto.createHmac('sha256', String(key)).update(String(value)).digest();
        return Array.from(digest, (b) => (b > 127 ? b - 256 : b));
      },
      computeDigest: (algo, value) => {
        const digest = crypto.createHash(String(algo)).update(String(value)).digest();
        return Array.from(digest, (b) => (b > 127 ? b - 256 : b));
      },
      formatDate: (date, tz, fmt) => {
        const d = date instanceof Date ? date : new Date(date);
        return fmt.replace('yyyy', d.getFullYear())
          .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
          .replace('dd', String(d.getDate()).padStart(2, '0'));
      },
      newBlob: (content, type, name) => ({
        getContentType: () => type || 'text/plain',
        getName: () => name || 'blob',
        setName: (n) => ({ getContentType: () => type, getName: () => n }),
        getBytes: () => (Array.isArray(content) ? content : Array.from(Buffer.from(String(content), 'utf8'))),
        getAs: (mime) => ({ getContentType: () => mime }),
      }),
      sleep: (ms) => { throw new Error('Utilities.sleep not supported in tests: ' + ms); },
      getScriptTimeZone: () => 'Asia/Amman',
    },

    // ---- DriveApp ----
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE', ANYONE: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN' },
      Permission: { VIEW: 'VIEW', EDIT: 'EDIT', NONE: 'NONE' },
      getFolderByName: (name) => {
        if (!files.has('folder:' + name)) {
          files.set('folder:' + name, env.DriveApp.createFolder(name));
        }
        return files.get('folder:' + name);
      },
      getFolderById: (id) => files.get(id),
      getFileById: (id) => files.get(id) || null,
      createFolder: (name) => {
        const f = {
          id: 'folder-' + name, _name: name, isFolder: true,
          getId: function () { return this.id; },
          getName: function () { return this._name; },
          setName(n) { this._name = n; return this; },
          createFile: (blob) => {
            const file = new GasFile('file-' + (files.size + 1), (blob && blob.getName && blob.getName()) || 'file');
            file._blob = blob;
            files.set(file.id, file);
            return file;
          },
        };
        files.set(f.id, f);
        return f;
      },
      createFile: (blob) => {
        const f = new GasFile('file-' + (files.size + 1), 'file');
        f._blob = blob;
        files.set(f.id, f);
        return f;
      },
      getFilesByName: (name) => Array.from(files.values()).filter(f => f._name === name),
    },

    // ---- Session ----
    Session: {
      getActiveUser: () => ({ getEmail: () => 'tester@example.com', getUsername: () => 'tester' }),
      getEffectiveUser: () => ({ getEmail: () => 'tester@example.com' }),
      getScriptTimeZone: () => 'Asia/Amman',
    },

    // ---- ScriptApp ----
    // Modelled on the real fluent builder: newTrigger(fn) returns an object
    // that only materialises a trigger when .create() is called. A stub that
    // returned a bare object let installDataSyncTrigger() "pass" here while
    // throwing for real in Apps Script, because forSpreadsheet was missing.
    ScriptApp: {
      WeekDay: { SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6 },
      getProjectTriggers: () => env._scriptTriggers.slice(),
      newTrigger: (fn) => {
        const b = {
          _type: null,
          forSpreadsheet(sheet) { b._type = 'spreadsheet'; b._sheet = sheet; return b; },
          onEdit() { b._event = 'onEdit'; return b; },
          onChange() { b._event = 'onChange'; return b; },
          onOpen() { b._event = 'onOpen'; return b; },
          timeBased() { b._type = 'time'; return b; },
          everyMinutes(n) { b._every = n; return b; },
          everyHours(n) { b._every = n; return b; },
          everyDays(n) { b._every = n; return b; },
          everyWeeks(n) { b._every = n; return b; },
          onWeekDay(d) { b._day = d; return b; },
          atHour(h) { b._hour = h; return b; },
          create() {
            if (!b._type) throw new Error('newTrigger: must pick forSpreadsheet() or timeBased()');
            const t = {
              uid: 'trigger-' + (++triggerId),
              handler: fn,
              getHandlerFunction: () => fn,
              getTriggerType: () => b._type,
              getEventType: () => b._event || null,
            };
            env._scriptTriggers.push(t);
            return t;
          },
        };
        return b;
      },
      deleteTrigger: (t) => {
        const i = env._scriptTriggers.findIndex(x => x === t || x.uid === t.uid);
        if (i > -1) env._scriptTriggers.splice(i, 1);
      },
    },

    // ---- ContentService ----
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain', HTML: 'text/html', CSV: 'text/csv' },
      createTextOutput: (text) => {
        const out = {
          _text: text,
          _type: 'text/plain',
          setMimeType(t) { out._type = t; return out; },
          setContentType(t) { out._type = t; return out; },
          append() { return out; },
          getContent: () => text,
        };
        return out;
      },
    },

    // ---- Date / globals helpers ----
    __mock: true,
  };

  return env;
}

module.exports = { createGasEnv, GasSheet, GasSpreadsheet, GasRange, GasCache };
