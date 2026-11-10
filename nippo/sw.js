// 電波がなくても開けるように、アプリ本体をタブレットに保存しておく
const CACHE = 'nippo-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', '../lib/exceljs/exceljs.min.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('nippo-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// ネット優先・だめなら保存分
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req.url, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
    .catch(() => caches.match(req, { ignoreSearch: true })));
});
