// ===================================================================
// Service Worker V42 — Smart cache / offline-first / fast navigation
// ===================================================================
const CACHE_NAME = 'festival-app-v45-split-user-attendance-only';
const APP_SHELL = [
  './index.html','./reports.html','./history.html','./materialsMovement.html','./attendance.html','./dashboard.html',
  './style.css','./core.js','./page-login.js','./page-reports.js','./page-history.js','./page-dashboard.js','./page-movement.js','./page-attendance.js','./manifest.json',
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
  'getInitialData','getReports','getReportById','findProductByBarcode','getCompetitorProducts',
  'getUserFestivalMovements','getTeamOptions','getAttendance','getStatusOptions'
]);

async function cacheNetworkResponse(cache, request) {
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (e) { return null; }
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.all(APP_SHELL.map(url => cache.add(url).catch(()=>{}))))
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
  event.waitUntil((async()=>{
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    await Promise.all(requests.map(req => {
      const u = new URL(req.url);
      const isApi = u.hostname.includes('script.google.com') && u.pathname.includes('/macros/s/');
      return isApi ? cache.delete(req) : Promise.resolve(false);
    }));
  })());
});

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
        if(fresh && fresh.ok) { const cache=await caches.open(CACHE_NAME); await cache.put(request, fresh.clone()); }
        return fresh;
      })());
      return;
    }
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE_NAME);
      const cached=await cache.match(request);
      // API: stale-while-revalidate. The exact query string is the cache key,
      // so user/role/target filters remain separated.
      const refresh=cacheNetworkResponse(cache,request);
      if(cached){
        event.waitUntil(refresh.catch(()=>{}));
        return cached;
      }
      const fresh=await refresh;
      if(fresh) return fresh;
      return new Response(JSON.stringify({status:'error',message:'لا يوجد اتصال بالإنترنت ولا توجد بيانات مخزنة'}),{status:503,headers:{'Content-Type':'application/json'}});
    })());
    return;
  }
  // Static resources: cache-first with background refresh.
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const cached=await cache.match(request);
    const refresh=cacheNetworkResponse(cache,request);
    if(cached){ event.waitUntil(refresh.catch(()=>{})); return cached; }
    const fresh=await refresh;
    if(fresh) return fresh;
    if(request.mode==='navigate') return (await cache.match('./index.html')) || new Response('',{status:503});
    return new Response('',{status:503});
  })());
});
