// ===================================================================
//   core.js - الكود المشترك بين كل صفحات الموقع (V43: تقسيم script.js لملفات أصغر لكل صفحة)
// ===================================================================

// ===================================================================
//                     DARK MODE
// ===================================================================
function initDarkMode() {
    const toggle = document.getElementById('darkModeToggle');
    if (!toggle) return;
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
    toggle.addEventListener('click', () => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
        localStorage.setItem('theme', isDark ? 'light' : 'dark');
    });
}

// ===================================================================
//                     PWA INSTALL PROMPT
// ===================================================================
let deferredInstallPrompt = null;
function initPwaInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (sessionStorage.getItem('installBannerShown') || !document.querySelector('nav.navbar')) return;
        sessionStorage.setItem('installBannerShown', '1');
        const banner = document.createElement('div');
        banner.id = 'installBanner';
        banner.innerHTML = `<span class="install-icon"><i class="fa-solid fa-mobile-screen-button"></i></span>
            <div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:.95rem;">ثبّت لوحة التحكم على جهازك</div>
            <div class="small text-muted">افتحها بنقرة واحدة حتى من دون إنترنت.</div></div>
            <button id="installConfirmBtn" class="btn btn-sm btn-primary">تثبيت</button>
            <button id="installCloseBtn" class="btn btn-sm btn-outline-secondary" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button>`;
        document.body.appendChild(banner);
        banner.querySelector('#installCloseBtn').addEventListener('click', () => banner.remove());
        banner.querySelector('#installConfirmBtn').addEventListener('click', async () => {
            if (!deferredInstallPrompt) { banner.remove(); return; }
            deferredInstallPrompt.prompt();
            await deferredInstallPrompt.userChoice.catch(() => {});
            deferredInstallPrompt = null;
            banner.remove();
        });
    });
}

// ===================================================================
//                     SESSION LOG (دفتر الجلسات)
// ===================================================================
function recordLoginSession(userName) {
    try {
        const sessions = JSON.parse(localStorage.getItem('loginSessions') || '[]');
        const now = new Date();
        const device = { ua: navigator.userAgent, t: now.getTime(), name: userName || '', time: now.toLocaleString('ar-EG') };
        const currentDevice = navigator.userAgent.replace(/\d+/g, '#');
        const isNewDevice = !sessions.some(s => s.ua && s.ua.replace(/\d+/g, '#') === currentDevice);
        sessions.unshift(device);
        localStorage.setItem('loginSessions', JSON.stringify(sessions.slice(0, 6)));
        return isNewDevice && sessions.length > 1;
    } catch (e) { return false; }
}

// ===================================================================
//                     SESSION TIMEOUT
// ===================================================================
const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const SESSION_WARNING_MS = 10 * 60 * 1000;
let sessionTimer = null;
let sessionWarningTimer = null;

// «تذكرني»: the user asked to stay signed in, so no idle timeout runs for them.
// The checkbox used to pick localStorage over sessionStorage and nothing else —
// the 8-hour timer fired either way, which is why a remembered session still
// got kicked out after 8 hours and the checkbox felt broken.
const REMEMBER_SESSION_KEY = 'rememberSession';

function isRememberedSession() {
    try { return localStorage.getItem(REMEMBER_SESSION_KEY) === '1'; } catch (e) { return false; }
}

function setRememberedSession(on) {
    try {
        if (on) localStorage.setItem(REMEMBER_SESSION_KEY, '1');
        else localStorage.removeItem(REMEMBER_SESSION_KEY);
    } catch (e) { /* التخزين ممتلئ */ }
}

function startSessionTimeout() {
    clearTimeout(sessionTimer);
    clearTimeout(sessionWarningTimer);
    const userRaw = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
    if (!userRaw) return;
    if (isRememberedSession()) return;
    const loginTime = Number(localStorage.getItem('loginTimestamp') || sessionStorage.getItem('loginTimestamp'));
    if (!loginTime) {
        const now = Date.now();
        if (localStorage.getItem('currentUser')) localStorage.setItem('loginTimestamp', now);
        else sessionStorage.setItem('loginTimestamp', now);
        startSessionTimeout();
        return;
    }
    const elapsed = Date.now() - loginTime;
    const remaining = SESSION_TIMEOUT_MS - elapsed;
    if (remaining <= 0) { forceLogout('انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى.'); return; }
    const warningAt = remaining - SESSION_WARNING_MS;
    if (warningAt > 0) {
        sessionWarningTimer = setTimeout(() => showSessionWarning(SESSION_WARNING_MS), warningAt);
    } else if (remaining > 0) {
        showSessionWarning(remaining);
    }
    sessionTimer = setTimeout(() => forceLogout('انتهت صلاحية الجلسة.'), remaining);
}

function showSessionWarning(durationMs) {
    const existing = document.querySelector('.session-timeout-banner');
    if (existing) return;
    const minutes = Math.ceil(durationMs / 60000);
    const banner = document.createElement('div');
    banner.className = 'session-timeout-banner';
    banner.innerHTML = `<i class="fa-solid fa-clock"></i> ستنتهي جلستك خلال ${minutes} دقيقة. <button id="extendSessionBtn">تمديد الجلسة</button>`;
    document.body.appendChild(banner);
    document.getElementById('extendSessionBtn').addEventListener('click', () => {
        banner.remove();
        clearTimeout(sessionTimer);
        clearTimeout(sessionWarningTimer);
        const now = Date.now();
        if (localStorage.getItem('currentUser')) localStorage.setItem('loginTimestamp', now);
        else sessionStorage.setItem('loginTimestamp', now);
        startSessionTimeout();
    });
}

async function forceLogout(message) {
    clearTimeout(sessionTimer);
    clearTimeout(sessionWarningTimer);
    // The page's own caches are cleared below, but the service worker's API
    // cache is a separate store that would keep answering with this user's
    // responses to whoever opens the app next. Started now, awaited before the
    // redirect so the next login cannot race the deletion.
    const purge = clearServiceWorkerApiCache();
    localStorage.removeItem('currentUser');
    sessionStorage.removeItem('currentUser');
    localStorage.removeItem('loginTimestamp');
    sessionStorage.removeItem('loginTimestamp');
    setRememberedSession(false);
    localStorage.removeItem('appDB');
    localStorage.removeItem('dbCacheTimestamp');
    localStorage.removeItem(formStateKey());
    sessionStorage.removeItem(reportToEditKey());
    invalidateSmartCaches();
    // إعادة ضبط حالة الشاشات مثل زر الخروج حتى لا تبقى بيانات مستخدم سابق.
    Object.keys(viewMounted).forEach(k => delete viewMounted[k]);
    currentRoute = null;
    // V70: مسح كاش التقارير أيضاً عند انتهاء الجلسة، وإلا رأى المستخدم
    // التالي تقارير سابقه على نفس الجهاز.
    invalidateReportsCache();
    alert(message);
    await purge;
    navigateTo('login');
}

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbydC0vB8dFuoIWNTt1Ma_m-YHYvVo_YonReI4JyytW5QbmdayqB9DcCz9Mr7TrRu-g/exec";
const CACHE_DURATION_MINUTES = 1440;
// V70: مسودّات المستخدم مربوطة بهويته. لو بقيت بمفتاح واحد لصاحب الجلسة
// السابقة استعاد مستخدمٌ آخر مسودّة غيره (أو النقطة الأخيرة التي اختارها).
const formStateKey = () => ownerScopedKey('reportFormLastState');
const reportToEditKey = () => ownerScopedKey('reportToEdit');
// V25: in-memory caches eliminate repeated localStorage JSON parsing during the same page session.
let memoryDbCache = null;
let memoryReportsCache = null;
let dbBgRefreshInProgress = false;

// ===================================================================
//      AJAX LAYER (jQuery) + SHARED REPORTS CACHE — تحسين السرعة
// ===================================================================
const REPORTS_CACHE_TTL_MINUTES = 3;
const REPORTS_CACHE_PREFIX = 'reportsCache_v2::';
// V70: المفتاح القديم `reportsCache` لم يكن مرتبطاً بالمستخدم إطلاقاً، فكان
// مستخدمان على نفس المتصفح يقرآن تقارير بعض. صار لكل مستخدم مفتاح خاص.
const LEGACY_REPORTS_CACHE_PREFIX = 'reportsCache::';
let reportsMemoryByScope = {};
const reportsInflightMap = {};
let memoryReportsCacheOwner = '';

// مفتاح آمن داخل localStorage. لا نستبدل المحارف العربية لأنها قد تصل إلى
// معرّف المستخدم (احتياط username)، فتصبح كل المعرّفات العربية 'anon' ويبدأ
// التسريب من جديد. encodeURIComponent يحافظ على التمييز بين كل الأسماء.
const _safeKeyPart = (v) => {
    const raw = String(v ?? '').trim().toLowerCase();
    if (!raw) return 'anon';
    try { return encodeURIComponent(raw).replace(/\*/g, '%2A'); } catch (e) { return 'anon'; }
};

// مالك كاش التقارير: معرّف المستخدم الحالي. يُؤخذ من الاستدعاء وإن لم يُمرَّر
// يُقرأ من الجلسة المحفوظة، حتى تبقى كل نداءات الصفحة على نفس النطاق.
function reportsCacheOwnerId(params = {}) {
    const explicit = String(params.userId || params.userName || '').trim();
    if (explicit) return explicit;
    try {
        const raw = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
        const u = raw ? JSON.parse(raw) : null;
        return String((u && (u.id || u.username)) || 'anon').trim() || 'anon';
    } catch (e) { return 'anon'; }
}

function reportsScopeKey(params = {}) {
    const role = String(params.role || '').toLowerCase().replace(/[^a-z0-9]/gi, '') || 'default';
    const owner = _safeKeyPart(reportsCacheOwnerId(params));
    const target = String(params.targetUserId || params.userId || 'all');
    return `${owner}__${role}__${target}`;
}

// قراءة الكاش القديم «reportsCache» لمستخدمه فقط.
function readLegacyReportsCacheJSON() {
    try {
        return localStorage.getItem(LEGACY_REPORTS_CACHE_PREFIX + _safeKeyPart(reportsCacheOwnerId({})));
    } catch (e) { return null; }
}

// كاش الذاكرة يُقرأ فقط إذا كان مالكه هو المستخدم الحالي (حماية من بقايا
// جلسة سابقة داخل نفس التبويب).
function getMemoryReportsCache() {
    if (!memoryReportsCache) return null;
    return memoryReportsCacheOwner === _safeKeyPart(reportsCacheOwnerId({})) ? memoryReportsCache : null;
}

// ===================================================================
// V70: كاش كل مستخدم بدل كاش واحد مشترك
//
// كل كاش يحتوي بيانات مستخدم (سجلات دوام، مسودّات، أساس بيانات فيه كشف
// الموظفين) كان يُخزَّن بمفتاح واحد يتقاسمه كل من ي logged in على نفس
// المتصفح. المفتاح صار ينتهي بهوية المالك، وشريط التنظيف أدناه يحذف أي
// مفتاح لا يخص المستخدم الحالي — فيبقى أي كاش جديد أو قديم محمياً حتى لو
// نُسي ربطه.
// ===================================================================

    // بادئات كل الكاشات الخاصة بالمستخدم. المفتاح المربوط = <بادئة>::<هوية المالك>.
// البادئات بلا '::' عمداً حتى نلتقط المفاتيح القديمة غير المربوطة ونتخلص منها
// (وإلا بقيت في التخزين.LocalStorage لأبد).
const USER_SCOPED_CACHE_PREFIXES = [
    'reportsCache_v2::', 'reportsCache::',
    'attendanceCache::', 'attendanceStatusCache',
    'appDB_', 'dbCacheTimestamp_',
    'expensesDraft::', 'lastReportPoint',
    'reportFormLastState', 'reportToEdit',
    'entryFeedSeen_v1::',
    'salaryAdvances::',
];

