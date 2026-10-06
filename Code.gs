// ===============================================================
// Code.gs - updated to sync edited sales prices back to Products
// ===============================================================

const aSheet = SpreadsheetApp.getActiveSpreadsheet();
const reportsSheet = aSheet.getSheetByName("Reports");
const salesSheet = aSheet.getSheetByName("sales");
const salesOfCompetitorSheet = aSheet.getSheetByName("salesOfCompetitor");
const expensesSheet = aSheet.getSheetByName("expenses");
const promotersSheet = aSheet.getSheetByName("promoters");
// V42: صفحة Users أُلغيت — حسابات الموظفين (id, username, password, role)
// أصبحت ضمن صفحة "Employees" بالأعمدة: A=id، B=name، C=username، D=password،
// E=role (admin/manager/user)، F=jobPosition (المنصب الوظيفي)، G=mgr (اسم المدير المباشر).
const ATTENDANCE_SHEET_NAME = "attendance";
const ATTENDANCE_HEADERS = ["timestamp","username","status","attendanceStatement","notes","medicalReportUrl","approvalStatus","approvedBy","approvedAt","rejectionReason","rejectionBy"];
const STATUS_WT_SHEET_NAME = "statusWT";
const MEDICAL_REPORT_FOLDER_NAME = "التقارير الطبية - الدوام";
const SICK_LEAVE_STATUS_LABEL = "اجازة مرضية";
const cache = CacheService.getScriptCache();
const CACHE_EXPIRATION_SECONDS = 3600;
// V69.1: كاش التقارير وحده يُبقي 12 ساعة بدل ساعة — أول قراءة بعد انتهاء الكاش
// تُعيد بناء كل التقارير من كل الأوراق المرتبطة، فرفع المدة يقلل البطء/التعليق.
const REPORT_CACHE_EXPIRATION_SECONDS = 12 * 60 * 60;
const INITIAL_DATA_CACHE_VERSION = 'v26-employees-merged';
const PRODUCT_LOOKUP_CACHE_VERSION = 'v25-product-lookup';

// ===============================================================
// Chunked cache — the single biggest speed lever in this file.
//
// `getInitialData` is what every page load waits on: the login screen, the
// employee list, every product dropdown, every barcode scan. CacheService
// allows ~100 KB per item, and at festival scale that payload is 400-500 KB.
// The old code did `try { cache.put(...) } catch (e) {}`, so the oversized
// write threw, the catch ate it, and NOTHING was cached. Every single page
// load then rebuilt five sheets from scratch. Nothing looked broken — the app
// was just permanently on its slowest path.
//
// So the payload is split across several cache entries instead. The manifest
// is written FIRST and holds the chunk count: it is the commit marker. A write
// interrupted half way therefore leaves chunks the manifest has not promised
// yet, so a reader treats it as a miss and rebuilds. Partial data is never
// served.
// ===============================================================
const CACHE_CHUNK_LIMIT_BYTES = 90 * 1024;
const INITIAL_DATA_CACHE_KEY = 'initialData_' + INITIAL_DATA_CACHE_VERSION;
const CACHE_MANIFEST_SUFFIX = '__n';

function cacheClearChunked_(baseKey) {
  const manifest = cache.get(baseKey + CACHE_MANIFEST_SUFFIX);
  const count = manifest == null ? 0 : Number(manifest) || 0;
  for (let i = 0; i < count; i++) cache.remove(baseKey + '__' + i);
  cache.remove(baseKey + CACHE_MANIFEST_SUFFIX);
  // Backwards compatibility: a single un-chunked entry from an older deploy.
  cache.remove(baseKey);
}

function cacheGetChunked_(baseKey) {
  const manifest = cache.get(baseKey + CACHE_MANIFEST_SUFFIX);
  if (manifest == null) {
    const legacy = cache.get(baseKey);
    if (!legacy) return null;
    try { return JSON.parse(legacy); } catch (e) { return null; }
  }
  const count = Number(manifest) || 0;
  if (count < 1) return null;
  let json = '';
  for (let i = 0; i < count; i++) {
    const part = cache.get(baseKey + '__' + i);
    if (part == null) return null;   // incomplete set -> rebuild, never half-serve
    json += part;
  }
  try { return JSON.parse(json); } catch (e) { return null; }
}

function cachePutChunked_(baseKey, json, seconds) {
  cacheClearChunked_(baseKey);
  const count = Math.max(1, Math.ceil(json.length / CACHE_CHUNK_LIMIT_BYTES));
  cache.put(baseKey + CACHE_MANIFEST_SUFFIX, String(count), seconds);
  for (let i = 0; i < count; i++) {
    cache.put(baseKey + '__' + i, json.slice(i * CACHE_CHUNK_LIMIT_BYTES, (i + 1) * CACHE_CHUNK_LIMIT_BYTES), seconds);
  }
  return count;
}

/** The one call every invalidation site should make for initial data. */
function clearInitialDataCache_() {
  try { cacheClearChunked_(INITIAL_DATA_CACHE_KEY); } catch (e) {}
  clearEmployeeAuthCache_();
}

// Same trap, second payload. `allReports` grows with every report ever filed,
// and its write was also wrapped in `catch(e){}`. Past ~100 KB the history page
// stopped caching and re-read every linked sheet on every visit.
const REPORTS_CACHE_KEY = 'allReports_v3_user_history';
const REPORTS_PAGE_DEFAULT_SIZE_ = 20;
const REPORTS_PAGE_MAX_SIZE_ = 50;

function clearReportsCache_() {
  try { cacheClearChunked_(REPORTS_CACHE_KEY); } catch (e) {}
}

// ===============================================================
// Data-version sync — getting a sheet edit into open browsers.
//
// A trigger runs on Google's servers and has no channel back to a browser, so
// the server cannot push. What it can do is move a counter; the client polls
// that counter and refreshes when it moves. Without this, a price edited in the
// sheet stayed stale in every open browser for up to an hour (the getInitialData
// TTL) and until each client reloaded on its own.
// ===============================================================
const DATA_VERSION_PROP = 'dataVersion';
const DATA_VERSION_SCOPE_PROP = 'dataVersionScope';
const DATA_WARM_THROTTLE_KEY = 'dataWarmThrottleMs';
const DATA_WARM_THROTTLE_MS = 20000;

// Which server cache a sheet feeds. Unlisted sheets fall back to 'master'.
const SHEET_SCOPE_MAP = {
  Products: 'master',
  ProductsOfCompetitor: 'master',
  Employees: 'master',
  Locations: 'master',
  ExpenseItems: 'master',
  Reports: 'reports',
  sales: 'reports',
  salesOfCompetitor: 'reports',
  expenses: 'reports',
  promoters: 'reports',
  attendance: 'reports',
  statusWT: 'reports',
  PromoterGoals: 'reports',
  festivalMovement: 'movements'
};

// The broader scope wins, so a client that only ever saw a 'master' edit still
// pulls everything after a later 'reports' edit.
const SCOPE_RANK = { master: 1, movements: 2, reports: 2 };

function getDataVersion_() {
  try {
    const props = PropertiesService.getScriptProperties();
    return {
      version: Number(props.getProperty(DATA_VERSION_PROP) || 0),
      scope: props.getProperty(DATA_VERSION_SCOPE_PROP) || ''
    };
  } catch (e) { return { version: 0, scope: '' }; }
}

function bumpDataVersion_(scope) {
  try {
    const props = PropertiesService.getScriptProperties();
    const current = getDataVersion_();
    const nextScope = (SCOPE_RANK[scope] || 0) >= (SCOPE_RANK[current.scope] || 0) ? scope : current.scope;
    props.setProperties({
      [DATA_VERSION_PROP]: String(current.version + 1),
      [DATA_VERSION_SCOPE_PROP]: nextScope
    });
    return current.version + 1;
  } catch (e) {
    // لا تبتلع الخطأ بصمت: هذا يعمل داخل محفّز، فأي فشل هنا يعني أن كل
    // المتصفحات المفتوحة ستبقى على بيانات قديمة دون أي أثر مرئي.
    console.error('bumpDataVersion_ failed for scope=' + scope, e);
    return 0;
  }
}

// يُقرأ قبل التحقق من الجلسة عمداً: يجب أن يعرف العميل أن الشيت تغيّر قبل أن
// يملك جلسة، وإلا كان دخوله التالي يقرأ بيانات قديمة. لا يُعيد سوى رقم.
function getDataVersion() {
  const v = getDataVersion_();
  return { status: 'success', version: v.version, scope: v.scope };
}

function invalidateCachesForScope_(scope) {
  if (scope === 'reports') {
    clearReportsCache_();
  } else if (scope === 'movements') {
    try { cache.remove(FESTIVAL_MOVEMENTS_CACHE_KEY); } catch (e) {}
  }
  // البيانات الأساسية تُبطَل دائماً: getInitialData يضم بيانات الموظفين والمنتجات
  // والمصارير التي تعرضها شاشات التقارير مباشرة.
  clearInitialDataCache_();
}

/**
 * إعادة بناء كاش getInitialData فوراً بعد التعديل.
 *
 * هذا هو سبب وجود المحفّز أصلاً من ناحية سرعة الدخول: الكاش يُبنى من خمس
 * أوراق، وإعادة بنائه عند انتهاء الساعة هو ما يجعل أول دخول بعد ساعتين بطيئاً.
 * محدود بمؤقّت لأن onEdit يُطلق عند كل تعديل، وrebuild عند كل ضغطة مفتاح
 * يستهلك حصة السكربت بلا فائدة؛ تعديل لاحق يعيد التسخين.
 */
function warmInitialDataCache_() {
  try {
    const now = Date.now();
    const last = Number(cache.get(DATA_WARM_THROTTLE_KEY) || 0);
    if (now - last < DATA_WARM_THROTTLE_MS) return false;
    cache.put(DATA_WARM_THROTTLE_KEY, String(now), 600);
  } catch (e) { return false; }
  try { getInitialData(false); return true; } catch (e) { return false; }
}

/**
 * تثبيت/إزالة محفّز المزامنة من داخل الموقع — للمدير فقط.
 *
 * installDataSyncTrigger() أصلاً دالة إعداد تُشغَّل مرة واحدة من محرّر Apps
 * Script، وقد تُركت بلا فحص صلاحية. ربطها بزر في الموقع يعني أن أي مستخدم
 * مسجّل يستطيع حذف المحفّز وإعادة إنشاءه واستنزاف حصة التنفيذ، لذا الفحص هنا
 * ليس زينة: هو ما يمنع ذلك.
 */
function adminSetDataSyncTrigger(payload, employee) {
  if (!employee || String(employee.systemRole || '').toLowerCase() !== 'admin') {
    throw new Error('تفعيل أو إزالة مزامنة الشيت متاح للإداري (admin) فقط');
  }
  const action = String((payload && payload.syncAction) || '').trim().toLowerCase();
  if (action === 'install') {
    const res = installDataSyncTrigger();
    return Object.assign({}, res, { sync: getDataSyncStatus() });
  }
  if (action === 'remove') {
    const res = removeDataSyncTrigger();
    return Object.assign({}, res, { sync: getDataSyncStatus() });
  }
  if (action === 'status') return { status: 'success', sync: getDataSyncStatus() };
  throw new Error('إجراء غير معروف: ' + action);
}

// مُعالِج محفّز التثبيت. لازم يكون محفّزاً مثبَّتاً (installable) وليس simple
// trigger: محفّز onEdit البسيط يعمل بلا تفويض، وCacheService وPropertiesService
// يرفضان العمل داخله — فيفشل صامتاً ولا يُحدِّث الإصدار أبداً. المحفّز المثبَّت
// يعمل بتفويض كامل، وهنا نحتاجه لإبطال الكاش ولتسخينه.
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (!sheet) return;
  const scope = SHEET_SCOPE_MAP[sheet.getName()] || 'master';
  invalidateCachesForScope_(scope);
  bumpDataVersion_(scope);
  warmInitialDataCache_();
}

/**
 * تفعيل مزامنة تعديلات الشيت. تُنفَّذ مرة واحدة من محرّر Apps Script.
 * المحفّز القديم يُحذف أولاً فلا تتكرر نسخته.
 */
function installDataSyncTrigger() {
  const props = PropertiesService.getScriptProperties();
  const existing = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onEdit');
  existing.forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onEdit').forSpreadsheet(aSheet).onEdit().create();
  props.setProperty('dataSyncEnabled', 'true');
  props.setProperty('dataSyncInstalledAt', new Date().toISOString());
  // تهيئة أولية حتى توجد نسخة صالحة قبل أول تعديل.
  warmInitialDataCache_();
  return {
    status: 'success',
    message: 'تم تفعيل مزامنة الشيت. أي تعديل يدوي في الأوراق يصل الآن إلى المتصفحات المفتوحة.',
    removed: existing.length
  };
}

function removeDataSyncTrigger() {
  const removed = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onEdit');
  removed.forEach(t => ScriptApp.deleteTrigger(t));
  try {
    PropertiesService.getScriptProperties().deleteProperty('dataSyncEnabled');
  } catch (e) {}
  return { status: 'success', removed: removed.length };
}

function getDataSyncStatus() {
  try {
    const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onEdit').length;
    const version = getDataVersion_();
    return {
      status: 'success',
      installed: triggers > 0,
      triggers: triggers,
      version: version.version,
      scope: version.scope,
      enabled: PropertiesService.getScriptProperties().getProperty('dataSyncEnabled') === 'true'
    };
  } catch (e) {
    return { status: 'success', installed: false, triggers: 0, version: 0, scope: '', error: String(e.message || e) };
  }
}

// ===============================================================
// V67: نظام الجلسات (التوثيق). سابقاً كان العميل يحدد هويته ودوره بنفسه في كل
// طلب، ما كان يسمح لأي شخص يعرف رابط التطبيق بقراءة كل البيانات أو التلاعب بها.
// الآن يُصدر doLogin رمز token، وتتحقق كل دوال القراءة/الكتابة من الرمز ثم
// تستخرج الهوية والدور من ملف Employees (المصدر الموثوق) — أي قيمة يرسلها
// العميل لهوية/دور تُتجاهل وتُستبدل بقيمة الخادم.
// مدة الجلسة: 6 ساعات (الحد الأقصى المسموح لـ ScriptCache TTL).
// ===============================================================
const SESSION_CACHE_PREFIX_ = 'sess_';
const SESSION_DURATION_SECONDS_ = 6 * 60 * 60;
const SESSION_STORE_ = CacheService.getScriptCache();
// V74: cache the small Employees authentication dataset so login and every
// authenticated API call do not reread the Employees sheet from scratch.
// The cache is invalidated together with the initial-data cache on edits.
const EMPLOYEE_AUTH_CACHE_KEY_ = 'employeeAuthRows_v2';
const EMPLOYEE_AUTH_CACHE_SECONDS_ = 600;

function clearEmployeeAuthCache_() {
  try { SESSION_STORE_.remove(EMPLOYEE_AUTH_CACHE_KEY_); } catch (e) {}
}

function getEmployeeAuthRows_() {
  try {
    const cached = SESSION_STORE_.get(EMPLOYEE_AUTH_CACHE_KEY_);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}

  const sheet = aSheet.getSheetByName("Employees");
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  try {
    const json = JSON.stringify(rows);
    if (json.length < 90 * 1024) SESSION_STORE_.put(EMPLOYEE_AUTH_CACHE_KEY_, json, EMPLOYEE_AUTH_CACHE_SECONDS_);
  } catch (e) {}
  return rows;
}

// Brute force protection
const LOGIN_ATTEMPTS_PREFIX_ = 'login_attempts_';
const LOGIN_LOCKOUT_PREFIX_ = 'login_lockout_';
const MAX_LOGIN_ATTEMPTS_ = 5;
const LOGIN_LOCKOUT_DURATION_SECONDS_ = 15 * 60;

// خطأ توثيق يحمل code='unauthorized' حتى يميزه العميل عن بقية الأخطاء.
function unauthorizedError_(message) {
  const err = new Error(message || 'Unauthorized');
  err.code = 'unauthorized';
  return err;
}

// قراءة صف الموظف من ملف Employees — المصدر الموثوق للهوية والدور والمنصب.
function getEmployeeByIdOrUsername_(value) {
  const v = String(value || '').trim();
  const data = getEmployeeAuthRows_();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowId = String(row[0] || '').trim();
    const rowUsername = String(row[2] || '').trim();
    if (rowId === v || rowUsername.toLowerCase() === v.toLowerCase()) {
      return {
        id: rowId || rowUsername.toLowerCase(),
        username: rowUsername,
        systemRole: String(row[4] || '').trim().toLowerCase(),
        jobPosition: String(row[5] || '').trim(),
        mgr: String(row[6] || '').trim(),
        name: String(row[1] || '').trim() || rowUsername
      };
    }
  }
  return null;
}

// إنشاء جلسة وإرجاع الـ token الجديد.
function createSession_(employee) {
  const token = Utilities.getUuid().replace(/-/g, '');
  const expiresAt = Date.now() + SESSION_DURATION_SECONDS_ * 1000;
  try { SESSION_STORE_.put(SESSION_CACHE_PREFIX_ + token, employee.id + '|' + expiresAt, SESSION_DURATION_SECONDS_); } catch (e) {}
  return { token, expiresAt };
}

// إنهاء الجلسة فوراً (زر خروج) — لا يصلح الـ token بعدها.
function revokeSession_(token) {
  const t = String(token || '').trim();
  if (!t) return;
  try { SESSION_STORE_.remove(SESSION_CACHE_PREFIX_ + t); } catch (e) {}
}

// تحويل token صالح إلى كائن الموظف الموثّق — أي طلب بلا token أو بجلسة منتهية يُرفض.
function authenticateRequest_(token) {
  const t = String(token || '').trim();
  if (!t) throw unauthorizedError_('لا توجد جلسة دخول — سجّل الدخول أولاً');
  let entry = null;
  try { entry = SESSION_STORE_.get(SESSION_CACHE_PREFIX_ + t); } catch (e) {}
  if (!entry) throw unauthorizedError_('انتهت الجلسة أو غير صالحة — سجّل الدخول مجدداً');
  const parts = String(entry).split('|');
  if (Number(parts[1]) < Date.now()) {
    try { SESSION_STORE_.remove(SESSION_CACHE_PREFIX_ + t); } catch (e) {}
    throw unauthorizedError_('انتهت مدة الجلسة — سجّل الدخول مجدداً');
  }
  const emp = getEmployeeByIdOrUsername_(parts[0]);
  if (!emp) throw unauthorizedError_('الحساب غير موجود');
  return emp;
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    // V72: يُجاب فحص الإصدار قبل التحقق من الجلسة عمداً — يجب أن يعرف العميل
    // أن الشيت تغيّر قبل أن يملك جلسة، وإلا كان دخوله التالي يقرأ بيانات قديمة.
    // لا يُعيد سوى رقم إصدار، فلا يسرّ بيانات.
    if (action === "getDataVersion") return createJsonResponse(getDataVersion());
    // V67: كل أفعال GET تتطلب جلسة موثّقة؛ الهوية والدور من ملف Employees على الخادم.
    const emp = authenticateRequest_(e.parameter.token);
    let response;
    switch (action) {
      case "getInitialData": response = getInitialData(e.parameter.forceRefresh === "1"); break;
      case "getReports": response = getReports(emp.id, emp.systemRole, emp.name, e.parameter.targetUserId); break;
      case "getReportsPage": response = getReportsPage(emp.id, emp.systemRole, emp.name, e.parameter.targetUserId, e.parameter.page, e.parameter.pageSize); break;
      case "getReportById": response = getReportById(e.parameter.id, emp); break;
      case "findProductByBarcode": response = findProductByBarcode(e.parameter.barcode, e.parameter.campaign); break;
      case "getCompetitorProducts": response = getCompetitorProductsFromSheet(); break;
      case "getUserFestivalMovements": response = getUserFestivalMovements(emp.id, emp.systemRole, e.parameter.targetUserId); break;
      case "getTeamOptions": response = getTeamOptions(emp.id, emp.systemRole); break;
      case "getAttendance": response = getAttendance(emp.id, emp.systemRole, emp.name, e.parameter.targetUserId); break;
      case "getStatusOptions": response = getStatusOptions(); break;
      case "getDashboardData": response = getDashboardData(emp.id, emp.systemRole); break;
      case "getPromoterGoals": response = getPromoterGoals(e.parameter.month, emp.id, emp.systemRole); break;
      case "getUsers": response = getUsersAdmin(emp); break;
      // V70.1: accepts the action name actually sent by page-users.js.
      case "getUsersAdmin": response = getUsersAdmin(emp); break;
      // مصاريف دمشق وريفها (ورقة لكل يوم).
      case "getExpensesOptions": response = getExpensesOptions(); break;
      case "getExpensesByDate": response = getExpensesByDate(e.parameter.date); break;
      case "getExpensesList": response = getExpensesList(); break;
      case "getSalaryAdvances": response = getSalaryAdvances(emp); break;
      default: response = {status:"error", message:"Invalid GET Action"};
    }
    return createJsonResponse(response);
  } catch (err) {
    return createJsonResponse({status:"error", code:err.code||'', message:err.message});
  }
}

