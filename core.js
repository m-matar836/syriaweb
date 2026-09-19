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
//                     SESSION TIMEOUT
// ===================================================================
const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const SESSION_WARNING_MS = 10 * 60 * 1000;
let sessionTimer = null;
let sessionWarningTimer = null;

function startSessionTimeout() {
    const userRaw = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
    if (!userRaw) return;
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

function forceLogout(message) {
    clearTimeout(sessionTimer);
    clearTimeout(sessionWarningTimer);
    localStorage.removeItem('currentUser');
    sessionStorage.removeItem('currentUser');
    localStorage.removeItem('loginTimestamp');
    sessionStorage.removeItem('loginTimestamp');
    localStorage.removeItem('appDB');
    localStorage.removeItem('dbCacheTimestamp');
    localStorage.removeItem(FORM_STATE_KEY);
    sessionStorage.removeItem(EDIT_STATE_KEY);
    alert(message);
    window.location.href = 'index.html';
}

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzjkRGq2WuUkIGeafJqMPqGujfi0EgP1WuDgGjGBnAyOGMXwfNDrXc_DuFj71gHSSSc/exec";
const CACHE_DURATION_MINUTES = 1440;
const FORM_STATE_KEY = 'reportFormLastState'; 
const EDIT_STATE_KEY = 'reportToEdit';
// V25: in-memory caches eliminate repeated localStorage JSON parsing during the same page session.
let memoryDbCache = null;
let memoryReportsCache = null;

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

async function queueReportOffline(reportData) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite');
        tx.objectStore(OFFLINE_QUEUE_STORE).put({
            localId: `${reportData.id}_${Date.now()}`,
            reportData,
            createdAt: Date.now()
        });
        tx.oncomplete = () => { db.close(); resolve(); registerBackgroundSync(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
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
            const res = await fetch(SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action: 'submitReport', payload: item.reportData })
            });
            const result = await res.json();
            if (result.status !== 'success') throw new Error(result.message || 'فشل المزامنة');
            await removePendingReport(item.localId);
            syncedAny = true;
        } catch (error) {
            console.warn('Offline sync stopped:', error);
            break;
        }
    }
    if (syncedAny) {
        // Syncing reports does not require rebuilding master data. Invalidate only
        // the local report list so the next history view gets fresh server data.
        memoryReportsCache = null;
        localStorage.removeItem('reportsCache');
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
            const res = await fetch(SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action: 'submitAttendance', payload: item.payload })
            });
            const result = await res.json();
            if (result.status !== 'success') throw new Error(result.message || 'فشل المزامنة');
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
            const res=await fetch(SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'addFestivalMovement',payload:item.payload})});
            const result=await res.json();
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
    setTimeout(() => { updateOfflineStatus(); syncPendingReports(); syncPendingAttendance(); syncPendingMovements(); }, 500);
});

// ===================================================================