/** يبني مفتاح كاش لا يشارك فيه إلا صاحب هذه الجلسة. */
function ownerScopedKey(name) {
    return `${name}::${_safeKeyPart(reportsCacheOwnerId({}))}`;
}

function isUserScopedCacheKey(key) {
    return USER_SCOPED_CACHE_PREFIXES.some(p => key.startsWith(p));
}

/**
 * يحذف من التخزين المحلي والجلسة كل كاش لا يخص المستخدم الحالي، بما فيه
 * المفاتيح القديمة غير المربوطة. تُستدعى بعد تسجيل الدخول وقبل قراءة أي
 * كاش، حتى لا يقرأ مستخدم جديد بيانات سابقه. تُعيد قائمة المفاتيح المحذوفة.
 *
 * sessionStorage مشمول لأن 'reportToEdit' (تعديل تقرير) تعيش هناك، وإلا
 * لبقيت في التبويب نفسه بعد تبديل المستخدم.
 */
function sweepForeignUserCaches() {
    const mine = '::' + _safeKeyPart(reportsCacheOwnerId({}));
    const removed = [];
    [localStorage, sessionStorage].forEach(store => {
        try {
            Object.keys(store).forEach(k => {
                if (!isUserScopedCacheKey(k)) return;
                if (k.endsWith(mine)) return;   // يخصّني، أبقِه
                store.removeItem(k);
                removed.push(k);
            });
        } catch (e) { /* التخزين غير متاح */ }
    });
    return removed;
}


// ===================================================================
// V67: جلسة العميل — token يصدره الخادم عند الدخول ويُرفق بكل طلب لاحق.
// عند رفض التوثيق (code='unauthorized') نُعيد المستخدم لشاشة الدخول تلقائياً.
// ===================================================================
const AUTH_TOKEN_KEY = 'appAuthToken';
const CSRF_TOKEN_KEY = 'appCsrfToken';

function storeAppToken(token) {
    if (!token) return;
    clearAppToken();
    try { localStorage.setItem(AUTH_TOKEN_KEY, token); } catch (e) { try { sessionStorage.setItem(AUTH_TOKEN_KEY, token); } catch (e2) {} }
}

function getAppToken() {
    try {
        const t = localStorage.getItem(AUTH_TOKEN_KEY);
        if (t) return t;
        return sessionStorage.getItem(AUTH_TOKEN_KEY) || '';
    } catch (e) { return ''; }
}

function clearAppToken() {
    try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) {}
    try { sessionStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) {}
}

function storeCsrfToken(token) {
    if (!token) return;
    try { localStorage.setItem(CSRF_TOKEN_KEY, token); } catch (e) { try { sessionStorage.setItem(CSRF_TOKEN_KEY, token); } catch (e2) {} }
}

function getCsrfToken() {
    try {
        const t = localStorage.getItem(CSRF_TOKEN_KEY);
        if (t) return t;
        return sessionStorage.getItem(CSRF_TOKEN_KEY) || '';
    } catch (e) { return ''; }
}

function clearCsrfToken() {
    try { localStorage.removeItem(CSRF_TOKEN_KEY); } catch (e) {}
    try { sessionStorage.removeItem(CSRF_TOKEN_KEY); } catch (e) {}
}

let authExpiryHandled = false;
async function handleAuthExpired() {
    if (authExpiryHandled) return;
    authExpiryHandled = true;
    clearAppToken();
    localStorage.removeItem('currentUser');
    sessionStorage.removeItem('currentUser');
    localStorage.removeItem('loginTimestamp');
    sessionStorage.removeItem('loginTimestamp');
    invalidateSmartCaches();
    Object.keys(viewMounted).forEach(k => delete viewMounted[k]);
    currentRoute = null;
    // V70: نفس الشيء عند التبديل بين المستخدمين.
    invalidateReportsCache();
    navigateTo('login');
    await activateRoute();
}

function detectAuthFailure(res) {
    if (!res || typeof res !== 'object') return;
    if (res.status === 'error' && res.code === 'unauthorized') handleAuthExpired();
}

// ===================================================================
// V69: إشعارات الرفض — عند فتح الموظف حسابه يرى أي تقرير/دوام/حركة مادة مرفوضة
// (تُشتق مباشرة من حالة الاعتماد في البيانات، دون جدول إشعارات منفصل).
// ===================================================================
const REJECTION_DISMISS_KEY = 'rejectedNotificationsDismissed_v1';
let rejectionCheckInFlight = false;

function rejectionIdsSignature(rejected) {
    if (!rejected) return '';
    const mapId = (x) => String(x && (x.id ?? x.timestamp ?? ''));
    const r = (rejected.reports || []).map(x => 'r' + mapId(x)).join(',');
    const a = (rejected.attendance || []).map(x => 'a' + mapId(x)).join(',');
    const m = (rejected.movements || []).map(x => 'm' + mapId(x)).join(',');
    return r + '|' + a + '|' + m;
}

async function loadUserRejections() {
    const user = getStoredUser();
    if (!user) return { reports: [], attendance: [], movements: [] };
    const u = String(user.id || ''), r = String(user.role || ''), n = String(user.name || '');
    const res = await Promise.allSettled([
        apiGet('getReports', { userId: u, role: r, userName: n, targetUserId: u }),
        apiGet('getAttendance', { userId: u, role: r, userName: n, targetUserId: u }),
        apiGet('getUserFestivalMovements', { userId: u, role: r, targetUserId: u })
    ]);
    const rejected = { reports: [], attendance: [], movements: [] };
    if (res[0].status === 'fulfilled' && Array.isArray(res[0].value)) rejected.reports = res[0].value.filter(x => String(x.approvalStatus) === 'rejected');
    if (res[1].status === 'fulfilled' && Array.isArray(res[1].value)) rejected.attendance = res[1].value.filter(x => String(x.approvalStatus) === 'rejected');
    if (res[2].status === 'fulfilled' && res[2].value && Array.isArray(res[2].value.movements)) rejected.movements = res[2].value.movements.filter(x => String(x.approvalStatus) === 'rejected');
    return rejected;
}

function removeRejectedBanner() {
    const el = document.getElementById('rejection-notices');
    if (el) el.innerHTML = '';
}

function renderRejectedBanner(rejected) {
    const el = document.getElementById('rejection-notices');
    if (!el) return;
    const e = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const counts = [];
    if (rejected.reports.length) counts.push(`<strong>${rejected.reports.length}</strong> تقرير مرفوض`);
    if (rejected.attendance.length) counts.push(`<strong>${rejected.attendance.length}</strong> سجل دوام مرفوض`);
    if (rejected.movements.length) counts.push(`<strong>${rejected.movements.length}</strong> حركة مادة مرفوضة`);
    if (!counts.length) { removeRejectedBanner(); return; }
    const lines = [];
    if (rejected.reports.length) {
        const x = rejected.reports[0];
        lines.push(`<li><i class="fa-solid fa-file-circle-xmark me-1"></i>تقرير رقم <b>${e(x.id)}</b> (${e(x.date || '')}) — السبب: <b>${e(x.rejectionReason || 'غير مذكور')}</b> — بواسطة ${e(x.rejectionBy || 'غير معروف')}</li>`);
    }
    if (rejected.attendance.length) {
        const x = rejected.attendance[0];
        lines.push(`<li><i class="fa-solid fa-clock me-1"></i>سجل دوام <b>${e(x.timestamp || '')}</b> — السبب: <b>${e(x.rejectionReason || 'غير مذكور')}</b> — بواسطة ${e(x.rejectionBy || 'غير معروف')}</li>`);
    }
    if (rejected.movements.length) {
        const x = rejected.movements[0];
        lines.push(`<li><i class="fa-solid fa-box-open me-1"></i>حركة مادة <b>${e(x.item || '')}</b> — السبب: <b>${e(x.rejectionReason || 'غير مذكور')}</b> — بواسطة ${e(x.rejectionBy || 'غير معروف')}</li>`);
    }
    el.innerHTML = `<div class="alert alert-danger d-flex justify-content-between align-items-start rounded-3 shadow-sm mb-0">
        <div>
            <i class="fa-solid fa-circle-exclamation me-1"></i><strong>لديك ${counts.join('، ')}</strong>
            <ul class="mb-0 mt-1 small ps-3">${lines.join('')}</ul>
        </div>
        <button type="button" class="btn-close" aria-label="إخفاء الإشعار"></button>
    </div>`;
    const closeBtn = el.querySelector('.btn-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
        el.innerHTML = '';
        try {
            const user = getStoredUser();
            const userKey = 'u' + (user ? (user.id || user.name || '') : '');
            localStorage.setItem(REJECTION_DISMISS_KEY, userKey + '::' + rejectionIdsSignature(rejected));
        } catch (e2) {}
    });
}

async function checkRejections({ force = false } = {}) {
    if (rejectionCheckInFlight) return;
    const user = getStoredUser();
    if (!user) { removeRejectedBanner(); return; }
    rejectionCheckInFlight = true;
    try {
        const rejected = await loadUserRejections();
        const sig = rejectionIdsSignature(rejected);
        if (!sig) { removeRejectedBanner(); return; }
        const userKey = 'u' + String(user.id || user.name || '');
        try {
            const dismissed = localStorage.getItem(REJECTION_DISMISS_KEY);
            if (!force && dismissed && dismissed === userKey + '::' + sig) { removeRejectedBanner(); return; }
        } catch (e0) {}
        renderRejectedBanner(rejected);
    } finally { rejectionCheckInFlight = false; }
}

// ===================================================================
// إشعار الإدخالات الجديدة من بقية الفريق
//
// الأدمن يشوف كل الإدخالات، والمدير يشوف إدخالات فريقه. الموظف العادي لا
// إشعار له: getTeamMemberIds يرجّع [id] لغير الأدمن والمدير، فلا يصله أصلاً
// بيانات غيره، والفلتر النهائي هنا است defence في العمق.
// الفلسفة: «شريط داخل التطبيق» — يظهر عند فتح التطبيق أو عند تحديث البيانات.
// ===================================================================
const ENTRY_FEED_MAX = 6;          // أقصى عدد أسطر في الشريط
const ENTRY_FEED_WINDOW_HOURS = 72; // لا نعلن عن إدخال أقدم من هذا
const ENTRY_FEED_SEEN_LIMIT = 200;  // سقف قائمة «المقروء»
let entryFeedCheckInFlight = false;
// الإدخالات الظاهرة حالياً في الشريط. نحتفظ بها لنعرف أيّها صار «مقروءاً» عند
// التنقل، لأن الشريط لا يحمل حالة مقروء/غير مقروء لكل سطر على حدة.
let entryFeedPending = [];

// قائمة المقروء تخصّ صاحبها فقط؛ لو تركناها بمفتاح واحد لافترض managers
// متعدّدون على نفس المتصفح أن بعضهم قرأ إشعار بعض.
function entryFeedSeenKey() { return ownerScopedKey('entryFeedSeen_v1'); }

function userSystemRole() {
    const u = getStoredUser() || {};
    return String(u.systemRole || u.role || '').trim().toLowerCase();
}

