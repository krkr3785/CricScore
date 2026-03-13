// ═══════════════════════════════════════════════════════════
//  CricScore Service Worker — Phase 1
//  Offline caching + background sync queue
// ═══════════════════════════════════════════════════════════

const CACHE_NAME    = 'cricscore-v18';
const APP_SHELL_URL = './index.html';

// External resources to pre-cache on install
const PRECACHE_URLS = [
  './index.html',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800;900&family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
];

// ── INSTALL ─────────────────────────────────────────────────
// Cache the app shell and static assets immediately
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // Cache app shell first (critical)
        return cache.add(APP_SHELL_URL)
          .then(() => {
            // Cache external resources — don't fail install if CDN is unreachable
            return Promise.allSettled(
              PRECACHE_URLS.slice(1).map(url =>
                fetch(url, { mode: 'cors' })
                  .then(res => { if (res.ok) cache.put(url, res); })
                  .catch(() => {}) // CDN unreachable — skip silently
              )
            );
          });
      })
      .then(() => self.skipWaiting()) // activate immediately
  );
});

// ── ACTIVATE ────────────────────────────────────────────────
// Remove old caches from previous versions
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim()) // take control of all open tabs
  );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── 1. Supabase API calls — NETWORK ONLY, never cache ──
  // Live match data must always be fresh
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(request).catch(() => {
        // Return a JSON error so the app can handle it gracefully
        return new Response(
          JSON.stringify({ error: 'offline', message: 'No network — save queued' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // ── 2. Google Fonts — cache forever (fonts don't change) ──
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => cached); // offline + not cached = silent fail (font loads from system)
        })
      )
    );
    return;
  }

  // ── 3. App HTML — Network First, Cache Fallback ──
  // Always try to get the latest version from the network first.
  // If offline or network takes too long, serve from cache.
  // This ensures users always get the latest deploy.
  if (url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          // Try network with 4s timeout
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const response = await fetch(request, { signal: controller.signal });
          clearTimeout(timeout);
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        } catch (e) {
          // Network failed or timed out — serve from cache
          const cached = await cache.match(request);
          if (cached) return cached;
          // Ultimate fallback
          return cache.match('./index.html');
        }
      })()
    );
    return;
  }

  // ── 4. CDN scripts (Supabase JS SDK etc) — Cache with refresh ──
  if (url.hostname.includes('jsdelivr.net') || url.hostname.includes('unpkg.com') || url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached; // CDN scripts are versioned — cache is always valid
          return fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => {
            // Return a dummy script to prevent fatal errors
            return new Response('/* offline — using cached version */', {
              headers: { 'Content-Type': 'application/javascript' }
            });
          });
        })
      )
    );
    return;
  }

  // ── 5. Everything else — Network with cache fallback ──
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok && request.method === 'GET') {
          caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(cached =>
          cached || caches.match(APP_SHELL_URL) // ultimate fallback: show the app
        )
      )
  );
});

// ── BACKGROUND SYNC ─────────────────────────────────────────
// When connectivity returns, drain the offline save queue
self.addEventListener('sync', event => {
  if (event.tag === 'cw-sync-saves') {
    event.waitUntil(drainSaveQueue());
  }
});

async function drainSaveQueue() {
  // Notify all app clients to attempt queued saves
  const clients = await self.clients.matchAll();
  clients.forEach(client =>
    client.postMessage({ type: 'DRAIN_SAVE_QUEUE' })
  );
}

// ── MESSAGE HANDLER ──────────────────────────────────────────
// Listen for messages from the app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
