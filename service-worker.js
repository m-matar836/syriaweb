// Service Worker — Smart cache / offline-first / fast navigation
// ===================================================================
// CACHE_NAME يحمل إصداراً عمداً: عند رفعه يحذف الـinstall الكاش القديم wholesale
// بدل أن نترك أول صفحة تُحمَّل تخدم نسخة قديمة من القشرة.
// v55: إصلاح دالة «تعديل» في السجل (page-history.js) وتحويل style.css إلى 100dvh.
// v71: تمديد الشبكة الأولى لكل أصول القشرة same-origin، وردّ (ack) على رسالة
//      CLEAR_APP_CACHE بعد انتهاء الحذف فعلياً بدل إرساله دون انتظار.
// v73: إزالة حجب الرسم عن سكربتات CDN (defer)، وجلب Chart.js عند فتح التحليلات فقط.
// v74: تسريع المصادقة وتحسين Mobile/Tablet responsive layout.
// v75: history pagination + browser API cache for report pages.
// v76: show per-user last-point restore and write reports to IndexedDB before sending.
const CACHE_NAME = 'festival-app-v76-offline-report-retention';
const APP_SHELL = [
  './index.html',
  './style.css','./core.js','./page-login.js','./page-reports.js','./page-expenses.js','./page-history.js','./page-dashboard.js','./page-movement.js','./page-attendance.js','./page-users.js','./page-salary.js','./manifest.json','./icons/icon.svg',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/js/bootstrap.bundle.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.1.1/css/all.min.css',
  'https://code.jquery.com/jquery-3.6.0.min.js',
  'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/css/select2.min.css',
  'https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/js/select2.min.js',
  'https://cdn.jsdelivr.net/npm/select2-bootstrap-5-theme@1.3.0/dist/select2-bootstrap-5-theme.rtl.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];
const CACHEABLE_API_ACTIONS = new Set([
  'getInitialData','getReports','getReportsPage','getReportById','findProductByBarcode','getCompetitorProducts',
  'getUserFestivalMovements','getTeamOptions','getAttendance','getStatusOptions',
  'getExpensesOptions','getExpensesByDate','getExpensesList'
]);

// V67: مفتاح الكاش يستبعد باراميترات الجلسة (token، _ ، _tt) حتى لا يُخزَّن الـ token
// في IndexedDB ولا تتكاثر نسخ الكاش لكل جلسة دخول.
function apiCacheKeyUrl(url) {
  const u = new URL(url);
  ['token','_','_tt'].forEach(p => u.searchParams.delete(p));
  return u.toString();
}

async function cacheNetworkResponse(cache, request) {
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (e) { return null; }
}

// `cache.add(url)` is a NORMAL fetch, so it can be answered from the HTTP cache
// and quietly re-precache the very file we just changed. That is how a CSS fix
// ships and the tablet keeps showing the old layout. `{cache:'reload'}` forces
// the network so a new CACHE_NAME actually delivers new bytes.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(APP_SHELL.map(url =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))))
      .then(()=>self.skipWaiting())
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

// V42: Background Sync — عندما يعاود الجهاز الاتصال بالإنترنت، يتم إبلاغ جميع
// الصفحات المفتوحة لتشغيل مزامنة قوائم الانتظار المحلية (تقارير/دوام/حركات).
// يبقى الـ setInterval في core.js كاحتياط للبيئات التي لا تدعم Background Sync.
self.addEventListener('sync', event => {
  if (event.tag === 'sync-pending') {
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => client.postMessage({ type: 'SYNC_PENDING' }));
    })());
  }
});
self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'CLEAR_APP_CACHE') return;
  // V71: The page cannot know when the deletion finished unless we say so.
  // refreshAppCache() awaits this reply before it issues any API request — a
  // fire-and-forget clear let those requests be answered from the very cache
  // being emptied, so «تحديث البيانات» reported success on stale data.
  const reply = (payload) => {
    const port = event.ports && event.ports[0];
    if (port && typeof port.postMessage === 'function') port.postMessage(payload);
  };
  event.waitUntil((async()=>{
    try {
      const cache = await caches.open(CACHE_NAME);
      const requests = await cache.keys();
      await Promise.all(requests.map(req => {
        const u = new URL(req.url);
        const isApi = u.hostname.includes('script.google.com') && u.pathname.includes('/macros/s/');
        return isApi ? cache.delete(req) : Promise.resolve(false);
      }));
      reply({ ok: true });
    } catch (error) {
      reply({ ok: false, error: String((error && error.message) || error) });
    }
  })());
});