/** يقبل 'yyyy-MM-dd HH:mm:ss' أو Date أو رقم، ويرجع null عند التعذّر. */
function parseEntryTime(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === 'number' && isFinite(value)) return value;
    const s = String(value ?? '').trim();
    if (!s) return null;
    // تاريخ بلا وقت: يُقرأ كـ«يوم محلي» مثل ورقة Sheets.
    // Date.parse يقرأ صيغة 'yyyy-mm-dd' كتوقيت UTC، فيزحلقه 3 ساعات
    // (−03:00) فيظهر تقرير «اليوم» dated أمس عند حافة نافذة السبعين ساعة.
    const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime();
    // '2026-01-05 13:04:00' — لا يمكن لـ Date.parse قراءة فراغ بدل T.
    const t = Date.parse(s.replace(' ', 'T'));
    return isNaN(t) ? null : t;
}

/**
 * يحوّل إدخالات الأنواع الأربعة إلى قائمة موحّدة، ويشيل إدخالات المستخدم الحالي
 * و.redundant والمكرر. دالة خالصة عمداً حتى يسهل اختبارها.
 *
 * movements لا تحمل وقتاً في الرد (الخادم يحذف rawDate)، فنعتمد على ترتيب
 * المصفوفة: الخادم يرجّعها تنازلياً بالأحدث أولاً.
 */
function buildTeamEntryFeed(sources, meId) {
    const me = String(meId ?? '').trim();
    const isMine = (authorId, authorName) => {
        const a = String(authorId ?? '').trim();
        if (a) return a === me;
        const n = String(authorName ?? '').trim();
        return !!n && !!me && n === me;
    };
    const out = [];
    const seen = new Set();
    const push = (entry) => {
        const key = entry.key;
        if (!key || seen.has(key)) return;   // نفس الإدخال مرّ من مصدرين
        seen.add(key);
        out.push(entry);
    };

    (Array.isArray(sources.reports) ? sources.reports : []).forEach(r => {
        if (!r || r.deletedAt) return;                       // محذوف ناعم
        if (isMine(r.createdById, r.createdByName)) return;
        push({
            key: 'report:' + r.id, type: 'report',
            time: parseEntryTime(r.date), date: String(r.date ?? ''),
            who: String(r.createdByName || r.createdById || 'غير معروف'),
            what: [r.event, r.campaign, r.market].filter(Boolean).join(' · '),
        });
    });
    (Array.isArray(sources.attendance) ? sources.attendance : []).forEach(a => {
        if (!a) return;
        if (isMine(a.userId, a.username)) return;
        push({
            key: 'att:' + (a.timestamp || '') + ':' + (a.username || ''), type: 'attendance',
            time: parseEntryTime(a.timestamp), date: String(a.timestamp || ''),
            who: String(a.username || 'غير معروف'),
            what: String(a.status || 'تسجيل دوام'),
        });
    });
    (Array.isArray(sources.movements) ? sources.movements : []).forEach((m, i) => {
        if (!m) return;
        if (isMine(m.createdById, m.createdByName)) return;
        push({
            key: 'move:' + String(i) + ':' + String(m.createdById || '') + ':' + String(m.item || ''),
            type: 'movement', time: null, date: '',
            who: String(m.createdByName || m.createdById || 'غير معروف'),
            what: String(m.item || 'حركة مادة'),
        });
    });
    (Array.isArray(sources.advances) ? sources.advances : []).forEach(s => {
        if (!s) return;
        if (isMine(s.employeeId, s.createdByName)) return;
        push({
            key: 'sal:' + String(s.date || '') + ':' + String(s.employeeId || '') + ':' + String(s.amount || ''),
            type: 'advance',
            time: parseEntryTime(s.createdAt) ?? parseEntryTime(s.date),
            date: String(s.date || ''),
            who: String(s.employeeName || s.createdByName || 'غير معروف'),
            what: [s.type, s.amount ? Number(s.amount) : ''].filter(Boolean).join(' — '),
        });
    });
    return out;
}

/** الجديد = غير موجود في قائمة «المقروء» وداخل نافذة الزمن. */
function selectUnseenEntries(entries, seenKeys, nowMs, maxItems, windowHours) {
    const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys || []);
    const cutoff = Number(nowMs) - (Number(windowHours) * 3600000);
    // maxItems = 0 تعني «لا تعرض شيئاً» لا «بلا حد» — وإلا عاد فخ السقف
    // المكسور إلى لا نهائي بلا أن ينتبه أحد.
    const capped = Number.isFinite(Number(maxItems)) && Number(maxItems) >= 0;
    const limit = capped ? Number(maxItems) : Infinity;
    const fresh = [];
    for (const e of entries) {
        if (fresh.length >= limit) break;    // قبل الدفع لا بعده، وإلا مرّ واحد على الأقل
        if (!e || seen.has(e.key)) continue;
        // بلا وقت = لا نعرف عمره؛ نقبله إن كان ضمن أولى القائمة والأحدث ترتيباً.
        if (e.time != null && e.time < cutoff) continue;
        fresh.push(e);
    }
    return fresh;
}

function loadSeenEntryKeys() {
    try {
        const raw = localStorage.getItem(entryFeedSeenKey());
        const parsed = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch (e) { return new Set(); }
}

function rememberSeenEntryKeys(entries, extra = []) {
    const keys = [...(Array.isArray(entries) ? entries : []), ...extra]
        .filter(Boolean).map(e => (typeof e === 'string' ? e : e.key)).filter(Boolean);
    if (!keys.length) return;
    try {
        // ندمج مع القديم على شكل مجموعة، وبسقف، حتى لا تتضخم بلا حد.
        const merged = [...new Set([...keys, ...loadSeenEntryKeys()])].slice(0, ENTRY_FEED_SEEN_LIMIT);
        localStorage.setItem(entryFeedSeenKey(), JSON.stringify(merged));
    } catch (e) {}
}

const ENTRY_FEED_ICONS = {
    report: 'fa-file-lines', attendance: 'fa-clock',
    movement: 'fa-box-open', advance: 'fa-money-bill-transfer',
};
const ENTRY_FEED_LABELS = {
    report: 'تقرير', attendance: 'سجل دوام',
    movement: 'حركة مادة', advance: 'سلفة',
};

function removeEntryFeedBanner() {
    const el = document.getElementById('entry-feed-notices');
    if (el) el.innerHTML = '';
    entryFeedPending = [];
}

/**
 * يُعتبر الإدخالات الظاهرة «مقروءة» ويُخفيها من الشريط.
 * تُستدعى عند التنقل لصفحة: فتح الصفحة يعني أن المستخدم رأى الإشعار، فلا يبقى
 * شريطاً دائماً يحجب الواجهة. الإشعارات الجديدة تظهر في الفتحة التالية.
 */
function markEntryFeedRead() {
    if (!entryFeedPending.length) return;
    rememberSeenEntryKeys(entryFeedPending);
    removeEntryFeedBanner();
}

function renderEntryFeedBanner(entries) {
    const el = document.getElementById('entry-feed-notices');
    if (!el) return;
    if (!Array.isArray(entries) || !entries.length) { removeEntryFeedBanner(); return; }
    entryFeedPending = entries;
    const e = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const rows = entries.map(x => {
        const meta = [ENTRY_FEED_LABELS[x.type] || 'إدخال', x.date].filter(Boolean).join(' — ');
        return `<li><i class="fa-solid ${ENTRY_FEED_ICONS[x.type] || 'fa-circle-info'} me-1"></i>`
            + `<b>${e(x.who)}</b> أضاف ${e(ENTRY_FEED_LABELS[x.type] || 'إدخال')}`
            + `${x.what ? ': ' + e(x.what) : ''}`
            + `${meta ? ` <span class="text-muted small">(${e(meta)})</span>` : ''}</li>`;
    });
    const more = entries.length >= ENTRY_FEED_MAX
        ? `<li class="text-muted small">وهناك إدخالات أخرى — افتح «سجل التعديلات» للتفاصيل.</li>` : '';
    el.innerHTML = `<div class="alert alert-info d-flex justify-content-between align-items-start rounded-3 shadow-sm mb-0">
        <div>
            <i class="fa-solid fa-bell me-1"></i><strong>إدخالات جديدة من فريقك (${entries.length})</strong>
            <ul class="mb-0 mt-1 small ps-3">${rows.join('')}${more}</ul>
        </div>
        <button type="button" class="btn-close" aria-label="إخفاء الإشعار"></button>
    </div>`;
    const closeBtn = el.querySelector('.btn-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
        // removeEntryFeedBanner تمسح الشريط وentryFeedPending معاً، وإلا ظلّت
        // الإدخالات محفوظة «معلّقة» وتُعاد إضافتها للمقروء عند تنقل لاحق.
        removeEntryFeedBanner();
        rememberSeenEntryKeys(entries);
    });
}

/** يستعلم من الأربعة. Promise.allSettled حتى لا يُسقط فشل مصدر واحد الشريط. */
async function loadTeamEntrySources() {
    const user = getStoredUser();
    if (!user) return null;
    const role = userSystemRole();
    if (role !== 'admin' && role !== 'manager') return null;   // لا إشعار لموظف عادي
    const u = String(user.id || ''), r = String(user.role || ''), n = String(user.name || '');
    const res = await Promise.allSettled([
        apiGet('getReports', { userId: u, role: r, userName: n, targetUserId: 'all' }),
        apiGet('getAttendance', { userId: u, role: r, userName: n, targetUserId: 'all' }),
        apiGet('getUserFestivalMovements', { userId: u, role: r, targetUserId: 'all' }),
        apiGet('getSalaryAdvances', {}),
    ]);
    return {
        reports: res[0].status === 'fulfilled' && Array.isArray(res[0].value) ? res[0].value : [],
        attendance: res[1].status === 'fulfilled' && Array.isArray(res[1].value) ? res[1].value : [],
        movements: res[2].status === 'fulfilled' && res[2].value && Array.isArray(res[2].value.movements) ? res[2].value.movements : [],
        advances: res[3].status === 'fulfilled' && res[3].value && Array.isArray(res[3].value.advances) ? res[3].value.advances : [],
    };
}

async function checkTeamEntryFeed({ force = false } = {}) {
    if (entryFeedCheckInFlight) return;
    const user = getStoredUser();
    if (!user) { removeEntryFeedBanner(); return; }
    const role = userSystemRole();
    if (role !== 'admin' && role !== 'manager') { removeEntryFeedBanner(); return; }
    entryFeedCheckInFlight = true;
    try {
        const sources = await loadTeamEntrySources();
        if (!sources) { removeEntryFeedBanner(); return; }
        const entries = buildTeamEntryFeed(sources, user.id || user.username);
        const seen = force ? new Set() : loadSeenEntryKeys();
        const fresh = selectUnseenEntries(entries, seen, Date.now(), ENTRY_FEED_MAX, ENTRY_FEED_WINDOW_HOURS);
        if (!fresh.length) { removeEntryFeedBanner(); return; }
        renderEntryFeedBanner(fresh);
    } catch (e) {
        removeEntryFeedBanner();
    } finally { entryFeedCheckInFlight = false; }
}

// GET عبر jQuery (مع احتياطي fetch).
function apiGet(action, params = {}) {
    const query = new URLSearchParams();
    query.set('action', action);
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') query.set(k, v); });
    const token = getAppToken();
    if (token) query.set('token', token);
    const csrfToken = getCsrfToken();
    if (csrfToken) query.set('csrfToken', csrfToken);
    query.set('_', String(Date.now()));
    const url = `${SCRIPT_URL}?${query.toString()}`;
    const req = !window.jQuery
        ? fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        : $.ajax({ url, method: 'GET', dataType: 'json', cache: false, timeout: 120000 })
            .then(d => d, x => { throw new Error((x && (x.statusText || x.responseText)) || 'خطأ في الاتصال'); });
    return req.then(d => { detectAuthFailure(d); return d; });
}