// ===================================================================
//                      1. التهيئة العامة والتحقق من تسجيل الدخول
// ===================================================================
document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();
    startSessionTimeout();
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    const isLoginPage = !!document.getElementById('loginForm');

    // V46: القيد على صفحة الدوام فقط يشمل حصراً حساب role="user" ومنصبه الوظيفي (jobPosition)
    // = "مروج". بقية أدوار/مناصب role=user (مثل مسؤول جرد أو منسق نقطة) تحتفظ بصلاحياتها
    // الطبيعية كمستخدم عادي (تقاريرها الخاصة فقط، دون قيد الدوام).
    const isAttendanceOnlyAccount = (u) => {
        const r = String(u?.role || '').trim().toLowerCase();
        const jp = String(u?.jobPosition || '').trim();
        return r === 'user' && jp === 'مروج';
    };

    if (isLoginPage && currentUser) {
        window.location.href = isAttendanceOnlyAccount(currentUser) ? 'attendance.html' : 'reports.html';
        return;
    }
    if (!isLoginPage && !currentUser) { window.location.href = 'index.html'; return; }

    // حساب role="user" ومنصبه "مروج" لا يملك صلاحية سوى صفحة الدوام — أي محاولة لفتح أي
    // صفحة أخرى (حتى عبر رابط مباشر) تُعاد توجيهها تلقائياً إلى صفحة الدوام.
    if (!isLoginPage) {
        if (isAttendanceOnlyAccount(currentUser) && !window.location.pathname.includes('attendance.html')) {
            window.location.href = 'attendance.html';
            return;
        }
    }

    if (!isLoginPage) {
        document.getElementById('welcomeMessage').textContent = `أهلاً بك، ${currentUser.name}`;
        const logout = () => {
            localStorage.removeItem('currentUser');
            sessionStorage.removeItem('currentUser');
            localStorage.removeItem('loginTimestamp');
            sessionStorage.removeItem('loginTimestamp');
            localStorage.removeItem('appDB');
            localStorage.removeItem('dbCacheTimestamp');
            localStorage.removeItem(FORM_STATE_KEY); 
            sessionStorage.removeItem(EDIT_STATE_KEY);
            window.location.href = 'index.html';
        };
        document.getElementById('logoutBtn').addEventListener('click', logout);

        if (window.location.pathname.includes('reports.html')) document.querySelector('.nav-link-reports').classList.add('active');
        if (window.location.pathname.includes('history.html')) document.querySelector('.nav-link-history').classList.add('active');
        if (window.location.pathname.includes('materialsMovement.html')) document.querySelector('.nav-link-movement')?.classList.add('active');
        if (window.location.pathname.includes('attendance.html')) document.querySelector('.nav-link-attendance')?.classList.add('active');
        if (window.location.pathname.includes('dashboard.html')) document.querySelector('.nav-link-dashboard')?.classList.add('active');

        // V42: صفحة التحليلات تظهر فقط للمشرف (admin) والمدير (manager).
        // المستخدم العادي (user) لا يرى زر التحليلات في القائمة.
        const allowedAnalyticsRoles = ['admin', 'manager'];
        const role = String(currentUser?.role || '').trim().toLowerCase();
        if (!allowedAnalyticsRoles.includes(role)) {
            document.querySelectorAll('.nav-link-dashboard').forEach(el => { el.closest('.nav-item').style.display = 'none'; });
        }

        // V46: حساب role="user" ومنصبه "مروج" يرى فقط رابط "الدوام" في القائمة العلوية —
        // بقية الروابط مخفية بالكامل له فقط. بقية أدوار/مناصب role=user تبقى ترى صفحاتها
        // المسموحة عادةً (التقارير مثلاً) دون أي تغيير في هذا القيد.
        if (isAttendanceOnlyAccount(currentUser)) {
            document.querySelectorAll('.nav-link-reports, .nav-link-history, .nav-link-movement, .nav-link-dashboard').forEach(el => {
                const item = el.closest('.nav-item');
                if (item) item.style.display = 'none';
            });
        }
    }

    if (isLoginPage) handleLoginPage();
    else if (document.getElementById('reportForm')) handleReportPage();
    else if (document.getElementById('reports-accordion')) handleHistoryPage();
    else if (document.getElementById('movement-table-body')) handleMaterialsMovementPage();
    else if (document.getElementById('attendanceForm')) handleAttendancePage();
    else if (document.getElementById('dashboard-container')) handleDashboardPage();
});

