// ===================================================================
//   script.js - النسخة النهائية مع إصلاح مشكلة تفريغ الحقول
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

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxnVIJZwvLW9rsjgH-Ea1cG6fVqAXWaCOqfa94TpAF2ueiFW-Rraiwozm0rDScxFN9y/exec";
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
//     V27: تحميل مكتبات خارجية ثقيلة عند الحاجة فقط (Lazy Loading)
// ===================================================================
const HTML5_QRCODE_SRC = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
let html5QrcodeLoadPromise = null;
function loadHtml5QrcodeLibrary() {
    if (typeof Html5Qrcode !== 'undefined') return Promise.resolve(true);
    if (html5QrcodeLoadPromise) return html5QrcodeLoadPromise;
    html5QrcodeLoadPromise = new Promise((resolve) => {
        const existing = document.querySelector(`script[src="${HTML5_QRCODE_SRC}"]`);
        if (existing) {
            existing.addEventListener('load', () => resolve(true));
            existing.addEventListener('error', () => resolve(false));
            return;
        }
        const script = document.createElement('script');
        script.src = HTML5_QRCODE_SRC;
        script.async = true;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.body.appendChild(script);
    });
    return html5QrcodeLoadPromise;
}

// ===================================================================
//                      1. التهيئة العامة والتحقق من تسجيل الدخول
// ===================================================================
document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();
    startSessionTimeout();
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    const isLoginPage = !!document.getElementById('loginForm');

    if (isLoginPage && currentUser) { window.location.href = 'reports.html'; return; }
    if (!isLoginPage && !currentUser) { window.location.href = 'index.html'; return; }

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
const APP_DB_VERSION = 'v42-super';
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


// ===================================================================
//                 إضافة بيانات جديدة إلى Locations
// ===================================================================
async function addLocationToSheet(type, value, governorate = '', region = '') {
    const cleanValue = String(value ?? '').trim();
    if (!cleanValue) throw new Error('يرجى إدخال القيمة الجديدة.');
    if (!navigator.onLine) throw new Error('إضافة بيانات جديدة تحتاج إلى اتصال بالإنترنت.');

    const payload = {
        action: 'addLocation',
        payload: {
            type,
            value: cleanValue,
            governorate: String(governorate ?? '').trim(),
            region: String(region ?? '').trim()
        }
    };

    const response = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!result || result.status !== 'success') {
        throw new Error(result?.message || 'تعذر إضافة البيانات إلى Locations');
    }
    return result;
}

function setupLocationAddButtons(DBRef) {
    const modalEl = document.getElementById('addLocationModal');
    const form = document.getElementById('addLocationForm');
    if (!modalEl || !form) return;
    const modal = new bootstrap.Modal(modalEl);
    const typeInput = document.getElementById('addLocationType');
    const valueInput = document.getElementById('addLocationValue');
    const contextHint = document.getElementById('addLocationContext');
    const saveBtn = document.getElementById('saveLocationBtn');
    const governorateSelect = document.getElementById('governorate');
    const regionSelect = document.getElementById('region');
    const marketSelect = document.getElementById('market_name');

    const labels = { governorate: 'المحافظة', region: 'المنطقة', market: 'اسم المحل' };

    document.querySelectorAll('[data-add-location]').forEach(btn => {
        if (btn.dataset.locationAddBound === '1') return;
        btn.dataset.locationAddBound = '1';
        btn.addEventListener('click', () => {
            const type = btn.dataset.addLocation;
            const gov = governorateSelect?.value || '';
            const region = regionSelect?.value || '';
            if (type === 'region' && !gov) {
                alert('اختر المحافظة أولاً ثم أضف المنطقة.');
                return;
            }
            if (type === 'market' && (!gov || !region)) {
                alert('اختر المحافظة والمنطقة أولاً ثم أضف اسم المحل.');
                return;
            }
            typeInput.value = type;
            valueInput.value = '';
            valueInput.placeholder = `أدخل ${labels[type] || 'البيانات'} الجديدة`;
            contextHint.textContent = type === 'governorate'
                ? 'ستتم إضافة محافظة جديدة.'
                : type === 'region'
                    ? `المحافظة: ${gov}`
                    : `المحافظة: ${gov} — المنطقة: ${region}`;
            modal.show();
            setTimeout(() => valueInput.focus(), 200);
        });
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const type = typeInput.value;
        const value = valueInput.value.trim();
        const gov = governorateSelect?.value || '';
        const region = regionSelect?.value || '';
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>جاري الحفظ...';
        try {
            await addLocationToSheet(type, value, gov, region);
            modal.hide();
            if (typeof window.showToast === 'function') {
                window.showToast('تمت إضافة البيانات بنجاح. جاري تحديث القوائم...');
            } else {
                console.log('تمت إضافة البيانات بنجاح. جاري تحديث القوائم...');
            }
            const result = await refreshAppCache({ silent: true });
            if (!result.ok) throw result.error || new Error('تمت الإضافة لكن تعذر تحديث القوائم');

            // Select the newly-added value immediately after refresh.
            if (type === 'governorate') {
                $('#governorate').val(value).trigger('change');
            } else if (type === 'region') {
                $('#region').val(value).trigger('change');
            } else if (type === 'market') {
                $('#market_name').val(value).trigger('change');
            }
        } catch (error) {
            alert(`تعذر إضافة البيانات: ${error.message || error}`);
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-save me-1"></i>حفظ';
        }
    });
}

// ===================================================================
//                      3. منطق صفحة تسجيل الدخول
// ===================================================================
async function handleLoginPage() {
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = e.target.username.value.trim().toLowerCase();
        const password = e.target.password.value.trim();
        const rememberMe = e.target.rememberMe.checked;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const errorMessage = document.getElementById('errorMessage');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جار التحقق...';
        errorMessage.textContent = '';
        try {
            const resLogin = await fetch(SCRIPT_URL, {
                method: 'POST', body: JSON.stringify({ action: 'doLogin', payload: { username, password } }),
            });
            const loginResult = await resLogin.json();
            if (loginResult.status !== 'success') throw new Error('Invalid credentials');
            
            if (rememberMe) {
                localStorage.setItem('currentUser', JSON.stringify(loginResult.user));
                localStorage.setItem('loginTimestamp', Date.now());
            } else {
                sessionStorage.setItem('currentUser', JSON.stringify(loginResult.user));
                sessionStorage.setItem('loginTimestamp', Date.now());
            }
            
            await getDbData();
            errorMessage.textContent = 'تم التحقق بنجاح! جارٍ التحويل...';
            errorMessage.style.color = '#2ecc71';
            setTimeout(() => { window.location.href = 'reports.html'; }, 1000);
        } catch (error) {
            errorMessage.textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة.';
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'دخـــول';
        }
    });

    const togglePassword = document.querySelector('.toggle-password');
    if(togglePassword) {
        togglePassword.addEventListener('click', function () {
            const passwordInput = document.getElementById('password');
            const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
            passwordInput.setAttribute('type', type);
            this.classList.toggle('fa-eye');
            this.classList.toggle('fa-eye-slash');
        });
    }
}