// POST عبر jQuery (مع احتياطي fetch).
function apiPost(action, payload = {}) {
    const data = Object.assign({}, payload);
    if (action !== 'doLogin') {
        const token = getAppToken();
        if (token) data.token = token;
        const csrfToken = getCsrfToken();
        if (csrfToken) data.csrfToken = csrfToken;
    }
    if (!window.jQuery) {
        return fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, payload: data }) })
            .then(r => r.json()).then(d => { detectAuthFailure(d); return d; });
    }
    return $.ajax({
        url: SCRIPT_URL, method: 'POST', dataType: 'json',
        contentType: 'text/plain;charset=utf-8', timeout: 120000,
        data: JSON.stringify({ action, payload: data })
    }).then(d => { detectAuthFailure(d); return d; }, x => { throw new Error((x && (x.statusText || x.responseText)) || 'خطأ في الاتصال'); });
}

// -------------------------------------------------------------------
// V73: تأجيل العمل غير المرئي عن لحظة الإقلاع.
// الإشعاران (المرفوضات + إدخالات الفريق) يطلبان 7 ردود من Apps Script، وكانا
// يُطلقان في نفس اللحظة التي تطلب فيها الشاشة الأولى بياناتها، فيتزاحمان معها
// على نفس الاتصال — وكل رد من Apps Script بطيء. التأجيل هنا لا يُلغي العمل،
// بل يضعه بعد أول رسم وبعد أن تكون طلبات الشاشة الأولى قد انطلقت.
// -------------------------------------------------------------------
function afterFirstScreen(fn, delayMs = 2500) {
    setTimeout(() => { try { fn(); } catch (e) { console.warn('Deferred task failed:', e); } }, Number(delayMs) || 0);
}

// V73: Chart.js وحدها ~205KB، ولا تحتاجها إلا شاشة التحليلات. كانت تُنزَّل مع
// كل فتح للتطبيق — بما فيه شاشة الدخول. تُجلب الآن عند فتح التحليلات فقط،
// وتبقى في APP_SHELL فتُخدم من كاش الـservice worker فوراً على الأجهزة المثبّتة.
const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
const CHART_JS_INTEGRITY = 'sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4';
let chartLibPromise = null;
function ensureChartLib() {
    if (typeof Chart !== 'undefined') return Promise.resolve(true);
    if (chartLibPromise) return chartLibPromise;
    chartLibPromise = new Promise((resolve) => {
        const el = document.createElement('script');
        el.src = CHART_JS_URL;
        el.integrity = CHART_JS_INTEGRITY;
        el.crossOrigin = 'anonymous';
        el.async = true;
        el.onload = () => resolve(typeof Chart !== 'undefined');
        // فشل الجلب لا يُعلَّق الشاشة: تُبنى بقية التحليلات بلا رسوم بيانية.
        el.onerror = () => { chartLibPromise = null; resolve(false); };
        (document.head || document.body).appendChild(el);
    });
    return chartLibPromise;
}
let chartWarmStarted = false;
function warmChartLibWhenIdle() {
    if (chartWarmStarted) return;
    const role = String((getStoredUser() || {}).role || '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'manager') return;   // التحليلات لهم فقط
    chartWarmStarted = true;
    afterFirstScreen(() => { ensureChartLib(); }, 4000);
}

// جلب getReports مع منع التكرار أثناء وجود طلب جارٍ (dedupe).
function ajaxGetReports(params = {}) {
    const scope = reportsScopeKey(params);
    if (reportsInflightMap[scope]) return reportsInflightMap[scope];
    const p = apiGet('getReports', params);
    reportsInflightMap[scope] = p;
    p.then(() => { if (reportsInflightMap[scope] === p) delete reportsInflightMap[scope]; }, () => { if (reportsInflightMap[scope] === p) delete reportsInflightMap[scope]; });
    return p;
}

const reportPagesInflight = {};
function ajaxGetReportsPage(params = {}) {
    const key = [
        reportsScopeKey(params),
        String(params.page || 1),
        String(params.pageSize || 20)
    ].join('__');
    if (reportPagesInflight[key]) return reportPagesInflight[key];
    const p = apiGet('getReportsPage', params);
    reportPagesInflight[key] = p;
    p.then(() => { if (reportPagesInflight[key] === p) delete reportPagesInflight[key]; },
           () => { if (reportPagesInflight[key] === p) delete reportPagesInflight[key]; });
    return p;
}

function saveReportsCacheEntry(scope, data, params = {}) {
    reportsMemoryByScope[scope] = data;
    try {
        localStorage.setItem(REPORTS_CACHE_PREFIX + scope, JSON.stringify(data));
        localStorage.setItem(REPORTS_CACHE_PREFIX + scope + '_ts', String(Date.now()));
    } catch (e) { /* امتلاء التخزين */ }
    // توافق مع الأجزاء القديمة التي تقرأ memoryReportsCache / reportsCache —
    // لكن تحت مفتاح المالك حتى لا يقرأه مستخدم آخر.
    if (!params.targetUserId || params.targetUserId === 'all') {
        memoryReportsCache = data;
        memoryReportsCacheOwner = _safeKeyPart(reportsCacheOwnerId(params));
        try {
            localStorage.setItem(LEGACY_REPORTS_CACHE_PREFIX + memoryReportsCacheOwner, JSON.stringify(data));
        } catch (e) {}
    }
}

function invalidateReportsCache() {
    reportsMemoryByScope = {};
    memoryReportsCache = null;
    memoryReportsCacheOwner = '';
    try {
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith(REPORTS_CACHE_PREFIX) || k.startsWith(LEGACY_REPORTS_CACHE_PREFIX)) {
                localStorage.removeItem(k);
            }
        });
        // المفتاح القديم غير المرتبط بالمستخدم — يُمسح مرة واحدة عند الترقية.
        localStorage.removeItem('reportsCache');
    } catch (e) {}
}

// جلب التقارير بأسلوب «اعرض القديم فوراً + حدّث بالخلفية» (stale-while-revalidate):
// - كاش طازج  => يعيده فوراً دون أي شبكة.
// - كاش قديم  => يعيده فوراً ويجلب الأحدث بالخلفية ثم يرسل reportsCacheUpdated.
// - لا كاش    => ينتظر الشبكة.
// - أوفلاين   => يعيد أي كاش محفوظ مهما كان قديماً.
async function cachedReportsFetch(params = {}, opts = {}) {
    const force = !!opts.force;
    const ttlMs = (opts.ttlMinutes || REPORTS_CACHE_TTL_MINUTES) * 60000;
    const scope = reportsScopeKey(params);
    const storeKey = REPORTS_CACHE_PREFIX + scope;
    const tsKey = storeKey + '_ts';

    let cached = null, ts = 0;
    try {
        if (!reportsMemoryByScope[scope]) {
            const raw = localStorage.getItem(storeKey);
            if (raw && raw !== 'undefined') reportsMemoryByScope[scope] = JSON.parse(raw);
        }
        cached = reportsMemoryByScope[scope] || null;
        ts = Number(localStorage.getItem(tsKey) || 0);
    } catch (e) { cached = null; }

    const isFresh = !!cached && !!ts && (Date.now() - ts) < ttlMs;

    if (force) {
        try {
            // forceRefresh=1: موجه للـ Service Worker لتجاوز كاش الأكواد (وبالتالي
            // الحصول على بيانات جديدة فعلاً بدل نسخة قديمة تُعاد فوراً).
            const data = await ajaxGetReports(Object.assign({}, params, { forceRefresh: '1' }));
            saveReportsCacheEntry(scope, data, params);
            return data;
        } catch (e) {
            return cached || [];
        }
    }

    if (isFresh || (!navigator.onLine && cached)) return cached || [];

    if (!cached) {
        try {
            const data = await ajaxGetReports(params);
            saveReportsCacheEntry(scope, data, params);
            return data;
        } catch (e) {
            return [];
        }
    }

    // كاش قديم: نعيده فوراً ونحدّثه بالخلفية.
    if (!reportsInflightMap[scope]) {
        ajaxGetReports(params).then(data => {
            saveReportsCacheEntry(scope, data, params);
            window.dispatchEvent(new CustomEvent('reportsCacheUpdated', { detail: { scope, data } }));
        }).catch(err => console.warn('تحديث خلفي للتقارير فشل (يستمر بالكاش):', err));
    }
    return cached;
}

let originalCreatedAt = null; 

// ===================================================================
//                     OFFLINE-FIRST STORAGE
// ===================================================================
const OFFLINE_DB_NAME = 'festivalOfflineDB';
const OFFLINE_DB_VERSION = 4;
const OFFLINE_QUEUE_STORE = 'pendingReports';
const OFFLINE_ATTENDANCE_STORE = 'pendingAttendance';
const OFFLINE_MOVEMENT_STORE = 'pendingMovements';

