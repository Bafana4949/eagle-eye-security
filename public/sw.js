/*
 * Eagle Eye service worker.
 *
 * Registered by src/components/shared/PwaRegistrar.tsx as /sw.js?v=<build version>. Every cache name
 * carries that version, so each build starts with fresh caches and the previous build's caches are
 * deleted when this worker activates.
 *
 * Strategies
 *   - Page navigations: network first. When the network has not answered within 4 s and a saved copy of
 *     the page exists, the saved copy is shown (the network answer still refreshes the cache). When the
 *     network fails: saved copy of that page -> saved guard home (/guard) for /guard/** -> /offline.html.
 *     Only the guard app routes and /login are ever saved; they are static app shells with no personal
 *     data (all data is loaded in the browser from Supabase / IndexedDB after sign-in).
 *   - /_next/static/**: cache first (file names are content-hashed and immutable).
 *   - Icons, manifest, logo, fonts, /_next/image: stale-while-revalidate.
 *   - Never cached: other origins (Supabase REST/Auth/Storage/Realtime), /api/**, /auth/**, anything
 *     with "callback" in the path, non-GET requests, range requests and React Server Component
 *     (RSC) requests.
 *
 * Updates: the new worker installs in the background and then WAITS. It only takes over after the page
 * posts {type: 'SKIP_WAITING'} (the guard tapped "Reload" in the update banner), so a guard is never
 * switched to a new build in the middle of a form.
 */
'use strict';

const VERSION = (() => {
  try {
    const v = new URL(self.location.href).searchParams.get('v') || '';
    return /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : 'unversioned';
  } catch (_err) {
    return 'unversioned';
  }
})();

const CACHE_PREFIX = 'ee-';
const PAGES_CACHE = `${CACHE_PREFIX}pages-${VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${VERSION}`;
const ASSETS_CACHE = `${CACHE_PREFIX}assets-${VERSION}`;
const CURRENT_CACHES = [PAGES_CACHE, STATIC_CACHE, ASSETS_CACHE];
// Cache names used by earlier Eagle Eye service workers (removed on activate).
const LEGACY_CACHES = ['eagle-eye-cache-v1', 'eagle-eye-v1'];

const OFFLINE_URL = '/offline.html';
const GUARD_SHELL = '/guard';
/** Pages that are saved for offline use. Everything else is network only. */
const APP_ROUTES = ['/login', '/guard', '/guard/patrol', '/guard/gate', '/guard/incident', '/guard/history', '/guard/more'];
const APP_ROUTE_SET = new Set(APP_ROUTES);
const PRECACHE_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/Eagle_Eye_Logo.jpg',
  '/eagle_eye_enhanced_emblem.jpg',
];
const PRECACHE_ASSET_SET = new Set(PRECACHE_ASSETS);

const NAVIGATION_TIMEOUT_MS = 4000;
const WARM_DELAY_MS = 5000;
const WARM_INTERVAL_MS = 10 * 60 * 1000;
const MAX_STATIC_URLS_PER_PAGE = 250;
const PRECACHE_CONCURRENCY = 4;
const ASSETS_CACHE_MAX_ENTRIES = 60;

const RUNTIME_ASSET_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/i;

let lastWarmStartedAt = 0;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '') || '/';
  return pathname;
}

function pageKey(pathname) {
  return new URL(normalizePath(pathname), self.location.origin).href;
}

function isGuardPath(path) {
  return path === GUARD_SHELL || path.startsWith(`${GUARD_SHELL}/`);
}

/** Paths that must always go straight to the network and never touch Cache Storage. */
function isNeverCachedPath(url) {
  const p = url.pathname;
  return (
    p === '/sw.js' ||
    p.startsWith('/api/') ||
    p === '/api' ||
    p.startsWith('/auth/') ||
    p === '/auth' ||
    /callback/i.test(p)
  );
}

function isRscRequest(request, url) {
  return (
    request.headers.get('RSC') === '1' ||
    request.headers.has('Next-Router-State-Tree') ||
    request.headers.has('Next-Router-Prefetch') ||
    url.searchParams.has('_rsc')
  );
}

function isRuntimeAsset(url) {
  if (url.pathname.startsWith('/_next/image')) return true;
  if (url.pathname.startsWith('/_next/')) return false;
  return url.pathname === '/manifest.json' || RUNTIME_ASSET_PATTERN.test(url.pathname);
}

/** A same-origin, successful, non-redirected HTML document: the only kind of page we save. */
function isSavablePage(response) {
  if (!response || response.status !== 200 || response.type !== 'basic' || response.redirected) return false;
  const type = response.headers.get('Content-Type') || '';
  return type.includes('text/html');
}

function isSavableAsset(response) {
  return Boolean(response) && response.ok && response.status === 200 && response.type === 'basic' && !response.redirected;
}

/** Resolves with the promise's value, or with undefined after `ms` (never rejects because of the timer). */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds /_next/static URLs referenced by an HTML document, including the escaped strings inside the
 * inline React Server Component payload ("\"/_next/static/chunks/x.js\"") and chunk paths written
 * without the /_next prefix ("static/chunks/x.js").
 */