function doPost(e) {
  try {
    const request = JSON.parse(e.postData.contents || '{}');
    const action = request.action;
    let response;

    if (action === "doLogin") {
      response = doLogin(request.payload);
    } else if (action === "logout") {
      // V67: إلغاء الجلسة فوراً — يُرسل العميل الـ token الحالي ليُبطَل.
      revokeSession_((request.payload || {}).token);
      response = {status:"success"};
    } else {
      const raw = request.payload || {};
      // V67: هوية ودور موثّقان من ملف Employees — نستبدل أي قيم يرسلها العميل.
      const emp = authenticateRequest_(raw.token);
      // CSRF protection: verify the request originates from our app
      const csrfToken = raw.csrfToken;
      const sessionCsrfKey = 'csrf_' + raw.token;
      let validCsrf = null;
      try { validCsrf = SESSION_STORE_.get(sessionCsrfKey); } catch (e) {}
      if (!validCsrf || validCsrf !== csrfToken) {
        throw unauthorizedError_('CSRF token invalid or missing');
      }
      const payload = Object.assign({}, raw);
      delete payload.token;
      payload.userId = emp.id;
      payload.userName = emp.name;
      payload.role = emp.systemRole;
      payload.mgr = emp.mgr;
      payload.jobPosition = emp.jobPosition;
      // ملاحظة: payload.username لا يُكتب هنا — فهو يحمل معنيين مختلفين:
      // هوية مُسجِّل الدوام (submitAttendance) أو معرّف سجل الدوام المستهدف (approveAttendance).
      // يُضبط لمجال الدوام فقط عند الحاجة أدناه.
      // أسماء/معرّفات المُنشئ والمُعدّل تُفرض من الخادم (لا يمكن تزويرها).
      payload.createdById = emp.id;
      payload.createdByName = emp.name;
      payload.editedBy = emp.name;

      switch (action) {
        case "submitReport":
          response = handleReportSubmission(payload);
          break;

        case "addLocation":
          response = addLocation(payload);
          break;

        case "updateProductPrice":
          response = updateProductPrice(payload);
          break;

        case "refreshCache":
          response = refreshCache();
          break;

        // إدارة محفّز المزامنة — للمدير فقط (الفحص داخل الدالة).
        case "dataSyncTrigger":
          response = adminSetDataSyncTrigger(payload, emp);
          break;

        case "addFestivalMovement":
          response = addFestivalMovement(payload);
          break;

        case "closeOutUserTallyToSales":
          response = closeOutUserTallyToSales(payload);
          break;

        case "submitAttendance":
          // V67: هوية مُسجِّل الدوام من الحساب الموثّق حصراً — لا يمكن التبليغ عن الدوام بصيغة مغايرة.
          payload.username = emp.username;
          response = submitAttendance(payload);
          break;

        case "archiveOldReports":
          response = archiveOldReports(payload);
          break;

        // V69.1: أرشفة سجلات الدوام القديمة (خيار منفصل عن أرشفة التقارير).
        case "archiveOldAttendance":
          response = archiveOldAttendance(payload);
          break;

        // V50: اعتماد التقارير — دور «مدقق» (auditor) أو admin فقط.
        case "approveReport":
          response = approveReport(payload);
          break;

        case "approveAllReports":
          response = approveAllReports(payload);
          break;

        // V61: حذف ناعم لتقرير — admin/manager/auditor.
        case "deleteReport":
          response = deleteReport(payload);
          break;

        // V66: اعتماد/رفض سجل دوام.
        case "approveAttendance":
          response = approveAttendance(payload);
          break;

        case "approveAllAttendance":
          response = approveAllAttendance(payload);
          break;

        // V66: اعتماد/رفض حركة سحب/مرتجع.
        case "approveMovement":
          response = approveMovement(payload);
          break;

        case "approveAllMovements":
          response = approveAllMovements(payload);
          break;

        // V69: تعديل حركة مادة مرفوضة/قيد المراجعة من صاحبها فقط — المعتمدة لا تُعدَّل.
        case "editFestivalMovement":
          response = editFestivalMovement(payload, emp);
          break;

        // V69: تعديل سجل دوام مرفوض/قيد المراجعة من صاحبه فقط — المعتمد لا يُعدَّل.
        case "editAttendance":
          response = editAttendance(payload, emp);
          break;

        // V63: أهداف المروجين الشهرية.
        case "savePromoterGoals":
          response = savePromoterGoals(payload);
          break;

        // V63: النسخ الاحتياطي الأسبوعي.
        case "setupWeeklyBackup":
          response = setupWeeklyBackup(payload);
          break;
        case "backupNow":
          response = backupNow(payload);
          break;

        // V68: إدارة المستخدمين والصلاحيات — للإداري (admin) فقط.
        case "saveUser":
          // «المنصب الوظيفي» (jobPosition) و«المدير المباشر» (manager) حقلان من نموذج
          // إدارة المستخدمين — نستعيدهما من الطلب الخام لأن doPost يفرض قيمهما
          // تلقائياً لصاحب الطلب نفسه.
          payload.jobPosition = String(raw.jobPosition || '').trim();
          payload.actorUsername = emp.username;
          response = saveUser(payload);
          break;
        case "deleteUser":
          payload.actorUsername = emp.username;
          response = deleteUser(payload);
          break;

        // مصاريف دمشق وريفها (ورقة لكل يوم).
        case "submitExpenses":
          response = submitExpenses(payload);
          break;
        case "saveExpensesMeta":
          response = saveExpensesMeta(payload);
          break;
        case "deleteExpensesSheet":
          response = deleteExpensesSheet(payload);
          break;
        case "approveExpenses":
          response = approveExpenses(payload);
          break;

        case "saveSalaryAdvance":
          response = saveSalaryAdvance(payload, emp);
          break;

        default:
          response = {
            status: "error",
            message: "Invalid POST Action: " + action
          };
      }
    }

    return createJsonResponse(response);

  } catch (err) {
    return createJsonResponse({
      status: "error",
      code: err.code || '',
      message: err.message
    });
  }
}

    function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function getAttendanceSheet_() {
  let sheet = aSheet.getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sheet) sheet = aSheet.insertSheet(ATTENDANCE_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,ATTENDANCE_HEADERS.length).setValues([ATTENDANCE_HEADERS]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < ATTENDANCE_HEADERS.length) {
    // Upgrade older sheets (created before the medicalReportUrl column existed)
    // by filling in any missing header cells without touching existing data.
    const existingHeaders = sheet.getRange(1,1,1,ATTENDANCE_HEADERS.length).getValues()[0];
    ATTENDANCE_HEADERS.forEach((h,i) => { if (!existingHeaders[i]) sheet.getRange(1,i+1).setValue(h); });
  }
  return sheet;
}

// Fallback list used only if the "statusWT" sheet cannot be created/read for
// some reason (e.g. permissions). Also used as the seed data the very first
// time the "statusWT" sheet is created.
const ATTENDANCE_ALLOWED_STATUSES = ["بداية دوام","نهاية دوام","عطلة أسبوعية","عطلة رسمية","اجازة إدارية","اجازة مرضية","حضور إضافي"];

// Returns the "statusWT" sheet, creating it (with a header row + the default
// status list already filled in) the very first time the app runs.
function getStatusWTSheet_() {
  let sheet = aSheet.getSheetByName(STATUS_WT_SHEET_NAME);
  if (!sheet) {
    sheet = aSheet.insertSheet(STATUS_WT_SHEET_NAME);
    sheet.getRange(1,1,1,1).setValue("حالة الدوام");
    sheet.setFrozenRows(1);
    sheet.getRange(2,1,ATTENDANCE_ALLOWED_STATUSES.length,1).setValues(ATTENDANCE_ALLOWED_STATUSES.map(s => [s]));
  }
  return sheet;
}

// Reads the list of attendance-status options from the "statusWT" sheet
// (column A, skipping the header row). Creates the sheet with the default
// options on first run so the dropdowns always have data to show.
function getStatusWTOptions_() {
  const sheet = getStatusWTSheet_();
  if (sheet.getLastRow() < 2) return ATTENDANCE_ALLOWED_STATUSES.slice();
  const values = sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues();
  const options = values.map(row => String(row[0] || '').trim()).filter(v => v);
  return options.length ? options : ATTENDANCE_ALLOWED_STATUSES.slice();
}

// GET action: returns the current dropdown options so the front-end (attendance
// form select + history filter) always mirrors the "statusWT" sheet.
function getStatusOptions() {
  return {status:"success", options: getStatusWTOptions_()};
}

// Returns the Drive folder used for medical reports, creating it once and
// remembering its ID in Script Properties. This intentionally avoids
// DriveApp.getFoldersByName(), which needs the broad "See, edit, create and
// delete ALL your Drive files" permission (drive / drive.readonly scope).
// Only ever creating/opening a folder the script itself made keeps Apps
// Script's auto-detected scope down to the narrower drive.file permission.
const MEDICAL_REPORT_FOLDER_ID_PROP = "MEDICAL_REPORT_FOLDER_ID";
function getMedicalReportFolder_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(MEDICAL_REPORT_FOLDER_ID_PROP);
  if (savedId) {
    try { return DriveApp.getFolderById(savedId); } catch (e) { /* folder was moved/deleted - recreate below */ }
  }
  const folder = DriveApp.createFolder(MEDICAL_REPORT_FOLDER_NAME);
  props.setProperty(MEDICAL_REPORT_FOLDER_ID_PROP, folder.getId());
  return folder;
}

// Saves an uploaded medical report (PDF or image, sent as base64) to Drive and
// returns a shareable link to store alongside the attendance row.
function saveMedicalReport_(base64Data, fileName, mimeType) {
  let folder;
  try {
    folder = getMedicalReportFolder_();
  } catch (e) {
    throw new Error(driveAuthErrorMessage_(e));
  }
  const safeMime = String(mimeType || '').trim() || 'application/octet-stream';
  const safeName = String(fileName || 'medical-report').trim();
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), safeMime, safeName);
  let file;
  try {
    file = folder.createFile(blob);
  } catch (e) {
    throw new Error(driveAuthErrorMessage_(e));
  }
  try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW); } catch (e) { /* sharing may be restricted by domain policy */ }
  return file.getUrl();
}

// Turns Google's raw "you do not have permission to call DriveApp..." error
// into a clear, actionable Arabic message pointing at the one-time fix
// (see setupDriveAccess() below and the README).
function driveAuthErrorMessage_(e) {
  const raw = String((e && e.message) || e || '');
  if (/DriveApp|drive\.readonly|permission/i.test(raw)) {
    return "لم يتم منح صلاحية Google Drive لهذا المشروع بعد. افتح محرر Apps Script، شغّل الدالة setupDriveAccess مرة واحدة ووافق على الصلاحيات المطلوبة، ثم انشر نسخة جديدة من الويب أب (Deploy > Manage deployments > New version). راجع ملف الـ README المرفق لخطوات مفصّلة.";
  }
  return raw || "حدث خطأ غير متوقع أثناء حفظ التقرير الطبي على Drive";
}

/**
 * ⚠️ شغّل هاي الدالة يدوياً من محرر Apps Script (زر ▶ Run) مرة واحدة فقط بعد
 * نسخ هذا الكود لأول مرة، أو أي مرة يُطلب منك فيها صلاحية Drive من جديد.
 * هدفها الوحيد هو إظهار نافذة "Authorization required" ليوافق مالك المشروع
 * عليها؛ بدون هذه الموافقة اليدوية (لمرة واحدة) ترفض Google أي استدعاء
 * لـ DriveApp من الويب أب برسالة "You do not have permission...".
 * بعد الموافقة، لازم تنشر نسخة جديدة من الويب أب حتى يعمل رفع التقارير
 * الطبية: Deploy > Manage deployments > قلم التعديل > Version: New version > Deploy.
 */
function setupDriveAccess() {
  const folder = getMedicalReportFolder_();
  Logger.log('تم منح صلاحية Drive بنجاح. رابط مجلد التقارير الطبية: ' + folder.getUrl());
}

function submitAttendance(payload) {
  const sheet = getAttendanceSheet_();
  const username = String(payload && (payload.username || payload.userName) || '').trim();
  const status = String(payload && payload.status || '').trim();
  const statement = String(payload && (payload.attendanceStatement || payload.statement) || '').trim();
  const notes = String(payload && payload.notes || '').trim();
  if (!username) throw new Error("اسم المستخدم مطلوب");
  const allowedStatuses = getStatusWTOptions_();
  if (allowedStatuses.indexOf(status) === -1) throw new Error("حالة الدوام غير صحيحة");
  if (!statement) throw new Error("بيان الدوام مطلوب");

  let medicalReportUrl = '';
  const fileBase64 = payload && payload.medicalReportBase64;
  if (status === SICK_LEAVE_STATUS_LABEL) {
    if (!fileBase64) throw new Error("يجب إرفاق التقرير الطبي (PDF أو صورة) عند اختيار حالة اجازة مرضية");
    medicalReportUrl = saveMedicalReport_(fileBase64, payload.medicalReportFileName, payload.medicalReportMimeType);
  }

  sheet.appendRow([new Date(),username,status,statement,notes,medicalReportUrl]);
  sheet.getRange(sheet.getLastRow(),1).setNumberFormat("yyyy-MM-dd HH:mm:ss");
  return {status:"success",message:"تم تسجيل الدوام بنجاح"};
}

function getAttendance(userId, userRole, userName, targetUserId) {
  const sheet = getAttendanceSheet_();
  if (sheet.getLastRow() < 2) return [];
  const lastCol = Math.max(sheet.getLastColumn(), ATTENDANCE_HEADERS.length);
  const values = sheet.getRange(2,1,sheet.getLastRow()-1,lastCol).getValues();
  const headersAll = sheet.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h || '').trim().toLowerCase());
  const colOf = (name) => { const i = headersAll.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName(name)); return i >= 0 ? i : -1; };
  const iApproval = colOf('approvalStatus'), iApprovedBy = colOf('approvedBy'), iApprovedAt = colOf('approvedAt'), iRejReason = colOf('rejectionReason'), iRejBy = colOf('rejectionBy');
  const role = String(userRole || '').trim().toLowerCase();
  const requesterId = String(userId || '').trim();
  const selectedId = String(targetUserId || '').trim();
  const allowedIds = getTeamMemberIds(requesterId,role);
  let allowedNames = null;
  const users = getUsersLite();
  if (allowedIds !== null) {
    const allowed = users.filter(u => allowedIds.indexOf(u.id) !== -1);
    allowedNames = allowed.map(u => String(u.username || u.name || ''));
    if (selectedId) {
      const selected = allowed.find(u => u.id === selectedId);
      allowedNames = selected ? [String(selected.username || selected.name || '')] : [];
    }
  } else if (selectedId) {
    const selected = users.find(u => u.id === selectedId);
    allowedNames = selected ? [String(selected.username || selected.name || '')] : [];
  }
  return values.filter(row => allowedNames === null || allowedNames.indexOf(String(row[1] || '')) !== -1)
    .reverse().map(row => ({
      timestamp: row[0] instanceof Date ? Utilities.formatDate(row[0],Session.getScriptTimeZone(),"yyyy-MM-dd HH:mm:ss") : String(row[0] || ''),
      username:String(row[1] || ''), status:String(row[2] || ''),
      attendanceStatement:String(row[3] || ''), notes:String(row[4] || ''),
      medicalReportUrl:String(row[5] || ''),
      approvalStatus: iApproval >= 0 ? String(row[iApproval] || '') : '',
      approvedBy: iApprovedBy >= 0 ? String(row[iApprovedBy] || '') : '',
      approvedAt: iApprovedAt >= 0 ? String(row[iApprovedAt] || '') : '',
      rejectionReason: iRejReason >= 0 ? String(row[iRejReason] || '') : '',
      rejectionBy: iRejBy >= 0 ? String(row[iRejBy] || '') : ''
    }));
}

// V66: اعتماد/رفض سجل دوام — admin/manager/auditor. يحدد الصف عبر timestamp+username.
function approveAttendance(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'manager' && role !== 'auditor') {
    throw new Error('صلاحية الاعتماد متاحة للمدقق (auditor) والإداري (admin) والمدير (manager) فقط');
  }
  const timestamp = String(payload.timestamp || '').trim();
  const username = String(payload.username || '').trim();
  if (!timestamp || !username) throw new Error('معرّف سجل الدوام (الوقت والمستخدم) مطلوب');
  const status = String(payload.status || 'approved').trim().toLowerCase();
  if (status !== 'approved' && status !== 'rejected') throw new Error('حالة غير صالحة (approved أو rejected)');
  const sheet = getAttendanceSheet_();
  const lastCol = Math.max(sheet.getLastColumn(), ATTENDANCE_HEADERS.length);
  const headersAll = sheet.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h || '').trim());
  const data = sheet.getRange(2,1,sheet.getLastRow()-1,lastCol).getValues();
  const tz = Session.getScriptTimeZone();
  let targetRow = -1;
  for (let i = 0; i < data.length; i++) {
    const cellTime = data[i][0] instanceof Date ? Utilities.formatDate(data[i][0], tz, 'yyyy-MM-dd HH:mm:ss') : String(data[i][0] || '');
    if (cellTime === timestamp && String(data[i][1] || '').trim() === username) { targetRow = i + 2; break; }
  }
  if (targetRow === -1) throw new Error('سجل الدوام غير موجود');
  const col = (name, fallback) => {
    const idx = headersAll.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName(name));
    return idx >= 0 ? idx + 1 : fallback;
  };
  const by = String(payload.approvedBy || payload.userName || '');
  const now = String(payload.approvedAt || new Date().toISOString());
  sheet.getRange(targetRow, col('approvalStatus', 7)).setValue(status);
  sheet.getRange(targetRow, col('approvedBy', 8)).setValue(by);
  sheet.getRange(targetRow, col('approvedAt', 9)).setValue(now);
  sheet.getRange(targetRow, col('rejectionReason', 10)).setValue(status === 'rejected' ? String(payload.reason || '') : '');
  sheet.getRange(targetRow, col('rejectionBy', 11)).setValue(status === 'rejected' ? by : '');
  return { status: 'success', message: status === 'approved' ? 'تم اعتماد سجل الدوام.' : 'تم رفض سجل الدوام.' };
}

// V66: اعتماد/رفض حركة سحب/مرتجع/صرف/مبيعات — admin/manager/auditor. يحدد الصف عبر المعرّف id.
function approveMovement(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'manager' && role !== 'auditor') {
    throw new Error('صلاحية الاعتماد متاحة للمدقق (auditor) والإداري (admin) والمدير (manager) فقط');
  }
  const id = String(payload.id || '').trim();
  if (!id) throw new Error('معرّف الحركة مطلوب');
  const status = String(payload.status || 'approved').trim().toLowerCase();
  if (status !== 'approved' && status !== 'rejected') throw new Error('حالة غير صالحة (approved أو rejected)');
  const sheet = ensureFestivalMovementSheet();
  const lastCol = Math.max(sheet.getLastColumn(), FESTIVAL_MOVEMENT_HEADERS.length);
  const headersAll = sheet.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h || '').trim());
  const data = sheet.getRange(2,1,sheet.getLastRow()-1,lastCol).getValues();
  let targetRow = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][8] || '').trim() === id) { targetRow = i + 2; break; }
  }
  if (targetRow === -1) throw new Error('الحركة غير موجودة');
  const col = (name) => {
    const idx = headersAll.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName(name));
    return idx >= 0 ? idx + 1 : -1;
  };
  const by = String(payload.approvedBy || payload.userName || '');
  const now = String(payload.approvedAt || new Date().toISOString());
  const sets = { approvalStatus: status, approvedBy: by, approvedAt: now, rejectionReason: status === 'rejected' ? String(payload.reason || '') : '', rejectionBy: status === 'rejected' ? by : '' };
  Object.keys(sets).forEach(name => {
    const c = col(name);
    if (c >= 0) sheet.getRange(targetRow, c).setValue(sets[name]);
  });
  cache.remove(FESTIVAL_MOVEMENTS_CACHE_KEY);
  return { status: 'success', message: status === 'approved' ? 'تم اعتماد الحركة.' : 'تم رفض الحركة.' };
}

// V69: تعديل حركة سحب/مرتجع غير معتمدة — صاحبها (أو admin/manager/auditor).
// المعتمدة لا تُعدَّل، وبعد التعديل تعود الحركة «قيد المراجعة» ويُمحى أثر الاعتماد/الرفض.
function editFestivalMovement(payload, emp) {
  payload = payload || {};
  const id = String(payload.id || '').trim();
  if (!id) throw new Error('معرّف الحركة مطلوب');

  const item = String(payload.item || '').trim();
  const quantity = Number(payload.quantity);
  const operation = String(payload.operation || '').trim();
  const invoiceNumber = String(payload.invoiceNumber || '').trim();
  if (!item) throw new Error('اسم المادة مطلوب');
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('الكمية يجب أن تكون رقماً أكبر من 0');
  if (operation !== 'سحب' && operation !== 'مرتجع') throw new Error('نوع العملية يجب أن يكون "سحب" أو "مرتجع"');

  const requesterId = String((emp && emp.id) || payload.createdById || '').trim();
  const requesterRole = String((emp && emp.systemRole) || '').trim().toLowerCase();

  const sheet = ensureFestivalMovementSheet();
  const lastCol = Math.max(sheet.getLastColumn(), FESTIVAL_MOVEMENT_HEADERS.length);
  const headersAll = sheet.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h || '').trim());
  const data = sheet.getRange(2,1,sheet.getLastRow()-1,lastCol).getValues();
  let targetRow = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][8] || '').trim() === id) { targetRow = i + 2; break; }
  }
  if (targetRow === -1) throw new Error('الحركة غير موجودة');

  const ownerId = String(data[targetRow - 2][5] || '').trim();
  const canEdit = requesterRole === 'admin' || requesterRole === 'manager' || requesterRole === 'auditor' || (ownerId !== '' && ownerId === requesterId);
  if (!canEdit) throw new Error('لا تملك صلاحية تعديل هذه الحركة');

  if (String(data[targetRow - 2][9] || '').trim() !== 'rejected') throw new Error('لا يمكن تعديل الحركة إلا إذا كانت مرفوضة');

  const col = (name) => {
    const idx = headersAll.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName(name));
    return idx >= 0 ? idx + 1 : -1;
  };
  const sets = {
    item: item, quantity: quantity, operation: operation, invoiceNumber: invoiceNumber,
    approvalStatus: '', approvedBy: '', approvedAt: '', rejectionReason: '', rejectionBy: ''
  };
  Object.keys(sets).forEach(name => {
    const c = col(name);
    if (c >= 0) sheet.getRange(targetRow, c).setValue(sets[name]);
  });
  cache.remove(FESTIVAL_MOVEMENTS_CACHE_KEY);
  return { status: 'success', message: 'تم تعديل الحركة وأصبحت قيد المراجعة مجدداً.' };
}