function openOfflineDB() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB غير مدعوم'));
        const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) {
                db.createObjectStore(OFFLINE_QUEUE_STORE, { keyPath: 'localId' });
            }
            if (!db.objectStoreNames.contains(OFFLINE_ATTENDANCE_STORE)) {
                db.createObjectStore(OFFLINE_ATTENDANCE_STORE, { keyPath: 'localId' });
            }
            if (!db.objectStoreNames.contains(OFFLINE_MOVEMENT_STORE)) {
                db.createObjectStore(OFFLINE_MOVEMENT_STORE, { keyPath: 'localId' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function queueReportOffline(reportData, options = {}) {
    const db = await openOfflineDB();
    const localId = `${reportData.id}_${Date.now()}`;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite');
        tx.objectStore(OFFLINE_QUEUE_STORE).put({
            localId,
            reportData,
            createdAt: Date.now()
        });
        tx.oncomplete = () => {
            db.close();
            resolve(localId);
            if (options.registerSync !== false) registerBackgroundSync();
        };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

// اطلب من المتصفح إبقاء بيانات التطبيق المثبّت وقائمة المزامنة عند ضغط مساحة
// التخزين. الطلب أفضل محاولة ولا يغيّر السلوك في المتصفحات التي لا تدعمه.
async function requestOfflineStoragePersistence() {
    try {
        const storage = navigator.storage;
        if (!storage || typeof storage.persist !== 'function') return false;
        if (typeof storage.persisted === 'function' && await storage.persisted()) return true;
        return await storage.persist();
    } catch (e) {
        return false;
    }
}

async function getPendingReports() {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_QUEUE_STORE, 'readonly');
        const req = tx.objectStore(OFFLINE_QUEUE_STORE).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function removePendingReport(localId) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite');
        tx.objectStore(OFFLINE_QUEUE_STORE).delete(localId);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function syncPendingReports() {
    if (!navigator.onLine) return;
    let pending = [];
    try { pending = await getPendingReports(); } catch (e) { return; }
    let syncedAny = false;
    for (const item of pending) {
        try {
            // V67: مزامنة آمنة عبر apiPost (يرفق الـ token تلقائياً ويتحقق من الجلسة).
            const result = await apiPost('submitReport', item.reportData);
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل المزامنة');
            await removePendingReport(item.localId);
            syncedAny = true;
        } catch (error) {
            // إن انتهت الجلسة، يوقف detectAuthFailure المزامنة ويعيد التوجيه لتسجيل الدخول.
            if (error?.code === 'unauthorized') return;
            console.warn('Offline sync stopped:', error);
            break;
        }
    }
    if (syncedAny) {
        // Syncing reports does not require rebuilding master data. Invalidate only
        // the local report list so the next history view gets fresh server data.
        invalidateReportsCache();
        window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
    }
    updateOfflineStatus();
}

// ---- Attendance offline queue (same pattern as reports, separate store) ----
async function queueAttendanceOffline(payload) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_ATTENDANCE_STORE, 'readwrite');
        tx.objectStore(OFFLINE_ATTENDANCE_STORE).put({
            localId: `attendance_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            payload,
            createdAt: Date.now()
        });
        tx.oncomplete = () => { db.close(); resolve(); registerBackgroundSync(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function getPendingAttendance() {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_ATTENDANCE_STORE, 'readonly');
        const req = tx.objectStore(OFFLINE_ATTENDANCE_STORE).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function removePendingAttendance(localId) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_ATTENDANCE_STORE, 'readwrite');
        tx.objectStore(OFFLINE_ATTENDANCE_STORE).delete(localId);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function syncPendingAttendance() {
    if (!navigator.onLine) return;
    let pending = [];
    try { pending = await getPendingAttendance(); } catch (e) { return; }
    let syncedAny = false;
    for (const item of pending) {
        try {
            const result = await apiPost('submitAttendance', item.payload);
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل المزامنة');
            await removePendingAttendance(item.localId);
            syncedAny = true;
        } catch (error) {
            console.warn('Attendance offline sync stopped:', error);
            break;
        }
    }
    if (syncedAny) {
        localStorage.removeItem('attendanceCache');
        window.dispatchEvent(new CustomEvent('attendanceCacheInvalidated'));
    }
    updateOfflineStatus();
}


// ---- Materials movement offline queue ----
async function queueMovementOffline(payload) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_MOVEMENT_STORE, 'readwrite');
        tx.objectStore(OFFLINE_MOVEMENT_STORE).put({
            localId: `movement_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            payload, createdAt: Date.now()
        });
        tx.oncomplete = () => { db.close(); resolve(); registerBackgroundSync(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}
async function getPendingMovements() {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_MOVEMENT_STORE, 'readonly');
        const req = tx.objectStore(OFFLINE_MOVEMENT_STORE).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}
async function removePendingMovement(localId) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_MOVEMENT_STORE, 'readwrite');
        tx.objectStore(OFFLINE_MOVEMENT_STORE).delete(localId);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}
async function syncPendingMovements() {
    if (!navigator.onLine) return;
    let pending=[]; try { pending=await getPendingMovements(); } catch(e) { return; }
    let syncedAny=false;
    for (const item of pending) {
        try {
            const result=await apiPost('addFestivalMovement',item.payload);
            if(!result || result.status!=='success') throw new Error(result?.message||'فشل مزامنة الحركة');
            await removePendingMovement(item.localId); syncedAny=true;
        } catch(e) { console.warn('Movement offline sync stopped:',e); break; }
    }
    if(syncedAny) window.dispatchEvent(new CustomEvent('movementCacheInvalidated'));
    updateOfflineStatus();
}

async function updateOfflineStatus() {
    const el = document.getElementById('offline-status');
    if (!el) return;
    let pendingCount = 0;
    try {
        const [reportsPending, attendancePending, movementsPending] = await Promise.all([getPendingReports(), getPendingAttendance(), getPendingMovements()]);
        pendingCount = reportsPending.length + attendancePending.length + movementsPending.length;
    } catch (e) {}
    const badge = document.getElementById('syncPendingBadge');
    if (badge) {
        if (pendingCount) {
            badge.textContent = pendingCount;
            badge.title = `${pendingCount} عنصر بانتظار المزامنة — اضغط للمزامنة الآن`;
            badge.classList.remove('d-none');
        } else {
            badge.classList.add('d-none');
        }
    }
    if (!navigator.onLine) {
        el.textContent = pendingCount ? `🔴 بدون إنترنت — ${pendingCount} عنصر بانتظار المزامنة` : '🔴 بدون إنترنت — العمل محفوظ محلياً';
        el.style.display = 'block';
        el.style.background = '#dc3545';
        el.style.color = '#fff';
    } else if (pendingCount) {
        el.textContent = `🟠 متصل — ${pendingCount} عنصر بانتظار المزامنة`;
        el.style.display = 'block';
        el.style.background = '#ffc107';
        el.style.color = '#000';
    } else {
        el.textContent = '🟢 متصل';
        el.style.display = 'block';
        el.style.background = '#198754';
        el.style.color = '#fff';
        setTimeout(() => { if (navigator.onLine) el.style.display = 'none'; }, 2500);
    }
}

// ===================================================================
//  نافذة تفاصيل المزامنة المعلّقة (#6) — قائمة العناصر + مزامنة يدوية
// ===================================================================
const SYNC_TYPE_LABELS = { reports: 'تقرير مبيعات', attendance: 'تسجيل دوام', movements: 'حركة سحب / مرتجع' };

async function openSyncDetails() {
    const modalEl = document.getElementById('syncDetailsModal');
    if (!modalEl) return;
    if (!window._syncModal) {
        window._syncModal = new bootstrap.Modal(modalEl);
        document.getElementById('syncNowBtn')?.addEventListener('click', async () => {
            const btn = document.getElementById('syncNowBtn');
            const orig = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جارٍ المزامنة...';
            try { await runPendingSyncIfNeeded(); } catch (e) {}
            btn.disabled = false;
            btn.innerHTML = orig;
            renderSyncList();
        });
    }
    renderSyncList();
    window._syncModal.show();
}

async function renderSyncList() {
    const container = document.getElementById('syncListContainer');
    const statusEl = document.getElementById('syncListStatus');
    if (!container) return;
    let items = [];
    try {
        const [reports, attendance, movements] = await Promise.all([
            getPendingReports(), getPendingAttendance(), getPendingMovements()
        ]);
        items = [
            ...reports.map(it => ({ led: it, store: 'reports', label: SYNC_TYPE_LABELS.reports, summary: (it.reportData && (it.reportData.campaign || it.reportData.market)) ? [it.reportData.campaign, it.reportData.market].filter(Boolean).join(' - ') : 'تقرير' })),
            ...attendance.map(it => ({ led: it, store: 'attendance', label: SYNC_TYPE_LABELS.attendance, summary: (it.payload && it.payload.status) || 'دوام' })),
            ...movements.map(it => ({ led: it, store: 'movements', label: SYNC_TYPE_LABELS.movements, summary: 'حركة مواد' }))
        ];
    } catch (e) { items = []; }
    items.sort((a, b) => (a.led.createdAt || 0) - (b.led.createdAt || 0));
    if (statusEl) {
        statusEl.textContent = navigator.onLine
            ? (items.length ? `${items.length} عنصر بانتظار الإرسال — اضغط «مزامنة الآن».` : 'كل العناصر متزامنة.')
            : `${items.length} عنصر محفوظ محلياً — ستُرسل تلقائياً عند عودة الإنترنت.`;
    }
    if (!items.length) {
        container.innerHTML = '<div class="text-center text-muted py-4"><i class="fa-solid fa-circle-check fs-3 d-block mb-2 text-success"></i>لا توجد عناصر بانتظار المزامنة</div>';
        return;
    }
    container.innerHTML = items.map(it => {
        const when = new Date(it.led.createdAt || Date.now()).toLocaleString('ar');
        return `<div class="list-group-item d-flex justify-content-between align-items-center"><div><strong>${escapeHtmlGlobal(it.label)}</strong><div class="small text-muted">${escapeHtmlGlobal(it.summary)}<br>${escapeHtmlGlobal(String(when))}</div></div><button type="button" class="btn btn-sm btn-outline-danger" data-remove-ledger="${escapeHtmlGlobal(String(it.led.localId))}" data-store="${it.store}" title="تجاهل هذا العنصر"><i class="fa-solid fa-xmark"></i></button></div>`;
    }).join('');
    container.querySelectorAll('[data-remove-ledger]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.removeLedger;
            const store = btn.dataset.store;
            try {
                if (store === 'reports') await removePendingReport(id);
                else if (store === 'attendance') await removePendingAttendance(id);
                else await removePendingMovement(id);
            } catch (e) {}
            renderSyncList();
            updateOfflineStatus();
        });
    });
}

window.addEventListener('online', () => { updateOfflineStatus(); syncPendingReports(); syncPendingAttendance(); syncPendingMovements(); });
window.addEventListener('offline', updateOfflineStatus);
navigator.serviceWorker?.addEventListener?.('message', (event) => {
    if (event.data && event.data.type === 'SYNC_PENDING') {
        syncPendingReports(); syncPendingAttendance(); syncPendingMovements();
    }
});
// V42: تسجيل مزامنة الخلفية عند وجود عناصر معلقة (يفضّل على الانتظار للـ setInterval).
async function registerBackgroundSync() {
    if (!navigator.serviceWorker?.ready || !('SyncManager' in window)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register('sync-pending');
    } catch (e) { /* SyncManager غير مدعوم — يبقى setInterval هو الاحتياط */ }
}
let pendingSyncTimer = null;
async function runPendingSyncIfNeeded() {
    if (!navigator.onLine) return;
    try {
        const [reportsPending, attendancePending, movementsPending] = await Promise.all([getPendingReports(), getPendingAttendance(), getPendingMovements()]);
        if (reportsPending.length) await syncPendingReports();
        if (attendancePending.length) await syncPendingAttendance();
        if (movementsPending.length) await syncPendingMovements();
    } catch (e) {
        console.warn('Pending sync check skipped:', e);
    }
}
pendingSyncTimer = setInterval(runPendingSyncIfNeeded, 300000);
document.addEventListener('DOMContentLoaded', () => {
    setupCacheRefreshButtons();
    setupDataSyncTriggerButton();
    requestOfflineStoragePersistence();
    setTimeout(() => { updateOfflineStatus(); syncPendingReports(); syncPendingAttendance(); syncPendingMovements(); }, 500);
});

// ===================================================================
//                     SPA ROUTER (شل واحد + راوتر تجزئة)
// ===================================================================
const SPA_ROUTES = {
    login: 'view-login',
    reports: 'view-reports',
    expenses: 'view-expenses',
    history: 'view-history',
    movement: 'view-movement',
    attendance: 'view-attendance',
    dashboard: 'view-dashboard',
    users: 'view-users',
    salary: 'view-salary',
    complaints: 'view-complaints',
    'complaints-opinion': 'view-complaints-opinion',
    'complaints-bean': 'view-complaints-bean',
    'complaints-site': 'view-complaints-site'
};
const SPA_TITLES = {
    login: 'تسجيل الدخول - لوحة التحكم',
    reports: 'إدخال التقارير - لوحة التحكم',
    expenses: 'المصاريف - لوحة التحكم',
    history: 'سجل التعديلات - لوحة التحكم',
    movement: 'سحب / مرتجع مواد - لوحة التحكم',
    attendance: 'الدوام - لوحة التحكم',
    dashboard: 'التحليلات - لوحة التحكم',
    users: 'إدارة المستخدمين - لوحة التحكم',
    salary: 'السلف المالية - لوحة التحكم',
    complaints: 'شكاوي والملاحظات - لوحة التحكم',
    'complaints-opinion': 'تبديل رأي - لوحة التحكم',
    'complaints-bean': 'ملاحظات البن - لوحة التحكم',
    'complaints-site': 'ملاحظات السيتي - لوحة التحكم'
};
const viewActivators = {};
const viewMounted = {};
let currentRoute = null;

// تسجيل دالة تهيئة كل شاشة (تُنفَّذ مرة واحدة عند أول فتح للشاشة).
function registerView(route, activator) { viewActivators[route] = activator; }

function getStoredUser() {
    try {
        return JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser')) || null;
    } catch (e) { return null; }
}

// حساب role="user" ومنصبه "مروج". المروج يملك الدوام والسلف المالية.
function isPromoterAccount(u) {
    const r = String(u?.role || '').trim().toLowerCase();
    const jp = String(u?.jobPosition || '').trim();
    return r === 'user' && jp === 'مروج';
}

