// 電波のない現場でも開けるように、アプリ本体と部品（PDF・Excel・書体）をスマホに保存しておく
// 外部のサイトには頼らない（Googleドライブとの同期・感想の送信だけはネットを使う）
const CACHE = 'jissokucho-v59';
const FONTS = 'jissokucho-fonts'; // 書体の文字ファイル（版が変わっても消さない）
const OCR = 'jissokucho-ocr'; // スキャン図面の文字を読み取る部品（約11MB。版が変わっても消さない）
// 日本語の図面PDFで使われる文字の対応表
const CMAPS = ['78-EUC-H', '78-EUC-V', '78-H', '78-RKSJ-H', '78-RKSJ-V', '78-V', '78ms-RKSJ-H', '78ms-RKSJ-V', '83pv-RKSJ-H', '90ms-RKSJ-H', '90ms-RKSJ-V', '90msp-RKSJ-H', '90msp-RKSJ-V', '90pv-RKSJ-H', '90pv-RKSJ-V', 'Add-H', 'Add-RKSJ-H', 'Add-RKSJ-V', 'Add-V', 'Adobe-Japan1-0', 'Adobe-Japan1-1', 'Adobe-Japan1-2', 'Adobe-Japan1-3', 'Adobe-Japan1-4', 'Adobe-Japan1-5', 'Adobe-Japan1-6', 'Adobe-Japan1-UCS2', 'EUC-H', 'EUC-V', 'Ext-H', 'Ext-RKSJ-H', 'Ext-RKSJ-V', 'Ext-V', 'H', 'Hankaku', 'Hiragana', 'Katakana', 'NWP-H', 'NWP-V', 'RKSJ-H', 'RKSJ-V', 'Roman', 'UniJIS-UCS2-H', 'UniJIS-UCS2-HW-H', 'UniJIS-UCS2-HW-V', 'UniJIS-UCS2-V', 'UniJIS-UTF16-H', 'UniJIS-UTF16-V', 'UniJIS-UTF32-H', 'UniJIS-UTF32-V', 'UniJIS-UTF8-H', 'UniJIS-UTF8-V', 'UniJIS2004-UTF16-H', 'UniJIS2004-UTF16-V', 'UniJIS2004-UTF32-H', 'UniJIS2004-UTF32-V', 'UniJIS2004-UTF8-H', 'UniJIS2004-UTF8-V', 'UniJISPro-UCS2-HW-V', 'UniJISPro-UCS2-V', 'UniJISPro-UTF8-V', 'UniJISX0213-UTF32-H', 'UniJISX0213-UTF32-V', 'UniJISX02132004-UTF32-H', 'UniJISX02132004-UTF32-V', 'V', 'WP-Symbol'];
const FILES = [
  './', 'index.html', 'style.css', 'store.js', 'sync.js', 'annot.js', 'demo.js', 'ocr.js', 'intro.html', 'privacy.html', 'app.js', 'manifest.webmanifest', 'favicon-48.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'lib/pdfjs/pdf.min.js', 'lib/pdfjs/pdf.worker.min.js',
  ...CMAPS.map(n => `lib/pdfjs/cmaps/${n}.bcmap`),
  'lib/exceljs/exceljs.min.js', 'lib/fonts/fonts.css',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== FONTS && k !== OCR).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 自分のファイルは「ネット優先・だめなら保存分」。書体の文字ファイルは「保存分優先」（使った文字の分だけ保存）
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 書体の文字ファイルと、スキャン図面の文字を読み取る部品（大きいので版が変わっても消さない）は「保存分優先」
  const keep = url.pathname.includes('/lib/fonts/files/') ? FONTS : url.pathname.includes('/lib/tesseract/') ? OCR : null;
  if (keep) {
    e.respondWith(caches.open(keep).then(c => c.match(req, { ignoreSearch: true }).then(m => m || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }))));
    return;
  }
  e.respondWith(fetch(req.url, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
    .catch(() => caches.match(req, { ignoreSearch: true })));
});