function extractStaticUrls(text) {
  const found = new Set();
  const re = /(?:\/_next\/)?static\/(?:chunks|css|media|[A-Za-z0-9_-]{6,})\/[^"'`\\\s<>()]+/g;
  let match;
  while ((match = re.exec(text)) !== null && found.size < MAX_STATIC_URLS_PER_PAGE) {
    let ref = match[0].replace(/&amp;/g, '&').replace(/[.,;:]+$/, '');
    if (!ref.startsWith('/_next/')) ref = `/_next/${ref}`;
    try {
      const url = new URL(ref, self.location.origin);
      if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) found.add(url.href);
    } catch (_err) {
      // ignore malformed references
    }
  }
  return Array.from(found);
}

/** Finds url(...) references (fonts, images) inside a CSS file that live under /_next/static. */
function extractCssUrls(cssText, cssHref) {
  const found = new Set();
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let match;
  while ((match = re.exec(cssText)) !== null && found.size < MAX_STATIC_URLS_PER_PAGE) {
    const ref = match[2].trim();
    if (!ref || ref.startsWith('data:')) continue;
    try {
      const url = new URL(ref, cssHref);
      if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) found.add(url.href);
    } catch (_err) {
      // ignore malformed references
    }
  }
  return Array.from(found);
}

async function runLimited(items, limit, worker) {
  const queue = items.slice();
  const runners = [];
  for (let i = 0; i < Math.min(limit, queue.length); i++) {
    runners.push(
      (async () => {
        while (queue.length) {
          const item = queue.shift();
          try {
            await worker(item);
          } catch (_err) {
            // One missing file must not stop the others.
          }
        }
      })()
    );
  }
  await Promise.all(runners);
}

/**
 * Saves /_next/static files in this version's static cache. Files that an older build already
 * downloaded (same hashed name) are copied from that cache instead of downloaded again.
 */
async function precacheStaticUrls(urls) {
  if (!urls.length) return;
  const cache = await caches.open(STATIC_CACHE);
  const cssFollowUps = [];
  await runLimited(urls, PRECACHE_CONCURRENCY, async (href) => {
    if (await cache.match(href)) return;
    let response = await caches.match(href);
    if (!response) {
      response = await fetch(href, { credentials: 'same-origin' });
      if (!isSavableAsset(response)) return;
    }
    const isCss = new URL(href).pathname.endsWith('.css');
    if (isCss) {
      const text = await response.clone().text();
      cssFollowUps.push(...extractCssUrls(text, href));
    }
    await cache.put(href, response);
  });
  const followUps = cssFollowUps.filter((u) => !urls.includes(u));
  if (followUps.length) {
    await runLimited(followUps, PRECACHE_CONCURRENCY, async (href) => {
      if (await cache.match(href)) return;
      const existing = await caches.match(href);
      const response = existing || (await fetch(href, { credentials: 'same-origin' }));
      if (isSavableAsset(response)) await cache.put(href, response);
    });
  }
}

/** Downloads one app route and the static files its HTML references. Returns true when saved. */
async function precacheRoute(path) {
  const response = await fetch(new Request(path, { credentials: 'same-origin', cache: 'no-cache', redirect: 'follow' }));
  // A redirect (for example to /login because the session expired) is never saved as the page.
  if (!isSavablePage(response)) return false;
  const html = await response.clone().text();
  const pages = await caches.open(PAGES_CACHE);
  await pages.put(pageKey(path), response);
  await precacheStaticUrls(extractStaticUrls(html));
  return true;
}

async function precacheRoutes(paths) {
  const results = [];
  // Sequential on purpose: slow rural links cope better with one page at a time.
  for (const path of paths) {
    try {
      results.push([path, await precacheRoute(path)]);
    } catch (_err) {
      results.push([path, false]);
    }
  }
  return results;
}

async function precacheAsset(path) {
  const cache = await caches.open(ASSETS_CACHE);
  const response = await fetch(new Request(path, { credentials: 'same-origin', cache: 'no-cache' }));
  if (isSavableAsset(response)) await cache.put(path, response);
}

/** Removes the oldest runtime entries beyond maxEntries; the precached icons, manifest and logo stay. */
async function trimCache(name, maxEntries) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const removable = keys.filter((req) => !PRECACHE_ASSET_SET.has(new URL(req.url).pathname));
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess && i < removable.length; i++) await cache.delete(removable[i]);
}

/**
 * After a successful online visit to the guard app, save the guard routes that are not saved yet
 * (for example when the worker was installed on the login page, before the guard was signed in).
 */
async function warmGuardRoutes() {
  const now = Date.now();
  if (now - lastWarmStartedAt < WARM_INTERVAL_MS) return;
  lastWarmStartedAt = now;
  // Let the page that was just opened download its own files first.
  await delay(WARM_DELAY_MS);
  const pages = await caches.open(PAGES_CACHE);
  const missing = [];
  for (const path of APP_ROUTES) {
    if (!(await pages.match(pageKey(path)))) missing.push(path);
  }
  if (missing.length) await precacheRoutes(missing);
}

