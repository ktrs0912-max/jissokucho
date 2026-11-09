// スキャンした図面（文字のデータがないPDF）から、端末の中で文字を読み取る（Tesseract.js）
// 部品と読み取りデータは lib/tesseract に入れてある。図面を外に送ることはない。
// 読み取った文字は、PDFの文字と同じ形 { s, x, y, h, w }（PDFの1倍の座標。y は上向き＝下端を負の値）にそろえて返す。
const OCR = (() => {
  const BASE = new URL('lib/tesseract/', location.href).href;
  const FILES = ['tesseract.min.js', 'worker.min.js', 'core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js', 'lang/jpn.traineddata.gz', 'lang/eng.traineddata.gz'];
  let worker = null, loading = null, onProg = null;

  function loadLib() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise((ok, ng) => { const s = document.createElement('script'); s.src = BASE + 'tesseract.min.js'; s.onload = ok; s.onerror = () => ng(new Error('文字を読み取る部品を読み込めませんでした')); document.head.append(s); });
  }
  async function getWorker() {
    if (worker) return worker;
    if (!loading) loading = (async () => {
      await loadLib();
      const w = await Tesseract.createWorker(['jpn', 'eng'], 1, {
        workerPath: BASE + 'worker.min.js', corePath: BASE + 'core', langPath: BASE + 'lang',
        workerBlobURL: false, cacheMethod: 'none', gzip: true,
        logger: m => onProg?.(m),
      });
      // 図面は文字がばらばらに置かれているので「まばらな文字」として読む
      await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      worker = w; return w;
    })().catch(e => { loading = null; throw e; });
    return loading;
  }
  // 読み間違えやすい形を直す（1文字・2文字の数字の I l | O → 1 1 1 0）
  const fixWord = s => /^[0-9Il|O]{1,2}[ア-ン]?$/.test(s) && /[0-9]/.test(s.replace(/[Il|O]/g, '')) || /^[Il|]$/.test(s)
    ? s.replace(/[Il|]/g, '1').replace(/O/g, '0') : s;
  // 日本語の文字の間に入った空白を取る（「西 立 面 図」→「西立面図」）
  const joinJa = t => t.replace(/(?<=[^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, '');
  // 「2～7F」の波線は「7」や「1」と読まれやすい（「277F」）。60階をこえる数は、間の7・1を「～」とみなす
  const fixRange = t => t.replace(/(\d)\s*~\s*T(?=\s*F)/g, '$1~7').replace(/(?<![0-9])(\d{3,5})(?=\s*[F階])/g, m => {
    if (+m <= 60) return m;
    for (let i = 1; i < m.length - 1; i++) if ('71'.includes(m[i])) { const a = +m.slice(0, i), b = +m.slice(i + 1); if (a >= 1 && b > a && b <= 60) return `${a}~${b}`; }
    return m;
  });

  // ---- 丸で囲んだ符号（上に「BT」、横線、下に「1」）をさがす ----
  // 文字読み取りは丸の線を文字と間違えるので、丸を先に見つけて、中の上半分と下半分を別々に読む。
  // 白黒にして、つながった黒い線のかたまりのうち「ほぼ正方形で、中が空いている」ものを丸とみなす（半分の大きさで調べる）
  function findRings(canvas, k) {
    const S = 2, W = Math.ceil(canvas.width / S), H = Math.ceil(canvas.height / S);
    const t = document.createElement('canvas'); t.width = W; t.height = H;
    const tg = t.getContext('2d'); tg.drawImage(canvas, 0, 0, W, H);
    const px = tg.getImageData(0, 0, W, H).data, n = W * H;
    const lab = new Int32Array(n).fill(-1), par = [];
    const find = a => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4;
      if (px[p] * 0.3 + px[p + 1] * 0.59 + px[p + 2] * 0.11 > 140) continue;
      const up = y ? lab[i - W] : -1, lf = x ? lab[i - 1] : -1;
      if (up < 0 && lf < 0) { lab[i] = par.length; par.push(par.length); }
      else if (up >= 0 && lf >= 0) { const a = find(up), b = find(lf); lab[i] = a; if (a !== b) par[b] = a; }
      else lab[i] = up >= 0 ? up : lf;
    }
    const box = new Map();
    for (let i = 0; i < n; i++) {
      if (lab[i] < 0) continue;
      const r = find(lab[i]), x = i % W, y = (i / W) | 0;
      let b = box.get(r); if (!b) box.set(r, b = { x0: x, y0: y, x1: x, y1: y, c: 0 });
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; b.c++;
    }
    // 符号の丸は直径およそ12〜80pt（4〜28mm）
    const lo = 12 * k / S, hi = 80 * k / S, rings = [];
    box.forEach(b => {
      const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, fill = b.c / (w * h);
      if (w < lo || w > hi || h < lo || h > hi || w / h < 0.8 || w / h > 1.25 || fill > 0.32 || fill < 0.03) return;
      rings.push({ x: b.x0 * S, y: b.y0 * S, w: w * S, h: h * S });
    });
    return rings;
  }
  // 丸の中を切り出して読む。横線があれば上下に分けて読む
  async function readRing(w, canvas, r) {
    const inset = 0.16, cx = r.x + r.w * inset, cy = r.y + r.h * inset, cw = r.w * (1 - inset * 2), ch = r.h * (1 - inset * 2);
    const g = canvas.getContext('2d'), img = g.getImageData(Math.round(cx), Math.round(cy), Math.round(cw), Math.round(ch));
    const dark = (x, y) => { const p = (y * img.width + x) * 4; return img.data[p] < 140; };
    // 真ん中あたりで、黒い点が横にずっと続く行＝仕切りの横線
    let split = -1;
    for (let y = Math.round(img.height * 0.3); y < img.height * 0.7; y++) {
      let c = 0; for (let x = 0; x < img.width; x++) c += dark(x, y);
      if (c > img.width * 0.6) { split = y; break; }
    }
    const part = async (y0, y1, chars) => {
      const hgt = Math.max(1, Math.round(y1 - y0)), sc = Math.min(4, 90 / hgt), pad = 14;
      const c = document.createElement('canvas'); c.width = Math.round(img.width * sc) + pad * 2; c.height = Math.round(hgt * sc) + pad * 2;
      const cg = c.getContext('2d'); cg.fillStyle = '#fff'; cg.fillRect(0, 0, c.width, c.height);
      cg.drawImage(canvas, cx, cy + y0, img.width, hgt, pad, pad, img.width * sc, hgt * sc);
      // 丸の線の切れ端（四すみ）を消し、白か黒かにはっきり分ける
      const id = cg.getImageData(0, 0, c.width, c.height), d = id.data, mx = r.x + r.w / 2, my = r.y + r.h / 2, rad = r.w / 2;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const p = (y * c.width + x) * 4, ox = cx + (x - pad) / sc, oy = cy + y0 + (y - pad) / sc;
        const out = x < pad || y < pad || x >= c.width - pad || y >= c.height - pad || Math.hypot(ox - mx, oy - my) > rad * 0.78;
        const v = out || d[p] * 0.3 + d[p + 1] * 0.59 + d[p + 2] * 0.11 > 150 ? 255 : 0;
        d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
      }
      cg.putImageData(id, 0, 0);
      const tryRead = async psm => {
        await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: chars });
        const { data } = await w.recognize(c);
        return (data.text || '').replace(/\s+/g, '').normalize('NFKC').toUpperCase();
      };
      // 1行として読み、だめなら1語として読み直す
      let s = await tryRead('7'); if (!s) s = await tryRead('8');
      return { s };
    };
    const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', NUM = '0123456789';
    if (split > 0) {
      // 横線の太さの分だけ上下を離して読む
      let e = split; while (e < img.height - 1 && (() => { let c = 0; for (let x = 0; x < img.width; x++) c += dark(x, e); return c > img.width * 0.4; })()) e++;
      const top = await part(0, split - 1, AZ), bot = await part(e + 1, img.height, NUM);
      return /^[A-Z]{1,3}$/.test(top.s) && /^\d{1,2}$/.test(bot.s) ? { L: top.s, N: bot.s, split: cy + (split + e) / 2 } : null;
    }
    const one = await part(0, img.height, AZ + NUM + '-');
    const m = one.s.match(/^([A-Z]{1,3})-?(\d{1,2}[ア-コ]?)$/);
    return m ? { L: m[1], N: m[2], split: null } : null;
  }

  // canvas：読む画像、k：画像1ドット＝PDFの何倍か、ox,oy：画像の左上がPDFのどこか（PDFの1倍の座標）
  // opts.ptPx：画像の何ドットが1ポイントか（符号の丸の大きさの見当に使う。PDFでは k と同じ）
  async function read(canvas, k, ox, oy, progress, opts = {}) {
    onProg = m => { if (m.status === 'recognizing text') progress?.(m.progress); else progress?.(null, m.status); };
    const w = await getWorker();
    await w.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
    const { data } = await w.recognize(canvas);
    onProg = null;
    const items = [];
    const P = (x, y) => [ox + x / k, oy + y / k]; // 画像のドット → PDFの1倍の座標
    for (const wd of data.words || []) {
      if (wd.confidence < 25) continue;
      const raw = fixWord((wd.text || '').trim());
      if (!raw) continue;
      const b = wd.bbox, h = (b.y1 - b.y0) / k;
      items.push({ s: raw.normalize('NFKC').toUpperCase(), x: ox + b.x0 / k, y: -(oy + b.y1 / k), h, w: (b.x1 - b.x0) / k });
    }
    // 丸で囲んだ符号
    const rings = findRings(canvas, opts.ptPx || k);
    for (const [i, r] of rings.entries()) {
      progress?.(null, `丸の中の符号を読んでいます（${i + 1}/${rings.length}）`);
      const got = await readRing(w, canvas, r).catch(() => null);
      if (!got) continue;
      if (got.split != null) { // 上下に並んだ形として渡す（PDFの文字の時と同じ扱いになる）
        const [lx, ly] = P(r.x + r.w * 0.3, got.split), [, top] = P(0, r.y + r.h * 0.18), [, bot] = P(0, r.y + r.h * 0.84), rw = r.w * 0.4 / k;
        items.push({ s: got.L, x: lx, y: -ly, h: ly - top, w: rw });
        items.push({ s: got.N, x: lx, y: -bot, h: bot - ly, w: rw });
      } else {
        const [x, y] = P(r.x + r.w * 0.2, r.y + r.h * 0.7);
        items.push({ s: `${got.L}-${got.N}`, x, y: -y, h: r.h * 0.4 / k, w: r.w * 0.6 / k });
      }
    }
    await w.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
    const text = fixRange(joinJa((data.text || '').normalize('NFKC')));
    return { items, text };
  }
  async function end() { const w = worker; worker = null; loading = null; try { await w?.terminate(); } catch (e) {} }
  // 電波のある時に、読み取りの部品を先に保存しておく（電波のない現場でも使えるように）
  async function prefetch() {
    if (!window.caches || navigator.onLine === false || navigator.connection?.saveData) return;
    try {
      const c = await caches.open('jissokucho-ocr');
      for (const f of FILES) if (!await c.match(BASE + f)) await c.add(BASE + f);
    } catch (e) {}
  }
  return { read, end, prefetch, _rings: findRings, _ring: async (c, r) => readRing(await getWorker(), c, r) };
})();
