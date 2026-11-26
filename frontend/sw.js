/* StoreGuard service worker: makes the app installable and lets it open with no connection.
 *
 * - App pages, scripts, styles and libraries are cached on install.
 * - Online: pages/scripts come from the network (always the latest), and the cache is refreshed.
 * - Offline (or server unreachable): everything is served from the cache.
 * - /api/ is never cached here — the POS keeps its own offline queue and product list.
 *
 * The server replaces __BUILD__ with a hash of the frontend files, so every update gets a fresh cache.
 */
'use strict';

const BUILD = '__BUILD__';
const CACHE = `storeguard-${BUILD}`;
const NETWORK_TIMEOUT_MS = 4000;

const PAGES = [
  '/home.html', '/app.html', '/offline.html', '/auth.html', '/index.html', '/pos.html', '/st.html',
  '/inventory.html', '/stock.html', '/suppliers.html', '/employees.html', '/shifts.html', '/cash.html',
  '/expenses.html', '/security.html', '/reports.html', '/customers.html', '/approvals.html', '/audit.html',
  '/devices.html', '/settings.html', '/cashierdash.html', '/cashiermyshift.html', '/cashiercashdrawer.html',
  '/cashierrefunds.html', '/profile.html', '/help.html', '/404.html',
];
const ASSETS = [
  '/manifest.webmanifest', '/support.json', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
  '/css/app.css', '/css/home.css', '/js/pwa.js', '/js/storeguard.js', '/js/shift-detail.js', '/js/home.js', '/js/launch.js',
  '/js/pages/approvals.js', '/js/pages/audit.js', '/js/pages/auth.js', '/js/pages/cash.js', '/js/pages/cashierdash.js',
  '/js/pages/customers.js', '/js/pages/devices.js', '/js/pages/drawer.js', '/js/pages/employees.js',
  '/js/pages/expenses.js', '/js/pages/help.js', '/js/pages/inventory.js', '/js/pages/myrefunds.js',
  '/js/pages/myshift.js', '/js/pages/overview.js', '/js/pages/pos.js', '/js/pages/profile.js',
  '/js/pages/reports.js', '/js/pages/sales.js', '/js/pages/security.js', '/js/pages/settings.js',
  '/js/pages/shifts.js', '/js/pages/stock.js', '/js/pages/suppliers.js',
  '/vendor/inter/inter.css', '/vendor/inter/inter-latin-wght-normal.woff2', '/vendor/inter/inter-latin-ext-wght-normal.woff2',
  '/vendor/bootstrap/bootstrap.min.css', '/vendor/bootstrap/bootstrap.bundle.min.js',
  '/vendor/bootstrap-icons/bootstrap-icons.min.css', '/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2',
  '/vendor/chartjs/chart.umd.min.js',
];
// Short URLs that are served by a page above.
const ALIASES = { '/': '/home.html', '/app': '/app.html' };

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' bypasses the HTTP cache so a new build never stores stale files.
    await cache.addAll([...PAGES, ...ASSETS].map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('storeguard-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'version' && event.source) event.source.postMessage({ type: 'version', build: BUILD });
});

function cacheKey(url) {
  return ALIASES[url.pathname] || url.pathname;
}

/** Network first (with a timeout so a flaky connection doesn't hang the till), cache as fallback. */
async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  const fromNetwork = fetch(request).then(response => {
    if (response.ok && response.type === 'basic') cache.put(key, response.clone());
    return response;
  });
  fromNetwork.catch(() => {}); // a late failure after the timeout is not an error
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
  try {
    const response = await Promise.race([fromNetwork, timeout]);
    if (response) return response;
  } catch (e) { /* offline — fall through to the cache */ }
  const cached = await cache.match(key);
  if (cached) return cached;
  // Not cached and the network was only slow: keep waiting for it.
  try { return await fromNetwork; } catch (e) { return null; }
}

/** Libraries under /vendor/ and icons never change for a given URL: serve from cache, fetch once if missing. */
async function cacheFirst(request, key) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') cache.put(key, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/download/') || url.pathname === '/healthz' || url.pathname === '/sw.js') return;

  const key = cacheKey(url);
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const response = await networkFirst(request, key);
      if (response) return response;
      const cache = await caches.open(CACHE);
      return (await cache.match('/offline.html')) || new Response('StoreGuard is offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    })());
    return;
  }
  if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request, key));
    return;
  }
  event.respondWith((async () => (await networkFirst(request, key)) || new Response('', { status: 504 }))());
});
