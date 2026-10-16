// 電波のない現場でも開けるように、アプリ本体とPDF部品をスマホに保存しておく
const CACHE = 'jissokucho-v31';
const FONTS = 'jissokucho-fonts';
const FILES = [
  './', 'index.html', 'style.css', 'store.js', 'sync.js', 'annot.js', 'demo.js', 'intro.html', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 自分のファイルは「ネット優先・だめなら保存分」、PDF部品は「保存分優先」
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const own = new URL(req.url).origin === location.origin;
  if (own) {
    e.respondWith(fetch(req.url, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (req.url.startsWith('https://cdnjs.cloudflare.com/')) {
    e.respondWith(caches.match(req).then(m => m || fetch(req)));
  } else if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(req.url)) {
    // 書体：一度読んだら保存しておき、電波がなくても同じ見た目にする
    e.respondWith(caches.open(FONTS).then(c => c.match(req).then(m => m || fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }))));
  }
});