// V69: تعديل سجل دوام غير معتمد — صاحبه (أو admin/manager/auditor).
// المعتمد لا يُعدَّل، وبعد التعديل يعود السجل «قيد المراجعة» ويُمحى أثر الاعتماد/الرفض.
function editAttendance(payload, emp) {
  payload = payload || {};
  const timestamp = String(payload.timestamp || '').trim();
  const username = String(payload.username || '').trim();
  if (!timestamp || !username) throw new Error('معرّف سجل الدوام (الوقت والمستخدم) مطلوب');

  const status = String(payload.status || '').trim();
  const statement = String(payload.attendanceStatement || payload.statement || '').trim();
  const notes = String(payload.notes || '').trim();
  const allowedStatuses = getStatusWTOptions_();
  if (allowedStatuses.indexOf(status) === -1) throw new Error('حالة الدوام غير صالحة');
  if (!statement) throw new Error('بيان الدوام مطلوب');

  const requesterRole = String((emp && emp.systemRole) || '').trim().toLowerCase();
  const requesterUsername = String((emp && emp.username) || payload.editedBy || '').trim();

  const sheet = getAttendanceSheet_();
  const lastCol = Math.max(sheet.getLastColumn(), ATTENDANCE_HEADERS.length);
  const headersAll = sheet.getRange(1,1,1,lastCol).getValues()[0].map(h => String(h || '').trim());
  const data = sheet.getRange(2,1,sheet.getLastRow()-1,lastCol).getValues();
  const tz = Session.getScriptTimeZone();
  let targetRow = -1;
  for (let i = 0; i < data.length; i++) {
    const cellTime = data[i][0] instanceof Date ? Utilities.formatDate(data[i][0], tz, 'yyyy-MM-dd HH:mm:ss') : String(data[i][0] || '');
    if (cellTime === timestamp && String(data[i][1] || '').trim() === username) { targetRow = i + 2; break; }
  }
  if (targetRow === -1) throw new Error('سجل الدوام غير موجود');

  const canEdit = requesterRole === 'admin' || requesterRole === 'manager' || requesterRole === 'auditor' || (username !== '' && username === requesterUsername);
  if (!canEdit) throw new Error('لا تملك صلاحية تعديل سجل الدوام هذا');

  if (String(data[targetRow - 2][6] || '').trim() !== 'rejected') throw new Error('لا يمكن تعديل سجل الدوام إلا إذا كان مرفوضاً');

  const col = (name) => {
    const idx = headersAll.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName(name));
    return idx >= 0 ? idx + 1 : -1;
  };
  const sets = {
    status: status, attendanceStatement: statement, notes: notes,
    approvalStatus: '', approvedBy: '', approvedAt: '', rejectionReason: '', rejectionBy: ''
  };
  Object.keys(sets).forEach(name => {
    const c = col(name);
    if (c >= 0) sheet.getRange(targetRow, c).setValue(sets[name]);
  });
  return { status: 'success', message: 'تم تعديل سجل الدوام وأصبح قيد المراجعة مجدداً.' };
}

function getLoginAttempts_(username) {
  const key = LOGIN_ATTEMPTS_PREFIX_ + String(username || '').toLowerCase();
  try {
    const val = SESSION_STORE_.get(key);
    return val ? JSON.parse(val) : { count: 0, firstAttempt: Date.now() };
  } catch (e) { return { count: 0, firstAttempt: Date.now() }; }
}

function incrementLoginAttempts_(username) {
  const key = LOGIN_ATTEMPTS_PREFIX_ + String(username || '').toLowerCase();
  const attempts = getLoginAttempts_(username);
  attempts.count++;
  try { SESSION_STORE_.put(key, JSON.stringify(attempts), 3600); } catch (e) {}
  if (attempts.count >= MAX_LOGIN_ATTEMPTS_) {
    const lockoutKey = LOGIN_LOCKOUT_PREFIX_ + String(username || '').toLowerCase();
    try { SESSION_STORE_.put(lockoutKey, String(Date.now()), LOGIN_LOCKOUT_DURATION_SECONDS_); } catch (e) {}
  }
  return attempts.count;
}

function resetLoginAttempts_(username) {
  const key = LOGIN_ATTEMPTS_PREFIX_ + String(username || '').toLowerCase();
  try { SESSION_STORE_.remove(key); } catch (e) {}
}

function isLoginLockedOut_(username) {
  const lockoutKey = LOGIN_LOCKOUT_PREFIX_ + String(username || '').toLowerCase();
  try {
    const lockedAt = SESSION_STORE_.get(lockoutKey);
    if (!lockedAt) return false;
    if (Date.now() - Number(lockedAt) > LOGIN_LOCKOUT_DURATION_SECONDS_ * 1000) {
      SESSION_STORE_.remove(lockoutKey);
      return false;
    }
    return true;
  } catch (e) { return false; }
}

function doLogin(payload) {
  const usersData = getEmployeeAuthRows_();
  if (!usersData.length) throw new Error("لا توجد بيانات موظفين");
  const inputUsernameLower = String(payload.username || '').toLowerCase();
  const inputPassword = String(payload.password || '');

  if (isLoginLockedOut_(inputUsernameLower)) {
    throw new Error("الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة. حاول بعد 15 دقيقة.");
  }

  // V42: تحقق آمن من كلمة المرور.
  // 1) إذا كانت المخزنة بصيغة hash (تبدأ بـ "pwd$") نقارن بالـ hash.
  // 2) وإلا (نص عادي من أنظمة أقدم) نقارن مباشرة، وعند النجاح نرقّي المخزنة إلى hash تلقائياً
  //    حتى لا تبقى أي كلمة مرور نصية في الـ Sheet.
  for (let i = 0; i < usersData.length; i++) {
    const row = usersData[i];
    if (String(row[2]).toLowerCase() !== inputUsernameLower) continue;
    const stored = String(row[3] || '');
    if (!stored) continue;
    let valid = false;
    if (stored.indexOf('pwd$') === 0) {
      // صيغة مخزنة: pwd$<salt>$<hash> حيث hash = HMAC(salt+password)
      const parts = stored.split('$');
      if (parts.length === 3) {
        const salt = parts[1];
        const expected = parts[2];
        const actual = computePasswordHash_(inputPassword, salt);
        valid = (actual === expected);
      }
    } else {
      // نص عادي قديم: نتأكد من التطابق، ومن ثم نرقّيها لاحقاً.
      valid = (stored === inputPassword);
    }
    if (!valid) continue;
    // ترقية تلقائية لكلمات المرور النصية القديمة إلى hash (مرة واحدة لكل مستخدم).
    if (stored.indexOf('pwd$') !== 0) {
      const { salt, hash } = hashPassword_(inputPassword);
      const sheet = aSheet.getSheetByName("Employees");
      if (sheet) sheet.getRange(i + 2, 4).setValue('pwd$' + salt + '$' + hash);
      try { row[3] = 'pwd$' + salt + '$' + hash; SESSION_STORE_.put(EMPLOYEE_AUTH_CACHE_KEY_, JSON.stringify(usersData), EMPLOYEE_AUTH_CACHE_SECONDS_); } catch (e) {}
    }
    // V42: المعرّف للواجهة = عمود id، وإن كان فارغاً نعتمد على username كبديل حتى
    // تُبنى صلاحيات المدير (الفريق) بشكل صحيح حتى لمن لم يملأ عمود id.
    const rawId = String(row[0] || '').trim();
    const rawName = String(row[1] || '').trim();
    const rawUsername = String(row[2] || '').trim();
    resetLoginAttempts_(inputUsernameLower);
    // V67: إنشاء جلسة وإرجاع الـ token — كل الطلبات اللاحقة تتطلب هذا الـ token.
    const session = createSession_({ id: rawId || rawUsername });
    // CSRF: generate and store a CSRF token tied to this session
    const csrfToken = Utilities.getUuid().replace(/-/g, '');
    try { SESSION_STORE_.put('csrf_' + session.token, csrfToken, SESSION_DURATION_SECONDS_); } catch (e) {}
    // V74: استجابة الدخول صغيرة عمداً. لا نرسل getInitialData (قد تكون مئات الكيلوبايت)
    // داخل طلب المصادقة؛ الشاشة الهدف تقرأ كاش المتصفح أو تجلب البيانات مباشرة بعد الدخول.
    return {status:"success", token: session.token, csrfToken: csrfToken, expiresAt: session.expiresAt, user:{
      id: rawId || rawUsername,
      username: rawUsername,
      role: String(row[4] || '').trim().toLowerCase(),
      jobPosition: String(row[5] || '').trim(),
      name: rawName || rawUsername
    }};
  }
  incrementLoginAttempts_(inputUsernameLower);
  throw new Error("Invalid credentials");
}

// توليد salt عشوائي (طول 16 بايت) وتشفير كلمة المرور به.
// نستخدم Utilities.computeHmacSha256Signature لعدم الحاجة لأي مكتبة خارجية،
// والأهم أنه لا يمكن استرجاع كلمة المرور من الـ hash المخزّن.
function hashPassword_(password) {
  const salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  const hash = computePasswordHash_(password, salt);
  return { salt, hash };
}

function computePasswordHash_(password, salt) {
  const sig = Utilities.computeHmacSha256Signature(String(password), String(salt));
  return sig.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

// دالة مساعدة لتوليد hash يدوياً لأي مستخدم جديد في الـ Sheet:
// تُستخدم عند إضافة مستخدم جديد لنوع كلمة مرور نصية قديمة؛
// لا تُستدعى تلقائياً في هذا الملف.
function hashPasswordForUser(password) {
  const { salt, hash } = hashPassword_(String(password || ''));
  return 'pwd$' + salt + '$' + hash;
}

// معرّف = لأغراض التوثيق: الصيغة المخزنة الناتجة من hashPasswordForUser
// تكون 'pwd$<salt>$<hash>' مثل: pwd$abc123def4567890$a1b2c3...


// ===============================================================
// نظام الصلاحيات: admin (كل شيء) / manager (فريقه فقط) / user (نفسه فقط)
// ===============================================================

// V42: تطبيع اسم لمقارنة متسامحة (إزالة مسافات مكررة + تجاهل حالة الأحرف) لتجنّب
// فشل التطابق بسبب مسافة إضافية أو فرق في الأحرف الكبيرة/الصغيرة.
function normalizeName_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// V42: قراءة بيانات حسابات الموظفين من صفحة "Employees" (لم تعد صفحة Users موجودة).
// الأعمدة: A=id، B=name، C=username، D=password، E=role، F=jobPosition، G=mgr.
function getUsersLite() {
  const data = getEmployeeAuthRows_();
  if (!data.length) return [];
  return data
    .map(row => {
      const rawId = String(row[0] ?? '').trim();
      const rawName = String(row[1] ?? '').trim();
      const rawUsername = String(row[2] ?? '').trim();
      return {
        id: rawId || rawUsername, // V42: احتياط — إن كان عمود id فارغاً نعتمد على username
        name: rawName,
        username: rawUsername,
        role: String(row[4] ?? '').trim().toLowerCase(),
        jobPosition: String(row[5] ?? '').trim(),
        mgr: String(row[6] ?? '').trim(),
        nname: normalizeName_(row[1]),
        nusername: normalizeName_(row[2])
      };
    })
    // نحتفظ بالصفوف التي تملك معرّفاً أو اسماً أو اسم مستخدم — لا نحذف من فراغ المعرّف.
    .filter(u => u.id || u.name || u.username);
}

// V42: مصدر الحقيقة لهرمية الفريق هو صفحة "Employees" وعمود (G / mgr) الذي يحوي
// اسم المدير المباشر لكل موظف. نعيد خريطة: الاسم المطبّع -> اسم مديره المطبّع.
function getEmployeeMgrMap() {
  // getEmployeeAuthRows_() يستفيد من كاش Employees المستخدم أيضاً للمصادقة،
  // وبالتالي لا نعيد قراءة الورقة نفسها كل مرة يبني فيها المدير قائمة فريقه.
  const rows = getEmployeeAuthRows_();
  if (!rows.length) return {};
  const map = {};
  rows.forEach(row => {
    const name = String(row[1] ?? '').trim();   // B = name
    const mgr = String(row[6] ?? '').trim();     // G = mgr
    if (name) map[normalizeName_(name)] = normalizeName_(mgr);
  });
  return map;
}

// يجد اسم الموظف من صفحة Employees حسب المعرّف، مع احتياط لمطابقة اسم المستخدم.
function getUserNameById(userId) {
  const id = String(userId || '').trim();
  if (!id) return '';
  const users = getUsersLite();
  let u = users.find(x => x.id === id);
  if (!u) u = users.find(x => x.username !== '' && normalizeName_(x.username) === normalizeName_(id));
  return u ? (u.name || u.username) : '';
}

// V42: يجمع أسماء كل من يتبع (مباشرة أو عبر التسلسل الهرمي) اسماً معيّناً،
// اعتماداً على صفحة Employees (عمود G / mgr). الـ BFS يغطي عدة مستويات.
function collectSubordinateNames(mgrName, empMgrMap) {
  const result = new Set();
  const start = normalizeName_(mgrName);
  if (!start) return result;
  const queue = [start];
  let guard = 0;
  while (queue.length && guard++ < 2000) {
    const current = queue.shift();
    Object.keys(empMgrMap).forEach(name => {
      if (empMgrMap[name] === current && !result.has(name)) {
        result.add(name);
        queue.push(name);
      }
    });
  }
  return result;
}

// يجمع معرّفات أعضاء الفريق الكامل (التسلسل الهرمي متعدد المستويات من صفحة Employees)
// لمدير معيّن: نفسه + كل من يتبعه مباشرة أو عبر مستوى أدنى.
function getManagerTeamIds(requesterId) {
  const empMgrMap = getEmployeeMgrMap();
  const requesterName = getUserNameById(requesterId);
  const users = getUsersLite();
  // نضمن إدراج المدير نفسه (بالمعرّف أو باسم المستخدم إن كان المعرّف فراغاً).
  const idSet = new Set([String(requesterId).trim()]);
  const requesterNname = normalizeName_(requesterName);
  users.forEach(u => {
    if (u.id === String(requesterId).trim()) idSet.add(u.id);
    if (requesterNname && (u.nname === requesterNname || u.nusername === requesterNname)) idSet.add(u.id);
  });

  if (requesterName && Object.keys(empMgrMap).length) {
    const subNames = collectSubordinateNames(requesterName, empMgrMap);
    users.forEach(u => {
      if (u.nname && subNames.has(u.nname)) idSet.add(u.id);
    });
  }

  return Array.from(idSet);
}

// يحدد معرّفات المستخدمين التي يحق لصاحب الطلب رؤية بياناتهم.
// يعيد null إذا كانت الصلاحية شاملة (admin)، أو مصفوفة معرّفات محصورة (manager/user).
function getTeamMemberIds(requesterId, requesterRole) {
  const role = String(requesterRole || '').trim().toLowerCase();
  const id = String(requesterId || '').trim();
  if (role === 'admin') return null;
  if (role === 'manager') return getManagerTeamIds(id);
  return [id];
}

// قائمة أسماء الموظفين لتعبئة القائمة المنسدلة: admin يرى الجميع، manager يرى فريقه (كل المستويات).
function getTeamOptions(requesterId, requesterRole) {
  const role = String(requesterRole || '').trim().toLowerCase();
  const id = String(requesterId || '').trim();
  if (role !== 'admin' && role !== 'manager') return { status:'success', options: [] };

  const users = getUsersLite();
  let list;
  if (role === 'admin') {
    list = users.filter(u => u.id !== id);
  } else {
    const allowedIds = new Set(getManagerTeamIds(id));
    list = users.filter(u => u.id !== id && allowedIds.has(u.id));
  }

  list.sort((a,b) => String(a.name).localeCompare(String(b.name), 'ar'));
  return { status:'success', options: list.map(u => ({ id:u.id, name:u.name || u.username })) };
}

function normalizeHeaderName(value) {
  return String(value ?? '').trim().replace(/\s+/g,' ').toLowerCase();
}

function getColumnIndex(headers, names, fallback) {
  const normalized = headers.map(normalizeHeaderName);
  for (const name of names) {
    const idx = normalized.indexOf(normalizeHeaderName(name));
    if (idx !== -1) return idx;
  }
  return fallback;
}

function isCancelledValue(value) {
  if (value === true) return true;
  const text = String(value ?? '').trim().toLowerCase();
  // يقبل نفس الكلمات التي يسمّي بها عمود "ملغاء المادة" نفسه، وإلا بقيت
  // المادة الملغاة فعّالة في البيع عند كتابة "ملغي"/"ملغية" بالعربية.
  return ['true', '1', 'yes', 'نعم', 'ملغي', 'ملغية', 'ملغى', 'ملغ', 'الغاء', 'الغي', 'cancelled', 'canceled', 'cancel'].includes(text);
}


function getCompetitorProductsFromSheet() {
  const sheet = aSheet.getSheetByName("ProductsOfCompetitor");
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return [];

  const headers = values[0].map(h => String(h ?? '').trim());
  const productCol = getColumnIndex(headers, ['product','المادة','اسم المادة'], 0);
  const barcodeCol = getColumnIndex(headers, ['barcode','باركود','الباركود'], 1);
  const cancelledCol = getColumnIndex(headers, ['إلغاء المادة','cancelled','canceled','الغاء المادة'], 2);

  return values.slice(1).map(row => {
    const name = String(row[productCol] ?? '').trim();
    const barcode = String(row[barcodeCol] ?? '').trim();
    const cancelled = isCancelledValue(row[cancelledCol]);
    return { name, barcode, cancelled };
  }).filter(p => p.name && !p.cancelled);
}

function getInitialData(forceRefresh) {
  const cacheKey = INITIAL_DATA_CACHE_KEY;
  if (!forceRefresh) {
    const cachedData = cacheGetChunked_(cacheKey);
    if (cachedData) return cachedData;
  } else {
    clearInitialDataCache_();
  }

  // Read only the sheets required by the application instead of scanning every
  // spreadsheet tab on each cache rebuild. This is noticeably faster on large files.
  const requiredSheetNames = ["Locations","Products","ProductsOfCompetitor","Employees","ExpenseItems"];
  const sheetData = {};
  requiredSheetNames.forEach(sheetName => {
    const sheet = aSheet.getSheetByName(sheetName);
    if (sheet && sheet.getLastRow() > 0) {
      sheetData[sheetName] = sheet.getDataRange().getValues();
    }
  });

  const locations = (sheetData.Locations || [[]]).slice(1).map(row => ({gov:row[0], region:row[1], market:row[2]}));
  // V42: صفحة Employees الموحّدة الأعمدة: A=id، B=name، C=username، D=password،
  // E=role (admin/manager/user)، F=jobPosition (المنصب الوظيفي)، G=mgr.
  // "role" على الواجهة = المنصب الوظيفي (مسؤول جرد/منسق نقطة/مروج) كما كانت سابقاً.
  const employees = (sheetData.Employees || [[]]).slice(1).map(row => ({
    id: String(row[0] ?? '').trim(),
    name: String(row[1] ?? '').trim(),
    username: String(row[2] ?? '').trim(),
    systemRole: String(row[4] ?? '').trim().toLowerCase(),
    role: String(row[5] ?? '').trim(),            // jobPosition = المنصب الوظيفي
    mgr: String(row[6] ?? '').trim()
  })).filter(e => e.name || e.id);

  const products = {};
  const productRows = sheetData.Products || [];
  if (productRows.length > 1) {
    const headers = productRows[0];
    const campaignCol = getColumnIndex(headers,['campaign','الحملة'],0);
    const productCol = getColumnIndex(headers,['product','المادة','اسم المادة'],1);
    const priceCol = getColumnIndex(headers,['price','السعر'],2);
    const companyCol = getColumnIndex(headers,['الشركة','company'],3);
    const barcodeCol = getColumnIndex(headers,['barcode','باركود','الباركود'],4);
    const categoryCol = getColumnIndex(headers,['تصنيف المادة','category','التصنيف'],5);
    const cancelledCol = getColumnIndex(headers,['إلغاء المادة','cancelled','canceled','الغاء المادة'],6);
    productRows.slice(1).forEach(row => {
      const campaign = String(row[campaignCol] ?? '').trim();
      const product = String(row[productCol] ?? '').trim();
      if (!campaign || !product || isCancelledValue(row[cancelledCol])) return;
      if (!products[campaign]) products[campaign] = [];
      products[campaign].push({name:product, price:Number(row[priceCol]) || 0, company:String(row[companyCol] ?? '').trim(), barcode:String(row[barcodeCol] ?? '').trim(), category:String(row[categoryCol] ?? '').trim()});
    });
  }

  const expenseItems = {};
  (sheetData.ExpenseItems || [[]]).slice(1).forEach(([campaign,item]) => {
    if (!expenseItems[campaign]) expenseItems[campaign] = [];
    expenseItems[campaign].push(item);
  });

  const initialData = {locations, products, competitorProducts: buildCompetitorProductsFromRows(sheetData.ProductsOfCompetitor || []), employees, expenseItems};
  try {
    cachePutChunked_(cacheKey, JSON.stringify(initialData), CACHE_EXPIRATION_SECONDS);
  } catch (e) {
    // Chunking keeps every entry under the service limit, so this should now be
    // unreachable. If it ever fires, drop whatever partial set was written so a
    // later read cannot mistake it for a complete one.
    clearInitialDataCache_();
  }
  return initialData;
}

// «شاملة» و«مهرجان» حملتان تجميعيتان: تغطّيان مواد كل الحملات وليس لهما صفوف خاصة.
// أي اختلاف في المعاملة بينهما كان يجعل «مهرجان» تُفشل البحث عن الباركود وتُرفض عند حفظ السعر.
const AGGREGATE_CAMPAIGNS_ = ['شاملة', 'مهرجان'];
function isAggregateCampaign_(campaign) {
  return AGGREGATE_CAMPAIGNS_.indexOf(String(campaign || '').trim()) !== -1;
}

// تصنيف مرن: ورقة Products قد تفتقد عمود «تصنيف المادة» أو تستعمل صيغة أخرى.
function isSaleCategory_(value) {
  const t = String(value == null ? '' : value).trim().toLowerCase();
  return !t ? false : /بيع|بيعه|sale|sell/.test(t);
}
function isTastingCategory_(value) {
  const t = String(value == null ? '' : value).trim().toLowerCase();
  return !t ? false : /تذوق|tast|sampl/.test(t);
}

function findProductByBarcode(barcode, campaign) {
  const code = String(barcode || '').trim();
  if (!code) return {status:"error", message:"Barcode is required"};

  // V25: never scan the entire Products sheet for every barcode. Reuse the
  // already-built initial-data cache and search only the relevant campaign.
  const initialData = getInitialData(false);
  const productsByCampaign = initialData.products || {};
  const wantedCampaign = String(campaign || '').trim();
  const campaigns = (!wantedCampaign || isAggregateCampaign_(wantedCampaign))
    ? Object.keys(productsByCampaign)
    : [wantedCampaign];

  for (const camp of campaigns) {
    const list = productsByCampaign[camp] || [];
    // مادة بلا تصنيف (عمود فارغ) تبقى مقبولة حتى لا يختفي منتج بسبب عمود ناقص.
    const match = list.find(p => {
      if (String(p.barcode || '').trim() !== code || p.cancelled) return false;
      const category = String(p.category || '').trim();
      return !category || isSaleCategory_(category);
    });
    if (match) {
      return {status:"success", product:{campaign:camp, name:match.name, price:Number(match.price)||0, company:match.company||'', barcode:String(match.barcode||'').trim(), category:match.category||'', cancelled:false}};
    }
  }
  return {status:"error", message:"Product not found"};
}

function clearReportDetails(reportId) {
  const sheetsToProcess = [
    {sheet:salesSheet, columns:4},
    {sheet:salesOfCompetitorSheet, columns:4},
    {sheet:expensesSheet, columns:3},
    {sheet:promotersSheet, columns:3}
  ];
  sheetsToProcess.forEach(obj => {
    if (!obj.sheet || obj.sheet.getLastRow() < 2) return;
    const data = obj.sheet.getRange(1,1,obj.sheet.getLastRow(),obj.columns).getValues();
    const headers = data.shift();
    const dataToKeep = data.filter(row => String(row[0]) !== String(reportId));
    obj.sheet.clearContents();
    obj.sheet.getRange(1,1,1,headers.length).setValues([headers]);
    if (dataToKeep.length) obj.sheet.getRange(2,1,dataToKeep.length,dataToKeep[0].length).setValues(dataToKeep);
  });
}

function addReportDetails(reportData) {
  const reportId = String(reportData.id);
  if (reportData.sales && reportData.sales.length) {
    const salesRows = reportData.sales.map(s => [reportId,s.product,Number(s.price)||0,Number(s.quantity)||0]);
    salesSheet.getRange(salesSheet.getLastRow()+1,1,salesRows.length,4).setValues(salesRows);
  }
  if (reportData.salesOfCompetitor && reportData.salesOfCompetitor.length && salesOfCompetitorSheet) {
    const rows = reportData.salesOfCompetitor.map(s => [reportId,s.product,Number(s.price)||0,Number(s.quantity)||0]);
    salesOfCompetitorSheet.getRange(salesOfCompetitorSheet.getLastRow()+1,1,rows.length,4).setValues(rows);
  }
  if (reportData.expenses && reportData.expenses.length) {
    const expenseRows = reportData.expenses.map(e => [reportId,e.item,Number(e.quantity)||0]);
    expensesSheet.getRange(expensesSheet.getLastRow()+1,1,expenseRows.length,3).setValues(expenseRows);
  }
  if (reportData.promoters && reportData.promoters.length) {
    const promoterRows = reportData.promoters.filter(p => p && String(p).trim()).map(p => [reportId,p,reportData.date]);
    if (promoterRows.length) promotersSheet.getRange(promotersSheet.getLastRow()+1,1,promoterRows.length,3).setValues(promoterRows);
  }
}

function buildCompetitorProductsFromRows(rows) {
  const result = [];
  if (!Array.isArray(rows) || rows.length < 2) return result;
  const headers = rows[0];
  const productCol = getColumnIndex(headers,['product','المادة','اسم المادة'],0);
  const barcodeCol = getColumnIndex(headers,['barcode','باركود','الباركود'],1);
  const cancelledCol = getColumnIndex(headers,['إلغاء المادة','cancelled','canceled','الغاء المادة'],2);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const product = String(row[productCol] ?? '').trim();
    if (!product || isCancelledValue(row[cancelledCol])) continue;
    // `product` duplicated `name` byte-for-byte and was never read (the client
    // filters competitorProducts on .name and looks them up by .barcode). At ~1k
    // competitor rows that duplicate string was pure login payload. `cancelled`
    // is dropped too: isCancelledValue() above already excluded cancelled rows,
    // so it was always false — and both readers (`String(p.cancelled ?? '')`,
    // `p.cancelled === true`) treat an absent key exactly like false.
    result.push({name: product, barcode: String(row[barcodeCol] ?? '').trim()});
  }
  return result;
}