// ===================================================================
//                      4. منطق صفحة إدخال التقارير
// ===================================================================
async function handleReportPage() {
    let isFormDirty = false;
    
    const mainContainer = document.querySelector('.main-container');
    const form = document.getElementById('reportForm');
    form.style.display = 'none';
    mainContainer.insertAdjacentHTML('afterbegin', `<div id="loading-spinner" class="text-center p-5"><div class="mx-auto mb-3" style="width:80%;"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line skeleton-line-medium"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line skeleton-line-short"></div><div class="skeleton skeleton-card"></div></div></div>`);
    let DB = await getDbData();
    if (!DB) {
        const logoutOnClick = "localStorage.clear(); sessionStorage.clear(); window.location.href='index.html'; return false;";
        mainContainer.innerHTML = `<div class="alert alert-danger">فشل تحميل البيانات الأساسية. يرجى <a href="#" onclick="${logoutOnClick}">تسجيل الخروج</a> والمحاولة مرة أخرى.</div>`;
        return;
    }
    // Update the in-memory DB immediately when the user refreshes the cache.
    // No page reload is needed, so an unfinished report is not lost.
    window.addEventListener('dbCacheRefreshed', (event) => {
        if (!event.detail) return;
        DB = event.detail;
        if (!Array.isArray(DB.competitorProducts)) DB.competitorProducts = [];
        try {
            // Rebuild the main selects from the fresh data where applicable.
            const selectedGovernorate = governorateSelect.value;
            const selectedRegion = regionSelect.value;
            const selectedMarket = marketSelect.value;
            const selectedCampaign = campaignSelect.value;

            if (typeof populateSelect === 'function') {
                const locations = Array.isArray(DB.locations) ? DB.locations : [];
                const governors = [...new Set(locations.map(l => String(l.gov ?? '').trim()).filter(Boolean))];
                const regions = selectedGovernorate
                    ? [...new Set(locations.filter(l => String(l.gov ?? '').trim() === String(selectedGovernorate).trim())
                        .map(l => String(l.region ?? '').trim()).filter(Boolean))]
                    : [];
                const markets = selectedGovernorate && selectedRegion
                    ? [...new Set(locations.filter(l =>
                        String(l.gov ?? '').trim() === String(selectedGovernorate).trim() &&
                        String(l.region ?? '').trim() === String(selectedRegion).trim())
                        .map(l => String(l.market ?? '').trim()).filter(Boolean))]
                    : [];

                populateSelect(governorateSelect, governors, selectedGovernorate);
                populateSelect(regionSelect, regions, selectedRegion);
                populateSelect(marketSelect, markets, selectedMarket);
            }

            // Re-run dependent product filtering without touching existing rows.
            if (typeof updateProductAvailability === 'function') updateProductAvailability();
        } catch (e) {
            console.warn('In-page DB refresh UI update skipped:', e);
        }
    });

    document.getElementById('loading-spinner').remove();
    form.style.display = 'block';
    setupLocationAddButtons(DB);

    const reportForm = document.getElementById('reportForm'), governorateSelect = document.getElementById('governorate'), regionSelect = document.getElementById('region'), marketSelect = document.getElementById('market_name'), campaignSelect = document.getElementById('campaign'), salesTableBody = document.getElementById('sales-table-body'), salesCard = document.getElementById('salesCard'), expensesTableBody = document.getElementById('expenses-table-body'), addSaleRowBtn = document.getElementById('add-sale-row'), addExpenseRowBtn = document.getElementById('add-expense-row'), mainSubmitBtn = document.querySelector('.main-submit-btn'), supervisorInput = document.getElementById('supervisor'), submitAndAddAnotherBtn = document.getElementById('submitAndAddAnotherBtn');
    const competitorSalesCard = document.getElementById('competitorSalesCard'), competitorSalesTableBody = document.getElementById('competitor-sales-table-body'), addCompetitorSaleRowBtn = document.getElementById('add-competitor-sale-row'), competitorProductModal = new bootstrap.Modal(document.getElementById('competitorProductSelectionModal')), competitorProductSearchInput = document.getElementById('competitorProductSearchInput'), competitorProductSelectionTbody = document.querySelector('#competitorProductSelectionTable tbody'), addSelectedCompetitorProductsBtn = document.getElementById('addSelectedCompetitorProductsBtn');
    const productModal = new bootstrap.Modal(document.getElementById('productSelectionModal'));
    const productSearchInput = document.getElementById('productSearchInput');
    const productSelectionTbody = document.querySelector('#productSelectionTable tbody');
    const addSelectedProductsBtn = document.getElementById('addSelectedProductsBtn');
    const expenseModal = new bootstrap.Modal(document.getElementById('expenseSelectionModal'));
    const expenseSearchInput = document.getElementById('expenseSearchInput');
    const expenseSelectionTbody = document.querySelector('#expenseSelectionTable tbody');
    const addSelectedExpensesBtn = document.getElementById('addSelectedExpensesBtn');
    const successModal = new bootstrap.Modal(document.getElementById('successModal'));
    const viewReportBtn = document.getElementById('viewReportBtn');

    const toastContainer = document.getElementById('toast-notification');
    const toastMessage = toastContainer.querySelector('.toast-message');
    const showToast = (message, isError = false) => {
        toastMessage.textContent = message;
        toastMessage.classList.toggle('error', isError);
        toastContainer.classList.add('show');
        setTimeout(() => toastContainer.classList.remove('show'), 3000);
    };
    window.showToast = showToast;

    const getFormState = () => {
        const loggedUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser')) || {};
        const directPromotion = String($('#event').val() || '').trim() === 'ترويج مباشر';
        return {
        governorate: $('#governorate').val(), region: $('#region').val(), market: $('#market_name').val(),
        campaign: $('#campaign').val(), event: $('#event').val(),
        eventDays: document.getElementById('eventDays').value, date: document.getElementById('date').value,
        phoneNumber: document.getElementById('phoneNumber')?.value.trim() || '',
        timeFrom: document.getElementById('timeFrom').value, timeTo: document.getElementById('timeTo').value,
        inventoryDependency: $('#inventoryDependency').val(), coordinator: $('#coordinator').val(),
        promoter1: $('#promoter1').val(), promoter2: $('#promoter2').val(),
        promoter3: $('#promoter3').val(), promoter4: $('#promoter4').val(),
        promoters: getSelectedPromoters(),
        notes: document.getElementById('notes').value,
        sales: directPromotion ? [] : Array.from(salesTableBody.querySelectorAll('tr')).map(r => ({ product: $(r.querySelector('.sale-product')).val(), price: Number(r.querySelector('.sale-price').value) || 0, quantity: Number(r.querySelector('.sale-quantity').value) || 0, campaign: $('#campaign').val() })),
        salesOfCompetitor: Array.from(document.querySelectorAll('#competitor-sales-table-body tr')).map(r => ({ product: $(r.querySelector('.competitor-product')).val(), price: Number(r.querySelector('.competitor-price').value) || 0, quantity: Number(r.querySelector('.competitor-quantity').value) || 0 })),
        expenses: Array.from(expensesTableBody.querySelectorAll('tr')).map(r => ({ item: $(r.querySelector('.expense-item')).val(), quantity: r.querySelector('.expense-quantity').value })),
        createdById: loggedUser.id || '',
        createdByName: loggedUser.name || '',
        };
    };
    const saveFormState = () => { if (isFormDirty) { localStorage.setItem(FORM_STATE_KEY, JSON.stringify(getFormState())); } };
    const loadFormState = () => {
        const savedState = localStorage.getItem(FORM_STATE_KEY);
        if (!savedState) return;
        const state = JSON.parse(savedState);
        $('#campaign').val(state.campaign).trigger('change');
        $('#event').val(state.event).trigger('change');
        document.getElementById('eventDays').value = state.eventDays;
        document.getElementById('date').value = state.date;
        document.getElementById('timeFrom').value = state.timeFrom;
        document.getElementById('timeTo').value = state.timeTo;
        document.getElementById('notes').value = state.notes;
        if (document.getElementById('phoneNumber')) document.getElementById('phoneNumber').value = state.phoneNumber || '';
        $('#inventoryDependency').val(state.inventoryDependency).trigger('change');
        $('#coordinator').val(state.coordinator).trigger('change');
        $('#promoter1').val(state.promoter1).trigger('change');
        $('#promoter2').val(state.promoter2).trigger('change');
        $('#promoter3').val(state.promoter3).trigger('change');
        setSelectedPromoters([state.promoter1, state.promoter2, state.promoter3, state.promoter4]);
        if (state.governorate) {
            $('#governorate').val(state.governorate).trigger('change');
            if (state.region) {
                $('#region').val(state.region).trigger('change');
                if (state.market) {
                    $('#market_name').val(state.market).trigger('change');
                }
            }
        }
        salesTableBody.innerHTML = '';
        if (state.sales) state.sales.forEach(createSaleRow);
        if (state.salesOfCompetitor && typeof createCompetitorSaleRow === 'function') state.salesOfCompetitor.forEach(createCompetitorSaleRow);
        expensesTableBody.innerHTML = '';
        if (state.expenses) state.expenses.forEach(createExpenseRow);
        updateSaleTotals();
        isFormDirty = true;
    };

    reportForm.addEventListener('input', () => { isFormDirty = true; saveFormState(); });
    window.addEventListener('beforeunload', (event) => { if (isFormDirty) { event.preventDefault(); event.returnValue = ''; } });

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[char]));

    const initSelect2 = (selector, placeholder, allowTags = false) => { 
        $(selector).select2({ 
            theme: 'bootstrap-5', 
            dir: 'rtl', 
            placeholder, 
            width: '100%',
            tags: allowTags 
        }).on('change', () => { 
            isFormDirty = true; 
            saveFormState(); 
        }); 
    };
    const populateSelect = (select, options, selectedVal = '') => {
        const currentVal = $(select).val();
        const placeholder = select.querySelector('option[disabled]').textContent;
        select.innerHTML = `<option value="" selected disabled>${placeholder}</option>`;
        if (select.id.startsWith('promoter') || select.id === 'inventoryDependency' || select.id === 'coordinator') { select.innerHTML += `<option value="">غير محدد</option>`; }
        options.forEach(opt => select.innerHTML += `<option value="${opt}" ${opt === selectedVal ? 'selected' : ''}>${opt}</option>`);
        $(select).val(selectedVal || currentVal).trigger('change.select2');
    };
    const isValidPromoterName = (value) => {
        if (value === null || value === undefined) return false;
        const name = String(value).trim();
        return !!name && name.toLowerCase() !== 'undefined' && name.toLowerCase() !== 'null' && name !== '-';
    };

    const normalizePromoterNames = (names = []) => [...new Set(
        (Array.isArray(names) ? names : [names])
            .map(v => String(v ?? '').trim())
            .filter(isValidPromoterName)
    )];

    const getSelectedPromoters = () => normalizePromoterNames(
        [1,2,3,4].map(num => document.getElementById(`promoter${num}`)?.value)
    );

    const setSelectedPromoters = (names = []) => {
        const unique = normalizePromoterNames(names);
        [1,2,3,4].forEach((num, index) => {
            const input = document.getElementById(`promoter${num}`);
            if (input) input.value = unique[index] || '';
        });
        const text = document.getElementById('selectedPromotersText');
        const badges = document.getElementById('selectedPromotersBadges');
        if (text) text.textContent = unique.length ? `تم اختيار ${unique.length} من الأشخاص` : 'اختر الأشخاص المتواجدين ضمن النقطة...';
        if (badges) badges.innerHTML = unique.map(name => `<span class="badge text-bg-primary">${escapeHtml(name)}</span>`).join('');
    };

    const populateEmployees = (report = {}) => {
        const inventoryStaff = DB.employees.filter(e => e.role === 'مسؤول جرد').map(e => e.name);
        const coordinators = DB.employees.filter(e => e.role === 'منسق نقطة').map(e => e.name);
        populateSelect(document.getElementById('inventoryDependency'), inventoryStaff, report.inventoryDependency);
        populateSelect(document.getElementById('coordinator'), coordinators, report.coordinator);
        const reportPromoters = Array.isArray(report.promoters)
            ? report.promoters
            : [report.promoter1, report.promoter2, report.promoter3, report.promoter4];
        setSelectedPromoters(normalizePromoterNames(reportPromoters));
    };

    const promotersSelectionModal = new bootstrap.Modal(document.getElementById('promotersSelectionModal'));
    const promotersSearchInput = document.getElementById('promotersSearchInput');
    const promotersSelectionTbody = document.querySelector('#promotersSelectionTable tbody');
    const promotersEmptyMessage = document.getElementById('promotersEmptyMessage');
    const openPromotersBtn = document.getElementById('openPromotersBtn');
    const savePromotersBtn = document.getElementById('savePromotersBtn');

    const renderPromotersSelection = () => {
        const promoters = (Array.isArray(DB.employees) ? DB.employees : [])
            .filter(e => e && String(e.role || '').trim() === 'مروج')
            .map(e => String(e.name ?? '').trim())
            .filter(isValidPromoterName)
            .filter((name, index, arr) => arr.indexOf(name) === index);
        const selected = new Set(getSelectedPromoters());
        promotersSelectionTbody.innerHTML = '';
        const query = (promotersSearchInput?.value || '').toLowerCase().trim();
        const visible = promoters.filter(name => name.toLowerCase().includes(query));
        if (!visible.length) {
            promotersEmptyMessage.classList.remove('d-none');
            return;
        }
        promotersEmptyMessage.classList.add('d-none');
        visible.forEach(name => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td><div class="form-check"><input class="form-check-input promoter-checkbox" type="checkbox" value="${escapeHtml(name)}" ${selected.has(name) ? 'checked' : ''}></div></td><td>${escapeHtml(name)}</td>`;
            tr.addEventListener('click', e => {
                if (e.target.tagName !== 'INPUT') {
                    const cb = tr.querySelector('.promoter-checkbox');
                    cb.checked = !cb.checked;
                }
            });
            promotersSelectionTbody.appendChild(tr);
        });
    };

    openPromotersBtn?.addEventListener('click', () => {
        renderPromotersSelection();
        promotersSelectionModal.show();
    });
    promotersSearchInput?.addEventListener('input', renderPromotersSelection);
    savePromotersBtn?.addEventListener('click', () => {
        const selected = Array.from(promotersSelectionTbody.querySelectorAll('.promoter-checkbox:checked')).map(cb => cb.value);
        // إذا كانت القائمة مفلترة، نحافظ على الاختيارات الموجودة خارج نتيجة البحث.
        const current = new Set(getSelectedPromoters());
        const visibleNames = Array.from(promotersSelectionTbody.querySelectorAll('.promoter-checkbox')).map(cb => cb.value);
        visibleNames.forEach(name => current.delete(name));
        selected.forEach(name => current.add(name));
        setSelectedPromoters(Array.from(current));
        isFormDirty = true;
        saveFormState();
        promotersSelectionModal.hide();
    });

    const updateSaleTotals = () => {
        let grandTotal = 0, totalQuantity = 0;
        salesTableBody.querySelectorAll('tr').forEach(row => {
            const price = parseFloat(row.querySelector('.sale-price').value) || 0;
            const quantity = parseInt(row.querySelector('.sale-quantity').value) || 0;
            const rowTotal = price * quantity;
            row.querySelector('.row-total').value = rowTotal.toFixed(2);
            grandTotal += rowTotal;
            totalQuantity += quantity;
        });
        document.getElementById('grandTotal').textContent = grandTotal.toFixed(2);
        document.getElementById('totalQuantity').textContent = totalQuantity;
    };
    // ===============================================================
    //                         SALES / BARCODE
    // ===============================================================
    const isCancelledProduct = (product) => {
        if (!product) return true;
        if (product.cancelled === true) return true;
        const value = String(product.cancelled ?? '').trim().toLowerCase();
        return value === 'true' || value === '1' || value === 'yes' || value === 'نعم';
    };

    const getCampaignProducts = () => {
        const campaignName = campaignSelect.value;
        let products = [];
        if (campaignName === 'شاملة'||campaignName === 'مهرجان') {
            const allProducts = new Map();
            Object.values(DB.products || {}).flat().forEach(p => {
                if (p && p.name) allProducts.set(p.name, p);
            });
            products = Array.from(allProducts.values());
        } else {
            products = DB.products?.[campaignName] || [];
        }
        return products.filter(p => p && p.name && !isCancelledProduct(p));
    };

    const normalizeCategory = (value) => String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');
    const getSaleProducts = () => getCampaignProducts().filter(p => normalizeCategory(p.category) === 'مادة بيعية');
    const isDirectSaleEvent = () => String($('#event').val() || '').trim() === 'ترويج وبيع مباشر';
    const getSaleDisplayPrice = (product) => isDirectSaleEvent() ? Number(product?.price || 0) : '';
    const getCompetitorProducts = () => Array.isArray(DB.competitorProducts)
        ? DB.competitorProducts.filter(p => p && p.name && !isCancelledProduct(p))
        : [];
    const getTastingProducts = () => getCampaignProducts().filter(p => normalizeCategory(p.category) === 'مادة تذوق');

    const normalizeBarcode = (value) => String(value ?? '').trim();

    const findProductByBarcode = (barcode) => {
        const code = normalizeBarcode(barcode);
        if (!code) return null;

        const products = getSaleProducts().filter(
            p => normalizeBarcode(p.barcode) === code
        );
        if (!products.length) return null;

        // إذا كان الباركود موجوداً بأكثر من سجل، استخدم السعر المعتمد
        // في بيانات Products. وبعد تعديل السعر يتم تحديث جميع سجلات
        // المادة/الباركود في الشيت ثم إعادة بناء الكاش.
        const product = products[products.length - 1];
        return {...product, price: getSaleDisplayPrice(product)};
    };

    const findSaleRowByProduct = (productName, approvedPrice) => {
        const rows = Array.from(salesTableBody.querySelectorAll('tr')).filter(row =>
            $(row.querySelector('.sale-product')).val() === productName
        );
        if (!rows.length) return null;

        // عند وجود المادة مرتين في المبيعات بسعرين مختلفين:
        // الباركود يجب أن يزيد كمية السطر الذي يحمل السعر المعتمد،
        // وليس أول سطر عشوائياً.
        const masterPrice = Number(approvedPrice);
        if (Number.isFinite(masterPrice)) {
            const matching = rows.find(row => {
                const rowPrice = Number(row.querySelector('.sale-price')?.value);
                return Number.isFinite(rowPrice) && Math.abs(rowPrice - masterPrice) < 0.000001;
            });
            if (matching) return matching;
        }
        return rows[0];
    };

    const focusBarcodeInput = () => {
        const input = document.getElementById('barcodeInput');
        if (input) setTimeout(() => input.focus(), 50);
    };

    const addProductToSalesByBarcode = (rawBarcode) => {
        const barcode = normalizeBarcode(rawBarcode);
        const status = document.getElementById('barcodeStatus');
        if (!barcode) return false;

        // بعض أجهزة USB ترسل نفس المسح مرتين: input ثم Enter.
        // امنع التكرار الآلي فقط، مع السماح بمسح نفس المادة مرة أخرى بعد مهلة قصيرة.
        const now = Date.now();
        if (barcode === lastSalesBarcode && (now - lastSalesBarcodeAt) < 800) {
            const input = document.getElementById('barcodeInput');
            if (input) input.value = '';
            return false;
        }
        lastSalesBarcode = barcode;
        lastSalesBarcodeAt = now;

        if (!campaignSelect.value) {
            status.textContent = 'يرجى اختيار نوع الحملة أولاً.';
            status.className = 'small mt-2 text-danger';
            showToast('يرجى اختيار نوع الحملة أولاً.', true);
            focusBarcodeInput();
            return false;
        }

        const product = findProductByBarcode(barcode);
        if (!product) {
            status.textContent = `الباركود ${barcode} غير موجود ضمن منتجات الحملة الحالية.`;
            status.className = 'small mt-2 text-danger';
            showToast(`الباركود ${barcode} غير موجود.`, true);
            focusBarcodeInput();
            return false;
        }

        const existingRow = findSaleRowByProduct(product.name, product.price);
        if (existingRow) {
            const quantityInput = existingRow.querySelector('.sale-quantity');
            const currentQty = parseInt(quantityInput.value, 10) || 0;
            quantityInput.value = currentQty + 1;
            updateSaleTotals();
            status.textContent = `تمت زيادة كمية «${product.name}» إلى ${quantityInput.value}.`;
            status.className = 'small mt-2 text-success';
        } else {
            createSaleRow({
                product: product.name,
                price: product.price,
                quantity: 1,
                barcode: barcode
            });
            status.textContent = `تمت إضافة «${product.name}» بسعر ${Number(product.price || 0).toFixed(2)} × 1.`;
            status.className = 'small mt-2 text-success';
        }

        isFormDirty = true;
        saveFormState();
        const input = document.getElementById('barcodeInput');
        if (input) input.value = '';
        focusBarcodeInput();
        return true;
    };

    let priceUpdateTimer = null;
    const updateMasterProductPrice = async (row) => {
        if (!navigator.onLine) return;
        if (!isDirectSaleEvent()) return;

        const productSelect = row.querySelector('.sale-product');
        const product = String($(productSelect).val() || '').trim();
        const price = Number(row.querySelector('.sale-price')?.value);
        const campaign = String(campaignSelect.value || '').trim();
        const barcode = normalizeBarcode($(productSelect).find('option:selected').data('barcode') || '');

        if (!product || !campaign || !Number.isFinite(price) || price < 0) return;

        try {
            const res = await fetch(SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                    action: 'updateProductPrice',
                    payload: { product, price, campaign, barcode }
                }),
                cache: 'no-store'
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            if (result.status !== 'success') throw new Error(result.message || 'تعذر تحديث السعر');

            // السعر أصبح محفوظاً في Products. أعد تحميل بيانات الموقع كاملة من الـSheet
            // حتى يصبح السعر الجديد هو السعر المعتمد فوراً في الواجهة والباركود.
            await refreshAppCache({ silent: true, refreshReports: false });

            // حدّث الصف الحالي أيضاً من البيانات الجديدة، بدون إعادة فرض السعر القديم.
            row.querySelector('.sale-price').value = Number(result.price).toFixed(2);
            updateSaleTotals();
        } catch (error) {
            console.error('Immediate price update failed:', error);
            showToast(`تعذر تحديث سعر «${product}» على الشيت: ${error.message || error}`, true);
        }
    };

    const scheduleMasterProductPriceUpdate = (row) => {
        clearTimeout(priceUpdateTimer);
        priceUpdateTimer = setTimeout(() => updateMasterProductPrice(row), 120);
    };

    const createSaleRow = (sale = {}) => {
        const products = getSaleProducts();
        // لا نعيد مادة ملغاة/غير متاحة من حالة محلية قديمة.
        if (sale.product && !products.some(p => p.name === sale.product)) {
            return;
        }
        const existingProducts = Array.from(salesTableBody.querySelectorAll('.sale-product')).map(select => $(select).val());
        if (sale.product && existingProducts.includes(sale.product) && !sale.price) return;

        const row = document.createElement('tr');
        const productOptions = products.map(p => {
            const safeName = String(p.name ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            return `<option value="${safeName}" data-price="${getSaleDisplayPrice(p)}" data-barcode="${normalizeBarcode(p.barcode)}">${safeName}</option>`;
        }).join('');
        const priceValue = isDirectSaleEvent() ? (sale.price !== undefined && sale.price !== '' ? Number(sale.price || 0).toFixed(2) : '0.00') : (sale.price !== undefined && sale.price !== '' ? Number(sale.price).toFixed(2) : '');
        const quantityValue = sale.quantity !== undefined && sale.quantity !== '' ? sale.quantity : '';

        row.innerHTML = `<td><select class="form-select form-select-sm sale-product" required><option value="" selected disabled>اختر...</option>${productOptions}</select></td><td><input type="number" class="form-control form-control-sm sale-price" value="${priceValue}" step="0.01" required></td><td><input type="number" class="form-control form-control-sm sale-quantity" value="${quantityValue}" min="1" required></td><td><input type="text" class="form-control form-control-sm row-total" value="0.00" readonly></td><td><button type="button" class="btn btn-sm btn-outline-danger remove-row-btn"><i class="fa-solid fa-trash-can"></i></button></td>`;
        row.querySelector('.remove-row-btn').addEventListener('click', () => {
            row.remove();
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
            focusBarcodeInput();
        });

        const productSelect = $(row.querySelector('.sale-product'));
        initSelect2(productSelect, 'اختر المادة...');
        productSelect.on('change', function() {
            const newPrice = $(this).find('option:selected').data('price');
            if (newPrice !== undefined && newPrice !== '') {
                row.querySelector('.sale-price').value = parseFloat(newPrice).toFixed(2);
            }
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
        });

        row.querySelector('.sale-quantity').addEventListener('input', () => {
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
        });
        row.querySelector('.sale-price').addEventListener('input', () => {
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
            // تحديث السعر المعتمد تلقائياً بعد توقف المستخدم عن الكتابة.
            scheduleMasterProductPriceUpdate(row);
        });
        row.querySelector('.sale-price').addEventListener('change', () => {
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
            scheduleMasterProductPriceUpdate(row);
        });

        salesTableBody.appendChild(row);
        if (sale.product) productSelect.val(sale.product).trigger('change');
        if (sale.price !== undefined && sale.price !== '') row.querySelector('.sale-price').value = Number(sale.price || 0).toFixed(2);
        if (sale.quantity !== undefined && sale.quantity !== '') row.querySelector('.sale-quantity').value = sale.quantity;
        updateSaleTotals();
    };

    const createExpenseRow = (expense = {}) => {
        const expenseProducts = getTastingProducts();
        const existingExpenses = Array.from(expensesTableBody.querySelectorAll('.expense-item')).map(select => $(select).val());
        if (expense.item && existingExpenses.includes(expense.item) && !expense.quantity) return;

        const row = document.createElement('tr');
        const expenseOptions = expenseProducts.map(product => {
            const safeName = String(product.name ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            return `<option value="${safeName}" data-barcode="${normalizeBarcode(product.barcode)}">${safeName}</option>`;
        }).join('');

        row.innerHTML = `<td><select class="form-select form-select-sm expense-item" required><option value="" selected disabled>اختر...</option>${expenseOptions}</select></td><td><input type="number" class="form-control form-control-sm expense-quantity" value="${expense.quantity || ''}" min="1" required></td><td><button type="button" class="btn btn-sm btn-outline-danger remove-row-btn"><i class="fa-solid fa-trash-can"></i></button></td>`;
        row.querySelector('.remove-row-btn').addEventListener('click', () => { row.remove(); isFormDirty = true; saveFormState(); });
        const expenseSelect = $(row.querySelector('.expense-item'));
        initSelect2(expenseSelect, 'اختر مادة التذوق...');
        expensesTableBody.appendChild(row);
        if (expense.item) expenseSelect.val(expense.item).trigger('change');
        if (expense.quantity) row.querySelector('.expense-quantity').value = expense.quantity;
        row.querySelector('.expense-quantity').addEventListener('input', () => { isFormDirty = true; saveFormState(); });
    };

    /**
     * [إضافة جديدة] دالة لإعادة تعيين النموذج بالكامل بدون إعادة تحميل الصفحة
     */
    const resetFullForm = () => {
        // إعادة تعيين الحقول الأساسية
        document.getElementById('eventDays').value = '1';
        document.getElementById('date').value = '';
        document.getElementById('timeFrom').value = '';
        document.getElementById('timeTo').value = '';
        document.getElementById('notes').value = '';
        if (document.getElementById('phoneNumber')) document.getElementById('phoneNumber').value = '';

        // إعادة تعيين حقول Select2
        $('#governorate, #campaign, #event, #inventoryDependency, #coordinator, #promoter1, #promoter2, #promoter3, #promoter4').val(null).trigger('change');
        // تفريغ الأشخاص المتواجدين ضمن النقطة بالكامل
        setSelectedPromoters([]);
        const promotersSelectionTbodyReset = document.getElementById('promotersSelectionTbody');
        if (promotersSelectionTbodyReset) {
            promotersSelectionTbodyReset.querySelectorAll('.promoter-checkbox').forEach(cb => {
                cb.checked = false;
            });
        }
        // تفريغ القوائم المعتمدة
        $('#region, #market_name').empty().append('<option value="" selected disabled>اختر...</option>').val(null).trigger('change');

        // تفريغ الجداول
        salesTableBody.innerHTML = '';
        expensesTableBody.innerHTML = '';
        updateSaleTotals();

        // إزالة علامات التحقق من الصحة
        reportForm.classList.remove('was-validated');
    };

    const validateRequiredPrices = () => {
        const eventValue = String($('#event').val() || '').trim();
        const requiresUserPrice = eventValue !== 'ترويج وبيع مباشر';
        let firstInvalid = null;

        document.querySelectorAll('.sale-price, .competitor-price').forEach(input => {
            input.setCustomValidity('');
            if (requiresUserPrice && String(input.value ?? '').trim() === '') {
                input.setCustomValidity('السعر مطلوب لهذا النوع من الحدث.');
                if (!firstInvalid) firstInvalid = input;
            }
        });

        return firstInvalid;
    };

    const handleFormSubmit = (event, editId, addAnother = false) => {
        if(event) event.preventDefault();
        const firstInvalidPrice = validateRequiredPrices();
        if (firstInvalidPrice) firstInvalidPrice.focus();
        if (!reportForm.checkValidity()) { 
            if(event) event.stopPropagation(); 
            reportForm.classList.add('was-validated'); 
            return; 
        }

        const reportData = getFormState();
        isFormDirty = false;
        localStorage.removeItem(FORM_STATE_KEY); 
        
        if (addAnother) {
            // [تصحيح] استدعاء دالة إعادة التعيين الكاملة
            resetFullForm(); 
            showToast('التقرير قيد الحفظ في الخلفية...');
        } else {
            document.querySelector('#successModal .fs-5').textContent = 'التقرير قيد الحفظ في الخلفية...';
            document.getElementById('success-spinner').style.display = 'inline-block';
            viewReportBtn.classList.add('disabled');
            successModal.show();
        }

        reportData.id = editId || Date.now();
        reportData.createdAt = editId ? originalCreatedAt : new Date().toLocaleString('ar-EG');
        reportData.promoters = [reportData.promoter1, reportData.promoter2, reportData.promoter3, reportData.promoter4].filter(p => p && p !== 'غير محدد');
        reportData.supervisor = supervisorInput.value;
        reportData.participants = [...new Set([reportData.coordinator, reportData.inventoryDependency, reportData.supervisor, ...reportData.promoters].filter(Boolean))];
        
        const saveOnlineOrQueue = async () => {
            if (!navigator.onLine) {
                await queueReportOffline(reportData);
                return { queued: true };
            }
            try {
                const res = await fetch(SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'submitReport', payload: reportData })
                });
                const result = await res.json();
                if (result.status !== 'success') throw new Error(result.message || 'فشل الحفظ');
                // Do NOT rebuild the whole master-data cache after every report.
                // Reports do not change Products/Locations/Employees, so a full refresh here
                // only adds a large network round-trip and JSON parsing cost. The server
                // invalidates the report cache on save; history will fetch the fresh report list
                // when opened. Keep the current in-memory product cache intact.
                memoryReportsCache = null;
                localStorage.removeItem('reportsCache');
                window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
                return result;
            } catch (error) {
                // في حالة انقطاع الشبكة أثناء الإرسال، خزّن التقرير للمزامنة.
                const networkFailure = !navigator.onLine || error instanceof TypeError ||
                    /failed to fetch|network|load failed/i.test(String(error.message || ''));
                if (networkFailure) {
                    await queueReportOffline(reportData);
                    return { queued: true };
                }
                throw error;
            }
        };

        saveOnlineOrQueue()
            .then(result => {
                localStorage.removeItem('reportsCache');
                if (result.queued) {
                    updateOfflineStatus();
                    if (addAnother) {
                        showToast('تم حفظ التقرير محلياً وسيتم إرساله تلقائياً عند عودة الإنترنت.');
                    } else {
                        document.querySelector('#successModal .fs-5').textContent = 'تم حفظ التقرير محلياً — بانتظار الإنترنت للمزامنة';
                        document.getElementById('success-spinner').style.display = 'none';
                        viewReportBtn.classList.add('disabled');
                        successModal.show();
                    }
                    return;
                }

                if (addAnother) {
                    // resetFullForm() تم استدعاؤها مسبقاً، وتشمل تفريغ الأشخاص المتواجدين.
                    showToast('تم حفظ التقرير السابق بنجاح.');
                } else {
                    // بعد نجاح إرسال تقرير جديد فقط، نفرّغ الأشخاص المتواجدين ضمن النقطة.
                    // لا نفرّغ نموذج التعديل حتى يبقى التقرير المعروض كما هو.
                    if (!editId) {
                        setSelectedPromoters([]);
                        const promotersSelectionTbodyAfterSubmit = document.getElementById('promotersSelectionTbody');
                        if (promotersSelectionTbodyAfterSubmit) {
                            promotersSelectionTbodyAfterSubmit.querySelectorAll('.promoter-checkbox').forEach(cb => {
                                cb.checked = false;
                            });
                    }
                    }
                    document.querySelector('#successModal .fs-5').textContent = 'تم حفظ التقرير بنجاح!';
                    document.getElementById('success-spinner').style.display = 'none';
                    viewReportBtn.href = `history.html#c-${result.reportId}`;
                    viewReportBtn.classList.remove('disabled');
                }
            })
            .catch(error => {
                isFormDirty = true;
                saveFormState();
                if (addAnother) {
                    showToast(`فشل حفظ التقرير: ${error.message}`, true);
                } else {
                    successModal.hide();
                    alert(`فشل إرسال التقرير: ${error.message}`);
                }
            });
    };
    
    const updateSalesVisibility = () => {
        const directPromotion = String($('#event').val() || '').trim() === 'ترويج مباشر';
        if (salesCard) salesCard.style.display = directPromotion ? 'none' : '';
        if (directPromotion) {
            salesTableBody.innerHTML = '';
            updateSaleTotals();
        }
    };

    const updateCompetitorSalesVisibility = () => {
        const visible = String($('#event').val() || '').trim() === 'ترويج مولات';
        if (competitorSalesCard) competitorSalesCard.style.display = visible ? '' : 'none';
        if (!visible && competitorSalesTableBody) competitorSalesTableBody.innerHTML = '';
    };

    const updateCompetitorSaleTotals = () => {
        if (!competitorSalesTableBody) return;
        competitorSalesTableBody.querySelectorAll('tr').forEach(row => {
            const price = Number(row.querySelector('.competitor-price')?.value) || 0;
            const qty = Number(row.querySelector('.competitor-quantity')?.value) || 0;
            const total = row.querySelector('.competitor-row-total');
            if (total) total.value = (price * qty).toFixed(2);
        });
        const rows = Array.from(competitorSalesTableBody.querySelectorAll('tr'));
        const totalQty = rows.reduce((sum,row)=>sum+(Number(row.querySelector('.competitor-quantity')?.value)||0),0);
        const grand = rows.reduce((sum,row)=>sum+(Number(row.querySelector('.competitor-price')?.value)||0)*(Number(row.querySelector('.competitor-quantity')?.value)||0),0);
        const tq=document.getElementById('competitorTotalQuantity'); if(tq) tq.textContent=totalQty;
        const gt=document.getElementById('competitorGrandTotal'); if(gt) gt.textContent=grand.toFixed(2);
    };

    const createCompetitorSaleRow = (sale = {}) => {
        const products = getCompetitorProducts();
        if (sale.product && !products.some(p => p.name === sale.product)) return;
        const row = document.createElement('tr');
        const productOptions = products.map(p => {
            const safeName = escapeHtml(String(p.name ?? ''));
            return `<option value="${safeName}" data-barcode="${escapeHtml(normalizeBarcode(p.barcode))}">${safeName}</option>`;
        }).join('');
        const price = sale.price !== undefined && sale.price !== '' ? Number(sale.price || 0).toFixed(2) : '';
        const qty = sale.quantity !== undefined && sale.quantity !== '' ? sale.quantity : '';
        row.innerHTML = `<td><select class="form-select form-select-sm competitor-product" required><option value="" selected disabled>اختر...</option>${productOptions}</select></td><td><input type="number" class="form-control form-control-sm competitor-price" value="${price}" step="0.01" min="0" required></td><td><input type="number" class="form-control form-control-sm competitor-quantity" value="${qty}" min="1" required></td><td><input type="text" class="form-control form-control-sm competitor-row-total" value="0.00" readonly></td><td><button type="button" class="btn btn-sm btn-outline-danger remove-competitor-row-btn"><i class="fa-solid fa-trash-can"></i></button></td>`;
        row.querySelector('.remove-competitor-row-btn').addEventListener('click', () => { row.remove(); updateCompetitorSaleTotals(); isFormDirty=true; saveFormState(); });
        row.querySelector('.competitor-price').addEventListener('input', () => { updateCompetitorSaleTotals(); isFormDirty=true; saveFormState(); });
        row.querySelector('.competitor-quantity').addEventListener('input', () => { updateCompetitorSaleTotals(); isFormDirty=true; saveFormState(); });
        row.querySelector('.competitor-product').addEventListener('change', () => { isFormDirty=true; saveFormState(); });
        competitorSalesTableBody.appendChild(row);
        if (sale.product) $(row.querySelector('.competitor-product')).val(sale.product).trigger('change');
        updateCompetitorSaleTotals();
    };

    const populateCompetitorProductModal = async () => {
        let products = getCompetitorProducts();

        // If the current browser cache does not contain competitor products,
        // fetch them directly from ProductsOfCompetitor.
        if (!products.length && navigator.onLine) {
            try {
                const res = await fetch(`${SCRIPT_URL}?action=getCompetitorProducts&v=${APP_DB_VERSION}&t=${Date.now()}`, {cache:'no-store'});
                const freshProducts = await res.json();
                if (Array.isArray(freshProducts)) {
                    DB.competitorProducts = freshProducts;
                    products = getCompetitorProducts();
                    localStorage.setItem(APP_DB_KEY, JSON.stringify(DB));
                    localStorage.setItem(APP_DB_TS_KEY, String(Date.now()));
                }
            } catch (e) {
                console.warn('تعذر جلب مواد المنافس مباشرة:', e);
            }
        }

        competitorProductSelectionTbody.innerHTML = '';
        if (!products.length) {
            competitorProductSelectionTbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">لا توجد مواد في ProductsOfCompetitor</td></tr>';
        } else {
            products.forEach(p => competitorProductSelectionTbody.insertAdjacentHTML('beforeend', `<tr><td><div class="form-check"><input class="form-check-input competitor-product-select-check" type="checkbox" value="${escapeHtml(p.name)}" style="pointer-events:none;"></div></td><td>${escapeHtml(p.name)}</td></tr>`));
        }
        competitorProductSearchInput.value = '';
        competitorProductSearchInput.dispatchEvent(new Event('input'));
    };

    const addCompetitorProductByBarcode = (rawBarcode) => {
        const code = normalizeBarcode(rawBarcode);
        if (!code) return false;
        const product = getCompetitorProducts().find(p => normalizeBarcode(p.barcode) === code);
        const status = document.getElementById('competitorBarcodeStatus');
        if (!product) { if (status) { status.textContent=`الباركود ${code} غير موجود ضمن مواد المنافس.`; status.className='small mt-2 text-danger'; } showToast(`باركود المنافس ${code} غير موجود.`,true); return false; }
        const existing = Array.from(competitorSalesTableBody.querySelectorAll('tr')).find(r => $(r.querySelector('.competitor-product')).val()===product.name);
        if (existing) {
            const q=existing.querySelector('.competitor-quantity'); q.value=(parseInt(q.value,10)||0)+1;
        } else createCompetitorSaleRow({product:product.name,quantity:1});
        updateCompetitorSaleTotals();
        if(status){status.textContent=`تمت إضافة «${product.name}».`;status.className='small mt-2 text-success';}
        isFormDirty=true; saveFormState();
        const input=document.getElementById('competitorBarcodeInput'); if(input){input.value='';input.focus();}
        return true;
    };

    function setupModalRowClick(tbody) {
        tbody.addEventListener('click', (e) => {
            const row = e.target.closest('tr');
            if (!row) return;
            const checkbox = row.querySelector('.form-check-input');
            if (checkbox) {
                checkbox.checked = !checkbox.checked;
            }
        });
    }
    
    function populateProductSelectionModal(campaignName) {
        const products = getSaleProducts();
        productSelectionTbody.innerHTML = '';
        products.forEach(product => { productSelectionTbody.insertAdjacentHTML('beforeend', `<tr><td><div class="form-check"><input class="form-check-input product-select-check" type="checkbox" value="${product.name}" data-price="${getSaleDisplayPrice(product)}" style="pointer-events: none;"></div></td><td>${product.name}</td></tr>`); });
        productSearchInput.value = ''; productSearchInput.dispatchEvent(new Event('input'));
    }
    addSaleRowBtn.addEventListener('click', () => { const c = campaignSelect.value; if (!c) { alert('يرجى اختيار نوع الحملة أولاً.'); return; } populateProductSelectionModal(c); productModal.show(); });
    productSearchInput.addEventListener('input', () => { const s = productSearchInput.value.toLowerCase().trim(); productSelectionTbody.querySelectorAll('tr').forEach(r => { r.style.display = r.cells[1].textContent.toLowerCase().includes(s) ? '' : 'none'; }); });
    addSelectedProductsBtn.addEventListener('click', () => { productSelectionTbody.querySelectorAll('.product-select-check:checked').forEach(c => createSaleRow({ product: c.value, price: c.dataset.price })); updateSaleTotals(); productModal.hide(); isFormDirty = true; saveFormState(); });
    
    function populateExpenseSelectionModal(campaignName) {
        const products = getTastingProducts();
        expenseSelectionTbody.innerHTML = '';
        products.forEach(product => { expenseSelectionTbody.insertAdjacentHTML('beforeend', `<tr><td><div class="form-check"><input class="form-check-input expense-select-check" type="checkbox" value="${product.name}" style="pointer-events: none;"></div></td><td>${product.name}</td></tr>`); });
        expenseSearchInput.value = ''; expenseSearchInput.dispatchEvent(new Event('input'));
    }
    addExpenseRowBtn.addEventListener('click', () => { const c = campaignSelect.value; if (!c) { alert('يرجى اختيار نوع الحملة أولاً.'); return; } populateExpenseSelectionModal(c); expenseModal.show(); });
    expenseSearchInput.addEventListener('input', () => { const s = expenseSearchInput.value.toLowerCase().trim(); expenseSelectionTbody.querySelectorAll('tr').forEach(r => { r.style.display = r.cells[1].textContent.toLowerCase().includes(s) ? '' : 'none'; }); });
    addSelectedExpensesBtn.addEventListener('click', () => { expenseSelectionTbody.querySelectorAll('.expense-select-check:checked').forEach(c => createExpenseRow({ item: c.value })); expenseModal.hide(); isFormDirty = true; saveFormState(); });

    setupModalRowClick(productSelectionTbody);
    setupModalRowClick(expenseSelectionTbody);
    setupModalRowClick(competitorProductSelectionTbody);
    addCompetitorSaleRowBtn?.addEventListener('click', async () => { const c=campaignSelect.value; if(!c){alert('يرجى اختيار نوع الحملة أولاً.');return;} await populateCompetitorProductModal(); competitorProductModal.show(); });
    competitorProductSearchInput?.addEventListener('input', () => { const q=competitorProductSearchInput.value.toLowerCase().trim(); competitorProductSelectionTbody.querySelectorAll('tr').forEach(r => r.style.display=r.cells[1].textContent.toLowerCase().includes(q)?'':'none'); });
    addSelectedCompetitorProductsBtn?.addEventListener('click', () => { competitorProductSelectionTbody.querySelectorAll('.competitor-product-select-check:checked').forEach(c => createCompetitorSaleRow({product:c.value})); competitorProductModal.hide(); isFormDirty=true; saveFormState(); });
    
    const initEditMode = (report) => {
        populateSelect(governorateSelect, [...new Set(DB.locations.map(l => l.gov))], report.governorate);
        populateSelect(regionSelect, [...new Set(DB.locations.filter(l => l.gov === report.governorate).map(l => l.region))], report.region);
        populateSelect(marketSelect, [...new Set(DB.locations.filter(l => l.region === report.region).map(l => l.market))], report.market);
        $('#campaign').val(report.campaign).trigger('change');
        $('#event').val(report.event).trigger('change');
        document.getElementById('eventDays').value = report.eventDays;
        // القيم القادمة من Reports تكون بصيغة حقول HTML مباشرة.
        // يوجد fallback بسيط إذا أعاد Google Sheets قيمة Date/ISO.
        const toDateInputValue = (value) => {
            if (!value) return '';
            const text = String(value).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
            const d = new Date(text);
            return Number.isNaN(d.getTime()) ? text : d.toISOString().slice(0, 10);
        };
        const toTimeInputValue = (value) => {
            if (!value) return '';
            const text = String(value).trim();
            const match = text.match(/^(\d{1,2}):(\d{2})/);
            if (match) return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
            const d = new Date(text);
            return Number.isNaN(d.getTime()) ? text : d.toTimeString().slice(0, 5);
        };
        document.getElementById('date').value = toDateInputValue(report.date);
        document.getElementById('timeFrom').value = toTimeInputValue(report.timeFrom);
        document.getElementById('timeTo').value = toTimeInputValue(report.timeTo);
        document.getElementById('notes').value = report.notes;
        if (document.getElementById('phoneNumber')) document.getElementById('phoneNumber').value = report.phoneNumber || '';
        supervisorInput.value = report.supervisor || '';
        populateEmployees(report);
        originalCreatedAt = report.createdAt;
        salesTableBody.innerHTML = '';
        if (report.sales) report.sales.forEach(createSaleRow);
        updateSalesVisibility();
        if (competitorSalesTableBody) { competitorSalesTableBody.innerHTML = ''; if (report.salesOfCompetitor) report.salesOfCompetitor.forEach(createCompetitorSaleRow); updateCompetitorSaleTotals(); }
        updateCompetitorSalesVisibility();
        expensesTableBody.innerHTML = '';
        if (report.expenses) report.expenses.forEach(createExpenseRow);
        updateSaleTotals();
        mainSubmitBtn.innerHTML = '<i class="fa-solid fa-save"></i> تحديث التقرير';
        submitAndAddAnotherBtn.style.display = 'none';
        setTimeout(() => { isFormDirty = false; }, 200);
    };

    populateSelect(governorateSelect, [...new Set(DB.locations.map(l => l.gov))]);
    populateEmployees();
    reportForm.querySelectorAll('select:not(#market_name):not(.promoter-selector)').forEach(select => initSelect2(select, $(select).find("option:first").text(), false));
    
    $('#governorate').on('change', () => { const s = $('#governorate').val(); populateSelect(regionSelect, [...new Set(DB.locations.filter(l => l.gov === s).map(l => l.region))]); populateSelect(marketSelect, []); });
    $('#region').on('change', () => { const s = $('#region').val(); populateSelect(marketSelect, [...new Set(DB.locations.filter(l => l.region === s).map(l => l.market))]); });
    $('#inventoryDependency').on('change', function() { const s = $(this).val(); let n = ''; if (s) { const m = DB.employees.find(e => e.name === s); if (m && m.mgr) n = m.mgr; } supervisorInput.value = n; });
    $('#campaign').on('change', function() { salesTableBody.innerHTML = ''; expensesTableBody.innerHTML = ''; if (competitorSalesTableBody) competitorSalesTableBody.innerHTML = ''; updateCompetitorSalesVisibility(); updateSaleTotals(); const bi = document.getElementById('barcodeInput'); if (bi) bi.value = ''; const bs = document.getElementById('barcodeStatus'); if (bs) bs.textContent = ''; focusBarcodeInput(); });
    
    // const updatePhoneNumberRequirement = () => {
    //     const eventValue = String($('#event').val() || '').trim();
    //     const phoneInput = document.getElementById('phoneNumber');
    //     const hint = document.getElementById('phoneNumberHint');
    //     if (!phoneInput) return;
    //     const required = eventValue === 'ترويج وبيع غير مباشر';
    //     phoneInput.required = required;
    //     phoneInput.setAttribute('aria-required', required ? 'true' : 'false');
    //     if (hint) hint.textContent = required ? 'رقم هاتف صاحب المحل مطلوب لهذا النوع من الحدث.' : 'رقم الهاتف اختياري لهذا النوع من الحدث.';
    //     if (!required) phoneInput.setCustomValidity('');
    // };

    $('#event').on('change', function() {
       // updatePhoneNumberRequirement();
        updateSalesVisibility();
        updateCompetitorSalesVisibility();
        // أسعار المبيعات تعتمد على Products فقط في ترويج وبيع مباشر؛ وفي باقي الأحداث يجب على المستخدم إدخال السعر.
        salesTableBody.querySelectorAll('tr').forEach(row => { const sel=row.querySelector('.sale-product'); const name=String($(sel).val()||'').trim(); const master=getSaleProducts().find(p=>p.name===name); if(sel && master) row.querySelector('.sale-price').value = isDirectSaleEvent() ? Number(master.price||0).toFixed(2) : ''; });
        document.querySelectorAll('.sale-price, .competitor-price').forEach(input => input.setCustomValidity(''));
        updateSaleTotals();
        const isDirectPromotion = $(this).val() === 'ترويج مباشر';
        const marketSelectElement = $('#market_name');
        const currentValue = marketSelectElement.val();
        
        if (marketSelectElement.data('select2')) {
            marketSelectElement.select2('destroy');
        }
        
        initSelect2(marketSelectElement, 'اختر أو أدخل اسم المحل...', isDirectPromotion);
        marketSelectElement.val(currentValue).trigger('change');
    }).trigger('change');
    //updatePhoneNumberRequirement();
    updateSalesVisibility();

    const urlParams = new URLSearchParams(window.location.search);
    const editId = urlParams.get('edit');

    if (editId) {
        localStorage.removeItem(FORM_STATE_KEY);
        const reportFromState = JSON.parse(sessionStorage.getItem(EDIT_STATE_KEY));
        // الحالة المحلية تعرض التقرير فوراً، ثم الخادم يعيد أحدث نسخة دائماً.
        if (reportFromState && reportFromState.id == editId) {
            initEditMode(reportFromState);
            sessionStorage.removeItem(EDIT_STATE_KEY);
        }
        mainSubmitBtn.disabled = true;
        mainContainer.insertAdjacentHTML('afterbegin', `<div class="alert alert-info text-center p-3" id="edit-loading"><i class="fa-solid fa-spinner fa-spin"></i> مزامنة أحدث بيانات التقرير...</div>`);
        (async () => {
            try {
                const res = await fetch(`${SCRIPT_URL}?action=getReportById&id=${encodeURIComponent(editId)}&_refresh=${Date.now()}`, {cache:'no-store'});
                const result = await res.json();
                document.getElementById('edit-loading')?.remove();
                if (result.status === 'success') {
                    initEditMode(result.report);
                    mainSubmitBtn.disabled = false;
                } else throw new Error(result.message);
            } catch (error) {
                document.getElementById('edit-loading')?.remove();
                mainSubmitBtn.disabled = false;
                if (!reportFromState || reportFromState.id != editId) alert(`خطأ في تحميل بيانات التعديل: ${error.message}`);
            }
        })();
    } else {
        loadFormState();
    }
    

    // ===============================================================
    //                  EXPENSE / TASTING BARCODE
    // ===============================================================
    const expenseBarcodeInput = document.getElementById('expenseBarcodeInput');
    const scanExpenseBarcodeCameraBtn = document.getElementById('scanExpenseBarcodeCameraBtn');
    const clearExpenseBarcodeBtn = document.getElementById('clearExpenseBarcodeBtn');
    let expenseBarcodeDebounceTimer = null;

    const findExpenseByBarcode = (barcode) => {
        const code = normalizeBarcode(barcode);
        if (!code) return null;
        return getTastingProducts().find(p => normalizeBarcode(p.barcode) === code) || null;
    };

    const findExpenseRowByProduct = (productName) => {
        return Array.from(expensesTableBody.querySelectorAll('tr')).find(row =>
            $(row.querySelector('.expense-item')).val() === productName
        ) || null;
    };

    const focusExpenseBarcodeInput = () => {
        if (expenseBarcodeInput) setTimeout(() => expenseBarcodeInput.focus(), 50);
    };

    const addProductToExpensesByBarcode = (rawBarcode) => {
        const barcode = normalizeBarcode(rawBarcode);
        const status = document.getElementById('expenseBarcodeStatus');
        if (!barcode) return false;

        if (!campaignSelect.value) {
            status.textContent = 'يرجى اختيار نوع الحملة أولاً.';
            status.className = 'small mt-2 text-danger';
            showToast('يرجى اختيار نوع الحملة أولاً.', true);
            focusExpenseBarcodeInput();
            return false;
        }

        const product = findExpenseByBarcode(barcode);
        if (!product) {
            status.textContent = `الباركود ${barcode} غير موجود ضمن مواد التذوق للحملة الحالية.`;
            status.className = 'small mt-2 text-danger';
            showToast(`الباركود ${barcode} غير موجود ضمن مواد التذوق.`, true);
            focusExpenseBarcodeInput();
            return false;
        }

        const existingRow = findExpenseRowByProduct(product.name);
        if (existingRow) {
            const quantityInput = existingRow.querySelector('.expense-quantity');
            quantityInput.value = (parseInt(quantityInput.value, 10) || 0) + 1;
            status.textContent = `تمت زيادة كمية «${product.name}» إلى ${quantityInput.value}.`;
        } else {
            createExpenseRow({ item: product.name, quantity: 1, barcode });
            status.textContent = `تمت إضافة «${product.name}» × 1.`;
        }

        status.className = 'small mt-2 text-success';
        isFormDirty = true;
        saveFormState();
        expenseBarcodeInput.value = '';
        focusExpenseBarcodeInput();
        return true;
    };

    document.getElementById('competitorBarcodeInput')?.addEventListener('keydown', e => { if(e.key==='Enter'){ e.preventDefault(); clearTimeout(barcodeDebounceTimer); addCompetitorProductByBarcode(e.currentTarget.value); } });
    document.getElementById('competitorBarcodeInput')?.addEventListener('input', e => { clearTimeout(barcodeDebounceTimer); const value=normalizeBarcode(e.currentTarget.value); if(value.length<6)return; barcodeDebounceTimer=setTimeout(()=>{ if(document.activeElement===e.currentTarget && normalizeBarcode(e.currentTarget.value).length>=6) addCompetitorProductByBarcode(e.currentTarget.value); },250); });

    // ===============================================================
    //                 USB SCANNER + CAMERA SCANNER
    // ===============================================================
    const barcodeInput = document.getElementById('barcodeInput');
    const scanBarcodeCameraBtn = document.getElementById('scanBarcodeCameraBtn');
    const clearBarcodeBtn = document.getElementById('clearBarcodeBtn');
    const barcodeCameraModalElement = document.getElementById('barcodeCameraModal');
    const barcodeCameraModal = new bootstrap.Modal(barcodeCameraModalElement);
    let html5QrCode = null;
    let barcodeDebounceTimer = null;
    let lastSalesBarcode = '';
    let lastSalesBarcodeAt = 0;
    let cameraScanLocked = false;
    let cameraTarget = 'sales';

    const stopBarcodeCamera = async () => {
        if (!html5QrCode) return;
        try {
            const state = html5QrCode.getState?.();
            if (state === 2) await html5QrCode.stop();
        } catch (error) { console.warn('Barcode camera stop:', error); }
        try { await html5QrCode.clear(); } catch (error) {}
        html5QrCode = null;
        cameraScanLocked = false;
    };

    const handleScannedBarcode = (decodedText) => {
        if (cameraScanLocked) return;
        const barcode = normalizeBarcode(decodedText);
        if (!barcode) return;

        cameraScanLocked = true;
        const added = cameraTarget === 'expense'
            ? addProductToExpensesByBarcode(barcode)
            : cameraTarget === 'competitor'
                ? addCompetitorProductByBarcode(barcode)
                : addProductToSalesByBarcode(barcode);

        const status = document.getElementById('cameraScannerStatus');
        status.textContent = added ? 'تمت إضافة المادة. سيتم إغلاق الكاميرا...' : 'لم يتم العثور على المادة.';
        setTimeout(async () => {
            await stopBarcodeCamera();
            barcodeCameraModal.hide();
            cameraScanLocked = false;
        }, added ? 350 : 900);
    };

    const startBarcodeCamera = async (target = 'sales') => {
        cameraTarget = target;
        const status = document.getElementById('cameraScannerStatus');

        if (typeof Html5Qrcode === 'undefined') {
            if (!navigator.onLine) {
                const msg = 'مكتبة قراءة الباركود بالكاميرا تحتاج اتصالاً بالإنترنت لتحميلها أول مرة.';
                status.textContent = msg;
                showToast(msg, true);
                barcodeCameraModal.show();
                return;
            }
            status.textContent = 'جاري تحميل مكتبة الكاميرا...';
            barcodeCameraModal.show();
            const loaded = await loadHtml5QrcodeLibrary();
            if (!loaded || typeof Html5Qrcode === 'undefined') {
                const msg = 'تعذر تحميل مكتبة قراءة الباركود بالكاميرا. تحقق من الاتصال وحاول مجدداً.';
                status.textContent = msg;
                showToast(msg, true);
                return;
            }
        }
        if (!campaignSelect.value) {
            showToast('يرجى اختيار نوع الحملة أولاً.', true);
            return;
        }
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            const msg = 'الكاميرا تحتاج HTTPS أو localhost.';
            status.textContent = msg;
            showToast(msg, true);
            barcodeCameraModal.show();
            return;
        }

        cameraScanLocked = false;
        status.textContent = target === 'expense'
            ? 'جاري تجهيز الكاميرا لمواد التذوق...'
            : target === 'competitor'
                ? 'جاري تجهيز الكاميرا لمواد المنافس...'
                : 'جاري تجهيز الكاميرا للمواد البيعية...';
        barcodeCameraModal.show();

        const scannerConfig = {
            fps: 10,
            qrbox: { width: 280, height: 140 },
            formatsToSupport: [
                Html5QrcodeSupportedFormats.CODE_128,
                Html5QrcodeSupportedFormats.CODE_39,
                Html5QrcodeSupportedFormats.CODE_93,
                Html5QrcodeSupportedFormats.EAN_13,
                Html5QrcodeSupportedFormats.EAN_8,
                Html5QrcodeSupportedFormats.UPC_A,
                Html5QrcodeSupportedFormats.UPC_E,
                Html5QrcodeSupportedFormats.ITF,
                Html5QrcodeSupportedFormats.CODABAR
            ]
        };

        try {
            // لا نستخدم facingMode نهائياً. نطلب الكاميرات ونمرر cameraId مباشرة.
            const cameras = await Html5Qrcode.getCameras();
            if (!cameras || cameras.length === 0) {
                throw new DOMException('لم يتم العثور على كاميرا متاحة.', 'NotFoundError');
            }

            // html5-qrcode 2.3.8 expects a non-empty camera id string.
            // Some browsers expose the device id as `deviceId` instead of `id`,
            // so normalize all common shapes before calling start().
            const normalizedCameras = cameras.map(camera => {
                const isString = typeof camera === 'string';
                return {
                    raw: camera,
                    id: String(
                        isString
                            ? camera
                            : (camera?.id ??
                               camera?.deviceId ??
                               camera?.cameraId ??
                               '')
                    ).trim(),
                    label: String(isString ? '' : (camera?.label || '')).trim()
                };
            }).filter(camera => camera.id);

            if (!normalizedCameras.length) {
                throw new DOMException(
                    'لم يتمكن المتصفح من توفير معرف للكاميرا.',
                    'NotFoundError'
                );
            }

            const selectedCamera =
                normalizedCameras.find(camera => {
                    const label = camera.label.toLowerCase();
                    return label.includes('back') ||
                           label.includes('rear') ||
                           label.includes('environment') ||
                           label.includes('خلف');
                }) || normalizedCameras[0];

            const cameraId = selectedCamera.id;

            // Safety check: never call start() with an empty/undefined camera id.
            if (typeof cameraId !== 'string' || !cameraId.trim()) {
                throw new DOMException(
                    'معرف الكاميرا غير صالح.',
                    'NotFoundError'
                );
            }

            html5QrCode = new Html5Qrcode('barcode-reader', { verbose: false });

            await html5QrCode.start(
                cameraId,
                scannerConfig,
                handleScannedBarcode,
                () => {}
            );

            status.textContent = target === 'expense'
                ? 'وجّه الكاميرا نحو باركود مادة التذوق'
                : 'وجّه الكاميرا نحو باركود المادة البيعية';
        } catch (error) {
            console.error('Barcode camera error:', error);
            let message = `تعذر تشغيل الكاميرا: ${error?.name || ''} ${error?.message || error}`;

            if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
                message = 'تم رفض إذن الكاميرا. اسمح للمتصفح باستخدام الكاميرا ثم أعد المحاولة.';
            } else if (error?.name === 'NotFoundError') {
                message = 'لم يتم العثور على كاميرا متاحة على الجهاز.';
            } else if (error?.name === 'NotReadableError' || error?.name === 'AbortError') {
                message = 'الكاميرا مستخدمة من تطبيق أو صفحة أخرى. أغلقها ثم أعد المحاولة.';
            }

            status.textContent = message;
            showToast(message, true);
            await stopBarcodeCamera();
        }
    };

    scanBarcodeCameraBtn.addEventListener('click', () => startBarcodeCamera('sales'));
    scanExpenseBarcodeCameraBtn?.addEventListener('click', () => startBarcodeCamera('expense'));
    document.getElementById('scanCompetitorBarcodeCameraBtn')?.addEventListener('click', () => startBarcodeCamera('competitor'));

    clearBarcodeBtn.addEventListener('click', () => {
        barcodeInput.value = '';
        document.getElementById('barcodeStatus').textContent = '';
        focusBarcodeInput();
    });
    clearExpenseBarcodeBtn?.addEventListener('click', () => {
        expenseBarcodeInput.value = '';
        document.getElementById('expenseBarcodeStatus').textContent = '';
        focusExpenseBarcodeInput();
    });
    document.getElementById('clearCompetitorBarcodeBtn')?.addEventListener('click', () => { const input=document.getElementById('competitorBarcodeInput'); if(input){input.value='';input.focus();} document.getElementById('competitorBarcodeStatus').textContent=''; });

    barcodeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(barcodeDebounceTimer);
            addProductToSalesByBarcode(barcodeInput.value);
        }
    });
    barcodeInput.addEventListener('input', () => {
        clearTimeout(barcodeDebounceTimer);
        const value = normalizeBarcode(barcodeInput.value);
        if (value.length < 6) return;
        barcodeDebounceTimer = setTimeout(() => {
            if (document.activeElement === barcodeInput && normalizeBarcode(barcodeInput.value).length >= 6)
                addProductToSalesByBarcode(barcodeInput.value);
        }, 250);
    });

    expenseBarcodeInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(expenseBarcodeDebounceTimer);
            addProductToExpensesByBarcode(expenseBarcodeInput.value);
        }
    });
    expenseBarcodeInput?.addEventListener('input', () => {
        clearTimeout(expenseBarcodeDebounceTimer);
        const value = normalizeBarcode(expenseBarcodeInput.value);
        if (value.length < 6) return;
        expenseBarcodeDebounceTimer = setTimeout(() => {
            if (document.activeElement === expenseBarcodeInput && normalizeBarcode(expenseBarcodeInput.value).length >= 6)
                addProductToExpensesByBarcode(expenseBarcodeInput.value);
        }, 250);
    });

    barcodeCameraModalElement.addEventListener('hidden.bs.modal', async () => {
        await stopBarcodeCamera();
    });

    setTimeout(focusBarcodeInput, 300);

    salesTableBody.addEventListener('input', updateSaleTotals);
    reportForm.addEventListener('submit', (event) => handleFormSubmit(event, editId, false));
    submitAndAddAnotherBtn.addEventListener('click', (event) => handleFormSubmit(event, editId, true));
    
    document.getElementById('successModal').addEventListener('hidden.bs.modal', () => {
        if (!editId) { // فقط إذا كان تقريرًا جديدًا
            resetFullForm();
        } else {
            window.location.href = 'reports.html'; // في حالة التعديل، ارجع إلى صفحة فارغة
        }
    });
}