function routeFromHash() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    const name = h.split('?')[0];
    return SPA_ROUTES[name] ? name : 'login';
}

function queryFromHash() {
    const i = (location.hash || '').indexOf('?');
    return i < 0 ? new URLSearchParams() : new URLSearchParams((location.hash || '').slice(i + 1));
}

function navigateTo(route) {
    if (String(route).startsWith('#')) { location.hash = route; return; }
    location.hash = '#/' + route;
}

// الشاشة الرئيسية المناسبة للجلسة الحالية (المروج = الدوام، البقية = التقارير).
function navigateHome() {
    navigateTo(isPromoterAccount(getStoredUser()) ? 'attendance' : 'reports');
}

function hideAppSplash() {
    const splash = document.getElementById('app-splash');
    if (splash) splash.style.display = 'none';
}

function runActivator(route) {
    const fn = viewActivators[route];
    if (!fn) return;
    if (viewMounted[route]) {
        // إعادة فتح الشاشة: إشعار للشاشة لتعيد التحميل من الكاش/الخادم دون إعادة تثبيت.
        window.dispatchEvent(new CustomEvent('spaViewRevisited', { detail: { route } }));
        return;
    }
    viewMounted[route] = true;
    Promise.resolve().then(() => fn());
}

let shellControlsBound = false;
function bindShellUserControls() {
    const user = getStoredUser();
    if (!user) return;
    const welcomeEl = document.getElementById('welcomeMessage');
    if (welcomeEl) welcomeEl.textContent = `أهلاً بك، ${user.name}`;
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn && logoutBtn.dataset.logoutBound !== '1') {
        logoutBtn.dataset.logoutBound = '1';
        logoutBtn.addEventListener('click', async () => {
            // 같은 منطق forceLogout: مسح كاش الـ API عند عامل الخدمة. يُبدأ فوراً
            // حتى لا يتأخر إخراج المستخدم، ويُنتظر قبل التحويل لشاشة الدخول كي لا
            // يسجّل التالي دخوله قبل اكتمال الحذف.
            const purge = clearServiceWorkerApiCache();
            // V67: إبطال الجلسة على الخادم أولاً ثم مسح بيئة العميل.
            const sessionToken = getAppToken();
            if (sessionToken) apiPost('logout', { token: sessionToken }).catch(() => {});
            clearAppToken();
            localStorage.removeItem('currentUser');
            sessionStorage.removeItem('currentUser');
            localStorage.removeItem('loginTimestamp');
            sessionStorage.removeItem('loginTimestamp');
            setRememberedSession(false);
            localStorage.removeItem('appDB');
            localStorage.removeItem('dbCacheTimestamp');
            localStorage.removeItem(formStateKey());
            sessionStorage.removeItem(reportToEditKey());
            invalidateSmartCaches();
            // V69: حذف لافتة إشعارات الرفض عند تسجيل الخروج.
            removeRejectedBanner();
            // إعادة ضبط حالة الشاشات حتى تُبنى من جديد ببيانات المستخدم التالي عند الدخول.
            Object.keys(viewMounted).forEach(k => delete viewMounted[k]);
            currentRoute = null;
            // V70: مسح كاش التقارير بالكامل — كان يبقى على الجهاز بعد الخروج
            // فيقرأه المستخدم التالي قبل أن يجلب بياناته.
            invalidateReportsCache();
            await purge;
            location.hash = '#/login';
            activateRoute();
        });
    }
    // V42/V50: التحليلات للمشرف والمدير والمدقق فقط.
    const role = String(user.role || '').trim().toLowerCase();
    // V69: التحليلات للمدير (manager) والإداري (admin) فقط — مخفية تماماً عن بقية الأدوار.
    const showDashboard = role === 'admin' || role === 'manager';
    document.querySelectorAll('.nav-link-dashboard').forEach(el => { const it = el.closest('.nav-item'); if (it) it.style.display = showDashboard ? '' : 'none'; });
    // المروج يرى الدوام والسلف المالية، بينما تبقى الشاشات التشغيلية الأخرى مخفية.
    const isPromoter = isPromoterAccount(user);
    document.querySelectorAll('.nav-link-reports, .nav-link-expenses, .nav-link-history, .nav-link-movement, .nav-link-complaints').forEach(el => { const it = el.closest('.nav-item'); if (it) it.style.display = isPromoter ? 'none' : ''; });
    // V68: إدارة المستخدمين للإداري (admin) فقط — تُشغَّل بعد القاعدة أعلاه حتى لا يُعاد إظهارها لغير الإداري.
    document.querySelectorAll('.nav-link-users').forEach(el => { const it = el.closest('.nav-item'); if (it) it.style.display = role === 'admin' ? '' : 'none'; });
    shellControlsBound = true;
}

function activateRoute() {
    let route = routeFromHash();
    const user = getStoredUser();
    const prevRoute = currentRoute;

    // حراسة الصلاحيات: بلا جلسة → شاشة الدخول، جلسة على الدخول → الرئيسية.
    // المروج مسموح له بالدوام والسلف المالية فقط.
    if (!user && route !== 'login') route = 'login';
    else if (user && route === 'login') { navigateHome(); return; }
    else if (user && isPromoterAccount(user) && route !== 'attendance' && route !== 'salary') { navigateTo('attendance'); return; }
    // V68: شاشة إدارة المستخدمين للإداري (admin) فقط.
    else if (user && String(user.role || '').trim().toLowerCase() !== 'admin' && route === 'users') { navigateHome(); return; }
    // V69: التحليلات للمدير (manager) والإداري (admin) فقط — منع الدخول المباشر لغيرهم.
    else if (user && route === 'dashboard') {
        const role = String(user.role || '').trim().toLowerCase();
        if (role !== 'admin' && role !== 'manager') { navigateHome(); return; }
    }

    currentRoute = route;
    const isLogin = route === 'login';
    hideAppSplash();
    document.body.classList.toggle('login-body', isLogin);

    const loginView = document.getElementById('view-login');
    const appShell = document.getElementById('app-shell');
    if (loginView) loginView.classList.toggle('d-none', !isLogin);
    if (appShell) appShell.classList.toggle('d-none', isLogin);

    Object.keys(SPA_ROUTES).forEach(r => {
        const sec = document.getElementById(SPA_ROUTES[r]);
        if (sec && r !== 'login') sec.classList.toggle('d-none', r !== route);
    });

    document.querySelectorAll('.navbar-nav .nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.route === route);
    });

    if (document.title !== SPA_TITLES[route]) document.title = SPA_TITLES[route] || 'لوحة التحكم';

    if (isLogin) { runActivator('login'); return; }

    // التنقل الفعلي بين الشاشات = المستخدم رأى الإشعارات الظاهرة، فتختفي من الشريط.
    // لا نُطبق هذا عند الإقلاع الأول (prev فارغ) حتى لا يمسح الشريط قبل أن يُرسم.
    if (prevRoute && prevRoute !== route) markEntryFeedRead();

    bindShellUserControls();

    // أوامر التنقل بين الشاشات: فتح تقرير في السجل بعد الحفظ.
    // (معرّف التعديل لا يمر من هنا: يمرّ عبر window.__spaPendingEditId مباشرة،
    //  لأن مفتاح sessionStorage 'spaEditReportId' كان يُقرأ ولا يكتبه أحد.)
    if (route === 'history') {
        const scrollId = sessionStorage.getItem('spaScrollReportId');
        if (scrollId) { sessionStorage.removeItem('spaScrollReportId'); window.__spaPendingScrollId = scrollId; }
    }

    runActivator(route);
    window.scrollTo(0, 0);
    // إغلاق قائمة الأزرار على الجوال بعد التنقل.
    try {
        const nav = document.getElementById('mainNav');
        if (nav) bootstrap.Collapse.getOrCreateInstance(nav)?.hide();
    } catch (e) {}
}

document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();
    initPwaInstall();
    startSessionTimeout();
    activateRoute();
    // V73: الإشعارات بعد أول شاشة لا في لحظة إقلاعها (7 طلبات بطيئة).
    afterFirstScreen(() => checkRejections(), 2500);
    afterFirstScreen(() => checkTeamEntryFeed(), 3000);
    afterFirstScreen(() => warmChartLibWhenIdle(), 3500);
    window.addEventListener('hashchange', activateRoute);
    // V74: لا نرسل فحص إصدار الشيت قبل الدخول؛ الطلب كان ينافس doLogin على نفس
    // اتصال Apps Script بلا فائدة للمستخدم غير الموثّق. يبدأ الفحص مباشرة عند
    // وجود جلسة محفوظة، أو بعد الدخول بعد ظهور الشاشة الأولى.
    if (getStoredUser()) {
        startDataVersionWatch();
        checkServerDataVersion();
    }
    // العودة إلى التبويب هي أكثر لحظة يعود فيها المستخدم بعد تعديل ورقة.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !getStoredUser()) return;
        checkServerDataVersion();
    });
});

if (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    location.replace(location.href.replace(/^http:/, 'https:'));
}

// ===================================================================
//                      2. جلب البيانات من Google Sheet
// ===================================================================
async function getDbData() {
    if (memoryDbCache) return memoryDbCache;
    const DB_KEY = appDbCacheKey();
    const TS_KEY = appDbCacheTsKey();
    const cachedDB = localStorage.getItem(DB_KEY);
    const cacheTimestamp = localStorage.getItem(TS_KEY);

    if (cachedDB) {
        const ageMinutes = cacheTimestamp ? (Date.now() - Number(cacheTimestamp)) / 60000 : Infinity;
        // استخدم الكاش مباشرة إذا كان Offline، حتى لو انتهت مدته.
        if (!navigator.onLine || (cacheTimestamp && ageMinutes < CACHE_DURATION_MINUTES)) {
            memoryDbCache = JSON.parse(cachedDB);
            return memoryDbCache;
        }
        // الكاش قديم: نعرضه فوراً ولا نعلّق الشاشة، ونحدّثه بالخلفية (stale-while-revalidate).
        if (!dbBgRefreshInProgress) {
            dbBgRefreshInProgress = true;
            apiGet('getInitialData', { v: APP_DB_VERSION }).then(fresh => {
                if (!fresh || fresh.status === 'error') return;
                memoryDbCache = fresh;
                localStorage.setItem(DB_KEY, JSON.stringify(fresh));
                localStorage.setItem(TS_KEY, String(Date.now()));
                window.dispatchEvent(new CustomEvent('dbCacheRefreshed', { detail: fresh }));
            }).catch(err => console.warn('تحديث خلفي لبيانات الأساسيات فشل (يستمر بالكاش):', err))
              .finally(() => { dbBgRefreshInProgress = false; });
        }
        memoryDbCache = JSON.parse(cachedDB);
        return memoryDbCache;
    }

    try {
        const dbData = await apiGet('getInitialData', { v: APP_DB_VERSION });
        if (dbData.status === 'error') throw new Error(dbData.message || 'API error');
        memoryDbCache = dbData;
        localStorage.setItem(DB_KEY, JSON.stringify(dbData));
        localStorage.setItem(TS_KEY, Date.now());
        return dbData;
    } catch (error) {
        if (cachedDB) {
            console.warn('Using cached DB because network request failed:', error);
            memoryDbCache = JSON.parse(cachedDB);
            return memoryDbCache;
        }
        throw error;
    }
}