// V49: الشبكة أولاً للسكربتات المحلية والتنقل (أي صياغة تُعدَّل تظهر فوراً ولو بعد أول
// تحديث)، أما أصول CDN الثابتة فتبقى cache-first لأنها محمية بـ SRI ولا تتغير.
// V71: التوسّع ليشمل كل أصول القشرة نفس-الأصل لا السكربتات فقط. `style.css` كان
// cache-first، فأي إصلاح في التنسيق (مثل 100dvh) لا يصل إلا بعد تحميل إضافي —
// وهذا بالضبط سبب وصول إصلاح دون أن يلمسه أحد. نفس-الأصل لا SRI ولا كاش
// طويل الأمد، فتكلفة الشبكة عليه أقل من كلفة إظهار واجهة قديمة.
const SW_ORIGIN = self.location.origin;
function isLocalShellUrl(url) {
  if (url.origin !== SW_ORIGIN) return false;
  return /\.(?:js|css|html|json|svg|webmanifest)$/i.test(url.pathname);
}
async function networkFirstHandler(event, request, cache) {
  const cached = await cache.match(request);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match('./index.html')) || new Response('', { status: 503 });
    return new Response('', { status: 503 });
  }
}
self.addEventListener('fetch', event => {
  const request=event.request;
  if(request.method!=='GET') return;
  const url=new URL(request.url);
  const isApi=url.hostname.includes('script.google.com') && url.pathname.includes('/macros/s/');
  if(isApi){
    const action=url.searchParams.get('action');
    if(!CACHEABLE_API_ACTIONS.has(action)) return;
    if(url.searchParams.has('_refresh') || url.searchParams.get('forceRefresh') === '1') {
      event.respondWith((async()=>{
        const fresh = await fetch(request);
        if(fresh && fresh.ok) { const cache=await caches.open(CACHE_NAME); await cache.put(new Request(apiCacheKeyUrl(request.url)), fresh.clone()); }
        return fresh;
      })());
      return;
    }
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE_NAME);
      const keyReq=new Request(apiCacheKeyUrl(request.url));
      const cached=await cache.match(keyReq);
      // API: stale-while-revalidate. The cache key strips session params, so a single
      // cached copy is shared across the whole session lifetime.
      const refresh=(async()=>{
        try {
          const fresh=await fetch(request);
          if(fresh && (fresh.ok || fresh.type==='opaque')) await cache.put(keyReq,fresh.clone());
          return fresh;
        } catch(e) { return null; }
      })();
      if(cached){
        event.waitUntil(refresh.catch(()=>{}));
        return cached;
      }
      await refresh;
      const stored=await cache.match(keyReq);
      if(stored) return stored;
      return new Response(JSON.stringify({status:'error',message:'لا يوجد اتصال بالإنترنت ولا توجد بيانات مخزنة'}),{status:503,headers:{'Content-Type':'application/json'}});
    })());
    return;
  }
  // Static resources: network-first for local scripts/navigations, cache-first for the rest.
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    if (isLocalShellUrl(url) || request.mode === 'navigate') {
      return await networkFirstHandler(event, request, cache);
    }
    const cached=await cache.match(request);
    const refresh=cacheNetworkResponse(cache,request);
    if(cached){ event.waitUntil(refresh.catch(()=>{})); return cached; }
    const fresh=await refresh;
    if(fresh) return fresh;
    if(request.mode==='navigate') return (await cache.match('./index.html')) || new Response('',{status:503});
    return new Response('',{status:503});
  })());
});
