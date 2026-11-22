/* sw.js — caché de la app para abrirla sin conexión (la música necesita internet) */
const CACHE = 'musica-v18';
const SHELL = ['./', 'index.html', 'app.js', 'account.js', 'bpm.js', 'reco.js', 'wrapped.js', 'car.js', 'share.js', 'welcome.js', 'together.js', 'remote.js','liquid.js', 'glass.js', 'now.js', 'fx.js', 'm3.js', 'features.js', 'sources.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CACHE + '-img').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // portadas: primero la caché
  if (u.pathname === '/api/img') {
    e.respondWith(caches.open(CACHE + '-img').then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  if (u.pathname.startsWith('/api/')) return;
  // archivos de la app: primero la red (para recibir cambios), si falla la caché
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