// ===================================================================
//                 CACHE REFRESH / FAST DATA UPDATE
// ===================================================================
const APP_DB_VERSION = 'v42-employees-merged';
// دالّة لا ثابت: كاش الأساسيات يحوي كشف الموظفين كاملاً، فيجب أن يُربط
// بهوية المستخدم. لو كان ثابتاً لقيّد نفسه بهوية قبل تسجيل الدخول (anon)
// ثم ظل كل المستخدمين يتقاسمون '::anon'.
function appDbCacheKey() { return ownerScopedKey(`appDB_${APP_DB_VERSION}`); }
// V39: unified browser cache helpers. Data is served instantly from memory/local
// storage/Service Worker, then refreshed in the background when online.
const SMART_CACHE_PREFIX = 'festivalSmartCache::';
function invalidateSmartCaches() {
    memoryDbCache = null;
    memoryReportsCache = null;
    try {
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith(SMART_CACHE_PREFIX) || k.startsWith('attendanceCache::') || k.startsWith('attendanceStatusCache')) localStorage.removeItem(k);
        });
    } catch (e) {}
    // V50: امسح فقط كاشات المهرجان القديمة (v4..p الأقدم) دون حذف كاش النسخة الحالية.
    try { caches?.keys?.().then(keys => keys.filter(k => k.startsWith('festival-app-v4') && !k.startsWith('festival-app-v50')).forEach(k => caches.delete(k))).catch(()=>{}); } catch(e) {}
}

function appDbCacheTsKey() { return ownerScopedKey(`dbCacheTimestamp_${APP_DB_VERSION}`); }

let cacheRefreshInProgress = false;

// ===================================================================
// V72: مزامنة تعديلات الشيت مع المتصفحات المفتوحة.
//
// محرّك علىEdit يعمل على سيرفرات Google ولا يملك قناة عكسية للمتصفح، فالخادم
// لا يستطيع الدفع. ما يستطيعه هو تحريك عدّاد؛ العميل يسأل عن العدّاد ويحدّث
// نفسه عند تغيّره. بدونه يبقى تعديل السعر في الشيت قديماً في كل متصفح مفتوح
// حتى انتهاء الكاش (ساعة) أو حتى إعادة التحميل.
// فحص الإصدار يسبق التحقق من الجلسة في doGet عمداً، حتى لا يدخل المستخدم
// ببيانات قديمة قبل أن يملك أصلاً جلسة.
// ===================================================================
const DATA_VERSION_KEY = 'serverDataVersion';
const DATA_VERSION_CHECK_MS = 60000;
let dataVersionTimer = null;
let dataVersionCheckInFlight = false;

function getKnownDataVersion() {
    try { return Number(localStorage.getItem(DATA_VERSION_KEY) || 0); } catch (e) { return 0; }
}

function setKnownDataVersion(version) {
    try { localStorage.setItem(DATA_VERSION_KEY, String(version)); } catch (e) { /* التخزين ممتلئ */ }
}

/**
 * هل المستخدم في منتصف كتابة شيء سيضيع إن حدّثنا الآن؟
 *
 * هذا هو الثمن الحقيقي لميزة التحديث التلقائي: بدون هذا الحارس كان تعديلٌ في
 * الشيت يمسح جدول المبيعات الذي كان المستخدم يملؤه. الأنواع التي لا تحمل كتابة
 * (checkbox وأخواتها) لا تُحسب — التحديد لا يضيع.
 */
function userIsMidEntry() {
    try {
        const el = document.activeElement;
        if (!el) return false;
        const tag = String(el.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag !== 'INPUT') return false;
        return !['checkbox','radio','button','submit','reset','hidden','file','range','color','image']
            .includes(String(el.type || 'text').toLowerCase());
    } catch (e) { return false; }
}

/**
 * قارن إصدار الخادم بالإصدار المعروف، وحدّث إن تغيّر.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.force] ignore the mid-entry guard (a manual action).
 */
async function checkServerDataVersion({ force = false } = {}) {
    if (dataVersionCheckInFlight) return { ok: false, busy: true };
    if (!force && userIsMidEntry()) return { ok: false, deferred: true };
    dataVersionCheckInFlight = true;
    try {
        const res = await apiGet('getDataVersion');
        if (!res || res.status !== 'success') return { ok: false };
        const known = getKnownDataVersion();
        const seen = Number(res.version || 0);
        // أول تشغيل بعد النشر: نتبنّى رقم الخادم بدل إجبار كل مستخدم قائم على
        // تحديث كامل عند الترقية.
        if (!known) { setKnownDataVersion(seen); return { ok: true, adopted: seen }; }
        if (seen === known) return { ok: true, changed: false };
        // الورقة هي التي تحدد حجم السحب: تعديل سعر منتج لا يبرّر تنزيل كل
        // التقارير والدوام من جديد على جهاز المستخدم.
        const refreshReports = res.scope !== 'master';
        // بلا جلسة لا تنفع إعادة التحميل (كل نداءات الكاش تحتاج رمزاً)، والأسوأ
        // أنها كانت تُسجّل الإصدار الجديد بعد فشلها — فيُعتبر الكاش القديم
        // محدَّثاً بعد الدخول ولا يُجلب الجديد أبداً. نترك الإصدار على حاله
        // ليعيد الفحص التالي المحاولة بعد نجاح الدخول.
        if (!getAppToken()) return { ok: true, deferred: 'unauthenticated', version: seen };
        const refreshed = await refreshAppCache({ silent: true, refreshReports });
        if (!refreshed || refreshed.ok === false) {
            // لم يُحدَّث الكاش فعلاً: لا نُسجّل الإصدار حتى لا نتوقف عن المحاولة.
            return { ok: true, changed: true, scope: res.scope, refreshed: false };
        }
        setKnownDataVersion(seen);
        return { ok: true, changed: true, scope: res.scope, refreshed };
    } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
    } finally {
        dataVersionCheckInFlight = false;
    }
}

function stopDataVersionWatch() {
    if (dataVersionTimer) { clearInterval(dataVersionTimer); dataVersionTimer = null; }
}

/**
 * فحص دوري، ويتوقف كلياً While التبويب مخفي — لا فائدة من سؤال الخادم
 * لمşield لا أحد يراه. الفحص الأهم هو لحظة العودة إلى التبويب، لأنها أكثر
 * لحظة يعود فيها المستخدم لتغيير ورقة.
 */
function startDataVersionWatch() {
    if (dataVersionTimer) return;
    stopDataVersionWatch();
    dataVersionTimer = setInterval(() => {
        try { if (document.visibilityState === 'hidden') return; } catch (e) { /* sandbox */ }
        checkServerDataVersion();
    }, DATA_VERSION_CHECK_MS);
}

/**
 * Ask the service worker to drop its cached API responses, and wait until it
 * actually finished.
 *
 * postMessage() is fire-and-forget. The old code returned immediately, so the
 * API requests that followed raced the deletion and could still be answered from
 * the very cache being cleared. The button then reported "refreshed" while
 * showing stale data — and saved that stale copy into the app's own cache, so
 * it stuck.
 *
 * The worker replies over a MessageChannel. The timeout is a safety net so a
 * worker that dies mid-refresh cannot wedge the button forever.
 */
function clearServiceWorkerApiCache(timeoutMs = 3000) {
    const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!controller) return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        const timer = setTimeout(() => finish(false), timeoutMs);
        try {
            const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
            if (channel) channel.port1.onmessage = () => { clearTimeout(timer); finish(true); };
            controller.postMessage({ type: 'CLEAR_APP_CACHE' }, channel ? [channel.port2] : []);
        } catch (e) {
            clearTimeout(timer);
            finish(false);
        }
    });
}

/**
 * Refresh everything the app caches.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.silent]         suppress the alert on failure
 * @param {boolean} [opts.refreshReports] also pull reports/attendance/movements.
 *   Defaults to true. Callers that only changed master data — e.g. a product
 *   price edit, which page-reports.js debounces at 120ms — pass false, otherwise
 *   every keystroke in the sales table re-downloaded the whole site.
 */