// Updates master prices without rewriting the whole Products sheet.
function updateProductPrices(reportData) {
  const sheet = aSheet.getSheetByName('Products');
  if (!sheet || sheet.getLastRow() < 2 || !reportData || !Array.isArray(reportData.sales)) return;
  if (String(reportData.event || '').trim() !== 'ترويج وبيع مباشر') return;

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1,1,1,lastCol).getValues()[0];
  const productCol = getColumnIndex(headers,['product','المادة','اسم المادة'],1);
  const priceCol = getColumnIndex(headers,['price','السعر'],2);
  const campaignCol = getColumnIndex(headers,['campaign','الحملة'],0);

  const products = sheet.getRange(2, productCol + 1, lastRow - 1, 1).getValues();
  const campaigns = sheet.getRange(2, campaignCol + 1, lastRow - 1, 1).getValues();
  const prices = sheet.getRange(2, priceCol + 1, lastRow - 1, 1).getValues();

  const reportCampaign = String(reportData.campaign ?? '').trim();
  const requested = new Map();
  reportData.sales.forEach(s => {
    const name = String(s.product ?? '').trim();
    const price = Number(s.price);
    if (!name || !Number.isFinite(price)) return;
    const campaign = String(s.campaign ?? reportCampaign).trim();
    requested.set(`${campaign}|||${name}`, price);
  });
  if (!requested.size) return;

  let changed = false;
  for (let i = 0; i < products.length; i++) {
    const name = String(products[i][0] ?? '').trim();
    const rowCampaign = String(campaigns[i][0] ?? '').trim();
    if (!name) continue;
    let newPrice = requested.get(`${rowCampaign}|||${name}`);
    // الحملات التجميعية (شاملة/مهرجان) تُطابق بالاسم فقط لأن المادة قد تُسجَّل تحت حملة أخرى.
    if (newPrice === undefined && isAggregateCampaign_(reportCampaign)) {
      const matches = [...requested.entries()].filter(([k]) => k.endsWith(`|||${name}`));
      if (matches.length === 1) newPrice = matches[0][1];
    }
    if (newPrice !== undefined && Number(prices[i][0]) !== newPrice) {
      prices[i][0] = newPrice;
      changed = true;
    }
  }
  if (changed) {
    // One write for the price column instead of rewriting every Products cell.
    sheet.getRange(2, priceCol + 1, prices.length, 1).setValues(prices);
    SpreadsheetApp.flush();
    clearInitialDataCache_();
    clearReportsCache_();
  }
}

function ensureReportsColumn(columnName) {
  const headers = reportsSheet.getRange(1,1,1,reportsSheet.getLastColumn()).getValues()[0];
  const idx = headers.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName(columnName));
  if (idx !== -1) return idx + 1;
  const newCol = reportsSheet.getLastColumn() + 1;
  reportsSheet.getRange(1,newCol).setValue(columnName);
  return newCol;
}

function updateProductPrice(payload) {
  payload = payload || {};
  // V67: تغيير الأسعار للإداري/المدير فقط.
  const updaterRole = String(payload.role || '').trim().toLowerCase();
  if (updaterRole !== 'admin' && updaterRole !== 'manager') {
    throw new Error('صلاحية تعديل أسعار المواد متاحة للإداري (admin) والمدير (manager) فقط');
  }
  const productName = String(payload.product || '').trim();
  const campaign = String(payload.campaign || '').trim();
  const price = Number(payload.price);
  const barcode = String(payload.barcode || '').trim();
  if (!productName) throw new Error('اسم المادة مطلوب');
  if (!campaign) throw new Error('نوع الحملة مطلوب');
  if (!Number.isFinite(price) || price < 0) throw new Error('السعر غير صالح');

  const sheet = aSheet.getSheetByName('Products');
  if (!sheet || sheet.getLastRow() < 2) throw new Error('Products sheet is empty');
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1,1,1,lastCol).getValues()[0];
  const productCol = getColumnIndex(headers,['product','المادة','اسم المادة'],1);
  const priceCol = getColumnIndex(headers,['price','السعر'],2);
  const campaignCol = getColumnIndex(headers,['campaign','الحملة'],0);
  const barcodeCol = getColumnIndex(headers,['barcode','باركود','الباركود'],4);

  const names = sheet.getRange(2, productCol + 1, lastRow - 1, 1).getValues();
  const campaigns = sheet.getRange(2, campaignCol + 1, lastRow - 1, 1).getValues();
  const barcodes = sheet.getRange(2, barcodeCol + 1, lastRow - 1, 1).getValues();
  const prices = sheet.getRange(2, priceCol + 1, lastRow - 1, 1).getValues();

  let matches = 0;
  for (let i = 0; i < names.length; i++) {
    const rowName = String(names[i][0] ?? '').trim();
    const rowCampaign = String(campaigns[i][0] ?? '').trim();
    const rowBarcode = String(barcodes[i][0] ?? '').trim();
    // الحملات التجميعية تُطابق بالاسم فقط: المادة قد تكون مسجّلة تحت حملة أخرى في الورقة.
    const campaignMatches = isAggregateCampaign_(campaign)
      ? rowName === productName
      : (rowCampaign === campaign && rowName === productName);
    if (!campaignMatches) continue;
    if (barcode && rowBarcode && rowBarcode !== barcode) continue;
    prices[i][0] = price;
    matches++;
  }
  if (!matches) throw new Error('المادة غير موجودة ضمن الحملة المحددة');

  // Only the price column is written. This is dramatically faster than setValues on the entire sheet.
  sheet.getRange(2, priceCol + 1, prices.length, 1).setValues(prices);
  SpreadsheetApp.flush();
  clearInitialDataCache_();
  clearReportsCache_();
  getInitialData(true);

  return {status:'success', updated:matches, price:price, cacheRefreshed:true};
}

function refreshCache() {
  clearInitialDataCache_();
  clearReportsCache_();
  cache.removeAll([
    'allReports',
    'allReports_v2',
    FESTIVAL_MOVEMENTS_CACHE_KEY
  ]);

  // إعادة بناء بيانات الموقع فوراً من الـSheet، وليس فقط حذف الكاش.
  const initialData = getInitialData(true);
  return {
    status:'success',
    message:'تم تحديث جميع بيانات الموقع والكاش بنجاح',
    initialData: initialData,
    refreshedAt: new Date().toISOString()
  };
}

/**
 * Locate a report's sheet row from its id.
 *
 * Every submit/review/delete used `getRange('A2:A')`, an open-ended range whose
 * cost depends on how far the sheet is allowed to stretch. The bound is written
 * out instead, so the read is exactly the rows that exist.
 *
 * @return {number} 0-based index into the rows below the header, or -1.
 */
function reportRowIndexById(reportId) {
  const lastRow = reportsSheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = reportsSheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(String);
  return ids.indexOf(String(reportId));
}

/**
 * Report columns that belong to the server and are never part of the report form.
 *
 * Two separate problems are solved by one rule.
 *
 * 1. Data loss. The row used to be rebuilt from the payload and wrote '' for
 *    every key the form did not send (headers.map(h => reportData[h] === undefined ? '' : ...)).
 *    getFormState() in page-reports.js sends form fields only, so these columns
 *    were never in the payload: every edit silently erased them. An approved
 *    report looked unapproved again, the rejection reason vanished, and an
 *    attached photo/signature was dropped — with no error shown.
 *
 * 2. Privilege escalation. They must not be restored merely by default; if a
 *    client sends `approvalStatus: 'approved'` the old merge wrote it, which let
 *    any user self-approve their own report through submitReport. So on edit
 *    they are taken from the stored row unconditionally and the submitted value
 *    is discarded, and on create they are forced empty. The only writers are
 *    reviewReport(), deleteReport() and whatever legacy flow owns photo/signature.
 */
const REPORT_SERVER_OWNED_COLUMNS = [
  'approvalStatus', 'approvedBy', 'approvedAt',
  'rejectionReason', 'rejectionBy',
  'photo', 'signature',
  'deletedAt', 'deletedBy'
];
function handleReportSubmission(reportData) {
  reportData = reportData || {};
  ensureReportsColumn('createdById');
  ensureReportsColumn('createdByName');
  // V50: أعمدة الإثباتات وحالة الاعتماد (تُنشأ تلقائياً عند الحاجة).
  ['photo', 'signature', 'approvalStatus', 'approvedBy', 'approvedAt'].forEach(ensureReportsColumn);
  // V61: أعمدة أثر التعديل والموقع الجغرافي والحذف الناعم.
  ['editedAt', 'editedBy', 'latitude', 'longitude', 'deletedAt', 'deletedBy'].forEach(ensureReportsColumn);
  const submittedUserId = String(reportData.userId || reportData.createdById || '').trim();
  const submittedUserName = String(reportData.userName || reportData.createdByName || '').trim();
  // رقم الهاتف اختياري دائماً ولا يُشترط في أي نوع من الأحداث. كان شرطاً
  // لنوع واحد ("ترويج وبيع غير مباشر") فيتحقق في الخادم فقط، فكان الحقل يبدو
  // اختيارياً في النموذج ثم يرفض الحفظ برسالة لا تربط الخطأ بالحقل.
  const phoneNumber = String(reportData.phoneNumber || '').trim();
  // المسافات وحدها ليست رقماً. الصف يُبنى من reportData مباشرة (انظر newRow)،
  // فنُعيد القيمة بعد التشذيب وإلا خُزِّنت الخلية بمسافات كأنها رقم هاتف.
  reportData.phoneNumber = phoneNumber;
  ensureReportsColumn('phoneNumber');
  const headers = reportsSheet.getRange(1,1,1,reportsSheet.getLastColumn()).getValues()[0];
  const reportId = String(reportData.id);
  const existingRowIndex = reportRowIndexById(reportId);
  // عند التعديل نُبقي مالك التقرير الأصلي كما هو.
  if (existingRowIndex !== -1) {
    const existingRow = reportsSheet.getRange(existingRowIndex + 2, 1, 1, headers.length).getValues()[0];
    const ownerIdCol = headers.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName('createdById'));
    const ownerNameCol = headers.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName('createdByName'));
    if (ownerIdCol >= 0 && String(existingRow[ownerIdCol] || '').trim()) reportData.createdById = String(existingRow[ownerIdCol]);
    if (ownerNameCol >= 0 && String(existingRow[ownerNameCol] || '').trim()) reportData.createdByName = String(existingRow[ownerNameCol]);
    // V67: عند التعديل يُسمح للحفظ لمالك التقرير أو لإداري/مدير/مدقق فقط.
    const ownerId = ownerIdCol >= 0 ? String(existingRow[ownerIdCol] || '').trim() : '';
    const ownerName = ownerNameCol >= 0 ? String(existingRow[ownerNameCol] || '').trim() : '';
    const requesterRole = String(reportData.role || '').trim().toLowerCase();
    const isOwner = ownerId !== '' && submittedUserId !== '' && ownerId === submittedUserId;
    if (!isOwner && requesterRole !== 'admin' && requesterRole !== 'manager' && requesterRole !== 'auditor') {
      const ownerLabel = ownerName || ownerId || 'شخص آخر';
      throw new Error('لا يمكنك تعديل تقرير أنشأه ' + ownerLabel + ' — هذه الصلاحية لصاحب التقرير أو للإداري/المدير فقط');
    }
    // Rule: these are the server's columns, not the form's. Take the stored
    // value and ignore whatever the request sent — a payload that tries to
    // set or clear them must not be able to forge or wipe an approval.
    REPORT_SERVER_OWNED_COLUMNS.forEach(name => {
      const col = headers.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName(name));
      if (col >= 0) reportData[name] = existingRow[col];
      else delete reportData[name];
    });
  }

  // ملكية التقرير: تُحفظ عند الإنشاء، وعند التعديل يتم الحفاظ على المالك الأصلي أعلاه.
  if (existingRowIndex === -1) {
    reportData.createdById = submittedUserId;
    reportData.createdByName = submittedUserName;
    // تقرير جديد يبدأ بلا اعتماد. بدون هذا كان بإمكان الطلب إنشاء تقرير
    // يصل مسبقاً بحالة "معتمد" متجاوزاً reviewReport بالكامل.
    REPORT_SERVER_OWNED_COLUMNS.forEach(name => { reportData[name] = ''; });
  } else {
    // V61: سجل آخر تعديل — القيمة تُرسل من الواجهة وإلا نأخذ هوية المستخدم الحالي.
    reportData.editedAt = String(reportData.editedAt || new Date().toISOString());
    reportData.editedBy = String(reportData.editedBy || submittedUserName || submittedUserId || '');
  }

  const newRow = headers.map(header => reportData[header] === undefined ? '' : (Array.isArray(reportData[header]) ? JSON.stringify(reportData[header]) : reportData[header]));

  if (existingRowIndex !== -1) {
    reportsSheet.getRange(existingRowIndex+2,1,1,newRow.length).setValues([newRow]);
    clearReportDetails(reportId);
  } else {
    reportsSheet.appendRow(newRow);
  }

  addReportDetails(reportData);
  updateProductPrices(reportData);
  syncReportExpensesToFestivalMovement(reportData);
  clearInitialDataCache_();
  clearReportsCache_();
  cache.removeAll(['allReports','allReports_v2']);
  return {status:'success', reportId:reportId};
}

// تحويل قيم التاريخ والوقت القادمة من Google Sheets إلى صيغة مناسبة
// مباشرة لحقول HTML من نوع date / time.
// مهم عند التعديل: نقرأ القيمة الفعلية من Reports ثم نعيدها كـ yyyy-MM-dd و HH:mm.
function normalizeReportDateTimeFields(reportObj) {
  if (!reportObj) return reportObj;

  const timezone = aSheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'GMT';

  const formatDateValue = (value) => {
    if (value === null || value === undefined || value === '') return '';
    if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
      return Utilities.formatDate(value, timezone, 'yyyy-MM-dd');
    }
    const text = String(value).trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    // إذا كانت القيمة النصية ISO/تاريخاً قابلاً للتحويل، نعيدها بصيغة حقل date.
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return Utilities.formatDate(parsed, timezone, 'yyyy-MM-dd');
    }
    return text;
  };

  const formatTimeValue = (value) => {
    if (value === null || value === undefined || value === '') return '';
    if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
      return Utilities.formatDate(value, timezone, 'HH:mm');
    }

    const text = String(value).trim();
    if (!text) return '';

    // قيم الوقت المعتادة: 09:30 أو 09:30:00
    let match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (match) {
      return `${String(Number(match[1])).padStart(2,'0')}:${match[2]}`;
    }

    // قد تكون القيمة ISO أو نصاً ناتجاً عن Date.
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return Utilities.formatDate(parsed, timezone, 'HH:mm');
    }
    return text;
  };

  reportObj.date = formatDateValue(reportObj.date);
  reportObj.timeFrom = formatTimeValue(reportObj.timeFrom);
  reportObj.timeTo = formatTimeValue(reportObj.timeTo);

  return reportObj;
}

