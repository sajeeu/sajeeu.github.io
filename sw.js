/* EasyMenu service worker.
 *
 * Goals, in priority order:
 *  1. Never serve stale app code that could disagree with the server: the
 *     app shell and Dart entry points are fetched network-first, so an online
 *     customer always runs the latest deployment.
 *  2. Never cache API traffic (menus, prices, carts, orders, tokens). Ordering
 *     is always confirmed by the server; the API is on another origin and is
 *     passed straight through.
 *  3. Start fast on repeat visits and show a helpful page when offline.
 *
 * 20261119100719-e83d0d5 is replaced by tool/build_web.sh on every release build,
 * which rotates the static cache and removes the previous version's files.
 */
'use strict';

const VERSION = '20261119100719-e83d0d5';
const STATIC_CACHE = `easymenu-static-${VERSION}`;
const SHELL_CACHE = `easymenu-shell-${VERSION}`;
const SCOPE = self.registration.scope; // e.g. https://menu.example.com/

const url = (path) => new URL(path, SCOPE).toString();
const OFFLINE_URL = url('offline.html');
const SHELL_URL = url('index.html');

// Small, version-stamped files needed to show the offline page and icons.
const PRECACHE = [
  OFFLINE_URL,
  url('manifest.json'),
  url('icons/Icon-192.png'),
  url('favicon.png'),
];

// Fetched network-first (fall back to cache only when offline).
const NETWORK_FIRST = new Set([
  url(''),
  SHELL_URL,
  url('flutter_bootstrap.js'),
  url('flutter.js'),
  url('main.dart.js'),
  url('main.dart.wasm'),
  url('main.dart.mjs'),
  url('version.json'),
  url('manifest.json'),
]);

// Large engine/static files that only change with a new build version.
const CACHE_FIRST_PREFIXES = [url('canvaskit/'), url('assets/'), url('icons/')];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, SHELL_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('easymenu-') && !keep.has(name))
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  // Only handle this web app's own files. API calls, menu images, fonts and
  // anything else on another origin go straight to the network.
  if (requestUrl.origin !== self.location.origin) return;
  // Defensive: never cache an API that is mounted on the same origin.
  if (requestUrl.pathname.startsWith('/api/') || requestUrl.pathname === '/scan') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  const key = requestUrl.origin + requestUrl.pathname;
  if (NETWORK_FIRST.has(key)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }
  if (CACHE_FIRST_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
  }
});

// Every in-app route (/, /r/<slug>, /r/<slug>/t/<table>, /scan?…) is served
// by index.html. Online: always fresh. Offline: last known shell, then the
// offline page.
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (error) {
    const cache = await caches.open(SHELL_CACHE);
    const shell = await cache.match(SHELL_URL);
    if (shell) return shell;
    const offline = await caches.match(OFFLINE_URL);
    return offline || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
  }
  return response;
}