async function refreshAppCache({ silent = false, refreshReports = true } = {}) {
    if (cacheRefreshInProgress) return { ok: false, busy: true };
    if (!navigator.onLine) { if (!silent) alert('لا يمكن تحديث البيانات بدون اتصال بالإنترنت.'); return { ok:false, offline:true }; }
    cacheRefreshInProgress = true;
    // A background refresh (a product price was edited) must not touch the user's
    // button: it used to disable it, flash «تم تحديث كل البيانات» over it, and
    // 1.8s later wipe whatever the user had typed back in. The button belongs to
    // the person who pressed it, and nobody pressed it here.
    const buttons = silent ? [] : [...document.querySelectorAll('[data-refresh-cache]')];
    buttons.forEach(btn=>{btn.disabled=true;btn.dataset.originalHtml=btn.innerHTML;btn.innerHTML='<i class="fa-solid fa-spinner fa-spin me-1"></i>جاري تحديث كل البيانات...';});
    try {
        // Clear the service worker's API cache FIRST, and wait for it. Skipping
        // the wait is what let stale responses through — see clearServiceWorkerApiCache.
        await clearServiceWorkerApiCache();
        const currentUser=JSON.parse(localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser')||'null');
        const requests=[apiGet('getInitialData',{forceRefresh:1,v:APP_DB_VERSION})];
        if(currentUser && refreshReports){
            const u=String(currentUser.id||''), r=String(currentUser.role||''), n=String(currentUser.name||'');
            requests.push(apiGet('getReports',{userId:u,role:r,userName:n,targetUserId:'all'}));
            requests.push(apiGet('getTeamOptions',{userId:u,role:r,userName:n}));
            requests.push(apiGet('getUserFestivalMovements',{userId:u,role:r,targetUserId:u}));
            requests.push(apiGet('getAttendance',{userId:u,role:r,userName:n,targetUserId:u}));
            requests.push(apiGet('getStatusOptions'));
        }
        const settled = await Promise.allSettled(requests);
        const first = settled[0];
        if (!first || first.status !== 'fulfilled' || !first.value || first.value.status === 'error') {
            // حالات الفشل الفرعية (تقارير/دوام/حركات...) لا تُفشل التحديث الأساسي.
            throw new Error((first && first.reason && (first.reason.message || String(first.reason))) || (first && first.value && first.value.message) || 'فشل جلب البيانات الأساسية');
        }
        const freshDB = first.value;
        memoryDbCache=freshDB;
        // The payload is already in memory and in use. A full localStorage is a
        // caching problem, not a failed refresh: the old unguarded write threw
        // QuotaExceededError right here, which skipped every event below, so no
        // screen redrew and the user was told the refresh had failed although it
        // had succeeded.
        try {
            localStorage.setItem(appDbCacheKey(),JSON.stringify(freshDB));
            localStorage.setItem(appDbCacheTsKey(),String(Date.now()));
        } catch (storageError) {
            console.warn('تعذّر حفظ بيانات الأساسيات محلياً (امتلأت المساحة):', storageError);
        }
        const results = settled.map(s => s.status === 'fulfilled' ? s.value : null);
        if(currentUser && refreshReports && Array.isArray(results[1])) { const _uid = String(currentUser.id || currentUser.username || ''); saveReportsCacheEntry(reportsScopeKey({userId:_uid,role:currentUser.role,targetUserId:'all'}), results[1], {userId:_uid,targetUserId:'all'}); }
        window.dispatchEvent(new CustomEvent('dbCacheRefreshed',{detail:freshDB}));
        window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
        window.dispatchEvent(new CustomEvent('movementCacheInvalidated'));
        window.dispatchEvent(new CustomEvent('attendanceCacheInvalidated'));
        // حدث موحّد: كل الشاشات المفتوحة تعيد تحميل بياناتها بعد انتهاء التحديث.
        window.dispatchEvent(new CustomEvent('appDataRefreshed'));
        if (refreshReports) {
            // Both of these are about notifications a product price cannot produce.
            // Running them per keystroke was pure overhead; they belong to a full refresh.
            // V69: بعد تحديث شامل قد تظهر مرفوضات جديدة — تحدّث الإشعار (يحترم الإخفاء السابق لنفس المجموعة).
            checkRejections();
            // بدون force: التحديث يعرض الجديد فقط. force كان سيتجاوز «المقروء»
            // فيعيد الشريط بعد كل ضغطة تحديث حتى بعد إغلاقه.
            checkTeamEntryFeed();
            // reg.update() re-fetches and re-installs every worker. Left in the
            // background path it competed with the requests the user was waiting on.
            if(navigator.serviceWorker?.getRegistrations) navigator.serviceWorker.getRegistrations().then(regs=>Promise.all(regs.map(reg=>reg.update()))).catch(()=>{});
        }
        buttons.forEach(btn=>{btn.classList.remove('btn-outline-primary');btn.classList.add('btn-outline-success');btn.innerHTML='<i class="fa-solid fa-check me-1"></i>تم تحديث كل البيانات';});
        setTimeout(()=>buttons.forEach(btn=>{btn.classList.remove('btn-outline-success');btn.classList.add('btn-outline-primary');btn.innerHTML=btn.dataset.originalHtml||'<i class="fa-solid fa-arrows-rotate me-1"></i>تحديث البيانات';btn.disabled=false;}),1800);
        return {ok:true,data:freshDB};
    } catch(error){
        console.error('Full cache refresh failed:',error);
        buttons.forEach(btn=>btn.innerHTML='<i class="fa-solid fa-triangle-exclamation me-1"></i>فشل التحديث');
        setTimeout(()=>buttons.forEach(btn=>{btn.innerHTML=btn.dataset.originalHtml||'<i class="fa-solid fa-arrows-rotate me-1"></i>تحديث البيانات';btn.disabled=false;}),2000);
        if(!silent) alert(error.name==='AbortError'?'انتهت مهلة الاتصال. حاول مرة أخرى.':`تعذر تحديث كل البيانات: ${error.message||error}`);
        return {ok:false,error};
    } finally { cacheRefreshInProgress=false; }
}

/**
 * حالة مزامنة الشيت كما يراها الخادم.
 *
 * المحفّز يعمل وحده بعد تثبيته، فهذا قراءة فقط: لا يثبّت شيئاً ولا يعيد بناء
 * كاش. الغرض أن يعرف المدير إن كانت المزامنة شغالة بدل أن يبحث في محرّر
 * Apps Script كل مرة.
 */
async function fetchDataSyncStatus() {
    try {
        const res = await apiPost('dataSyncTrigger', { syncAction: 'status' });
        if (!res || res.status !== 'success') return null;
        return res.sync || null;
    } catch (e) { return null; }
}

function isAdminUser() {
    try {
        const raw = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser') || 'null';
        const u = JSON.parse(raw);
        return String(u && u.role || '').trim().toLowerCase() === 'admin';
    } catch (e) { return false; }
}

/**
 * زر «تفعيل المزامنة» — للمدير فقط.
 *
 * منفصل عن زر «تحديث البيانات» عمداً: التحديث يجلب بيانات، وهذا يثبّت محفّزاً.
 * دمجهما كان يعني حذف المحفّز وإعادة إنشاءه وإعادة بناء كاش الأوراق الخمس عند
 * كل ضغطة — بلا فائدة، لأن المحفّز يعمل تلقائياً بعد أول تثبيت.
 */
function setupDataSyncTriggerButton() {
    document.querySelectorAll('[data-install-data-sync]').forEach(btn => {
        if (btn.dataset.syncBound === '1') return;
        btn.dataset.syncBound = '1';
        btn.style.display = isAdminUser() ? '' : 'none';
        if (!isAdminUser()) return;
        btn.addEventListener('click', async (event) => {
            event.preventDefault();
            if (btn.disabled) return;
            const original = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>جارٍ التفعيل...';
            try {
                const res = await apiPost('dataSyncTrigger', { syncAction: 'install' });
                if (!res || res.status !== 'success') {
                    alert((res && res.message) || 'تعذّر تفعيل المزامنة.');
                    return;
                }
                alert('تم تفعيل المزامنة. أي تعديل يدوي في أوراق Google Sheets سيصل الآن إلى المتصفحات المفتوحة تلقائياً.');
            } catch (e) {
                alert('تعذّر تفعيل المزامنة: ' + String((e && e.message) || e));
            } finally {
                btn.disabled = false;
                btn.innerHTML = original;
            }
        });
    });
}

function setupCacheRefreshButtons() {
    document.querySelectorAll('[data-refresh-cache]').forEach(btn => {
        if (btn.dataset.refreshBound === '1') return;
        btn.dataset.refreshBound = '1';
        btn.addEventListener('click', async (event) => {
            event.preventDefault();
            await refreshAppCache();
            // مزامنة يدوية: إرسال أي تقارير/دوام/حركات معلّقة أولاً ثم تحديث العدّاد.
            await runPendingSyncIfNeeded();
            // تقرير الحالة فقط — التحديث لا يثبّت المحفّز ولا يعيد بناءه.
            await reportDataSyncStatus();
        });
    });
    // شارة المزامنة المعلّقة = فتح نافذة التفاصيل مع زر «مزامنة الآن».
    document.querySelectorAll('#syncPendingBadge').forEach(badge => {
        if (badge.dataset.bound === '1') return;
        badge.dataset.bound = '1';
        badge.addEventListener('click', () => {
            openSyncDetails();
        });
    });
}

/**
 * بعد التحديث: تخبر المستخدم إن كانت المزامنة التلقائية شغالة أم لا.
 * صامت تماماً حين تكون شغالة — أغلب الوقت — فلا يزعج أحداً.
 */
async function reportDataSyncStatus() {
    const sync = await fetchDataSyncStatus();
    if (!sync || sync.installed) return;
    // زر التفعيل يظهر للمدير فقط، فلا داعي لإزعاج غيره برسالة لا يملك أي
    // إجراء بشأنها.
    if (!isAdminUser()) return;
    alert('مزامنة تعديلات Google Sheets غير مفعّلة.\n'
        + 'اضغط «تفعيل المزامنة» مرة واحدة، بعدها يصبح أي تعديل في الشيت يصل تلقائياً.');
}

// ===================================================================
//   نظام الصلاحيات على الواجهة: admin (الكل) / manager (فريقه) / user (نفسه)
// ===================================================================
// يجلب أسماء الموظفين الذين يحق لصاحب الجلسة الحالية عرض بياناتهم:
// admin => كل الموظفين، manager => فريقه فقط، user => قائمة فارغة (لا تُعرض القائمة أصلاً).
async function fetchTeamOptions(currentUser) {
    const role = String(currentUser?.role || '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'manager') return [];
    try {
        const result = await apiGet('getTeamOptions', {
            userId: String(currentUser.id || ''),
            role
        });
        if (!result || result.status !== 'success' || !Array.isArray(result.options)) return [];
        return result.options;
    } catch (e) {
        console.warn('تعذر تحميل قائمة الموظفين:', e);
        return [];
    }
}

// ---- Shared utility functions used by more than one page (history + dashboard) ----
function escapeHtmlGlobal(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[char]));
}

function reportsToCSV(reports) {
    if (!Array.isArray(reports) || !reports.length) return 'لا توجد بيانات';
    const escapeCsv = (v) => {
        const s = String(v ?? '');
        // حقن الصيغ: نحيّد القيم التي تبدأ برموز Excel (= + - @) أو تبويب/سطر.
        const neutralized = /^[=+\-@\t\r\n]/.test(s) ? "'" + s : s;
        return `"${neutralized.replace(/"/g, '""')}"`;
    };
    const headers = ['رقم التقرير','التاريخ','الحملة','الحدث','المحافظة','المنطقة','المحل','المشرف','المنسق','تبعية الجرد','عدد الأيام','الوقت من','الوقت إلى','هاتف','المبيعات','الكمية','عدد المبيعات','المصاريف','عدد المصاريف','ملاحظات','أنشئ بواسطة','تاريخ الإنشاء'];
    const lines = [headers.join(',')];
    reports.forEach(r => {
        let salesTotal = 0, salesQty = 0, salesCount = 0;
        (r.sales || []).forEach(s => {
            salesTotal += (Number(s.price) || 0) * (Number(s.quantity) || 0);
            salesQty += Number(s.quantity) || 0;
            salesCount++;
        });
        let expenseTotal = 0, expenseCount = 0;
        (r.expenses || []).forEach(e => { expenseTotal += Number(e.quantity) || 0; expenseCount++; });
        lines.push([
            r.id, r.date, r.campaign, r.event, r.governorate, r.region, r.market,
            r.supervisor, r.coordinator, r.inventoryDependency, r.eventDays, r.timeFrom, r.timeTo,
            r.phoneNumber, salesTotal.toFixed(2), salesQty, salesCount,
            expenseTotal, expenseCount, r.notes, r.createdByName, r.createdAt
        ].map(escapeCsv).join(','));
    });
    return lines.join('\r\n');
}

function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: (mimeType || 'text/plain') + ';charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}


// نجمع الكروت عبر data attribute بدل الروابط: نص anchor قابل للتغيير،
// لكن اسم الـ route في data-* هو ما يربطه بالراوت.
// تعريف routes الشكاوى التي يشير إليها HTML (الملف المرفق لم يتضمن
// التعريف الذي كان core.js يحتاجه عند الإقلاع).
const COMPLAINTS_CARDS = [
    { route: 'complaints-opinion', view: 'view-complaints-opinion', body: 'complaintsOpinionBody' },
    { route: 'complaints-bean', view: 'view-complaints-bean', body: 'complaintsBeanBody' },
    { route: 'complaints-site', view: 'view-complaints-site', body: 'complaintsSiteBody' }
];

function complaintsCardElements() {
    return Array.prototype.slice.call(
        document.querySelectorAll('#view-complaints [data-complaint-card]')
    );
}

async function handleComplaintsPage() {
    const view = document.getElementById('view-complaints');
    if (!view) return;

    // تشخيص wiring: كرت يشير إلى route غير معروف في core.js يظهر للمستخدم
    // كصفحة فارغة دون أي خطأ في الـconsole، فنوقفه هنا بدل تركه مكسوراً.
    const broken = complaintsCardElements().filter((el) => {
        const target = el.getAttribute('data-complaint-card');
        return !COMPLAINTS_CARDS.some((c) => c.route === target);
    });
    if (broken.length) {
        console.warn('[complaints] بطاقات لا تقابل أي route معرّف:', broken.map((el) => el.getAttribute('data-complaint-card')));
    }
}

// كل صفحة فرعية: نشغّلها هيكلاً فارغاً الآن، وربط البنية لاحقاً يكون بنفس
// النمط المستخدم في بقية الصفحات (registerView + تحميل الكاش عند أول فتح).
// الدالة نفسها ليست async عمداً: registerView يحتاج activator callable، ولو
// صارت async لأعادت Promise وسُجّل كائناً لا دالة فلا تُنفَّذ الشاشة أصلاً.
function handleComplaintsDestination(cfg) {
    return async function () {
        const view = document.getElementById(cfg.view);
        // حارس: قد تصل hash قديمة أو شل مخبأ جزئياً. رمي خطأ هنا يكسر
        // activateRoute لكل التنقلات التالية، فنكتفي بالصمت.
        if (!view) return;
        const body = document.getElementById(cfg.body);
        if (body && !body.dataset.complaintsBound) {
            body.dataset.complaintsBound = '1';
        }
    };
}

if (typeof registerView === 'function') {
    registerView('complaints', handleComplaintsPage);
    COMPLAINTS_CARDS.forEach((card) => {
        registerView(card.route, handleComplaintsDestination(card));
    });
}