function getReports(userId, userRole, userName, targetUserId) {
  // v2 حتى لا نستخدم بيانات allReports القديمة المخزنة قبل إصلاح التاريخ والوقت.
  const cacheKey = REPORTS_CACHE_KEY;
  const cached = cacheGetChunked_(cacheKey);
  let allReports;
  if (cached) {
    allReports = cached;
  } else {
    if (reportsSheet.getLastRow() < 2) return [];
  const reportsData = reportsSheet.getDataRange().getValues();
  // الأوراق المرتبطة اختيارية: غياب أي منها أو إعادة تسميته كان يرمي استثناءً
  // يوقف صفحة «سجل التعديلات» بالكامل بدون رسالة واضحة.
  const readSheet_ = (sheet) => {
    try { return sheet && sheet.getLastRow() > 1 ? sheet.getDataRange().getValues() : []; }
    catch (e) { return []; }
  };
  const salesData = readSheet_(salesSheet);
  const competitorSalesData = readSheet_(salesOfCompetitorSheet);
  const expensesData = readSheet_(expensesSheet);
  const promotersData = readSheet_(promotersSheet);
  const reportHeaders = reportsData.shift();
  const reportsMap = new Map();
  reportsData.forEach(row => {
    if (!row[0]) return;
    const reportObj = {};
    reportHeaders.forEach((header,index) => {
      if (header === 'participants' || header === 'promoters') {
        try { reportObj[header] = JSON.parse(row[index] || '[]'); } catch(e) { reportObj[header]=[]; }
      } else if (header === 'photo' || header === 'signature') {
        // V50: لا تُحمَّل الصور/التوقيعات مع قوائم التقارير (تضخيم غير ضروري).
        // تُقرأ عند الحاجة فقط عبر getReportById.
      } else reportObj[header]=row[index];
    });
    reportObj.sales=[]; reportObj.salesOfCompetitor=[]; reportObj.expenses=[];
    normalizeReportDateTimeFields(reportObj);
    reportsMap.set(String(reportObj.id),reportObj);
  });
  if (salesData.length) {
    salesData.shift();
    salesData.forEach(([id,product,price,quantity]) => { const report=reportsMap.get(String(id)); if(report) report.sales.push({product,price,quantity}); });
  }
  if (competitorSalesData.length) {
    competitorSalesData.shift();
    competitorSalesData.forEach(([id,product,price,quantity]) => { const report=reportsMap.get(String(id)); if(report) report.salesOfCompetitor.push({product,price,quantity}); });
  }
  if (expensesData.length) {
    expensesData.shift();
    expensesData.forEach(([id,item,quantity]) => { const report=reportsMap.get(String(id)); if(report) report.expenses.push({item,quantity}); });
  }
  if (promotersData.length) {
    promotersData.shift();
    promotersData.forEach(([id,name]) => { const report=reportsMap.get(String(id)); if(report){ if(!Array.isArray(report.promoters)) report.promoters=[]; if(name) report.promoters.push(name); } });
  }
    allReports=Array.from(reportsMap.values());
    // V61: استبعاد التقارير المحذوفة (حذف ناعم — deletedAt ممتلئ) من كل القوائم والكاش.
    allReports = allReports.filter(r => !String(r.deletedAt || '').trim());
    try {
      cachePutChunked_(cacheKey, JSON.stringify(allReports), REPORT_CACHE_EXPIRATION_SECONDS);
    } catch (e) {
      // Same guard as initial data: never leave a half-written set that a later
      // read could mistake for complete.
      clearReportsCache_();
    }
  }

  // سجل المستخدم: نعتمد على createdById، مع fallback إلى الاسم للتقارير القديمة/التي لا تحتوي المعرّف.
  const normalizedRole = String(userRole || '').trim().toLowerCase();
  if (!userId) return allReports;
  const uid = String(userId).trim();
  const uname = String(userName || '').trim();

  // نطاق الصلاحية: null = الكل (admin)، أو مصفوفة معرّفات مسموحة (manager: فريقه، user: نفسه فقط).
  let allowedIds = getTeamMemberIds(uid, normalizedRole);

  // إذا طلب المستخدم عرض موظف/تقارير محددة عبر القائمة المنسدلة، نُضيّق النطاق إليه
  // شرط أن يكون ضمن صلاحياته أصلاً (حماية من تجاوز الصلاحيات).
  const target = String(targetUserId || '').trim();
  if (target && target !== 'all' && target !== 'الكل') {
    if (allowedIds === null || allowedIds.indexOf(target) !== -1) {
      allowedIds = [target];
    }
  }

  if (allowedIds === null) return allReports; // admin بدون تضييق إضافي

  const idsSet = new Set(allowedIds);
  // V42: نطابق أيضاً بالأسماء/أسماء المستخدمين — لأي تقرير يفتقد createdById،
  // نسمح به لو كان createdByName لأحد أعضاء الفريق (لا نقصر على المستخدم نفسه).
  const allowedNameSet = new Set();
  getUsersLite().forEach(u => {
    if (allowedIds.indexOf(u.id) !== -1) {
      if (u.nname) allowedNameSet.add(u.nname);
      if (u.nusername) allowedNameSet.add(normalizeName_(u.nusername));
    }
  });

  return allReports.filter(r => {
    const ownerId = String(r.createdById || '').trim();
    if (ownerId && idsSet.has(ownerId)) return true;
    const ownerName = String(r.createdByName || '').trim();
    return !!ownerName && allowedNameSet.has(normalizeName_(ownerName));
  });
}

/**
 * صفحة تقارير خفيفة للـ History: تعيد فقط الدفعة المطلوبة بدل نقل كل الأرشيف
 * إلى المتصفح في كل زيارة. تعتمد على getReports()، لذلك تستفيد من كاش التقارير
 * الموجود مسبقاً، ومع وجود الكاش لا تُجرى أي قراءة جديدة من Sheets.
 *
 * البحث النصي المتقدم بقي في الواجهة للحفاظ على نفس السلوك القديم، بينما التصفح
 * الافتراضي + فلتر الموظف يستخدمان هذا المسار الخفيف.
 */
function getReportsPage(userId, userRole, userName, targetUserId, page, pageSize) {
  const rawPage = Number(page);
  const rawSize = Number(pageSize);
  const pageNumber = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const size = Number.isInteger(rawSize) && rawSize > 0
    ? Math.min(rawSize, REPORTS_PAGE_MAX_SIZE_)
    : REPORTS_PAGE_DEFAULT_SIZE_;

  const rows = getReports(userId, userRole, userName, targetUserId);
  const total = Array.isArray(rows) ? rows.length : 0;
  // getReports يحتفظ بترتيب الصفوف كما هي في الشيت (الأقدم → الأحدث)، بينما
  // شاشة السجل تعرض الأحدث أولاً. نُرتّب مرة واحدة في الذاكرة ثم نأخذ نافذة الصفحة.
  const ordered = total ? rows.slice().reverse() : [];
  const start = (pageNumber - 1) * size;
  const items = ordered.slice(start, start + size);

  // خيارات الفلاتر صغيرة جداً مقارنة بأرشيف التقارير، لذلك نعيدها مع أول صفحة
  // بدل إجبار العميل على تنزيل كامل الأرشيف فقط لبناء قوائم الحملة/الحدث.
  let filterOptions = null;
  if (pageNumber === 1) {
    const campaigns = new Set();
    const events = new Set();
    rows.forEach(r => {
      if (r && r.campaign) campaigns.add(String(r.campaign));
      if (r && r.event) events.add(String(r.event));
    });
    filterOptions = {
      campaigns: Array.from(campaigns).sort(),
      events: Array.from(events).sort()
    };
  }

  return {
    status: 'success',
    page: pageNumber,
    pageSize: size,
    total,
    hasMore: start + items.length < total,
    items,
    filterOptions
  };
}

function getReportById(id, requester) {
  // V67: البحث داخل نطاق صلاحية الطالب فقط (لا يكشف تقارير المستخدمين الآخرين).
  const req = requester || {};
  const report = getReports(req.id, req.systemRole, req.name, '').find(r => String(r.id) === String(id));
  if (!report) return {status:'error',message:'Report not found'};
  // V50: قراءة الصورة والتوقيع لهذا التقرير فقط (مستثناة من قوائم getReports).
  try {
    const headers = reportsSheet.getRange(1,1,1,reportsSheet.getLastColumn()).getValues()[0];
    const idx = reportRowIndexById(id);
    if (idx !== -1) {
      const values = reportsSheet.getRange(idx + 2, 1, 1, headers.length).getValues()[0];
      headers.forEach((h,i) => { if (h === 'photo' || h === 'signature') report[h] = values[i] || ''; });
    }
  } catch (e) { /* تجاهل أخطاء القراءة التفصيلية */ }
  return {status:'success',report:report};
}

// ===============================================================
// V42: بيانات لوحة التحليلات (dashboard.html) — إحصائيات مجمّعة سريعة
// ===============================================================
function getDashboardData(userId, userRole) {
  // نعيد تقارير النطاق المسموح به فقط (نفس منطق getReports لكن بدون تفاصيل المبيعات الكاملة).
  const role = String(userRole || '').trim().toLowerCase();
  const uid = String(userId || '').trim();
  const all = getReports(uid, role, '', 'all'); // خاضع للصلاحيات admin/manager/user
  if (!Array.isArray(all)) return { status:'success', kpis:{}, daily:{}, campaigns:[], governorates:[], employees:[] };

  // ---- KPIs ----
  let totalSales = 0, totalQty = 0;
  const employeesSet = new Set();
  all.forEach(r => {
    (r.sales || []).forEach(s => {
      totalSales += (Number(s.price) || 0) * (Number(s.quantity) || 0);
      totalQty += Number(s.quantity) || 0;
    });
    if (r.createdByName) employeesSet.add(String(r.createdByName));
  });

  // ---- Daily sales (آخر 30 يوم) ----
  const dailyMap = {};
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = Utilities.formatDate(d, aSheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone(), 'yyyy-MM-dd');
    dailyMap[key] = 0;
  }
  all.forEach(r => {
    if (!r.date) return;
    const key = String(r.date).slice(0, 10);
    if (!(key in dailyMap)) return;
    let sum = 0;
    (r.sales || []).forEach(s => sum += (Number(s.price) || 0) * (Number(s.quantity) || 0));
    dailyMap[key] += sum;
  });

  // ---- Campaign totals ----
  const campMap = {};
  all.forEach(r => {
    const c = String(r.campaign || 'غير محدد');
    if (!campMap[c]) campMap[c] = 0;
    (r.sales || []).forEach(s => campMap[c] += (Number(s.price) || 0) * (Number(s.quantity) || 0));
  });

  // ---- Governorate totals ----
  const govMap = {};
  all.forEach(r => {
    const g = String(r.governorate || 'غير محدد');
    if (!govMap[g]) govMap[g] = 0;
    (r.sales || []).forEach(s => govMap[g] += (Number(s.price) || 0) * (Number(s.quantity) || 0));
  });

  // ---- Employee performance ----
  const empMap = {};
  all.forEach(r => {
    const name = String(r.createdByName || 'غير معروف');
    if (!empMap[name]) empMap[name] = { name, reports: 0, sales: 0 };
    empMap[name].reports++;
    (r.sales || []).forEach(s => empMap[name].sales += (Number(s.price) || 0) * (Number(s.quantity) || 0));
  });
  const employees = Object.values(empMap).sort((a,b) => b.sales - a.sales).slice(0, 15);

  const zip = (obj, max = 100) => Object.entries(obj).sort((a,b) => b[1]-a[1]).slice(0, max).map(([label, value]) => ({ label, value }));

  return {
    status: 'success',
    kpis: {
      totalReports: all.length,
      totalSales: Math.round(totalSales * 100) / 100,
      totalQuantity: totalQty,
      activeEmployees: employeesSet.size
    },
    daily: Object.keys(dailyMap).map(k => ({ date: k, value: dailyMap[k] })),
    campaigns: zip(campMap),
    governorates: zip(govMap, 10),
    employees
  };
}

// ===============================================================
// V44: أرشفة التقارير القديمة يدوياً (تُستخدم عادة مرة شهرياً) — تنقل التقارير
// الأقدم من عدد الأشهر المحدد، وكل بياناتها المرتبطة (sales/salesOfCompetitor/
// expenses/promoters/festivalMovement) إلى أوراق أرشيف منفصلة (تُنشأ تلقائياً
// إن لم تكن موجودة)، ثم تُفرغ كل الكاش فوراً حتى لا يبقى أي فرق بين البيانات
// الحقيقية والمعروضة. متاحة لحساب admin فقط، لأنها عملية شاملة على كل التقارير
// بغض النظر عن الفريق (لا معنى لأرشفة جزئية لفريق واحد فقط).
// ===============================================================
function ensureArchiveSheet(name, headers) {
  let sheet = aSheet.getSheetByName(name);
  if (!sheet) {
    sheet = aSheet.insertSheet(name);
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
  } else if (sheet.getLastRow() < 1) {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
  }
  return sheet;
}

function appendRowsToArchive(archiveSheet, rows) {
  if (!rows.length) return;
  archiveSheet.getRange(archiveSheet.getLastRow()+1,1,rows.length,rows[0].length).setValues(rows);
}

function archiveOldReports(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin') throw new Error('أرشفة التقارير القديمة متاحة فقط لحساب admin');

  const monthsToKeep = Number(payload.monthsToKeep);
  if (!Number.isFinite(monthsToKeep) || monthsToKeep <= 0) throw new Error('عدد الأشهر يجب أن يكون رقماً أكبر من صفر');

  const timezone = aSheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'GMT';
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsToKeep);
  const cutoffStr = Utilities.formatDate(cutoff, timezone, 'yyyy-MM-dd');

  if (reportsSheet.getLastRow() < 2) return { status:'success', archivedReports:0, cutoff: cutoffStr };

  // --- 1) تقسيم ورقة Reports إلى (تُبقى) و(تُؤرشف) حسب عمود date ---
  const reportsValues = reportsSheet.getDataRange().getValues();
  const reportHeaders = reportsValues[0];
  const dateColIdx = reportHeaders.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName('date'));
  const idColIdx = reportHeaders.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName('id'));
  if (dateColIdx === -1 || idColIdx === -1) throw new Error('تعذر تحديد عمودي id/date في ورقة Reports');

  const dataRows = reportsValues.slice(1);
  const toArchive = [];
  const toKeep = [];
  const archivedIds = new Set();
  dataRows.forEach(row => {
    const rowDate = String(row[dateColIdx] || '').slice(0, 10);
    if (rowDate && rowDate < cutoffStr) {
      toArchive.push(row);
      archivedIds.add(String(row[idColIdx]));
    } else {
      toKeep.push(row);
    }
  });

  if (!toArchive.length) {
    return { status:'success', archivedReports:0, cutoff: cutoffStr, message: 'لا توجد تقارير أقدم من هذا التاريخ لأرشفتها' };
  }

  // --- 2) نقل ورقة Reports نفسها ---
  const reportsArchiveSheet = ensureArchiveSheet('Reports_Archive', reportHeaders);
  appendRowsToArchive(reportsArchiveSheet, toArchive);
  reportsSheet.clearContents();
  reportsSheet.getRange(1,1,1,reportHeaders.length).setValues([reportHeaders]);
  if (toKeep.length) reportsSheet.getRange(2,1,toKeep.length,reportHeaders.length).setValues(toKeep);

  // --- 3) نفس المنطق لبقية الأوراق المرتبطة (مفتاحها reportId في العمود الأول) ---
  const relatedSheets = [
    { sheet: salesSheet, archiveName: 'sales_Archive' },
    { sheet: salesOfCompetitorSheet, archiveName: 'salesOfCompetitor_Archive' },
    { sheet: expensesSheet, archiveName: 'expenses_Archive' },
    { sheet: promotersSheet, archiveName: 'promoters_Archive' }
  ];
  relatedSheets.forEach(({ sheet, archiveName }) => {
    if (!sheet || sheet.getLastRow() < 2) return;
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const rows = values.slice(1);
    const keep = [];
    const archive = [];
    rows.forEach(row => {
      if (archivedIds.has(String(row[0]))) archive.push(row); else keep.push(row);
    });
    if (!archive.length) return;
    const archiveSheet = ensureArchiveSheet(archiveName, headers);
    appendRowsToArchive(archiveSheet, archive);
    sheet.clearContents();
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
    if (keep.length) sheet.getRange(2,1,keep.length,headers.length).setValues(keep);
  });

  // --- 4) نفس المنطق لورقة festivalMovement — الحركات اليدوية (سحب/مرتجع) التي لا
  //         تحمل reportId (فارغة) لا تُؤرشف أبداً لأنها غير مرتبطة بتقرير محدد أصلاً ---
  const movementSheet = aSheet.getSheetByName(FESTIVAL_MOVEMENT_SHEET_NAME);
  if (movementSheet && movementSheet.getLastRow() > 1) {
    const values = movementSheet.getDataRange().getValues();
    const headers = values[0];
    const rows = values.slice(1);
    const keep = [];
    const archive = [];
    rows.forEach(row => {
      const rid = String(row[0] || '').trim();
      if (rid && archivedIds.has(rid)) archive.push(row); else keep.push(row);
    });
    if (archive.length) {
      const archiveSheet = ensureArchiveSheet('festivalMovement_Archive', headers);
      appendRowsToArchive(archiveSheet, archive);
      movementSheet.clearContents();
      movementSheet.getRange(1,1,1,headers.length).setValues([headers]);
      if (keep.length) movementSheet.getRange(2,1,keep.length,headers.length).setValues(keep);
    }
  }

  // --- 5) تفريغ كل الكاش فوراً حتى لا يبقى أي فرق بين البيانات الحقيقية والمعروضة ---
  try {
    clearInitialDataCache_();
  clearReportsCache_();
  cache.removeAll(['allReports','allReports_v2']);
    cache.remove(FESTIVAL_MOVEMENTS_CACHE_KEY);
  } catch (e) {}

  return { status:'success', archivedReports: toArchive.length, cutoff: cutoffStr };
}

// V69.1: أرشفة سجلات الدوام القديمة — خيار منفصل عن أرشفة التقارير. للإداري (admin) فقط.
// يحوّل الصفوف الأقدم من عدد الأشهر المحدد إلى ورقة attendance_Archive في نفس الملف.
function archiveOldAttendance(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin') throw new Error('أرشفة سجلات الدوام القديمة متاحة فقط لحساب admin');

  const monthsToKeep = Number(payload.monthsToKeep);
  if (!Number.isFinite(monthsToKeep) || monthsToKeep <= 0) throw new Error('عدد الأشهر يجب أن يكون رقماً أكبر من صفر');

  const timezone = aSheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'GMT';
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsToKeep);
  const cutoffStr = Utilities.formatDate(cutoff, timezone, 'yyyy-MM-dd');

  const sheet = getAttendanceSheet_();
  if (sheet.getLastRow() < 2) return { status:'success', archivedAttendance:0, cutoff: cutoffStr, message: 'لا توجد سجلات دوام' };

  const lastCol = Math.max(sheet.getLastColumn(), ATTENDANCE_HEADERS.length);
  const values = sheet.getDataRange().getValues();
  const dataRows = values.slice(1);
  const toArchive = [];
  const toKeep = [];
  dataRows.forEach(row => {
    const cell = row[0];
    const rowDate = cell instanceof Date
      ? Utilities.formatDate(cell, timezone, 'yyyy-MM-dd')
      : String(cell || '').slice(0, 10);
    if (rowDate && rowDate < cutoffStr) toArchive.push(row); else toKeep.push(row);
  });

  if (!toArchive.length) {
    return { status:'success', archivedAttendance:0, cutoff: cutoffStr, message: 'لا توجد سجلات دوام أقدم من هذا التاريخ لأرشفتها' };
  }

  const archiveSheet = ensureArchiveSheet('attendance_Archive', ATTENDANCE_HEADERS);
  appendRowsToArchive(archiveSheet, toArchive);
  sheet.clearContents();
  sheet.getRange(1,1,1,ATTENDANCE_HEADERS.length).setValues([ATTENDANCE_HEADERS]);
  if (toKeep.length) sheet.getRange(2,1,toKeep.length,lastCol).setValues(toKeep);

  return { status:'success', archivedAttendance: toArchive.length, cutoff: cutoffStr };
}