async function offlineFallback(path) {
  const pages = await caches.open(PAGES_CACHE);
  if (APP_ROUTE_SET.has(path)) {
    const own = await pages.match(pageKey(path));
    if (own) return own;
  }
  if (isGuardPath(path)) {
    const shell = await pages.match(pageKey(GUARD_SHELL));
    if (shell) return shell;
  }
  const offline = await pages.match(pageKey(OFFLINE_URL));
  if (offline) return offline;
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Eagle Eye</title><body style="background:#18212B;color:#E9E4D8;font-family:system-ui,sans-serif;padding:24px">' +
      '<p>Offline / Geen verbinding nie / Akukho ukuxhumana</p>' +
      '<button onclick="location.reload()" style="min-height:48px;padding:0 20px">Retry / Probeer weer / Zama futhi</button></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

async function fetchNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
  } catch (_err) {
    // Navigation preload failed; fall through to a normal fetch.
  }
  return fetch(event.request);
}

// ---------------------------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------------------------

async function handleNavigation(event, url) {
  const path = normalizePath(url.pathname);
  const savable = APP_ROUTE_SET.has(path);

  const network = fetchNavigation(event);

  // Refresh the saved copy whenever the network answers with a proper page (runs in the background).
  event.waitUntil(
    network
      .then(async (response) => {
        if (savable && isSavablePage(response)) {
          const copy = response.clone();
          const pages = await caches.open(PAGES_CACHE);
          await pages.put(pageKey(path), copy);
        }
        if (isGuardPath(path) && isSavablePage(response)) {
          // Signed in and online: make sure the other guard screens are saved too.
          await warmGuardRoutes();
        }
      })
      .catch(() => undefined)
  );

  const pages = await caches.open(PAGES_CACHE);
  const saved = savable ? await pages.match(pageKey(path)) : undefined;

  try {
    if (saved) {
      const response = await withTimeout(network, NAVIGATION_TIMEOUT_MS);
      if (response === undefined) return saved; // slow network: show the saved copy now
      if (response.status >= 500) return saved; // server trouble: the saved app still works
      return response;
    }
    // No saved copy of this page: wait for the network as long as it takes (a slow page is better
    // than the offline page), unless the request fails outright.
    const response = await network;
    if (response.status >= 500 && isGuardPath(path)) {
      const shell = await pages.match(pageKey(GUARD_SHELL));
      if (shell) return shell;
    }
    return response;
  } catch (_err) {
    return offlineFallback(path);
  }
}

async function cacheFirst(request) {
  // Match across all caches: a page saved by an older worker may reference files that the newer
  // (waiting) worker already downloaded, and vice versa.
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (isSavableAsset(response)) {
    const copy = response.clone();
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, copy);
  }
  return response;
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(ASSETS_CACHE);
  const cached = (await cache.match(request)) || (await caches.match(request));
  const refresh = fetch(request).then(async (response) => {
    if (isSavableAsset(response)) {
      await cache.put(request, response.clone());
      await trimCache(ASSETS_CACHE, ASSETS_CACHE_MAX_ENTRIES);
    }
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // The offline page is the minimum this worker needs. If it cannot be saved the install fails and
      // the browser tries again on the next update check.
      const offline = await fetch(new Request(OFFLINE_URL, { cache: 'no-cache' }));
      if (!offline.ok) throw new Error(`offline page unavailable (${offline.status})`);
      const pages = await caches.open(PAGES_CACHE);
      await pages.put(pageKey(OFFLINE_URL), offline);

      await Promise.allSettled(PRECACHE_ASSETS.map(precacheAsset));
      // Routes that need a session (the guard screens) are skipped here when nobody is signed in;
      // warmGuardRoutes() saves them after the first signed-in online visit.
      await precacheRoutes(APP_ROUTES);
      // No self.skipWaiting(): the page decides when to switch (see the message handler).
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => (key.startsWith(CACHE_PREFIX) || LEGACY_CACHES.includes(key)) && !CURRENT_CACHES.includes(key))
          .map((key) => caches.delete(key))
      );
      if (self.registration && self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (_err) {
          // Not supported: normal fetches are used.
        }
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: 'VERSION', version: VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_err) {
    return;
  }

  // Supabase (REST, Auth, Storage, Realtime) and every other origin: straight to the network.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    if (isNeverCachedPath(url)) {
      // Still answer it so a navigation preload request is used rather than wasted.
      event.respondWith(fetchNavigation(event));
      return;
    }
    event.respondWith(handleNavigation(event, url));
    return;
  }

  if (isNeverCachedPath(url) || request.headers.has('range') || isRscRequest(request, url)) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isRuntimeAsset(url)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
  // Everything else: default browser behaviour (network, no Cache Storage).
});