// ===================================================================
//                      5. منطق صفحة سجل التعديلات
// ===================================================================
async function handleHistoryPage() {
    const reportsAccordion = document.getElementById('reports-accordion');
    const searchInput = document.getElementById('searchInput');
    const noResultsMessage = document.getElementById('no-results-message');
    const reportsCount = document.getElementById('reportsCount');
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    let currentReports = [];
    const userRole = String(currentUser?.role || '').trim().toLowerCase();
    const isAdmin = userRole === 'admin';
    const isManager = userRole === 'manager';
    const historyTitle = document.getElementById('historyTitle');
    const employeeFilterWrap = document.getElementById('historyEmployeeFilterWrap');
    const employeeFilterSelect = document.getElementById('historyEmployeeFilterSelect');
    let selectedTargetId = 'all';
    let teamOptionsByName = new Map();

    const updateHistoryTitle = () => {
        if (!historyTitle) return;
        if (selectedTargetId && selectedTargetId !== 'all') {
            const name = teamOptionsByName.get(selectedTargetId) || '';
            historyTitle.textContent = name ? `سجل تقارير: ${name}` : 'سجل التقارير';
        } else if (isAdmin) {
            historyTitle.textContent = 'سجل جميع التقارير';
        } else if (isManager) {
            historyTitle.textContent = 'سجل تقارير فريقي';
        } else {
            historyTitle.textContent = 'سجل تقاريري';
        }
    };
    updateHistoryTitle();

    const renderReports = (reportsToRender) => {
        reportsAccordion.innerHTML = '';
        const count = Array.isArray(reportsToRender) ? reportsToRender.length : 0;
        if (reportsCount) reportsCount.textContent = `${count} تقرير${count === 1 ? '' : ''}`;
        if (!reportsToRender || reportsToRender.length === 0) {
            noResultsMessage.textContent = searchInput.value ? 'لا توجد تقارير تطابق بحثك.' : 'لا توجد تقارير محفوظة لعرضها.';
            noResultsMessage.classList.remove('d-none');
            return;
        }
        noResultsMessage.classList.add('d-none');
        reportsToRender.slice().reverse().forEach(report => {
            let grandTotal = 0, totalQuantity = 0;
            const salesRows = report.sales?.length > 0 ? report.sales.map(s => { 
                const p = parseFloat(s.price) || 0;
                const q = parseInt(s.quantity) || 0;
                const t = p * q; 
                grandTotal += t; 
                totalQuantity += q; 
                return `<tr><td>${s.product||'-'}</td><td>${p.toFixed(2)}</td><td>${q}</td><td>${t.toFixed(2)}</td></tr>`; 
            }).join('') : '<tr><td colspan="4" class="text-center text-muted">لا توجد مبيعات</td></tr>';
            const expensesRows = report.expenses?.length > 0 ? report.expenses.map(exp => `<tr><td>${exp.item || '-'}</td><td>${exp.quantity || '0'}</td></tr>`).join('') : '<tr><td colspan="2" class="text-center text-muted">لا توجد مصاريف</td></tr>';
            const competitorSalesRows = report.salesOfCompetitor?.length > 0 ? report.salesOfCompetitor.map(s => `<tr><td>${s.product||'-'}</td><td>${Number(s.price||0).toFixed(2)}</td><td>${s.quantity||0}</td></tr>`).join('') : '<tr><td colspan="3" class="text-center text-muted">لا توجد مبيعات منافس</td></tr>';
            const promotersList = report.promoters && report.promoters.length > 0 ? report.promoters.join(', ') : 'لا يوجد';
            const reportHTML = `<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-${report.id}"><strong>${report.campaign} - ${report.market}</strong> (${report.date})</button></h2><div id="c-${report.id}" class="accordion-collapse collapse" data-bs-parent="#reports-accordion"><div class="accordion-body"><p><strong>تاريخ الإنشاء:</strong> ${report.createdAt || 'غير مسجل'}</p><p><strong>الحدث:</strong> ${report.event} (${report.eventDays} أيام) | <strong>الوقت:</strong> ${report.timeFrom} - ${report.timeTo}</p><p><strong>الفريق:</strong> منسق (${report.coordinator || 'N/A'})، جرد (${report.inventoryDependency || 'N/A'})، مشرف (${report.supervisor || 'N/A'})</p><p><strong>المروجون:</strong> ${promotersList}</p><h5 class="mt-4">المبيعات</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>السعر</th><th>الكمية</th><th>المجموع</th></tr></thead><tbody>${salesRows}</tbody>${report.sales?.length > 0 ? `<tfoot class="table-light fw-bold"><tr><td class="text-end" colspan="2">الإجمالي:</td><td>${totalQuantity}</td><td>${grandTotal.toFixed(2)}</td></tr></tfoot>` : ''}</table><h5 class="mt-4">مبيعات المنافس</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>السعر</th><th>الكمية</th></tr></thead><tbody>${competitorSalesRows}</tbody></table><h5 class="mt-4">المصاريف</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>الكمية</th></tr></thead><tbody>${expensesRows}</tbody></table>${report.notes ? `<hr><p><strong>ملاحظات:</strong> ${report.notes}</p>` : ''}<div class="text-end mt-3 border-top pt-3"><a href="reports.html?edit=${report.id}" class="btn btn-sm btn-primary edit-report-btn" data-report-id="${report.id}"><i class="fa-solid fa-pen-to-square me-1"></i> تعديل</a></div></div></div></div>`;
            reportsAccordion.insertAdjacentHTML('beforeend', reportHTML);
        });
        reportsAccordion.querySelectorAll('.edit-report-btn').forEach(button => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                const reportId = button.getAttribute('data-report-id');
                const reportData = currentReports.find(r => r.id == reportId);
                if (reportData) {
                    sessionStorage.setItem(EDIT_STATE_KEY, JSON.stringify(reportData));
                }
                window.location.href = button.href;
            });
        });
        
        if (window.location.hash) {
            const targetId = window.location.hash.substring(1);
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                new bootstrap.Collapse(targetElement).show();
                targetElement.scrollIntoView({ behavior: 'smooth' });
            }
        }
    };

    // جلب تقارير من الخادم — targetId = 'all' (النطاق الافتراضي حسب الصلاحية) أو معرّف موظف محدد.
    async function fetchReportsFromServer(targetId) {
        const params = new URLSearchParams({
            action: 'getReports',
            userId: String(currentUser.id || ''),
            role: String(currentUser.role || ''),
            userName: String(currentUser.name || ''),
            targetUserId: String(targetId || 'all'),
            _: String(Date.now())
        });
        const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error(data?.message || 'استجابة غير صالحة من الخادم');
        return data;
    }

    // القائمة المنسدلة لاختيار موظف معيّن — admin يرى الجميع، manager يرى فريقه فقط.
    if (employeeFilterWrap && employeeFilterSelect) {
        const options = await fetchTeamOptions(currentUser);
        if (options.length) {
            teamOptionsByName = new Map(options.map(o => [String(o.id), o.name]));
            employeeFilterSelect.innerHTML = '<option value="all">الكل</option>' +
                options.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
            employeeFilterWrap.classList.remove('d-none');
            employeeFilterSelect.addEventListener('change', async () => {
                selectedTargetId = employeeFilterSelect.value || 'all';
                updateHistoryTitle();
                if (selectedTargetId === 'all') {
                    currentReports = memoryReportsCache || [];
                    renderReports(currentReports);
                    return;
                }
                reportsAccordion.innerHTML = `<div class="text-center p-4"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
                try {
                    currentReports = await fetchReportsFromServer(selectedTargetId);
                    renderReports(currentReports);
                } catch (e) {
                    reportsAccordion.innerHTML = `<div class="alert alert-danger">تعذر تحميل بيانات هذا الموظف.</div>`;
                }
            });
        }
    }

    const cachedReportsJSON = memoryReportsCache ? null : localStorage.getItem('reportsCache');
    if (memoryReportsCache) {
        currentReports = memoryReportsCache;
        renderReports(currentReports);
    } else if (cachedReportsJSON) {
        try {
            const allCachedReports = JSON.parse(cachedReportsJSON);
            if (Array.isArray(allCachedReports)) {
                currentReports = allCachedReports;
                renderReports(currentReports);
            }
        } catch (e) {
            localStorage.removeItem('reportsCache');
        }
    }
    if (!cachedReportsJSON) {
        reportsAccordion.innerHTML = `<div class="p-2"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div>`;
    }

    // V27: debounce لتقليل عمليات إعادة الرسم أثناء الكتابة السريعة في قائمة طويلة من التقارير.
    let searchDebounceTimer = null;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        const value = e.target.value;
        searchDebounceTimer = setTimeout(() => {
            const term = value.toLowerCase().trim();
            if (!term) { renderReports(currentReports); return; }
            const filtered = currentReports.filter(r => {
                const haystack = r.__searchText || (r.__searchText = `${r.campaign||''} ${r.market||''} ${r.date||''} ${r.supervisor||''}`.toLowerCase());
                return haystack.includes(term);
            });
            renderReports(filtered);
        }, 150);
    });

    try {
        // النطاق الافتراضي (بدون تحديد موظف) — يحسمه الخادم حسب الدور: admin=الكل، manager=فريقه، user=نفسه.
        const allFreshReports = await fetchReportsFromServer('all');
        memoryReportsCache = allFreshReports;
        localStorage.setItem('reportsCache', JSON.stringify(allFreshReports));
        if (selectedTargetId === 'all') {
            currentReports = allFreshReports;
            renderReports(currentReports);
        }
    } catch (error) {
        if (!cachedReportsJSON) {
            reportsAccordion.innerHTML = `<div class="alert alert-danger">فشل تحميل سجل التقارير. يرجى التحقق من الاتصال وبيانات المستخدم ثم تحديث الصفحة.</div>`;
        }
    }

    const exportHistoryBtn = document.getElementById('exportHistoryCSV');
    exportHistoryBtn?.addEventListener('click', () => {
        if (!currentReports || !currentReports.length) {
            noResultsMessage.textContent = 'لا توجد تقارير لتصديرها.';
            noResultsMessage.classList.remove('d-none');
            return;
        }
        const csv = reportsToCSV(currentReports);
        downloadTextFile(`reports_${new Date().toISOString().slice(0,10)}.csv`, csv, 'text/csv');
    });
}

// ===================================================================
//   5.5 منطق صفحة التحليلات (dashboard.html) — رسوم بيانية وإحصائيات
// ===================================================================
function escapeHtmlGlobal(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[char]));
}
async function handleDashboardPage() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    if (!currentUser) { window.location.href = 'index.html'; return; }

    // V42: صلاحية صفحة التحليلات — admin و manager فقط (المدير يرى فريقه، الإداري الكل).
    // أي مستخدم آخر يُعاد إلى صفحة التقارير حتى لو فتح الرابط مباشرة.
    const role = String(currentUser.role || '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'manager') {
        window.location.href = 'reports.html';
        return;
    }

    let db = null;
    try { db = await getDbData(); } catch (e) { db = { locations: [], products: {}, employees: [] }; }

    const campaignFilter = document.getElementById('dashboardCampaignFilter');
    const toastContainer = document.getElementById('toast-notification');
    const showToast = (msg, isError = false) => {
        const tm = toastContainer?.querySelector('.toast-message');
        if (!tm) return;
        tm.textContent = msg;
        tm.classList.toggle('error', isError);
        toastContainer.classList.add('show');
        setTimeout(() => toastContainer.classList.remove('show'), 3000);
    };

    const campaignNames = new Set();
    Object.keys(db.products || {}).forEach(c => { if (c) campaignNames.add(c); });
    db.locations?.forEach(l => { if (l?.gov) campaignNames.add(''); });
    if (campaignFilter) {
        campaignFilter.innerHTML = '<option value="">كل الحملات</option>' +
            [...campaignNames].filter(Boolean).sort().map(c => `<option value="${c}">${c}</option>`).join('');
    }

    let charts = {};
    const textColor = () => getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim() || '#333';
    const gridColor = () => getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || '#dfe7f1';

    function destroyCharts() {
        Object.values(charts).forEach(c => { try { c?.destroy(); } catch (e) {} });
        charts = {};
    }

    function loadReports() {
        return new Promise(async (resolve, reject) => {
            try {
                const params = new URLSearchParams({
                    action: 'getReports',
                    userId: String(currentUser.id || ''),
                    role: String(currentUser.role || ''),
                    userName: String(currentUser.name || ''),
                    _: String(Date.now())
                });
                const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
                const data = await res.json();
                resolve(Array.isArray(data) ? data : []);
            } catch (e) { resolve([]); }
        });
    }

    // V42: جلب الإحصائيات المجمّعة من الخادم (أسرع بكثير من جلب كل التقارير وتجميعها محلياً).
    // مع fallback تلقائي إلى التجميع المحلي إذا فشل استدعاء getDashboardData.
    async function loadDashboardStats() {
        if (!navigator.onLine) return null;
        try {
            const params = new URLSearchParams({
                action: 'getDashboardData',
                userId: String(currentUser.id || ''),
                role: String(currentUser.role || ''),
                _: String(Date.now())
            });
            const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
            const data = await res.json();
            if (data && data.status === 'success' && data.kpis) return data;
            return null;
        } catch (e) {
            console.warn('تعذر جلب بيانات التحليلات المجمعة، سيتم التجميع محلياً:', e);
            return null;
        }
    }

    async function refreshDashboard() {
        destroyCharts();
        const campaign = campaignFilter?.value || '';
        const stats = await loadDashboardStats();

        if (stats && !campaign) {
            // نستخدم البيانات المجمّعة من الخادم عند عدم وجود فلتر حملة.
            renderFromServerStats(stats);
            return;
        }

        // فلترة حسب الحملة أو fallback: التجميع المحلي.
        const reports = campaign ? await loadReports() : [];
        const baseReports = stats && !campaign ? [] : (reports.length ? reports : await loadReports());
        const filtered = reports.length ? reports.filter(r => String(r.campaign || '') === campaign) : baseReports;
        renderClientSide(filtered, db);
    }

    function renderFromServerStats(stats) {
        const kpis = stats.kpis || {};
        const kpiReports = document.getElementById('kpiTotalReports');
        const kpiSales = document.getElementById('kpiTotalSales');
        const kpiEmployees = document.getElementById('kpiActiveEmployees');
        const kpiProducts = document.getElementById('kpiTotalProducts');
        if (kpiReports) kpiReports.textContent = kpis.totalReports || 0;
        if (kpiSales) kpiSales.textContent = (kpis.totalSales || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (kpiEmployees) kpiEmployees.textContent = kpis.activeEmployees || 0;
        if (kpiProducts) kpiProducts.textContent = Object.values(db.products || {}).flat().length || 0;

        // Daily line
        const dailyCtx = document.getElementById('chartDailySales');
        if (dailyCtx && typeof Chart !== 'undefined' && Array.isArray(stats.daily)) {
            charts.daily = new Chart(dailyCtx.getContext('2d'), {
                type: 'line',
                data: {
                    labels: stats.daily.map(d => String(d.date).slice(5)),
                    datasets: [{
                        label: 'المبيعات (بالمليون)',
                        data: stats.daily.map(d => (d.value || 0) / 1000000),
                        borderColor: '#4a90e2',
                        backgroundColor: 'rgba(74,144,226,0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2
                    }]
                },
                options: baseChartOptions('إجمالي المبيعات اليومية بالل.ل', textColor(), gridColor())
            });
        }

        // Campaign pie
        const pieCtx = document.getElementById('chartCampaignPie');
        if (pieCtx && typeof Chart !== 'undefined' && Array.isArray(stats.campaigns)) {
            charts.pie = new Chart(pieCtx.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: stats.campaigns.map(c => c.label),
                    datasets: [{
                        data: stats.campaigns.map(c => c.value),
                        backgroundColor: ['#4a90e2','#50e3c2','#f39c12','#e74c3c','#9b59b6','#1abc9c','#f1c40f'],
                        borderWidth: 1
                    }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: textColor() } } } }
            });
        }

        // Governorate bar
        const govCtx = document.getElementById('chartGovernorateBar');
        if (govCtx && typeof Chart !== 'undefined' && Array.isArray(stats.governorates)) {
            charts.gov = new Chart(govCtx.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: stats.governorates.map(g => g.label),
                    datasets: [{
                        label: 'المبيعات بالمليون',
                        data: stats.governorates.map(g => Math.round((g.value / 1000000) * 100) / 100),
                        backgroundColor: 'rgba(80,227,194,0.7)',
                        borderColor: '#50e3c2',
                        borderWidth: 1
                    }]
                },
                options: baseChartOptions('المبيعات بالمليون الليرة', textColor(), gridColor())
            });
        }

        // Employees
        const body = document.getElementById('employeePerformanceBody');
        if (body) {
            const list = Array.isArray(stats.employees) ? stats.employees : [];
            const totalSales = list.reduce((s, e) => s + (e.sales || 0), 0);
            body.innerHTML = list.length ? list.map(e => {
                const pct = totalSales ? Math.round((e.sales / totalSales) * 100) : 0;
                return `<tr><td><span class="fw-bold">${escapeHtmlGlobal(e.name)}</span></td><td>${e.reports || 0}</td><td>${(e.sales || 0).toLocaleString('en-US', { minimumFractionDigits: 0 })} <span class="badge bg-secondary ms-1">${pct}%</span></td></tr>`;
            }).join('') : '<tr><td colspan="3" class="text-center text-muted py-4">لا توجد بيانات</td></tr>';
        }
    }

    function renderClientSide(reports, db) {
        const txt = () => getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim() || '#333';
        const grd = () => getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || '#dfe7f1';
        const filtered = reports || [];

        let totalSales = 0, totalQty = 0;
        const employeesSet = new Set();
        filtered.forEach(r => {
            (r.sales || []).forEach(s => {
                totalSales += (Number(s.price) || 0) * (Number(s.quantity) || 0);
                totalQty += Number(s.quantity) || 0;
            });
            if (r.createdByName) employeesSet.add(r.createdByName);
        });
        const kpiReports = document.getElementById('kpiTotalReports');
        const kpiSales = document.getElementById('kpiTotalSales');
        const kpiEmployees = document.getElementById('kpiActiveEmployees');
        const kpiProducts = document.getElementById('kpiTotalProducts');
        if (kpiReports) kpiReports.textContent = filtered.length || 0;
        if (kpiSales) kpiSales.textContent = totalSales.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (kpiEmployees) kpiEmployees.textContent = employeesSet.size || 0;
        if (kpiProducts) kpiProducts.textContent = Object.values(db.products || {}).flat().length || 0;

        const dailyMap = new Map();
        const today = new Date();
        for (let i = 29; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); dailyMap.set(d.toISOString().slice(0,10), 0); }
        filtered.forEach(r => { const key = String(r.date || '').slice(0,10); if (dailyMap.has(key)) { let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); dailyMap.set(key,(dailyMap.get(key)||0)+sum); } });

        const dailyCtx = document.getElementById('chartDailySales');
        if (dailyCtx && typeof Chart !== 'undefined') {
            charts.daily = new Chart(dailyCtx.getContext('2d'), {
                type: 'line',
                data: { labels: [...dailyMap.keys()].map(k=>k.slice(5)), datasets: [{ label:'المبيعات (بالمليون)', data:[...dailyMap.values()].map(v=>v/1000000), borderColor:'#4a90e2', backgroundColor:'rgba(74,144,226,0.1)', fill:true, tension:0.3, pointRadius:2 }] },
                options: baseChartOptions('إجمالي المبيعات اليومية بالل.ل', txt(), grd())
            });
        }

        const campMap = new Map();
        filtered.forEach(r => { const c=String(r.campaign||'غير محدد'); let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); campMap.set(c,(campMap.get(c)||0)+sum); });
        const pieCtx = document.getElementById('chartCampaignPie');
        if (pieCtx && typeof Chart !== 'undefined') {
            const d=[...campMap.entries()];
            charts.pie = new Chart(pieCtx.getContext('2d'), { type:'doughnut', data:{ labels:d.map(([k])=>k), datasets:[{ data:d.map(([,v])=>v), backgroundColor:['#4a90e2','#50e3c2','#f39c12','#e74c3c','#9b59b6','#1abc9c','#f1c40f'], borderWidth:1 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ color:txt() } } } } });
        }

        const govMap = new Map();
        filtered.forEach(r => { const g=String(r.governorate||'غير محدد'); let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); govMap.set(g,(govMap.get(g)||0)+sum); });
        const govCtx = document.getElementById('chartGovernorateBar');
        if (govCtx && typeof Chart !== 'undefined') {
            const d=[...govMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
            charts.gov = new Chart(govCtx.getContext('2d'), { type:'bar', data:{ labels:d.map(([k])=>k), datasets:[{ label:'المبيعات', data:d.map(([,v])=>Math.round(v/1000000*100)/100), backgroundColor:'rgba(80,227,194,0.7)', borderColor:'#50e3c2', borderWidth:1 }] }, options: baseChartOptions('المبيعات بالمليون الليرة', txt(), grd()) });
        }

        renderEmployeePerformance(filtered, db);
    }

    function employeePerformance(reports) {
        const map = new Map();
        let productCount = 0;
        (reports || []).forEach(r => {
            const name = String(r.createdByName || 'غير معروف');
            if (!map.has(name)) map.set(name, { name, reports: 0, sales: 0 });
            const e = map.get(name);
            e.reports++;
            let sum = 0;
            (r.sales || []).forEach(s => sum += (Number(s.price) || 0) * (Number(s.quantity) || 0));
            e.sales += sum;
        });
        const list = [...map.values()].sort((a,b) => b.sales - a.sales).slice(0, 15);
        return { list, productCount };
    }

    function renderEmployeePerformance(reports, db) {
        const body = document.getElementById('employeePerformanceBody');
        if (!body) return;
        const { list } = employeePerformance(reports);
        const dbProducts = Object.values(db.products || {}).flat().length;
        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-4">لا توجد بيانات</td></tr>';
            return;
        }
        const totalSales = list.reduce((s, e) => s + e.sales, 0);
        body.innerHTML = list.map(e => {
            const pct = totalSales ? Math.round((e.sales / totalSales) * 100) : 0;
            return `<tr>
                <td><span class="fw-bold">${escapeHtmlGlobal(e.name)}</span>${dbProducts ? `<span class="text-muted small"> (${dbProducts} مادة)</span>` : ''}</td>
                <td>${e.reports}</td>
                <td>${e.sales.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} <span class="badge bg-secondary ms-1">${pct}%</span></td>
            </tr>`;
        }).join('');
    }

    function baseChartOptions(title, textColor, gridColor) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: textColor } },
                title: { display: !!title, text: title, color: textColor }
            },
            scales: {
                x: { ticks: { color: textColor, maxTicksLimit: 10 }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor } }
            }
        };
    }

    // Re-render charts on theme change for correct colors.
    const themeObserver = new MutationObserver(() => refreshDashboard());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    campaignFilter?.addEventListener('change', refreshDashboard);

    const exportBtn = document.getElementById('exportDashboardCSV');
    exportBtn?.addEventListener('click', async () => {
        const reports = await loadReports();
        const campaign = campaignFilter?.value || '';
        const filtered = campaign ? reports.filter(r => String(r.campaign || '') === campaign) : reports;
        const csv = reportsToCSV(filtered);
        downloadTextFile(`reports_${campaign || 'all'}_${new Date().toISOString().slice(0,10)}.csv`, csv, 'text/csv');
        showToast('تم تصدير CSV بنجاح.');
    });

    await refreshDashboard();
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

// ===================================================================
//   6. منطق صفحة سحب / مرتجع مواد (materialsMovement.html) — مبنية على المستخدم
// ===================================================================
// تعرض هذه الصفحة محصلة المستخدم الحالي (سحب/مرتجع/صرف/مبيعات).
// المبيعات تُرسل يدوياً بعد اختيار التقرير المستهدف، بينما المصاريف تُسجّل تلقائياً
// كحركة "صرف" في festivalMovement عند حفظ أو تعديل أي تقرير.
const DIRECT_SALE_EVENT_NAME = 'ترويج وبيع مباشر';
async function handleMaterialsMovementPage() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    if (!currentUser) { window.location.href = 'index.html'; return; }

    const toastContainer = document.getElementById('toast-notification');
    const toastMessage = toastContainer.querySelector('.toast-message');
    const showToast = (message, isError = false) => {
        toastMessage.textContent = message;
        toastMessage.classList.toggle('error', isError);
        toastContainer.classList.add('show');
        setTimeout(() => toastContainer.classList.remove('show'), 3000);
    };

    const userInfoBox = document.getElementById('reportInfoBox');
    const movementTableBody = document.getElementById('movement-table-body');
    const addMovementRowBtn = document.getElementById('addMovementRowBtn');
    const saveMovementBtn = document.getElementById('saveMovementBtn');
    const movementHistoryBody = document.getElementById('movement-history-body');
    const inventorySummaryBody = document.getElementById('inventory-summary-body');
    const movementEntryCard = document.getElementById('movementEntryCard');
    const closeOutTallyBtnEl = document.getElementById('closeOutTallyBtn');
    const employeeFilterWrap = document.getElementById('movementEmployeeFilterWrap');
    const employeeFilterSelect = document.getElementById('movementEmployeeFilterSelect');

    // النطاق المعروض حالياً: نفسي بشكل افتراضي، أو موظف آخر يختاره admin/manager من القائمة.
    let viewingTargetId = String(currentUser.id || '');
    let viewingTargetName = String(currentUser.name || '');
    const isViewingSelf = () => viewingTargetId === String(currentUser.id || '');

    function updateMovementScopeUI() {
        userInfoBox.classList.remove('d-none');
        userInfoBox.innerHTML = isViewingSelf()
            ? `<i class="fa-solid fa-user me-1"></i> محصلة السحب/المرتجع الخاصة بك: <strong>${currentUser.name || ''}</strong>`
            : `<i class="fa-solid fa-user-group me-1"></i> عرض بيانات الموظف: <strong>${viewingTargetName || ''}</strong> (وضع للعرض فقط)`;
        // تسجيل حركة جديدة وإرسال صافي المحصلة يبقيان دائماً مرتبطين بحسابك أنت فقط،
        // لذا يُخفيان عند تصفّح بيانات موظف آخر لتفادي أي التباس.
        if (movementEntryCard) movementEntryCard.style.display = isViewingSelf() ? '' : 'none';
        if (closeOutTallyBtnEl) closeOutTallyBtnEl.style.display = isViewingSelf() ? '' : 'none';
    }

    const productModal = new bootstrap.Modal(document.getElementById('movementProductSelectionModal'));
    const productSearchInput = document.getElementById('movementProductSearchInput');
    const productSelectionTbody = document.querySelector('#movementProductSelectionTable tbody');
    const addSelectedProductsBtn = document.getElementById('addSelectedMovementProductsBtn');

    let DB = null;

    const isCancelledProduct = (product) => {
        if (!product) return true;
        const value = String(product.cancelled ?? '').trim().toLowerCase();
        return product.cancelled === true || value === 'true' || value === '1' || value === 'yes' || value === 'نعم';
    };

    // كل مواد كل الحملات مجمّعة (بدون تكرار)، لأن الصفحة لم تعد مرتبطة بحملة/تقرير واحد.
    function getAllSellableProducts() {
        if (!DB || !DB.products) return [];
        const map = new Map();
        Object.values(DB.products).flat().forEach(p => {
            if (p && p.name && String(p.category ?? '').trim() === 'مادة بيعية' && !isCancelledProduct(p) && !map.has(p.name)) {
                map.set(p.name, p);
            }
        });
        return Array.from(map.values());
    }

    updateMovementScopeUI();

    // -----------------------------------------------------------------
    // إضافة صف حركة جديد (مادة + كمية + عملية)
    // -----------------------------------------------------------------
    function createMovementRow(productName) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <input type="text" class="form-control movement-product" value="${productName}" readonly>
            </td>
            <td>
                <input type="number" class="form-control movement-quantity" min="1" step="1" value="1">
            </td>
            <td>
                <input type="text" class="form-control movement-invoice" placeholder="اختياري">
            </td>
            <td>
                <select class="form-select movement-operation">
                    <option value="سحب">سحب</option>
                    <option value="مرتجع">مرتجع</option>
                </select>
            </td>
            <td class="text-center">
                <button type="button" class="btn btn-sm btn-outline-danger remove-movement-row"><i class="fa-solid fa-trash"></i></button>
            </td>`;
        tr.querySelector('.remove-movement-row').addEventListener('click', () => tr.remove());
        movementTableBody.appendChild(tr);
    }

    function populateProductModal() {
        const products = getAllSellableProducts();
        productSelectionTbody.innerHTML = '';
        products.forEach(p => {
            productSelectionTbody.insertAdjacentHTML('beforeend', `<tr><td><div class="form-check"><input class="form-check-input movement-product-check" type="checkbox" value="${p.name}" style="pointer-events:none;"></div></td><td>${p.name}</td></tr>`);
        });
        productSearchInput.value = '';
        productSearchInput.dispatchEvent(new Event('input'));
    }

    productSelectionTbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr');
        if (!row) return;
        const checkbox = row.querySelector('.form-check-input');
        if (checkbox) checkbox.checked = !checkbox.checked;
    });

    productSearchInput.addEventListener('input', () => {
        const s = productSearchInput.value.toLowerCase().trim();
        productSelectionTbody.querySelectorAll('tr').forEach(r => {
            r.style.display = r.cells[1].textContent.toLowerCase().includes(s) ? '' : 'none';
        });
    });

    addMovementRowBtn.addEventListener('click', () => {
        populateProductModal();
        productModal.show();
    });

    addSelectedProductsBtn.addEventListener('click', () => {
        productSelectionTbody.querySelectorAll('.movement-product-check:checked').forEach(c => createMovementRow(c.value));
        productModal.hide();
    });

    // -----------------------------------------------------------------
    // حفظ الحركة (سحب/مرتجع) إلى festivalMovement — مرتبطة بالمستخدم الحالي
    // -----------------------------------------------------------------
    saveMovementBtn.addEventListener('click', async () => {
        const rows = Array.from(movementTableBody.querySelectorAll('tr'));
        if (!rows.length) { showToast('يرجى إضافة مادة واحدة على الأقل.', true); return; }

        const items = [];
        for (const row of rows) {
            const item = row.querySelector('.movement-product').value.trim();
            const quantity = Number(row.querySelector('.movement-quantity').value);
            const operation = row.querySelector('.movement-operation').value;
            const invoiceNumber = row.querySelector('.movement-invoice').value.trim();
            if (!item) { showToast('اسم المادة مطلوب.', true); return; }
            if (!Number.isFinite(quantity) || quantity <= 0) { showToast(`الكمية غير صحيحة للمادة: ${item}`, true); return; }
            items.push({ item, quantity, operation, invoiceNumber });
        }

        saveMovementBtn.disabled = true;
        saveMovementBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري الحفظ...';
        try {
            const payload = { items, createdById: String(currentUser.id || ''), createdByName: String(currentUser.name || '') };
            if (!navigator.onLine) { await queueMovementOffline(payload); showToast('تم حفظ الحركة محلياً وستتم مزامنتها عند عودة الإنترنت.'); movementTableBody.innerHTML=''; updateOfflineStatus(); return; }
            const res = await fetch(SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify({action:'addFestivalMovement',payload}) });
            const result = await res.json();
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل حفظ الحركة');
            showToast('تم حفظ الحركة بنجاح.');
            movementTableBody.innerHTML = '';
            memoryReportsCache = null; localStorage.removeItem('reportsCache'); window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
            await refreshMovementsAndSummary();
        } catch (e) {
            if (!navigator.onLine || /failed to fetch|network|load failed/i.test(String(e.message||''))) {
                try { await queueMovementOffline({items,createdById:String(currentUser.id||''),createdByName:String(currentUser.name||'')}); movementTableBody.innerHTML=''; showToast('تعذر الاتصال — تم حفظ الحركة محلياً للمزامنة تلقائياً.'); updateOfflineStatus(); } catch(qe) { showToast(qe.message||'تعذر الحفظ المحلي',true); }
            } else showToast(e.message || 'حدث خطأ أثناء حفظ الحركة', true);
        } finally {
            saveMovementBtn.disabled = false;
            saveMovementBtn.innerHTML = '<i class="fa-solid fa-floppy-disk me-1"></i> حفظ الحركة';
        }
    });

    // -----------------------------------------------------------------
    // جلب سجل حركات المستخدم وبناء محصلته (سحب - مرتجع - صرف - مبيعات لكل مادة)
    // -----------------------------------------------------------------
    function operationBadge(operation) {
        if (operation === 'سحب') return '<span class="badge bg-danger">سحب</span>';
        if (operation === 'مرتجع') return '<span class="badge bg-success">مرتجع</span>';
        if (operation === 'صرف') return '<span class="badge bg-warning text-dark">صرف (تلقائي)</span>';
        if (operation === 'مبيعات') return '<span class="badge bg-primary">مبيعات</span>';
        return `<span class="badge bg-secondary">${operation}</span>`;
    }

    async function refreshMovementsAndSummary(targetId) {
        const scopedUserId = String(targetId || viewingTargetId || currentUser.id || '');
        movementHistoryBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin me-1"></i> جاري التحميل...</td></tr>`;
        inventorySummaryBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin me-1"></i> جاري التحميل...</td></tr>`;
        try {
            const params = new URLSearchParams({
                action: 'getUserFestivalMovements',
                userId: String(currentUser.id || ''),
                role: String(currentUser.role || ''),
                targetUserId: scopedUserId,
                _: String(Date.now())
            });
            const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
            const result = await res.json();
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر تحميل الحركات');
            const movements = Array.isArray(result.movements) ? result.movements : [];

            if (!movements.length) {
                movementHistoryBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">لا توجد حركات مسجلة بعد</td></tr>`;
                inventorySummaryBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">لا توجد بيانات بعد</td></tr>`;
                return;
            }

            movementHistoryBody.innerHTML = movements.map(m =>
                `<tr><td>${m.item}</td><td>${m.quantity}</td><td>${m.invoiceNumber ? m.invoiceNumber : '-'}</td><td>${operationBadge(m.operation)}</td><td>${m.date}</td><td>${m.reportId ? m.reportId : '-'}</td><td>${m.createdByName || '-'}</td></tr>`
            ).join('');

            const summaryMap = new Map();
            movements.forEach(m => {
                if (!summaryMap.has(m.item)) summaryMap.set(m.item, { item: m.item, withdrawn: 0, returned: 0, expensed: 0, sold: 0 });
                const entry = summaryMap.get(m.item);
                const qty = Number(m.quantity) || 0;
                if (m.operation === 'سحب') entry.withdrawn += qty;
                else if (m.operation === 'مرتجع') entry.returned += qty;
                else if (m.operation === 'صرف') entry.expensed += qty;
                else if (m.operation === 'مبيعات') entry.sold += qty;
            });

            const summary = Array.from(summaryMap.values()).map(e => ({ ...e, remaining: e.withdrawn - e.returned - e.expensed - e.sold }));
            inventorySummaryBody.innerHTML = summary.map(e =>
                `<tr><td>${e.item}</td><td>${e.withdrawn}</td><td>${e.returned}</td><td>${e.expensed}</td><td>${e.sold}</td><td class="fw-bold ${e.remaining < 0 ? 'text-danger' : ''}">${e.remaining}</td></tr>`
            ).join('');
        } catch (e) {
            movementHistoryBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">تعذر تحميل السجل: ${e.message || ''}</td></tr>`;
            inventorySummaryBody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">تعذر تحميل المحصلة</td></tr>`;
        }
    }

    // -----------------------------------------------------------------
    // إرسال صافي المحصلة إلى المبيعات — يختار المستخدم التقرير أولاً.
    // تُحفظ المبيعات في sales وfestivalMovement مع reportId المختار.
    // -----------------------------------------------------------------
    const closeOutTallyBtn = document.getElementById('closeOutTallyBtn');
    const salesReportModalEl = document.getElementById('salesReportSelectionModal');
    const salesReportModal = salesReportModalEl ? new bootstrap.Modal(salesReportModalEl) : null;
    const salesReportTbody = document.querySelector('#salesReportSelectionTable tbody');
    const salesReportSearchInput = document.getElementById('salesReportSearchInput');
    const salesReportStatus = document.getElementById('salesReportSelectionStatus');
    const confirmSalesReportBtn = document.getElementById('confirmSalesReportBtn');
    let salesReportCandidates = [];

    const escapeHtmlSafe = (value) => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

    function renderSalesReportCandidates() {
        if (!salesReportTbody) return;
        const q = String(salesReportSearchInput?.value || '').trim().toLowerCase();
        const filtered = salesReportCandidates.filter(r => {
            if (!q) return true;
            const text = [r.id,r.campaign,r.market,r.date,r.event,r.createdAt].map(v => String(v || '').toLowerCase()).join(' ');
            return text.includes(q);
        });
        salesReportTbody.innerHTML = filtered.length ? filtered.map((r, i) => `
            <tr>
                <td><input class="form-check-input sales-report-radio" type="radio" name="salesReportChoice" value="${escapeHtmlSafe(r.id)}"></td>
                <td>${escapeHtmlSafe(r.id)}</td>
                <td>${escapeHtmlSafe(r.campaign || '-')}</td>
                <td>${escapeHtmlSafe(r.market || '-')}</td>
                <td>${escapeHtmlSafe(r.date || '-')}</td>
                <td>${escapeHtmlSafe(r.event || '-')}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="text-center text-muted">لا توجد تقارير مطابقة</td></tr>';
        if (salesReportStatus) salesReportStatus.textContent = `عدد التقارير المتاحة: ${filtered.length}`;
    }

    async function loadReportsForSalesSelection() {
        if (!salesReportModal) throw new Error('نافذة اختيار التقرير غير متاحة');
        if (salesReportStatus) salesReportStatus.textContent = 'جاري تحميل تقاريرك...';
        if (salesReportTbody) salesReportTbody.innerHTML = '<tr><td colspan="6" class="text-center"><i class="fa-solid fa-spinner fa-spin me-1"></i> جاري التحميل...</td></tr>';
        const params = new URLSearchParams({
            action: 'getReports',
            userId: String(currentUser.id || ''),
            role: String(currentUser.role || ''),
            userName: String(currentUser.name || ''),
            _: String(Date.now())
        });
        const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        if (!Array.isArray(result)) throw new Error(result?.message || 'تعذر تحميل التقارير');
        salesReportCandidates = result.slice().sort((a,b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
        renderSalesReportCandidates();
    }

    closeOutTallyBtn.addEventListener('click', async () => {
        try {
            await loadReportsForSalesSelection();
            salesReportSearchInput.value = '';
            renderSalesReportCandidates();
            salesReportModal.show();
        } catch (e) {
            showToast(e.message || 'تعذر تحميل التقارير لاختيار التقرير', true);
        }
    });

    salesReportSearchInput?.addEventListener('input', renderSalesReportCandidates);

    confirmSalesReportBtn?.addEventListener('click', async () => {
        const selected = document.querySelector('.sales-report-radio:checked');
        if (!selected) {
            showToast('يرجى اختيار التقرير الذي ستضاف إليه المبيعات', true);
            return;
        }
        const selectedReportId = String(selected.value || '').trim();
        if (!selectedReportId) return;
        if (!confirm('سيتم إرسال صافي محصلتك الحالي إلى التقرير المحدد وتسجيله في sales وfestivalMovement. متابعة؟')) return;

        confirmSalesReportBtn.disabled = true;
        const oldText = confirmSalesReportBtn.innerHTML;
        confirmSalesReportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري الإرسال...';
        try {
            const res = await fetch(SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                    action: 'closeOutUserTallyToSales',
                    payload: {
                        createdById: String(currentUser.id || ''),
                        createdByName: String(currentUser.name || ''),
                        reportId: selectedReportId
                    }
                })
            });
            const result = await res.json();
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل إرسال صافي المحصلة');
            salesReportModal.hide();
            if (!result.added) showToast(result.message || 'لا توجد كميات متبقية لإرسالها.', true);
            else showToast(`تم إرسال ${result.added} مادة إلى التقرير ${selectedReportId} وتسجيلها في المبيعات وحركة المهرجان.`);
            memoryReportsCache = null; localStorage.removeItem('reportsCache'); window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
            await refreshMovementsAndSummary();
        } catch (e) {
            showToast(e.message || 'حدث خطأ أثناء إرسال صافي المحصلة', true);
        } finally {
            confirmSalesReportBtn.disabled = false;
            confirmSalesReportBtn.innerHTML = oldText;
        }
    });

    // -----------------------------------------------------------------
    // القائمة المنسدلة لاختيار موظف معيّن — admin يرى الجميع، manager يرى فريقه فقط.
    // -----------------------------------------------------------------
    if (employeeFilterWrap && employeeFilterSelect) {
        const options = await fetchTeamOptions(currentUser);
        if (options.length) {
            employeeFilterSelect.innerHTML = `<option value="${currentUser.id}">أنا (${currentUser.name || ''})</option>` +
                options.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
            employeeFilterWrap.classList.remove('d-none');
            employeeFilterSelect.addEventListener('change', async () => {
                viewingTargetId = employeeFilterSelect.value || String(currentUser.id || '');
                const selectedOption = employeeFilterSelect.options[employeeFilterSelect.selectedIndex];
                viewingTargetName = isViewingSelf() ? currentUser.name : (selectedOption ? selectedOption.textContent : '');
                updateMovementScopeUI();
                await refreshMovementsAndSummary(viewingTargetId);
            });
        }
    }

    // -----------------------------------------------------------------
    // التهيئة الأولية — تظهر الحركة والمحصلة دائماً فور دخول المستخدم للصفحة
    // -----------------------------------------------------------------
    try {
        DB = await getDbData();
    } catch (e) {
        DB = { products: {} };
    }

    await refreshMovementsAndSummary(viewingTargetId);
}

const ATTENDANCE_SICK_LEAVE_STATUS = 'اجازة مرضية';
const ATTENDANCE_MEDICAL_FILE_MAX_BYTES = 5 * 1024 * 1024;

function fileToBase64_(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(new Error('تعذرت قراءة ملف التقرير الطبي'));
        reader.readAsDataURL(file);
    });
}

async function handleAttendancePage() {
    const user = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    const form=document.getElementById('attendanceForm'), body=document.getElementById('attendance-table-body');
    const role=String(user.role||'').toLowerCase(), statusFilter=document.getElementById('attendanceFilterStatus');
    const employeeFilter=document.getElementById('attendanceEmployeeFilter'), message=document.getElementById('attendanceStatusMessage');
    const statusSelect=document.getElementById('attendanceStatus'), medicalWrap=document.getElementById('medicalReportWrap'), medicalFile=document.getElementById('medicalReportFile');
    let rows=[];
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
    const render=()=>{const filtered=rows.filter(r=>!statusFilter.value||r.status===statusFilter.value);document.getElementById('attendanceCount').textContent=`${filtered.length} سجل`;body.innerHTML=filtered.length?filtered.map(r=>`<tr><td dir="ltr">${esc(r.timestamp)}</td><td>${esc(r.username)}</td><td><span class="badge ${r.status==='بداية دوام'?'bg-success':'bg-secondary'}">${esc(r.status)}</span></td><td>${esc(r.attendanceStatement)}</td><td>${esc(r.notes)||'-'}</td><td>${r.medicalReportUrl?`<a href="${esc(r.medicalReportUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-primary"><i class="fa-solid fa-file-medical me-1"></i>عرض</a>`:'-'}</td></tr>`).join(''):'<tr><td colspan="6" class="text-center text-muted py-4">لا توجد سجلات مطابقة</td></tr>';};

    // ---- Smart cache-first loading (instant render from localStorage, refresh
    // in the background, and keep showing the cached list if offline/failed). ----
    const attendanceCacheKey=()=>`attendanceCache::${employeeFilter?.value||'all'}`;
    const readAttendanceCache=()=>{try{const raw=localStorage.getItem(attendanceCacheKey());if(!raw)return null;const parsed=JSON.parse(raw);return Array.isArray(parsed)?parsed:null;}catch(e){return null;}};
    const writeAttendanceCache=(data)=>{try{localStorage.setItem(attendanceCacheKey(),JSON.stringify(data));}catch(e){/* تجاهل امتلاء التخزين المحلي */}};
    const load=async()=>{
        const cached=readAttendanceCache();
        if(cached){rows=cached;render();} else {body.innerHTML='<tr><td colspan="6" class="text-center py-4">جار التحميل...</td></tr>';}
        try{
            const q=new URLSearchParams({action:'getAttendance',userId:String(user.id||''),role:String(user.role||''),userName:String(user.username||user.name||''),targetUserId:employeeFilter?.value||''});
            const r=await(await fetch(`${SCRIPT_URL}?${q}`,{cache:'no-store'})).json();
            if(!Array.isArray(r))throw Error(r.message||'تعذر تحميل السجل');
            rows=r;render();writeAttendanceCache(rows);
        }catch(e){
            if(!cached) body.innerHTML=`<tr><td colspan="6" class="text-center text-danger">${esc(e.message)}</td></tr>`;
            // إذا فيه كاش، منخليه ظاهر كما هو (أوفلاين) بدل ما نستبدله برسالة خطأ.
        }
    };
    window.addEventListener('attendanceCacheInvalidated', load);

    // Status options are pulled live from the "statusWT" sheet (auto-created
    // with defaults on first run by the backend) so the dropdown (form) and
    // the history filter always match what's configured there. Cached locally
    // too, so the dropdown appears instantly and still works offline.
    const STATUS_CACHE_KEY='attendanceStatusCache';
    const readStatusCache=()=>{try{const raw=localStorage.getItem(STATUS_CACHE_KEY);const parsed=raw?JSON.parse(raw):null;return Array.isArray(parsed)&&parsed.length?parsed:null;}catch(e){return null;}};
    const writeStatusCache=(options)=>{try{localStorage.setItem(STATUS_CACHE_KEY,JSON.stringify(options));}catch(e){}};
    const applyStatusOptions=(options)=>{
        const currentValue=statusSelect.value;
        statusSelect.innerHTML=options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('');
        if(options.includes(currentValue)) statusSelect.value=currentValue;
        const currentFilter=statusFilter.value;
        statusFilter.innerHTML='<option value="">كل الحالات</option>'+options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('');
        if(options.includes(currentFilter)) statusFilter.value=currentFilter;
        toggleMedicalReportField();
    };
    const loadStatusOptions=async()=>{
        const cached=readStatusCache();
        if(cached) applyStatusOptions(cached);
        try{
            const r=await(await fetch(`${SCRIPT_URL}?${new URLSearchParams({action:'getStatusOptions'})}`,{cache:'no-store'})).json();
            if(r&&r.status==='success'&&Array.isArray(r.options)&&r.options.length){applyStatusOptions(r.options);writeStatusCache(r.options);return;}
        }catch(e){console.warn('تعذر تحميل حالات الدوام من statusWT (سيتم استخدام القيم المخزنة/الافتراضية)',e);}
        if(!cached) applyStatusOptions(['بداية دوام','نهاية دوام','عطلة أسبوعية','عطلة رسمية','اجازة إدارية','اجازة مرضية','حضور إضافي']);
    };
    const toggleMedicalReportField=()=>{
        const isSick=statusSelect.value===ATTENDANCE_SICK_LEAVE_STATUS;
        medicalWrap.classList.toggle('d-none',!isSick);
        medicalFile.required=isSick;
        if(!isSick) medicalFile.value='';
    };

    if(role==='admin'||role==='manager'){try{const options=await fetchTeamOptions(user);employeeFilter.innerHTML='<option value="">كل الموظفين المسموح بهم</option>'+options.map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');document.getElementById('attendanceEmployeeFilterWrap').classList.remove('d-none');}catch(e){console.warn(e);}}
    statusFilter.addEventListener('change',render);employeeFilter?.addEventListener('change',load);
    statusSelect.addEventListener('change',toggleMedicalReportField);
    await loadStatusOptions();

    form.addEventListener('submit',async e=>{
        e.preventDefault();
        const b=form.querySelector('button[type=submit]');
        b.disabled=true;
        try{
            const status=statusSelect.value;
            const payload={username:user.username||user.name,status,attendanceStatement:document.getElementById('attendanceStatement').value.trim(),notes:document.getElementById('attendanceNotes').value.trim()};
            if(status===ATTENDANCE_SICK_LEAVE_STATUS){
                const file=medicalFile.files && medicalFile.files[0];
                if(!file) throw new Error('يجب إرفاق التقرير الطبي (PDF أو صورة) عند اختيار حالة اجازة مرضية');
                if(file.size>ATTENDANCE_MEDICAL_FILE_MAX_BYTES) throw new Error('حجم ملف التقرير الطبي يتجاوز 5 ميجابايت');
                payload.medicalReportBase64=await fileToBase64_(file);
                payload.medicalReportFileName=file.name;
                payload.medicalReportMimeType=file.type||'application/octet-stream';
            }

            const saveOnlineOrQueue=async()=>{
                if(!navigator.onLine){await queueAttendanceOffline(payload);return{queued:true};}
                try{
                    const r=await(await fetch(SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'submitAttendance',payload})})).json();
                    if(r.status!=='success')throw Error(r.message||'فشل الحفظ');
                    return r;
                }catch(err){
                    const networkFailure=!navigator.onLine||err instanceof TypeError||/failed to fetch|network|load failed/i.test(String(err.message||''));
                    if(networkFailure){await queueAttendanceOffline(payload);return{queued:true};}
                    throw err;
                }
            };

            const result=await saveOnlineOrQueue();
            form.reset();
            toggleMedicalReportField();
            if(result.queued){
                updateOfflineStatus();
                message.className='alert alert-warning mt-3';
                message.textContent='تم حفظ السجل محلياً وسيتم إرساله تلقائياً عند عودة الإنترنت.';
            }else{
                message.className='alert alert-success mt-3';
                message.textContent='تم تسجيل الدوام بنجاح.';
                localStorage.removeItem(attendanceCacheKey());
                await load();
            }
        }catch(err){
            message.className='alert alert-danger mt-3';
            message.textContent=err.message;
        }finally{
            b.disabled=false;
            b.innerHTML='<i class="fa-solid fa-check me-1"></i> تسجيل الدوام';
        }
    });
    await load();
}