function addLocation(payload) {
  payload = payload || {};
  // V67: إضافة المواقع للإداري (admin) فقط.
  const adderRole = String(payload.role || '').trim().toLowerCase();
  if (adderRole !== 'admin') throw new Error('صلاحية إضافة المواقع متاحة للإداري (admin) فقط');
  const sheet = aSheet.getSheetByName("Locations");

  if (!sheet) {
    throw new Error("Sheet 'Locations' غير موجودة");
  }

  payload = payload || {};

  // نوع الإضافة
  const type = String(
    payload.type ||
    payload.locationType ||
    payload.kind ||
    ""
  ).trim().toLowerCase();

  // نقبل أكثر من اسم حتى تتوافق مع script.js الحالي
  let gov = String(
    payload.gov ??
    payload.governorate ??
    payload.governor ??
    payload.province ??
    ""
  ).trim();

  let region = String(
    payload.region ??
    payload.area ??
    ""
  ).trim();

  let market = String(
    payload.market ??
    payload.marketName ??
    payload.shop ??
    payload.name ??
    ""
  ).trim();

  // إذا كانت الإضافة محافظة، فالقيمة قد تكون مرسلة كـ name أو value
  if (
    (type === "governorate" || type === "gov" || type === "province") &&
    !gov
  ) {
    gov = String(
      payload.name ??
      payload.value ??
      payload.text ??
      ""
    ).trim();
  }

  if (!type) {
    throw new Error("نوع البيانات المطلوب إضافتها غير محدد");
  }

  let newGov = gov;
  let newRegion = region;
  let newMarket = market;

  // =========================================================
  // إضافة محافظة
  // =========================================================
  if (
    type === "governorate" ||
    type === "gov" ||
    type === "province"
  ) {
    if (!newGov) {
      throw new Error("اسم المحافظة مطلوب");
    }

    newRegion = "";
    newMarket = "";
  }

  // =========================================================
  // إضافة منطقة
  // =========================================================
  else if (
    type === "region" ||
    type === "area"
  ) {
    if (!newGov) {
      throw new Error("يجب اختيار المحافظة أولاً");
    }

    if (!newRegion) {
      newRegion = String(
        payload.name ??
        payload.value ??
        payload.text ??
        ""
      ).trim();
    }

    if (!newRegion) {
      throw new Error("اسم المنطقة مطلوب");
    }

    newMarket = "";
  }

  // =========================================================
  // إضافة محل
  // =========================================================
  else if (
    type === "market" ||
    type === "shop"
  ) {
    if (!newGov) {
      throw new Error("يجب اختيار المحافظة أولاً");
    }

    if (!newRegion) {
      throw new Error("يجب اختيار المنطقة أولاً");
    }

if (!newMarket) {
  newMarket = String(
    payload.name ??
    payload.value ??
    payload.text ??
    ""
  ).trim();
}

if (!newMarket) {
  throw new Error("اسم المحل مطلوب");
}
  }

  else {
    throw new Error("نوع الموقع غير صحيح: " + type);
  }

  // =========================================================
  // منع التكرار
  // =========================================================

  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {

    const data = sheet
      .getRange(2, 1, lastRow - 1, 3)
      .getValues();

    const duplicate = data.some(row => {

      const rowGov = String(row[0] ?? "").trim();
      const rowRegion = String(row[1] ?? "").trim();
      const rowMarket = String(row[2] ?? "").trim();

      return (
        rowGov === newGov &&
        rowRegion === newRegion &&
        rowMarket === newMarket
      );
    });

    if (duplicate) {
      throw new Error("هذه البيانات موجودة مسبقاً");
    }
  }

  // =========================================================
  // إضافة إلى Locations
  // =========================================================

  sheet.appendRow([
    newGov,
    newRegion,
    newMarket
  ]);

  // =========================================================
  // تحديث الكاش
  // =========================================================

  try {
    clearInitialDataCache_();
  } catch (e) {}

  return {
    status: "success",
    message: "تمت إضافة البيانات بنجاح",
    location: {
      gov: newGov,
      region: newRegion,
      market: newMarket
    }
  };
}

// ===============================================================
// سحب / مرتجع مواد (festivalMovement) — مبنية على المستخدم (createdById)
// أنواع العمليات في العمود operation:
//   "سحب" / "مرتجع"  -> تُدخل يدوياً من صفحة سحب/مرتجع المواد.
//   "صرف"            -> تُسجَّل تلقائياً من جدول المصاريف عند حفظ تقرير "ترويج وبيع مباشر".
//   "مبيعات"         -> تُسجَّل فقط يدوياً عبر زر "إرسال صافي المحصلة إلى المبيعات"
//                       (لم تعد تلقائية)، وتُصفّر محصلة المستخدم لحظة إرسالها.
// ===============================================================

const FESTIVAL_MOVEMENT_SHEET_NAME = "festivalMovement";
const FESTIVAL_MOVEMENT_HEADERS = ["reportId","item","quantity","operation","date","createdById","createdByName","invoiceNumber","id","approvalStatus","approvedBy","approvedAt","rejectionReason","rejectionBy"];
const DIRECT_SALE_EVENT = "ترويج وبيع مباشر";
const FESTIVAL_MOVEMENT_SALE_OP = "مبيعات";
const FESTIVAL_MOVEMENT_EXPENSE_OP = "صرف";

function ensureFestivalMovementSheet() {
  let sheet = aSheet.getSheetByName(FESTIVAL_MOVEMENT_SHEET_NAME);
  if (!sheet) {
    sheet = aSheet.insertSheet(FESTIVAL_MOVEMENT_SHEET_NAME);
    sheet.getRange(1,1,1,FESTIVAL_MOVEMENT_HEADERS.length).setValues([FESTIVAL_MOVEMENT_HEADERS]);
    return sheet;
  }
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1,1,1,FESTIVAL_MOVEMENT_HEADERS.length).setValues([FESTIVAL_MOVEMENT_HEADERS]);
    return sheet;
  }
  // ترقية تلقائية وآمنة لأي عمود جديد ناقص (مثل invoiceNumber) دون المساس بالبيانات الحالية.
  const existingHeaders = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(h => String(h ?? '').trim());
  FESTIVAL_MOVEMENT_HEADERS.forEach((headerName, idx) => {
    const exists = existingHeaders.some(h => normalizeHeaderName(h) === normalizeHeaderName(headerName));
    if (!exists) sheet.getRange(1, idx + 1).setValue(headerName);
  });
  // V66: معرّف حتمي لكل صف بلا معرّف: mv-<رقم صف البيانات> (مستقر لأن إعادة الكتابة تحافظ عليه).
  if (sheet.getLastRow() >= 2) {
    const lastCol = Math.max(sheet.getLastColumn(), FESTIVAL_MOVEMENT_HEADERS.length);
    const allHeaders = sheet.getRange(1,1,1,lastCol).getValues()[0];
    const idIdx = allHeaders.findIndex(h => normalizeHeaderName(String(h || '')) === normalizeHeaderName('id'));
    const data = sheet.getRange(2,1,sheet.getLastRow()-1,lastCol).getValues();
    for (let i = 0; i < data.length; i++) {
      if (idIdx >= 0 && !String(data[i][idIdx] || '').trim()) {
        sheet.getRange(i + 2, idIdx + 1).setValue('mv-' + (i + 2));
      }
    }
  }
  return sheet;
}

const FESTIVAL_MOVEMENTS_CACHE_KEY = 'allFestivalMovements_v2';

// قراءة كل حركات الشيت مرة واحدة وتخزينها في الكاش (سريعة)، ثم نُفلترها بالذاكرة
// حسب صلاحية كل طالب بدل قراءة الشيت من جديد في كل طلب.
function getAllFestivalMovementsCached() {
  const cached = cache.get(FESTIVAL_MOVEMENTS_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const sheet = ensureFestivalMovementSheet();
  let movements = [];
  if (sheet.getLastRow() >= 2) {
    const timezone = aSheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'GMT';
    const lastCol = Math.max(sheet.getLastColumn(), FESTIVAL_MOVEMENT_HEADERS.length);
    const data = sheet.getRange(2,1,sheet.getLastRow()-1,lastCol).getValues();
    movements = data.map(row => {
      const dateValue = row[4];
      const dateText = (dateValue instanceof Date && !isNaN(dateValue.getTime()))
        ? Utilities.formatDate(dateValue, timezone, 'yyyy-MM-dd HH:mm')
        : String(dateValue || '');
      return {
        reportId: String(row[0] || ''),
        item: String(row[1]),
        quantity: Number(row[2]) || 0,
        operation: String(row[3]),
        date: dateText,
        rawDate: (dateValue instanceof Date) ? dateValue.getTime() : 0,
        createdById: String(row[5] || ''),
        createdByName: String(row[6] || ''),
        invoiceNumber: String(row[7] || ''),
        id: String(row[8] || ''),
        approvalStatus: String(row[9] || ''),
        approvedBy: String(row[10] || ''),
        approvedAt: String(row[11] || ''),
        rejectionReason: String(row[12] || ''),
        rejectionBy: String(row[13] || '')
      };
    });
  }
  try { cache.put(FESTIVAL_MOVEMENTS_CACHE_KEY, JSON.stringify(movements), CACHE_EXPIRATION_SECONDS); } catch (e) {}
  return movements;
}

// كل حركات مستخدم/فريق ضمن صلاحية الطالب (سحب/مرتجع يدوي + صرف تلقائي + مبيعات يدوية عبر زر التصفير)، الأحدث أولاً.
// admin: يرى الجميع أو يضيّق لموظف عبر targetUserId. manager: فريقه فقط (نفسه + كامل التسلسل الهرمي من صفحة Employees: عمود mgr).
// user: نفسه فقط دائماً بغض النظر عن targetUserId.
function getUserFestivalMovements(userId, userRole, targetUserId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('معرّف المستخدم مطلوب');
  const normalizedRole = String(userRole || '').trim().toLowerCase();

  let allowedIds = getTeamMemberIds(id, normalizedRole); // null = الكل (admin)
  const target = String(targetUserId || '').trim();
  if (target && target !== 'all' && target !== 'الكل') {
    if (allowedIds === null || allowedIds.indexOf(target) !== -1) {
      allowedIds = [target];
    }
  }

  const all = getAllFestivalMovementsCached();
  const movements = (allowedIds === null)
    ? all.slice()
    : (() => { const s = new Set(allowedIds); return all.filter(m => s.has(m.createdById)); })();

  movements.sort((a,b) => b.rawDate - a.rawDate);
  const cleaned = movements.map(m => { const c = Object.assign({}, m); delete c.rawDate; return c; });
  return { status:'success', movements: cleaned };
}

// يحسب لكل مادة: إجمالي السحب/المرتجع/الصرف التلقائي/المبيعات اليدوية، والمتبقي الصافي
// = سحب - مرتجع - صرف - مبيعات، لمستخدم معيّن.
function computeUserFestivalSummary(userId) {
  const id = String(userId || '').trim();
  if (!id) return [];
  const sheet = ensureFestivalMovementSheet();
  if (sheet.getLastRow() < 2) return [];

  const data = sheet.getRange(2,1,sheet.getLastRow()-1,FESTIVAL_MOVEMENT_HEADERS.length).getValues();
  const map = new Map();
  data.filter(row => String(row[5]).trim() === id).forEach(row => {
    const item = String(row[1] || '').trim();
    if (!item) return;
    if (!map.has(item)) map.set(item, { item, withdrawn:0, returned:0, expensed:0, sold:0 });
    const entry = map.get(item);
    const qty = Number(row[2]) || 0;
    const operation = String(row[3] || '').trim();
    if (operation === 'سحب') entry.withdrawn += qty;
    else if (operation === 'مرتجع') entry.returned += qty;
    else if (operation === FESTIVAL_MOVEMENT_EXPENSE_OP) entry.expensed += qty;
    else if (operation === FESTIVAL_MOVEMENT_SALE_OP) entry.sold += qty;
  });

  return Array.from(map.values()).map(e => ({ ...e, remaining: e.withdrawn - e.returned - e.expensed - e.sold }));
}

// سجل يدوي لسحب/مرتجع مواد مرتبط بالمستخدم الحالي (وليس بتقرير معيّن بالضرورة)، مع رقم فاتورة اختياري.
function addFestivalMovement(payload) {
  payload = payload || {};
  const createdById = String(payload.createdById || '').trim();
  if (!createdById) throw new Error('تعذر تحديد هوية المستخدم');
  const createdByName = String(payload.createdByName || '').trim();
  const reportId = String(payload.reportId || '').trim(); // اختياري: يبقى فارغاً للحركات اليدوية

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error('يرجى إضافة مادة واحدة على الأقل');

  const now = new Date();
  const rows = items.map(it => {
    const item = String((it && it.item) || '').trim();
    const quantity = Number(it && it.quantity);
    const operation = String((it && it.operation) || '').trim();
    const invoiceNumber = String((it && it.invoiceNumber) || '').trim();
    if (!item) throw new Error('اسم المادة مطلوب');
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('الكمية يجب أن تكون رقماً أكبر من صفر (المادة: ' + item + ')');
    if (operation !== 'سحب' && operation !== 'مرتجع') throw new Error('العملية يجب أن تكون "سحب" أو "مرتجع" (المادة: ' + item + ')');
    return [reportId, item, quantity, operation, now, createdById, createdByName, invoiceNumber];
  });

  const sheet = ensureFestivalMovementSheet();
  const startRow = sheet.getLastRow() + 1;
  const rowsFull = rows.map((r, i) => r.concat(['mv-' + (startRow + i), '', '', '', '', '']));
  sheet.getRange(startRow, 1, rowsFull.length, FESTIVAL_MOVEMENT_HEADERS.length).setValues(rowsFull);
  cache.remove(FESTIVAL_MOVEMENTS_CACHE_KEY);

  return { status:'success', added: rowsFull.length };
}

// تُستدعى تلقائياً من handleReportSubmission عند حفظ أو تعديل أي تقرير.
// تُسجّل كميات جدول المصاريف كحركة "صرف" باسم صاحب التقرير، فتُطرح تلقائياً من محصلته.
// عند تعديل تقرير موجود، تُستبدل حركات "صرف" السابقة لنفس التقرير بالقيم الجديدة (بدون تكرار).
function syncReportExpensesToFestivalMovement(reportData) {
  reportData = reportData || {};

  const reportId = String(reportData.id || '').trim();
  if (!reportId) return;

  const ownerId = String(reportData.createdById || '').trim();
  const ownerName = String(reportData.createdByName || '').trim();
  const expenses = Array.isArray(reportData.expenses) ? reportData.expenses : [];

  const sheet = ensureFestivalMovementSheet();
  const lastRow = sheet.getLastRow();
  const existingRows = lastRow > 1 ? sheet.getRange(2,1,lastRow-1,FESTIVAL_MOVEMENT_HEADERS.length).getValues() : [];

  // إزالة أي حركات "صرف" مسجلة سابقاً لنفس التقرير (لتفادي تكرارها عند التعديل).
  const kept = existingRows.filter(row => !(String(row[0]).trim() === reportId && String(row[3]).trim() === FESTIVAL_MOVEMENT_EXPENSE_OP));

  const now = new Date();
  const newExpenseRows = expenses
    .map(e => ({ item: String((e && e.item) || '').trim(), quantity: Number(e && e.quantity) || 0 }))
    .filter(e => e.item && e.quantity > 0)
    .map(e => [reportId, e.item, e.quantity, FESTIVAL_MOVEMENT_EXPENSE_OP, now, ownerId, ownerName, '', '', '', '', '', '', '']);

  const finalRows = kept.concat(newExpenseRows);

  sheet.clearContents();
  sheet.getRange(1,1,1,FESTIVAL_MOVEMENT_HEADERS.length).setValues([FESTIVAL_MOVEMENT_HEADERS]);
  if (finalRows.length) {
    sheet.getRange(2,1,finalRows.length,FESTIVAL_MOVEMENT_HEADERS.length).setValues(finalRows);
  }
  // V66: تملئة معرّفات أي صفوف جديدة بلا معرّف (اضطراب/ديمومة معرّفات الصفوف الباقية محفوظة).
  ensureFestivalMovementSheet();
  cache.remove(FESTIVAL_MOVEMENTS_CACHE_KEY);
}

// تُستدعى يدوياً فقط (زر "إرسال صافي المحصلة إلى المبيعات") لكل مادة معها صافٍ موجب:
// تُضاف حركة "مبيعات" بقيمة الصافي الحالي بالضبط، فتصبح محصلة تلك المادة صفراً فور الإرسال.
function closeOutUserTallyToSales(payload) {
  payload = payload || {};
  const createdById = String(payload.createdById || '').trim();
  if (!createdById) throw new Error('تعذر تحديد هوية المستخدم');
  const createdByName = String(payload.createdByName || '').trim();
  const selectedReportId = String(payload.reportId || '').trim();
  if (!selectedReportId) throw new Error('يرجى اختيار التقرير الذي ستضاف إليه المبيعات');

  const summary = computeUserFestivalSummary(createdById);
  const itemsToClose = summary.filter(e => e.remaining > 0);
  if (!itemsToClose.length) return { status:'success', added: 0, message: 'لا توجد كميات متبقية (صافي موجب) لإرسالها' };

  // نقرأ مبيعات التقرير المختار للحصول على السعر الصحيح لكل مادة.
  // إذا لم تكن المادة موجودة في التقرير، نستخدم السعر الحالي من Products كاحتياط.
  const report = getReports('', 'admin', '').find(r => String(r.id) === selectedReportId);
  if (!report) throw new Error('التقرير المحدد غير موجود');

  const reportPriceMap = new Map();
  (Array.isArray(report.sales) ? report.sales : []).forEach(s => {
    const product = String(s.product || '').trim();
    if (!product) return;
    const price = Number(s.price);
    if (Number.isFinite(price)) reportPriceMap.set(product, price);
  });

  const productsSheet = aSheet.getSheetByName('Products');
  const productPriceMap = new Map();
  if (productsSheet && productsSheet.getLastRow() > 1) {
    const values = productsSheet.getDataRange().getValues();
    const headers = values[0] || [];
    const productCol = getColumnIndex(headers, ['product','المادة','اسم المادة'], 1);
    const priceCol = getColumnIndex(headers, ['price','السعر'], 2);
    const cancelledCol = getColumnIndex(headers, ['إلغاء المادة','cancelled','canceled','الغاء المادة'], 6);
    values.slice(1).forEach(row => {
      const product = String(row[productCol] || '').trim();
      if (!product || isCancelledValue(row[cancelledCol])) return;
      const price = Number(row[priceCol]);
      if (Number.isFinite(price) && !productPriceMap.has(product)) productPriceMap.set(product, price);
    });
  }

  const now = new Date();
  const salesRows = itemsToClose.map(e => {
    const price = reportPriceMap.has(e.item) ? reportPriceMap.get(e.item) : (productPriceMap.get(e.item) || 0);
    return [selectedReportId, e.item, Number(price) || 0, e.remaining];
  });

  // 1) تسجَّل المبيعات في sales مع reportId للتقرير الذي اختاره المستخدم.
  if (!salesSheet) throw new Error("Sheet 'sales' غير موجودة");
  salesSheet.getRange(salesSheet.getLastRow() + 1, 1, salesRows.length, 4).setValues(salesRows);

  // 2) وتسجَّل في festivalMovement كحركة مبيعات مرتبطة بنفس التقرير.
  const movementSheet = ensureFestivalMovementSheet();
  const movementRows = itemsToClose.map((e, i) => [selectedReportId, e.item, e.remaining, FESTIVAL_MOVEMENT_SALE_OP, now, createdById, createdByName, '', 'mv-' + (movementSheet.getLastRow() + 1 + i), '', '', '', '', '']);
  movementSheet.getRange(movementSheet.getLastRow() + 1, 1, movementRows.length, FESTIVAL_MOVEMENT_HEADERS.length).setValues(movementRows);

  SpreadsheetApp.flush();
  clearReportsCache_();
  cache.remove(FESTIVAL_MOVEMENTS_CACHE_KEY);
  return { status:'success', added: movementRows.length, salesAdded: salesRows.length, reportId: selectedReportId };
}

// ===================================================================
// V50: اعتماد التقارير — يرصد تقريراً كـ «معتمد» مع اسم المدقق ووقته.
// ملاحظة: تتطلب هذه الدالة إعادة نشر (Deploy) لمشروع Apps Script بعد
// تحديث code.gs حتى يعمل زر «اعتماد» في صفحة سجل التعديلات.
// (الصيانة المحلية: role auditor أو admin فقط؛ أي دور آخر مرفوض).
// ===================================================================

// V70: اعتماد جماعي للتقارير — يعتمد كل ما هو قيد المراجعة ضمن نطاق المستخدم، ويترك المرفوض كما هو.
function approveAllReports(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'manager') throw new Error('اعتماد الكل متاح للإداري (admin) والمدير (manager) فقط');
  const reports = getReports(String(payload.userId || ''), role, String(payload.userName || ''), String(payload.targetUserId || '')) || [];
  const pending = reports.filter(r => String(r.approvalStatus || '').trim().toLowerCase() !== 'approved' && String(r.approvalStatus || '').trim().toLowerCase() !== 'rejected');
  let approved = 0;
  pending.forEach(r => { approveReport({ id: String(r.id), role, approvedBy: payload.userName || '', approvedAt: new Date().toISOString() }); approved++; });
  return { status:'success', approved, skippedRejected: reports.filter(r => String(r.approvalStatus || '').trim().toLowerCase() === 'rejected').length, message: approved ? `تم اعتماد ${approved} تقرير.` : 'لا توجد تقارير قيد المراجعة للاعتماد.' };
}

// V70: اعتماد جماعي للدوام — يعتمد كل ما هو قيد المراجعة ضمن نطاق المستخدم، ويترك المرفوض كما هو.
function approveAllAttendance(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'manager') throw new Error('اعتماد الكل متاح للإداري (admin) والمدير (manager) فقط');
  const rows = getAttendance(String(payload.userId || ''), role, String(payload.userName || ''), String(payload.targetUserId || '')) || [];
  const pending = rows.filter(r => String(r.approvalStatus || '').trim().toLowerCase() !== 'approved' && String(r.approvalStatus || '').trim().toLowerCase() !== 'rejected');
  let approved = 0;
  pending.forEach(r => { approveAttendance({ timestamp:String(r.timestamp), username:String(r.username), role, approvedBy:payload.userName || '', approvedAt:new Date().toISOString(), status:'approved' }); approved++; });
  return { status:'success', approved, skippedRejected: rows.filter(r => String(r.approvalStatus || '').trim().toLowerCase() === 'rejected').length, message: approved ? `تم اعتماد ${approved} سجل دوام.` : 'لا توجد سجلات دوام قيد المراجعة للاعتماد.' };
}

