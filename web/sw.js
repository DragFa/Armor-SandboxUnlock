/*
 * Service worker: what makes the page installable, and what lets it open without a network.
 *
 * Two rules, because the files come in two kinds. Everything under assets/ carries a content hash in
 * its name, so a given URL never changes and the cache can be trusted outright. The page itself has
 * a fixed name and does change, so it is fetched first and only falls back to the cache when there
 * is no network — otherwise an install would pin whatever version happened to be current on the day.
 */
// v4: v3 could hold a "401 Unauthorized" in place of the page (see AUTH_RETRY), and this drops it.
// v5: v4 served a fixed-name file (logo-mark.png) from the cache forever, so the corrected logo of
// 08/10/2026 never reached an installed copy; this drops what v4 kept (see the fetch handler below).
const CACHE = 'armor-simulator-v5';

/*
 * The query a navigation carries when the browser has to answer it by itself, with no worker in the way.
 *
 * The web copies on Hostinger sit behind a folder password (HTTP Basic). Browsers forget that password
 * when they close, and the next visit is answered 401. A navigation the browser makes on its own then
 * asks for the password again; a fetch made from this worker never does. So the page showed a bare
 * "401 Unauthorized", the worker kept it that way (the browser cannot even fetch a new worker without
 * the password), and the only way out the owner found was clearing the site's data — which took his
 * library with it (02/10/2026).
 *
 * On a 401 the worker now hands back a page that reloads the same address with this query, and leaves
 * every navigation that carries it to the browser: the browser asks for the password, the page loads,
 * and the worker carries on as before. Nothing is unregistered and nothing in storage is touched.
 * `main.tsx` takes the query back off the address bar.
 */
const AUTH_RETRY = 'auth-retry';

/** The page that sends a refused navigation back through the browser, with AUTH_RETRY on it. */
function retryPage(url) {
  const target = new URL(url);
  target.searchParams.set(AUTH_RETRY, '1');
  // Same origin, a path only, so it can send nowhere else. A request URL carries no fragment and the
  // parser already escapes "<" in the path and the query; escaping it again keeps a "</script>" out of
  // the page whatever the address was.
  const href = JSON.stringify(target.pathname + target.search).replace(/</g, '\\u003c');
  return new Response(`<!doctype html><meta charset="utf-8"><title>Armor Sandbox</title><script>location.replace(${href})</script>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/*
 * Cross-origin isolation, added to every response this worker hands back.
 *
 * `SharedArrayBuffer` is what lets more than one thread work on the same simulation state, and the
 * browser only offers it to a page that is cross-origin isolated — which normally means the server
 * sending these two headers. GitHub Pages does not let anyone set a header, so the service worker
 * sends them instead: it sits between the page and the network, and a response it rewrites counts.
 *
 * `require-corp` is only safe because this app loads nothing from anywhere else — no font service, no
 * CDN, no analytics. Every byte comes from this origin. Adding such a dependency later would be
 * blocked by this, which is the trade: the isolation buys threads and costs the right to hotlink.
 *
 * The very first visit ever made cannot be isolated, because no worker is controlling the page yet
 * to rewrite anything. Every visit after that is served through this and arrives isolated, which is
 * why nothing forces a reload to close that one gap; see `main.tsx`.
 */
const ISOLATION = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
];

/**
 * The same response, with the isolation headers on it.
 *
 * Never throws. This runs inside `respondWith`, so a exception here would not merely lose the
 * headers — it would fail the request and leave the page blank. Threads are worth a lot less than
 * the app loading, so anything unexpected hands back the response untouched and the app runs on one
 * thread, exactly as it did before any of this.
 */
function isolate(response) {
  try {
    // An opaque response has no readable body and no headers to speak of; hand it back untouched.
    if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') return response;
    const headers = new Headers(response.headers);
    for (const [k, v] of ISOLATION) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/** Stores a copy without holding up the response. */
async function keep(request, response) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
  } catch {
    /* quota, or an opaque response: nothing to do about either */
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // A navigation sent back to the browser after a 401 (AUTH_RETRY): the browser answers it itself,
    // which is what lets it ask for the password.
    if (url.searchParams.has(AUTH_RETRY)) return;
    event.respondWith(
      (async () => {
        let fresh;
        try {
          // no-store, not a plain fetch: the page has a fixed name and GitHub Pages serves it with a
          // short max-age, so a plain fetch can be answered from the browser's HTTP cache with the
          // version from ten minutes ago — which then pins the old hashed bundle. Going past the HTTP
          // cache is the whole point of fetching the page first, and it is what makes an update show up.
          fresh = await fetch(request, { cache: 'no-store' });
        } catch {
          const hit = (await caches.match(request)) ?? (await caches.match('index.html'));
          return hit ? isolate(hit) : Response.error();
        }
        if (fresh.status === 401) return retryPage(request.url);
        // Only a page that loaded is worth keeping: a refusal stored here would be what opens offline.
        if (fresh.ok) void keep(request, fresh.clone());
        return isolate(fresh);
      })(),
    );
    return;
  }

  /*
   * Cache first only where the name changes with the content: Vite puts a hash in everything under
   * `assets/`, so a file there never goes stale. A file with a fixed name (the logo, the icons, the
   * manifest) goes to the network first and falls back to the cache offline; cache first there kept
   * the old logo on installed copies after the new one was published (08/10/2026).
   */
  const hashed = url.pathname.includes('/assets/');
  /*
   * O vídeo da vitrine da Expansão Sci-Fi (`media/`, 04/11/2026) fica com o navegador: ele pede o arquivo em pedaços
   * (`Range`, resposta 206), que o cache não guarda, e o Safari recusa um vídeo cujos pedaços passaram por um worker que
   * não os entende. Sem rede ele simplesmente não toca, e a vitrine mostra o pôster.
   */
  if (request.headers.has('range') || url.pathname.includes('/media/')) return;
  event.respondWith(
    (async () => {
      if (hashed) {
        const hit = await caches.match(request);
        if (hit) return isolate(hit);
      }
      let fresh;
      try {
        fresh = await fetch(request, hashed ? undefined : { cache: 'no-cache' });
      } catch (err) {
        const hit = await caches.match(request);
        if (hit) return isolate(hit);
        throw err;
      }
      if (fresh.ok) void keep(request, fresh.clone());
      return isolate(fresh);
    })(),
  );
});