// ===================================================================
//                      2. جلب البيانات من Google Sheet
// ===================================================================
async function getDbData() {
    if (memoryDbCache) return memoryDbCache;
    const DB_KEY = APP_DB_KEY;
    const TS_KEY = APP_DB_TS_KEY;
    const cachedDB = localStorage.getItem(DB_KEY);
    const cacheTimestamp = localStorage.getItem(TS_KEY);

    if (cachedDB) {
        const ageMinutes = cacheTimestamp ? (Date.now() - Number(cacheTimestamp)) / 60000 : Infinity;
        // استخدم الكاش مباشرة إذا كان Offline، حتى لو انتهت مدته.
        if (!navigator.onLine || (cacheTimestamp && ageMinutes < CACHE_DURATION_MINUTES)) {
            memoryDbCache = JSON.parse(cachedDB);
            return memoryDbCache;
        }
    }

    try {
        const res = await fetch(`${SCRIPT_URL}?action=getInitialData&v=${APP_DB_VERSION}`, {
            cache: 'no-store'
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const dbData = await res.json();
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
const APP_DB_KEY = `appDB_${APP_DB_VERSION}`;
// V39: unified browser cache helpers. Data is served instantly from memory/local
// storage/Service Worker, then refreshed in the background when online.
const SMART_CACHE_PREFIX = 'festivalSmartCache::';
function invalidateSmartCaches() {
    memoryDbCache = null;
    memoryReportsCache = null;
    try {
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith(SMART_CACHE_PREFIX) || k.startsWith('attendanceCache::') || k === 'attendanceStatusCache') localStorage.removeItem(k);
        });
    } catch (e) {}
    try { caches?.keys?.().then(keys => keys.filter(k => k.includes('festival-app-v4')).forEach(k => caches.delete(k))).catch(()=>{}); } catch(e) {}
}

const APP_DB_TS_KEY = `dbCacheTimestamp_${APP_DB_VERSION}`;

let cacheRefreshInProgress = false;

async function refreshAppCache({ silent = false } = {}) {
    if (cacheRefreshInProgress) return { ok: false, busy: true };
    if (!navigator.onLine) { if (!silent) alert('لا يمكن تحديث البيانات بدون اتصال بالإنترنت.'); return { ok:false, offline:true }; }
    cacheRefreshInProgress = true;
    const buttons=document.querySelectorAll('[data-refresh-cache]');
    buttons.forEach(btn=>{btn.disabled=true;btn.dataset.originalHtml=btn.innerHTML;btn.innerHTML='<i class="fa-solid fa-spinner fa-spin me-1"></i>جاري تحديث كل البيانات...';});
    try {
        // Tell the Service Worker to remove stale API/static entries first.
        if (navigator.serviceWorker?.controller) navigator.serviceWorker.controller.postMessage({type:'CLEAR_APP_CACHE'});
        const currentUser=JSON.parse(localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser')||'null');
        const stamp=Date.now();
        const urls=[
            `${SCRIPT_URL}?action=getInitialData&forceRefresh=1&v=${encodeURIComponent(APP_DB_VERSION)}&_refresh=${stamp}`
        ];
        if(currentUser){
            const u=encodeURIComponent(String(currentUser.id||'')), r=encodeURIComponent(String(currentUser.role||'')), n=encodeURIComponent(String(currentUser.name||''));
            urls.push(`${SCRIPT_URL}?action=getReports&userId=${u}&role=${r}&userName=${n}&targetUserId=all&_refresh=${stamp}`);
            urls.push(`${SCRIPT_URL}?action=getTeamOptions&userId=${u}&role=${r}&userName=${n}&_refresh=${stamp}`);
            urls.push(`${SCRIPT_URL}?action=getUserFestivalMovements&userId=${u}&role=${r}&targetUserId=${u}&_refresh=${stamp}`);
            urls.push(`${SCRIPT_URL}?action=getAttendance&userId=${u}&role=${r}&userName=${n}&targetUserId=${u}&_refresh=${stamp}`);
        }
        urls.push(`${SCRIPT_URL}?action=getStatusOptions&_refresh=${stamp}`);
        const responses=await Promise.all(urls.map(url=>fetch(url,{cache:'no-store',redirect:'follow'})));
        const parsed=await Promise.all(responses.map(async r=>{if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json();}));
        const freshDB=parsed[0];
        if(!freshDB || freshDB.status==='error') throw new Error(freshDB?.message||'فشل جلب البيانات الأساسية');
        memoryDbCache=freshDB; localStorage.setItem(APP_DB_KEY,JSON.stringify(freshDB)); localStorage.setItem(APP_DB_TS_KEY,String(Date.now()));
        if(currentUser && Array.isArray(parsed[1])){ memoryReportsCache=parsed[1]; localStorage.setItem('reportsCache',JSON.stringify(parsed[1])); }
        window.dispatchEvent(new CustomEvent('dbCacheRefreshed',{detail:freshDB}));
        window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
        window.dispatchEvent(new CustomEvent('movementCacheInvalidated'));
        window.dispatchEvent(new CustomEvent('attendanceCacheInvalidated'));
        if(navigator.serviceWorker?.getRegistrations) navigator.serviceWorker.getRegistrations().then(regs=>Promise.all(regs.map(reg=>reg.update()))).catch(()=>{});
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

function setupCacheRefreshButtons() {
    document.querySelectorAll('[data-refresh-cache]').forEach(btn => {
        if (btn.dataset.refreshBound === '1') return;
        btn.dataset.refreshBound = '1';
        btn.addEventListener('click', async (event) => {
            event.preventDefault();
            await refreshAppCache();
        });
    });
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
        const params = new URLSearchParams({
            action: 'getTeamOptions',
            userId: String(currentUser.id || ''),
            role,
            _: String(Date.now())
        });
        const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) return [];
        const result = await res.json();
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
    const escapeCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
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