// V70: اعتماد جماعي للحركات — يعتمد كل ما هو قيد المراجعة ضمن نطاق المستخدم، ويترك المرفوض كما هو.
function approveAllMovements(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'manager') throw new Error('اعتماد الكل متاح للإداري (admin) والمدير (manager) فقط');
  const result = getUserFestivalMovements(String(payload.userId || ''), role, String(payload.targetUserId || '')) || { movements:[] };
  const movements = Array.isArray(result.movements) ? result.movements : [];
  const pending = movements.filter(m => String(m.approvalStatus || '').trim().toLowerCase() !== 'approved' && String(m.approvalStatus || '').trim().toLowerCase() !== 'rejected');
  let approved = 0;
  pending.forEach(m => { approveMovement({ id:String(m.id), role, approvedBy:payload.userName || '', approvedAt:new Date().toISOString(), status:'approved' }); approved++; });
  cache.remove(FESTIVAL_MOVEMENTS_CACHE_KEY);
  return { status:'success', approved, skippedRejected: movements.filter(m => String(m.approvalStatus || '').trim().toLowerCase() === 'rejected').length, message: approved ? `تم اعتماد ${approved} حركة.` : 'لا توجد حركات قيد المراجعة للاعتماد.' };
}

function approveReport(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'auditor' && role !== 'admin' && role !== 'manager') {
    throw new Error('صلاحية الاعتماد متاحة للمدقق (auditor) والإداري (admin) والمدير (manager) فقط');
  }
  const id = String(payload.id || '').trim();
  if (!id) throw new Error('معرّف التقرير مطلوب');
  // V63: دعم الحالتين معتمد/مرفوض + سبب الرفض.
  const status = String(payload.status || payload.approvalStatus || 'approved').trim().toLowerCase();
  if (status !== 'approved' && status !== 'rejected') throw new Error('حالة غير صالحة (approved أو rejected)');
  ensureReportsColumn('approvalStatus');
  ensureReportsColumn('approvedBy');
  ensureReportsColumn('approvedAt');
  ensureReportsColumn('rejectionReason');
  ensureReportsColumn('rejectionBy');
  const headers = reportsSheet.getRange(1, 1, 1, reportsSheet.getLastColumn()).getValues()[0];
  const row = reportRowIndexById(id);
  if (row === -1) throw new Error('التقرير غير موجود');
  const targetRow = row + 2;
  const by = String(payload.approvedBy || payload.userName || '');
  const now = String(payload.approvedAt || new Date().toISOString());
  const valuesByHeader = {
    approvalStatus: status,
    approvedBy: by,
    approvedAt: now,
    rejectionReason: status === 'rejected' ? String(payload.reason || payload.rejectionReason || '') : '',
    rejectionBy: status === 'rejected' ? by : ''
  };
  Object.keys(valuesByHeader).forEach(h => {
    const col = headers.findIndex(x => normalizeHeaderName(x) === normalizeHeaderName(h));
    if (col >= 0) reportsSheet.getRange(targetRow, col + 1).setValue(valuesByHeader[h]);
  });
  clearReportsCache_();
  cache.remove('allReports_v2');
  cache.remove('allReports');
  return { status: 'success', reportId: id, approvalStatus: status };
}

// V61: حذف ناعم لتقرير — متاح للإداري (admin) والمدير (manager) والمدقق (auditor).
// يُملأ deletedAt/deletedBy بدل إزالة الصف، وتُفرَّغ كواش التقارير فوراً.
function deleteReport(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'manager' && role !== 'auditor') {
    throw new Error('صلاحية الحذف متاحة للإداري (admin) والمدير (manager) والمدقق (auditor) فقط');
  }
  const id = String(payload.id || '').trim();
  if (!id) throw new Error('معرّف التقرير مطلوب');
  const row = reportRowIndexById(id);
  if (row === -1) throw new Error('التقرير غير موجود');
  const targetRow = row + 2;
  ensureReportsColumn('deletedAt');
  ensureReportsColumn('deletedBy');
  const freshHeaders = reportsSheet.getRange(1, 1, 1, reportsSheet.getLastColumn()).getValues()[0];
  const colAt = freshHeaders.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName('deletedAt'));
  const colBy = freshHeaders.findIndex(h => normalizeHeaderName(h) === normalizeHeaderName('deletedBy'));
  if (colAt >= 0) reportsSheet.getRange(targetRow, colAt + 1).setValue(new Date().toISOString());
  if (colBy >= 0) reportsSheet.getRange(targetRow, colBy + 1).setValue(String(payload.userName || payload.userId || ''));
  clearReportDetails(id);
  clearReportsCache_();
  cache.removeAll(['allReports_v2','allReports']);
  return { status: 'success', reportId: id };
}
// ---------- V63: أهداف المروجين الشهرية ----------
function getPromoterGoalsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('PromoterGoals');
  if (!sh) {
    sh = ss.insertSheet('PromoterGoals');
    sh.getRange('A1:D1').setValues([['month', 'promoter', 'points', 'pieces']]);
    sh.getRange('A1:D1').setFontWeight('bold');
  }
  return sh;
}

function getPromoterGoals(month, userId, role) {
  const m = String(month || '').trim();
  if (!m) throw new Error('الشهر مطلوب بصيغة YYYY-MM');
  const sh = getPromoterGoalsSheet_();
  const values = sh.getRange('A2:D').getValues().filter(r => String(r[0] || '') === m);
  return {
    status: 'success',
    goals: values.map(r => ({ promoter: String(r[1] || ''), points: Number(r[2]) || 0, pieces: Number(r[3]) || 0 }))
  };
}

function savePromoterGoals(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'manager') {
    throw new Error('صلاحية تحديد الأهداف متاحة للإداري (admin) والمدير (manager) فقط');
  }
  const m = String(payload.month || '').trim();
  if (!m) throw new Error('الشهر مطلوب بصيغة YYYY-MM');
  const sh = getPromoterGoalsSheet_();
  sh.getRange('A2:A' + Math.max(2, sh.getLastRow())).clearContent();
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (entries.length && entries.length > 0) {
    sh.getRange(2, 1, entries.length, 4).setValues(entries.map(e => [
      m,
      String(e.promoter || '').trim(),
      Number(e.points) || 0,
      Number(e.pieces) || 0
    ]));
  }
  return { status: 'success', message: 'تم حفظ أهداف الشهر.', month: m, saved: entries.length };
}

// ---------- V63: النسخ الاحتياطي الأسبوعي ----------
function createBackupSpreadsheet_() {
  const source = SpreadsheetApp.getActiveSpreadsheet();
  const stamp = Utilities.formatDate(new Date(), source.getSpreadsheetTimeZone(), 'yyyy-MM-dd_HH-mm');
  const backup = SpreadsheetApp.create('FieldReports_BACKUP_' + stamp);
  source.getSheets().forEach(function (sh) {
    // V69.1: لم نعد نستثني PromoterGoals — أهداف المروجين تُنسخ مع الباقي الآن.
    let target = null;
    try {
      target = backup.getSheetByName(sh.getName()) || backup.insertSheet(sh.getName());
    } catch (err) {
      target = backup.getSheetByName('Sheet1') || backup.insertSheet('Sheet1');
    }
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow > 0 && lastCol > 0) {
      target.getRange(1, 1, lastRow, lastCol).setValues(sh.getRange(1, 1, lastRow, lastCol).getValues());
    }
    target.getRange(1, 1, 1, Math.max(1, lastCol)).setFontWeight('bold');
  });
  try { backup.deleteSheet(backup.getSheetByName('Sheet1')); } catch (err) {}
  return { url: backup.getUrl() };
}

function setupWeeklyBackup(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin') throw new Error('صلاحية تفعيل النسخ الاحتياطي متاحة للإداري (admin) فقط');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('weeklyBackupEnabled', 'true');
  // V69.1: إزالة أي محفّزات قديمة مكررة قبل الإنشاء حتى لا تحصل نسخ مزدوجة.
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'weeklyBackupTrigger_')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('weeklyBackupTrigger_').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).create();
  const active = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'weeklyBackupTrigger_').length;
  // V69.1: نسخة فورية فور التفعيل للتأكد من الصلاحيات وتوفير الرابط مباشرة.
  const backup = createBackupSpreadsheet_();
  props.setProperty('lastBackupAt', new Date().toISOString());
  props.setProperty('lastBackupUrl', backup.url);
  props.setProperty('lastBackupRun', 'manual-enable');
  return { status: 'success', message: 'تم تفعيل النسخ الاحتياطي الأسبوعي (كل يوم أحد الساعة 2 صباحًا) وإنشاء نسخة أولية.', url: backup.url, activeTriggers: active };
}

function weeklyBackupTrigger_() {
  try {
    const enabled = PropertiesService.getScriptProperties().getProperty('weeklyBackupEnabled');
    if (enabled !== 'true') return;
    const backup = createBackupSpreadsheet_();
    const props = PropertiesService.getScriptProperties();
    props.setProperty('lastBackupAt', new Date().toISOString());
    props.setProperty('lastBackupUrl', backup.url);
    props.setProperty('lastBackupRun', 'weekly-trigger');
  } catch (err) {
    console.error('weekly backup failed: ' + err.message);
  }
}

function backupNow(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin') throw new Error('صلاحية إنشاء نسخة احتياطية متاحة للإداري (admin) فقط');
  const result = createBackupSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('lastBackupAt', new Date().toISOString());
  props.setProperty('lastBackupUrl', result.url);
  props.setProperty('lastBackupRun', 'manual-now');
  return { status: 'success', message: 'تم إنشاء النسخة الاحتياطية.', url: result.url };
}

// ===============================================================
// V68: إدارة المستخدمين والصلاحيات — للإداري (admin) فقط.
// الأعمدة: A=id، B=name، C=username، D=password (hash)، E=systemRole،
// F=jobPosition (المنصب الوظيفي)، G=mgr (اسم المدير المباشر).
// لا تُكشف كلمات المرور أبداً — admin يضبطها فقط (تُخزَّن hash).
// ===============================================================

// قراءة صفوف الموظفين (المعرّف + اسم الدخول + الدور) لفحص «آخر إداري».
function employeesRows_() {
  const sheet = aSheet.getSheetByName('Employees');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
}

function invalidateInitialDataCache_() {
  clearInitialDataCache_();
}

function getUsersAdmin(requester) {
  requester = requester || {};
  if (String(requester.systemRole || '').trim().toLowerCase() !== 'admin') {
    throw new Error('صلاحية إدارة المستخدمين مخصصة للإداري (admin) فقط');
  }
  const sheet = aSheet.getSheetByName('Employees');
  if (!sheet || sheet.getLastRow() < 2) return { status: 'success', users: [] };
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  return {
    status: 'success',
    users: data.map(row => ({
      id: String(row[0] ?? '').trim(),
      name: String(row[1] ?? '').trim(),
      username: String(row[2] ?? '').trim(),
      systemRole: String(row[4] ?? '').trim().toLowerCase(),
      jobPosition: String(row[5] ?? '').trim(),
      mgr: String(row[6] ?? '').trim(),
      hasPassword: !!String(row[3] ?? '').trim()
    })).filter(u => u.name || u.username || u.id)
  };
}

// إنشاء مستخدم جديد أو تعديل مستخدم موجود (editUsername = اسم الدخول الأصلي).
function saveUser(payload) {
  payload = payload || {};
  const actorRole = String(payload.role || '').trim().toLowerCase();
  if (actorRole !== 'admin') throw new Error('صلاحية إدارة المستخدمين مخصصة للإداري (admin) فقط');
  const norm = s => String(s || '').trim().toLowerCase();
  const actorUsername = String(payload.actorUsername || '').trim().toLowerCase();
  const editUsername = String(payload.editUsername || '').trim().toLowerCase();
  const name = String(payload.name || '').trim();
  const username = String(payload.username || '').trim().toLowerCase();
  if (!name) throw new Error('اسم الموظف مطلوب');
  if (!username) throw new Error('اسم الدخول (username) مطلوب');
  if (!/^[a-zA-Z0-9._\-]{3,50}$/.test(username)) throw new Error('اسم الدخول يجب أن يكون 3-50 حرفاً إنجليزياً/رقمياً بدون مسافات');
  const systemRole = String(payload.systemRole || '').trim().toLowerCase();
  const allowedRoles = ['admin', 'manager', 'auditor', 'user'];
  if (allowedRoles.indexOf(systemRole) === -1) throw new Error('صلاحية غير معروفة — اختر من القائمة');
  const jobPosition = String(payload.jobPosition || '').trim();
  const mgr = String(payload.manager || '').trim();
  const newPassword = String(payload.password || '').trim();

  const rows = employeesRows_();
  let targetIndex = -1;
  if (editUsername) {
    for (let i = 0; i < rows.length; i++) {
      if (norm(rows[i][2]) === editUsername) { targetIndex = i; break; }
    }
    if (targetIndex === -1) throw new Error('الحساب المطلوب تعديله غير موجود');
  }

  // فحص تفرد اسم الدخول (مع استثناء الصف نفسه عند التعديل).
  for (let i = 0; i < rows.length; i++) {
    if (i === targetIndex) continue;
    if (norm(rows[i][2]) === username) throw new Error('اسم الدخول مستخدم من قبل — اختر اسماً آخر');
  }

  // حماية: آخر إداري لا يُحذف ولا يُسحب، والإداري لا يسحب صلاحيته عن نفسه.
  const countAdmins = rows.filter(r => norm(r[4]) === 'admin').length;
  const targetRow = targetIndex >= 0 ? rows[targetIndex] : null;
  if (targetRow !== null) {
    const isEditSelf = actorUsername !== '' && norm(targetRow[2]) === actorUsername;
    if (norm(targetRow[4]) === 'admin' && systemRole !== 'admin' && countAdmins <= 1) {
      throw new Error('لا يمكن إزالة آخر حساب إداري — أضف إدارياً آخر أولاً');
    }
    if (isEditSelf && systemRole !== 'admin') throw new Error('لا يمكنك سحب صلاحية الإداري عن حسابك');
  }

  // كلمة المرور: مطلوبة للمستخدم الجديد، اختيارية عند التعديل (فارغة = إبقاء الحالية).
  let newHash = null;
  if (targetIndex === -1) {
    if (!newPassword) throw new Error('كلمة المرور مطلوبة لإنشاء حساب جديد');
    if (newPassword.length < 4) throw new Error('كلمة المرور لا تقل عن 4 أحرف');
    newHash = hashPassword_(newPassword);
  } else if (newPassword) {
    if (newPassword.length < 4) throw new Error('كلمة المرور لا تقل عن 4 أحرف');
    newHash = hashPassword_(newPassword);
  }

  const sheet = aSheet.getSheetByName('Employees');
  if (targetIndex === -1) {
    const rowNum = sheet.getLastRow() + 1;
    const hash = newHash ? ('pwd$' + newHash.salt + '$' + newHash.hash) : '';
    // A=id(فارغ)، B=name، C=username، D=password(hash)، E=systemRole، F=jobPosition، G=mgr.
    sheet.getRange(rowNum, 1, 1, 7).setValues([['', name, username, hash, systemRole, jobPosition, mgr]]);
    invalidateInitialDataCache_();
    return { status: 'success', message: 'تم إنشاء الحساب «' + name + '» بنجاح.' };
  }
  const rowNum = targetIndex + 2;
  // V68: نكتب الأعمدة الصحيحة فقط، مع ترك عمود كلمة المرور (D) دون مسّ ما لم تُحدَّث:
  // B=name، C=username ثم E=systemRole، F=jobPosition، G=mgr (نكسر الاستمرارية لتجنّب الكتابة على D).
  sheet.getRange(rowNum, 2, 1, 2).setValues([[name, username]]);
  sheet.getRange(rowNum, 5, 1, 3).setValues([[systemRole, jobPosition, mgr]]);
  if (newHash) sheet.getRange(rowNum, 4).setValue('pwd$' + newHash.salt + '$' + newHash.hash);
  invalidateInitialDataCache_();
  return { status: 'success', message: 'تم تحديث الحساب «' + name + '» بنجاح.' };
}

function deleteUser(payload) {
  payload = payload || {};
  const actorRole = String(payload.role || '').trim().toLowerCase();
  if (actorRole !== 'admin') throw new Error('صلاحية إدارة المستخدمين مخصصة للإداري (admin) فقط');
  const norm = s => String(s || '').trim().toLowerCase();
  const actorUsername = String(payload.actorUsername || '').trim().toLowerCase();
  const editUsername = String(payload.editUsername || '').trim().toLowerCase();
  if (!editUsername) throw new Error('معرّف الحساب مطلوب');
  const rows = employeesRows_();
  let targetIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (norm(rows[i][2]) === editUsername) { targetIndex = i; break; }
  }
  if (targetIndex === -1) throw new Error('الحساب غير موجود');
  if (actorUsername !== '' && norm(rows[targetIndex][2]) === actorUsername) throw new Error('لا يمكنك حذف حسابك بنفسك');
  const countAdmins = rows.filter(r => norm(r[4]) === 'admin').length;
  if (norm(rows[targetIndex][4]) === 'admin' && countAdmins <= 1) throw new Error('لا يمكن حذف آخر حساب إداري');
  aSheet.getSheetByName('Employees').deleteRow(targetIndex + 2);
  invalidateInitialDataCache_();
  return { status: 'success', message: 'تم حذف الحساب.' };
}

// ===============================================================
// مصاريف دمشق وريفها — ورقة (Sheet tab) لكل يوم
//   الورقة اليومية: مصاريف_YYYY-MM-DD  وتحتوي المادة / البيان / السعر
//   ورقة الفهرس : مصاريف_فهرس        وتحتوي بيانات اليوم والتوقيعات
//   ورقة الفئات : مصاريف_فئات        وتحتوي قائمة المادة (قابلة للتعديل)
//   الأدمن يحذف الورقة اليومية عند انتهائها، وأي إدخال بعده ينشئها من جديد.
// ===============================================================
const EXPENSES_TAB_PREFIX = 'مصاريف_';
const EXPENSES_INDEX_SHEET_NAME = 'مصاريف_فهرس';
const EXPENSES_CATEGORIES_SHEET_NAME = 'مصاريف_فئات';
const EXPENSES_FORM_CODE = 'TM-PT-OL.00';
const EXPENSES_STATUS_DRAFT = 'مسودة';
const EXPENSES_STATUS_APPROVED = 'معتمدة';
const EXPENSES_ROW_HEADERS = ['المادة', 'البيان', 'السعر'];
const EXPENSES_INDEX_HEADERS = [
  'التاريخ', 'المحافظة', 'رقم النموذج', 'كود النموذج', 'عدد البنود', 'الإجمالي',
  'الحالة', 'أدخلها', 'آخر تعديل', 'آخر معدِّل'
];
const EXPENSES_DEFAULT_CATEGORIES = [
  'مستلزمات', 'غسيل سيارة', 'مصفاة', 'طعام', 'مواصلات', 'نقل', 'أخرى'
];

// يوحّد أي مدخل تاريخ إلى YYYY-MM-DD (يقبل Date أو نصاً أو رقم Sheets).
function expensesDateKey_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  if (typeof value === 'number' && isFinite(value)) {
    const parsed = new Date(Math.round(value));
    if (!isNaN(parsed.getTime())) return expensesDateKey_(parsed);
  }
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  // YYYY-MM-DD أو YYYY/MM/DD
  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  // DD/MM/YYYY أو DD-MM-YYYY (الصيغة المستعملة في الورقية المطبوعة)
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  // نص ورد بنص «التاريخ : 27/9/2026»
  m = raw.replace(/[^\d/.\-]/g, ' ').trim().match(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? '' : expensesDateKey_(parsed);
}

// اسم الورقة اليومية المشتق من تاريخ اليوم.
function expensesTabName_(dateKey) {
  return EXPENSES_TAB_PREFIX + dateKey;
}

// رقم النموذج التلقائي: No.YY-MM.00  (مثال No.26-09.00 لتاريخ 27/9/2026)
function expensesFormNumber_(dateKey) {
  const m = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return 'No.' + m[1].slice(2) + '-' + m[2] + '.00';
}

function ensureExpensesIndexSheet_() {
  let sheet = aSheet.getSheetByName(EXPENSES_INDEX_SHEET_NAME);
  if (!sheet) {
    sheet = aSheet.insertSheet(EXPENSES_INDEX_SHEET_NAME);
    sheet.getRange(1, 1, 1, EXPENSES_INDEX_HEADERS.length).setValues([EXPENSES_INDEX_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, EXPENSES_INDEX_HEADERS.length).setValues([EXPENSES_INDEX_HEADERS]);
    return sheet;
  }
  const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), EXPENSES_INDEX_HEADERS.length)).getValues()[0]
    .map(h => normalizeHeaderName(h));
  EXPENSES_INDEX_HEADERS.forEach((header, idx) => {
    if (!existing.some(h => h === normalizeHeaderName(header))) sheet.getRange(1, idx + 1).setValue(header);
  });
  return sheet;
}

function ensureExpensesCategoriesSheet_() {
  let sheet = aSheet.getSheetByName(EXPENSES_CATEGORIES_SHEET_NAME);
  if (!sheet) {
    sheet = aSheet.insertSheet(EXPENSES_CATEGORIES_SHEET_NAME);
    sheet.getRange(1, 1).setValue('المادة');
    sheet.getRange(2, 1, EXPENSES_DEFAULT_CATEGORIES.length, 1).setValues(EXPENSES_DEFAULT_CATEGORIES.map(c => [c]));
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (sheet.getLastRow() < 1) sheet.getRange(1, 1).setValue('المادة');
  // ورقة الفئات فارغة من البيانات: املأها بالافتراضيات مرة واحدة فقط.
  if (sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, EXPENSES_DEFAULT_CATEGORIES.length, 1).setValues(EXPENSES_DEFAULT_CATEGORIES.map(c => [c]));
  }
  return sheet;
}

function getExpensesCategories_() {
  const sheet = ensureExpensesCategoriesSheet_();
  const values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  const seen = new Set();
  const out = [];
  values.forEach(row => {
    const name = String(row[0] || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  });
  return out.length ? out : EXPENSES_DEFAULT_CATEGORIES.slice();
}

// الورقة اليومية للتاريخ المطلوب. تنشئها فقط عند create = true.
function getExpensesSheet_(dateKey, create) {
  const name = expensesTabName_(dateKey);
  let sheet = aSheet.getSheetByName(name);
  if (sheet) return sheet;
  if (!create) return null;
  sheet = aSheet.insertSheet(name);
  sheet.getRange(1, 1, 1, EXPENSES_ROW_HEADERS.length).setValues([EXPENSES_ROW_HEADERS]);
  sheet.setFrozenRows(1);
  return sheet;
}

// كل الأوراق اليومية المفتوحة، الأحدث أولاً.
function listExpensesDateKeys_() {
  return aSheet.getSheets()
    .map(s => s.getName())
    .filter(n => n.indexOf(EXPENSES_TAB_PREFIX) === 0)
    .map(n => n.slice(EXPENSES_TAB_PREFIX.length))
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
    .reverse();
}

// يقرأ يوماً واحداً: البنود + الإجمالي المحسوب.
function readExpensesDay_(dateKey) {
  const sheet = getExpensesSheet_(dateKey, false);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  const items = [];
  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, EXPENSES_ROW_HEADERS.length).getValues();
    rows.forEach((row, i) => {
      const category = String(row[0] || '').trim();
      const statement = String(row[1] || '').trim();
      const price = Number(row[2] || 0) || 0;
      if (!category && !statement && !price) return;
      items.push({ row: i + 2, category, statement, price });
    });
  }
  return { dateKey, tabName: sheet.getName(), items, total: items.reduce((s, r) => s + r.price, 0) };
}

// بيانات اليوم (محافظة/توقيعات/حالة) من ورقة الفهرس.
function readExpensesIndexRow_(dateKey) {
  const index = aSheet.getSheetByName(EXPENSES_INDEX_SHEET_NAME);
  if (!index || index.getLastRow() < 2) return null;
  const headers = index.getRange(1, 1, 1, index.getLastColumn()).getValues()[0];
  const rows = index.getRange(2, 1, index.getLastRow() - 1, headers.length).getValues();
  const found = rows.find(r => expensesDateKey_(r[0]) === dateKey);
  if (!found) return null;
  const meta = {};
  headers.forEach((h, i) => { meta[normalizeHeaderName(h) || ('col' + (i + 1))] = found[i]; });
  return meta;
}

// يكتب/يحدّث صف اليوم في ورقة الفهرس (يحتوي على التوقيعات الثلاثة).
function writeExpensesIndex_(dateKey, patch) {
  const index = ensureExpensesIndexSheet_();
  const day = readExpensesDay_(dateKey);
  const nowIso = new Date().toISOString();
  const payload = Object.assign({
    'التاريخ': dateKey,
    'المحافظة': '',
    'رقم النموذج': expensesFormNumber_(dateKey),
    'كود النموذج': EXPENSES_FORM_CODE,
    'عدد البنود': 0,
    'الإجمالي': 0,
    'الحالة': EXPENSES_STATUS_DRAFT,
    'أدخلها': '',
    'آخر تعديل': nowIso,
    'آخر معدِّل': ''
  }, patch || {});
  if (day) {
    payload['عدد البنود'] = day.items.length;
    payload['الإجمالي'] = day.total;
  }

  if (index.getLastRow() < 1) {
    index.getRange(1, 1, 1, EXPENSES_INDEX_HEADERS.length).setValues([EXPENSES_INDEX_HEADERS]);
  }
  // نكتب بترتيب EXPENSES_INDEX_HEADERS الثابت، فالمواضع مطابقة للترتيب
  // حتى لو أضاف الأدمن أعمدة إضافية يدوياً إلى تبويب الفهرس.
  const rowValues = EXPENSES_INDEX_HEADERS.map(h => {
    const v = payload[h];
    return v === undefined || v === null ? '' : v;
  });

  const firstCol = index.getRange(1, 1, index.getLastRow(), 1).getValues();
  for (let r = 1; r < firstCol.length; r++) {
    if (expensesDateKey_(firstCol[r][0]) === dateKey) {
      index.getRange(r + 1, 1, 1, rowValues.length).setValues([rowValues]);
      return;
    }
  }
  index.appendRow(rowValues);
}

// يحذف صف اليوم من ورقة الفهرس (يُستدعى بعد حذف الورقة اليومية).
function clearExpensesIndexRow_(dateKey) {
  const index = aSheet.getSheetByName(EXPENSES_INDEX_SHEET_NAME);
  if (!index || index.getLastRow() < 2) return;
  const firstCol = index.getRange(1, 1, index.getLastRow(), 1).getValues();
  for (let r = 1; r < firstCol.length; r++) {
    if (expensesDateKey_(firstCol[r][0]) === dateKey) { index.deleteRow(r + 1); return; }
  }
}

// ---------- إضافة بنود إلى ورقة اليوم ----------

function submitExpenses(payload) {
  payload = payload || {};
  const dateKey = expensesDateKey_(payload.date);
  if (!dateKey) throw new Error('التاريخ غير صالح.');
  const governorate = String(payload.governorate || '').trim();
  if (!governorate) throw new Error('يجب اختيار المحافظة.');

  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const valid = rawItems
    .map(it => ({
      category: String(it && it.category || '').trim(),
      statement: String(it && it.statement || '').trim(),
      price: Number(it && it.price)
    }))
    .filter(it => it.category && it.statement && isFinite(it.price) && it.price >= 0);
  if (!valid.length) throw new Error('أضف بنداً واحداً على الأقل (المادة + البيان + السعر).');

  const sheet = getExpensesSheet_(dateKey, true);
  sheet.getRange(sheet.getLastRow() + 1, 1, valid.length, EXPENSES_ROW_HEADERS.length)
    .setValues(valid.map(it => [it.category, it.statement, it.price]));

  const previous = readExpensesIndexRow_(dateKey) || {};
  writeExpensesIndex_(dateKey, {
    'المحافظة': governorate,
    'الحالة': normalizeExpensesStatus_(payload.status, previous['الحالة'], payload.role),
    'أدخلها': String(payload.userName || '').trim(),
    'آخر تعديل': new Date().toISOString(),
    'آخر معدِّل': String(payload.userName || '').trim()
  });
  SpreadsheetApp.flush();

  const day = readExpensesDay_(dateKey);
  return {
    status: 'success',
    dateKey,
    tabName: sheet.getName(),
    formNumber: expensesFormNumber_(dateKey),
    added: valid.length,
    total: day.total
  };
}

// الحالة تُقبل (مسودة/معتمدة) من admin/manager/auditor فقط، ويرفض أي قيمة أخرى.
// لغيرهم: الحالة لا تتغير إطلاقاً — لا ترقية ولا خفض (يفرضها doPost عبر payload.role).
function normalizeExpensesStatus_(value, fallback, role) {
  const allowed = String(role || '').trim().toLowerCase();
  const canApprove = allowed === 'admin' || allowed === 'manager' || allowed === 'auditor';
  const fb = String(fallback == null ? '' : fallback).trim();
  const previous = fb === EXPENSES_STATUS_APPROVED ? EXPENSES_STATUS_APPROVED : EXPENSES_STATUS_DRAFT;
  if (!canApprove) return previous;
  const v = String(value == null ? '' : value).trim();
  return (v === EXPENSES_STATUS_APPROVED || v === EXPENSES_STATUS_DRAFT) ? v : previous;
}

// حفظ بيانات اليوم فقط (المحافظة والحالة) دون إضافة بنود.
function saveExpensesMeta(payload) {
  payload = payload || {};
  const dateKey = expensesDateKey_(payload.date);
  if (!dateKey) throw new Error('التاريخ غير صالح.');
  // إنشاء ورقة اليوم تلقائياً عند أول حفظ، حتى لو لم تكن موجودة بعد.
  // لا نبحث عن ورقة موجودة مسبقاً ولا نطلب من المستخدم إنشاءها يدوياً.
  getExpensesSheet_(dateKey, true);
  const previous = readExpensesIndexRow_(dateKey) || {};
  writeExpensesIndex_(dateKey, {
    'المحافظة': String(payload.governorate || '').trim() || String(previous['المحافظة'] || ''),
    'الحالة': normalizeExpensesStatus_(payload.status, previous['الحالة'], payload.role),
    'آخر تعديل': new Date().toISOString(),
    'آخر معدِّل': String(payload.userName || '').trim()
  });
  SpreadsheetApp.flush();
  return { status: 'success', dateKey };
}

// ---------- القراءة ----------

function getExpensesOptions() {
  return { status: 'success', categories: getExpensesCategories_(), formCode: EXPENSES_FORM_CODE };
}

// بنود يوم واحد (الفورم يملأ منها عند اختيار تاريخ ماضٍ).
function getExpensesByDate(date) {
  const dateKey = expensesDateKey_(date);
  if (!dateKey) throw new Error('التاريخ غير صالح.');
  const day = readExpensesDay_(dateKey);
  const meta = readExpensesIndexRow_(dateKey) || {};
  return {
    status: 'success',
    dateKey,
    exists: !!day,
    items: day ? day.items : [],
    total: day ? day.total : 0,
    meta: {
      governorate: String(meta['المحافظة'] || ''),
      formNumber: expensesFormNumber_(dateKey),
      formCode: EXPENSES_FORM_CODE,
      status: String(meta['الحالة'] || EXPENSES_STATUS_DRAFT),
      lastEditedBy: String(meta['آخر معدِّل'] || ''),
      lastEditedAt: meta['آخر تعديل'] instanceof Date ? meta['آخر تعديل'].toISOString() : String(meta['آخر تعديل'] || '')
    }
  };
}

// كل الأوراق اليومية — للإدارة، الأحدث أولاً.
function getExpensesList() {
  const days = listExpensesDateKeys_().map(dateKey => {
    const day = readExpensesDay_(dateKey) || { items: [], total: 0 };
    const meta = readExpensesIndexRow_(dateKey) || {};
    return {
      dateKey,
      tabName: expensesTabName_(dateKey),
      governorate: String(meta['المحافظة'] || ''),
      formNumber: expensesFormNumber_(dateKey),
      count: day.items.length,
      total: day.total,
      status: String(meta['الحالة'] || EXPENSES_STATUS_DRAFT),
      enteredBy: String(meta['أدخلها'] || '')
    };
  });
  return { status: 'success', days, formCode: EXPENSES_FORM_CODE, categories: getExpensesCategories_() };
}

// ---------- الحذف والاعتماد (الأدمن) ----------

function deleteExpensesSheet(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin') throw new Error('حذف ورقة المصاريف متاح للإداري (admin) فقط.');
  const dateKey = expensesDateKey_(payload.date);
  if (!dateKey) throw new Error('التاريخ غير صالح.');
  const sheet = getExpensesSheet_(dateKey, false);
  if (!sheet) throw new Error('لا توجد ورقة مصاريف لهذا التاريخ.');
  aSheet.deleteSheet(sheet);
  clearExpensesIndexRow_(dateKey);
  SpreadsheetApp.flush();
  return { status: 'success', dateKey, message: 'تم حذف ورقة المصاريف.' };
}

function approveExpenses(payload) {
  payload = payload || {};
  const role = String(payload.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'manager' && role !== 'auditor') {
    throw new Error('اعتماد ورقة المصاريف متاح للإداري (admin) والمدير (manager) والمدقق (auditor) فقط.');
  }
  const dateKey = expensesDateKey_(payload.date);
  if (!dateKey) throw new Error('التاريخ غير صالح.');
  if (!getExpensesSheet_(dateKey, false)) throw new Error('لا توجد ورقة مصاريف لهذا التاريخ.');
  writeExpensesIndex_(dateKey, {
    'الحالة': EXPENSES_STATUS_APPROVED,
    'آخر تعديل': new Date().toISOString(),
    'آخر معدِّل': String(payload.userName || '').trim()
  });
  SpreadsheetApp.flush();
  return { status: 'success', dateKey, message: 'تم اعتماد ورقة المصاريف.' };
}

// ===============================================================
// السلف المالية وسلف المواد
// ===============================================================

const SALARY_ADVANCES_SHEET_NAME = 'SalaryAdvances';
const SALARY_ADVANCES_HEADERS = ['date', 'employeeId', 'employeeName', 'type', 'amount', 'notes', 'createdById', 'createdByName', 'createdAt', 'installments'];

// أنواع السجل المسموح بها. 'loan' = قرض، وهو الوحيد الذي يحمل عدد دفعات.
const SALARY_ADVANCE_TYPES = ['advance', 'deduction', 'loan'];

// أقصى عدد دفعات للقرض. الحد مذكور في موضعين (هذا، وmax في حقل HTML) فجُمع هنا
// ونصون تطابقهما باختبار.
const SALARY_ADVANCE_MAX_INSTALLMENTS = 10;

/**
 * يقرأ صف العناوين ويحلّ ترتيب الأعمدة بالاسم بدل الاعتماد على مواضع ثابتة.
 * لولا هذا لقرأ أي عمود جديد (مثل installments) من خانة notes عند ورقة أُضيف
 * عمودها في منتصف القائمة لا في آخرها.
 */
function salaryAdvancesHeaderIndex_(sheet) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(v => String(v == null ? '' : v).trim());
  return (name, fallback) => {
    const i = headers.indexOf(name);
    return i === -1 ? fallback : i;
  };
}

function ensureSalaryAdvancesSheet_() {
  let sheet = aSheet.getSheetByName(SALARY_ADVANCES_SHEET_NAME);
  if (!sheet) {
    sheet = aSheet.insertSheet(SALARY_ADVANCES_SHEET_NAME);
    sheet.getRange(1, 1, 1, SALARY_ADVANCES_HEADERS.length).setValues([SALARY_ADVANCES_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // ترقية للأوراق الموجودة مسبقاً: أضف العناوين الناقصة في آخر الصف.
  // بدون هذا يكتب appendRow قيمة تحت خانة بلا عنوان، فتنحرف كل الأعمدة بعد
  // السطر الأول — وتظهر الدفعات في خانة createdAt.
  const lastCol = Math.max(1, sheet.getLastColumn());
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(v => String(v == null ? '' : v).trim());
  const hasAnyHeader = existing.some(h => h !== '');
  if (!hasAnyHeader) {
    sheet.getRange(1, 1, 1, SALARY_ADVANCES_HEADERS.length).setValues([SALARY_ADVANCES_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const missing = SALARY_ADVANCES_HEADERS.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function getEmployeeNameById_(employeeId) {
  const emp = getEmployeeByIdOrUsername_(employeeId);
  return emp ? emp.name : '';
}

function saveSalaryAdvance(payload, requester) {
  const req = requester || {};
  const requesterId = String(req.id || '').trim();
  const requesterRole = String(req.systemRole || '').trim().toLowerCase();
  if (!requesterId) throw new Error('تعذر التحقق من هوية المستخدم');

  const requestedId = String(payload.employeeId || '').trim();
  // الموظف العادي مسموح له فقط بتسجيل سلفة باسم نفسه؛ المدير والمشرف يحفظان باسم عضو الفريق.
  const employeeId = (requesterRole === 'admin' || requesterRole === 'manager') ? requestedId : requesterId;
  if (!employeeId) throw new Error('معرّف الموظف مطلوب');
  if (requesterRole !== 'admin' && requesterRole !== 'manager' && requestedId && requestedId !== requesterId) {
    throw new Error('لا يمكنك تسجيل سلفة باسم موظف آخر');
  }
  if (requesterRole === 'manager' && employeeId !== requesterId) {
    const teamIds = getManagerTeamIds(requesterId) || [];
    if (!teamIds.includes(employeeId)) throw new Error('هذا الموظف لا يتبعك');
  }

  const amount = Number(payload.amount);
  const type = String(payload.type || 'advance').trim();
  const notes = String(payload.notes || '').trim();
  const date = String(payload.date || '').trim();
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('المبلغ يجب أن يكون رقماً أكبر من صفر');
  if (SALARY_ADVANCE_TYPES.indexOf(type) === -1) {
    throw new Error('النوع يجب أن يكون advance أو deduction أو loan');
  }
  // القرض والخصم صلاحية إدارية. إخفاء الخيارات في الواجهة ليس كافياً لأن الطلب
  // يمكن استدعاؤه مباشرة، فيُفرض القيد هنا أيضاً.
  if (type !== 'advance' && requesterRole !== 'admin' && requesterRole !== 'manager') {
    throw new Error('القرض والخصم متاحان للمدير أو الإداري فقط');
  }
  if (!date) throw new Error('التاريخ مطلوب');

  // عدد الدفعات يخصّ القرض فقط. يُتحقق منه كعدد صحيح ضمن حدّ معقول حتى لا
  // تُحفظ قيمة مثل 2.5 أو رقم سالب أو 1e9 تفسد التقارير المالية لاحقاً.
  let installments = 0;
  const rawInstallments = payload.installments;
  if (type === 'loan' && rawInstallments !== undefined && rawInstallments !== null && String(rawInstallments).trim() !== '') {
    installments = Number(rawInstallments);
    if (!Number.isInteger(installments) || installments < 1 || installments > SALARY_ADVANCE_MAX_INSTALLMENTS) {
      throw new Error('عدد الدفعات يجب أن يكون عدداً صحيحاً بين 1 و ' + SALARY_ADVANCE_MAX_INSTALLMENTS);
    }
  }

  const employeeName = getEmployeeNameById_(employeeId);
  const sheet = ensureSalaryAdvancesSheet_();
  const col = salaryAdvancesHeaderIndex_(sheet);
  // نبني الصف كمصفوفة بنفس ترتيب العناوين. col() يرجع رقم العمود،
  // فلا يصلح مفتاحاً لكائن — كان يكتب row[0] بدل row['date'] فتضيع كل القيم.
  const row = new Array(SALARY_ADVANCES_HEADERS.length).fill('');
  row[col('date', 0)] = date;
  row[col('employeeId', 1)] = employeeId;
  row[col('employeeName', 2)] = employeeName;
  row[col('type', 3)] = type;
  row[col('amount', 4)] = amount;
  row[col('notes', 5)] = notes;
  row[col('createdById', 6)] = requesterId;
  row[col('createdByName', 7)] = String(req.name || '');
  row[col('createdAt', 8)] = new Date().toISOString();
  row[col('installments', 9)] = installments;

  // منع الحفظ المزدوج: لو وصل نفس الطلب مرتين (نقرة مزدوجة أو إعادة إرسال) يُهمل
  // الثاني. المفتاح يُكتب بعد نجاح كل التحقق حتى لا يستهلكه طلب مرفوض فيمنع المحاولة الصحيحة.
  const requestId = String(payload.requestId || '').trim();
  if (requestId) {
    const idemKey = 'salAdv:' + requesterId + ':' + requestId;
    try {
      const cache = CacheService.getScriptCache();
      if (cache.get(idemKey)) {
        return { status: 'success', message: 'تم حفظ السلفة بنجاح.', duplicate: true };
      }
      cache.put(idemKey, '1', 21600);
    } catch (e) { /* الكاش غير متاح: نكمل الحفظ العادي */ }
  }

  sheet.appendRow(row);
  return { status: 'success', message: 'تم حفظ السلفة بنجاح.' };
}

function getSalaryAdvances(requester) {
  const sheet = ensureSalaryAdvancesSheet_();
  if (sheet.getLastRow() < 2) return { status: 'success', advances: [] };
  const col = salaryAdvancesHeaderIndex_(sheet);
  const width = Math.max(1, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const at = (row, name, fallback) => {
    const v = row[col(name, fallback)];
    return v === undefined ? '' : v;
  };
  let advances = data.map(row => ({
    date: String(at(row, 'date', 0) || ''),
    employeeId: String(at(row, 'employeeId', 1) || ''),
    employeeName: String(at(row, 'employeeName', 2) || ''),
    type: String(at(row, 'type', 3) || ''),
    amount: Number(at(row, 'amount', 4)) || 0,
    notes: String(at(row, 'notes', 5) || ''),
    createdByName: String(at(row, 'createdByName', 7) || ''),
    createdAt: String(at(row, 'createdAt', 8) || ''),
    installments: Number(at(row, 'installments', 9)) || 0
  }));
  advances = advances.reverse();
  const req = requester || {};
  const role = String(req.systemRole || '').trim().toLowerCase();
  const requesterId = String(req.id || '').trim();
  if (role === 'admin') {
    return { status: 'success', advances };
  }
  if (role === 'manager') {
    const teamIds = getManagerTeamIds(requesterId) || [];
    const teamSet = new Set(teamIds.map(id => String(id).trim()).filter(Boolean));
    teamSet.add(requesterId);
    advances = advances.filter(a => teamSet.has(String(a.employeeId).trim()));
  } else {
    advances = advances.filter(a => String(a.employeeId).trim() === requesterId);
  }
  return { status: 'success', advances };
}