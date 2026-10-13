// 実測帳：図面をタップして①②③…と番号を打ち、階ごとの実測値を入れるアプリ
const $ = s => document.querySelector(s);
const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚';
const circ = n => CIRC[n - 1] || `(${n})`;
const COLORS = ['#c42f26', '#1f6fb2', '#2f8a3b', '#a54db8', '#d07a00', '#0f8b8d'];
const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

const S = { site: null, drawing: null, page: 1, pos: null, positions: [], selPoint: null, selFloor: null, addMode: true, undo: [], photos: [] };
const pdfCache = new Map();

function toast(t) {
  const el = $('#toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2600);
}
function ask(text) {
  return new Promise(res => {
    const d = $('#askDlg'); $('#askText').textContent = text;
    d.querySelector('form').onsubmit = e => { e.preventDefault(); const ok = e.submitter?.value === 'ok'; d.close(); res(ok); };
    d.oncancel = () => res(false);
    d.showModal();
  });
}
const num = v => (v === undefined || v === null || v === '') ? NaN : Number(String(v).replace(/[,\s]/g, ''));
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = n => Number.isFinite(n) ? (Math.round(n * 10) / 10).toLocaleString('ja-JP') : '–';
async function persist() { try { await navigator.storage?.persist?.(); } catch (e) {} }

/* ---------- 画面の切り替え ---------- */
function show(v) {
  ['vHome', 'vSite', 'vDraw'].forEach(id => $('#' + id).hidden = id !== v);
}
async function go(view, push = true) {
  if (push) history.pushState({ view, site: S.site?.id, drawing: S.drawing?.id }, '');
  if (view === 'home') { flushSave(); S.site = null; await renderHome(); show('vHome'); }
  if (view === 'site') { flushSave(); S.drawing = null; await renderSite(); show('vSite'); }
  if (view === 'draw') { show('vDraw'); await openDrawing(); }
}
window.addEventListener('popstate', e => {
  const v = e.state?.view || 'home';
  if (v === 'home' || !S.site) go('home', false);
  else if (v === 'site' || !S.drawing) go('site', false);
  else go('draw', false);
});
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => history.back());

/* ---------- ホーム ---------- */
async function renderHome() {
  const sites = (await Store.all('sites')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const ul = $('#siteList'); ul.innerHTML = '';
  sites.forEach(s => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.textContent = s.name;
    const sp = document.createElement('span'); sp.textContent = `図面 ${s.drawings.length}枚`; b.append(sp);
    b.onclick = () => { S.site = s; go('site'); };
    li.append(b); ul.append(li);
  });
  $('#homeEmpty').hidden = sites.length > 0;
  renderBackupInfo();
}
$('#addSite').onclick = async () => {
  const name = $('#newSiteName').value.trim();
  if (!name) { $('#newSiteName').focus(); return; }
  const now = new Date().toISOString();
  const s = { id: uid(), name, drawings: [], createdAt: now, updatedAt: now };
  await Store.put('sites', s); persist();
  $('#newSiteName').value = '';
  S.site = s; go('site');
};

/* ---------- 現場 ---------- */
async function renderSite() {
  $('#siteTitle').textContent = S.site.name;
  const ul = $('#drawList'); ul.innerHTML = '';
  const poss = await Store.byIndex('positions', 'site', S.site.id);
  S.site.drawings.forEach(d => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.textContent = d.name;
    const n = poss.filter(p => p.drawingId === d.id);
    const sp = document.createElement('span');
    sp.textContent = `${d.pages}ページ` + (n.length ? `・${n.map(p => p.name).join(' ')}` : '');
    b.append(sp);
    b.onclick = () => { S.drawing = d; S.page = d.lastPage || 1; S.pos = null; go('draw'); };
    li.append(b); ul.append(li);
  });
  $('#siteEmpty').hidden = S.site.drawings.length > 0;
  $('#xlsxBox').hidden = !poss.some(p => p.points.length);
}
async function saveSite() { S.site.updatedAt = new Date().toISOString(); await Store.put('sites', S.site); }

$('#fileIn').onchange = $('#photoIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const msg = $('#loadMsg'); msg.hidden = false; msg.textContent = `${f.name} を読み込んでいます…`;
  try {
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    let pages = 1;
    if (isPdf) {
      if (!window.pdfjsLib) throw new Error('PDFを読む部品がまだ読み込めていません。電波のある所で一度アプリを開いてください');
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      pages = doc.numPages; doc.destroy();
    }
    const d = { id: uid(), name: f.name.replace(/\.[^.]+$/, ''), type: isPdf ? 'pdf' : 'image', pages, lastPage: 1 };
    await Store.put('files', { id: d.id, blob: f });
    S.site.drawings.push(d); await saveSite(); persist();
    msg.hidden = true;
    S.drawing = d; S.page = 1; S.pos = null; go('draw');
  } catch (err) {
    msg.textContent = '読み込めませんでした：' + (err.message || err);
  }
};
$('#delSite').onclick = async () => {
  if (!await ask(`「${S.site.name}」の図面と実測値をすべて削除します。元に戻せません。`)) return;
  for (const d of S.site.drawings) await Store.del('files', d.id);
  for (const p of await Store.byIndex('positions', 'site', S.site.id)) await Store.del('positions', p.id);
  for (const ph of await Store.byIndex('photos', 'site', S.site.id)) await Store.del('photos', ph.id);
  await Store.del('sites', S.site.id);
  toast('削除しました'); history.back();
};

/* ---------- 図面の表示 ---------- */
const cv = $('#cv'), svg = $('#marks'), layer = $('#layer'), stage = $('#stage');
const V = { s: 1, x: 0, y: 0, w: 0, h: 0 };

async function getPdf(d) {
  if (pdfCache.has(d.id)) return pdfCache.get(d.id);
  const rec = await Store.get('files', d.id);
  const p = pdfjsLib.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) }).promise;
  pdfCache.set(d.id, p); return p;
}
// ページを素早く切り替えても、最後に選んだページだけを描く（裏の別キャンバスに描いてから差し替え）
let renderSeq = 0, renderTask = null;
async function renderPage() {
  const d = S.drawing, m = $('#stageMsg'), seq = ++renderSeq;
  m.hidden = false; m.textContent = '図面を表示しています…';
  try { renderTask?.cancel(); } catch (e) {}
  try {
    const tmp = document.createElement('canvas');
    if (d.type === 'pdf') {
      if (!window.pdfjsLib) throw new Error('PDFを読む部品が読み込めていません。電波のある所で一度アプリを開いてください');
      const doc = await getPdf(d), page = await doc.getPage(S.page);
      if (seq !== renderSeq) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 2600 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      tmp.width = Math.round(vp.width); tmp.height = Math.round(vp.height);
      renderTask = page.render({ canvasContext: tmp.getContext('2d'), viewport: vp });
      await renderTask.promise;
    } else {
      const rec = await Store.get('files', d.id);
      const img = await createImageBitmap(rec.blob);
      const k = Math.min(1, 3000 / Math.max(img.width, img.height));
      tmp.width = Math.round(img.width * k); tmp.height = Math.round(img.height * k);
      tmp.getContext('2d').drawImage(img, 0, 0, tmp.width, tmp.height);
    }
    if (seq !== renderSeq) return;
    cv.width = tmp.width; cv.height = tmp.height; cv.getContext('2d').drawImage(tmp, 0, 0);
    V.w = cv.width; V.h = cv.height;
    svg.setAttribute('width', V.w); svg.setAttribute('height', V.h);
    svg.setAttribute('viewBox', `0 0 ${V.w} ${V.h}`);
    m.hidden = true; fit(); drawMarks();
  } catch (err) {
    if (seq !== renderSeq || err?.name === 'RenderingCancelledException') return;
    m.textContent = '図面を表示できませんでした：' + (err.message || err);
  }
}
function fit() {
  const r = stage.getBoundingClientRect();
  if (!V.w || !r.width) return;
  V.s = V.minS = Math.min(r.width / V.w, r.height / V.h) * 0.96;
  V.x = (r.width - V.w * V.s) / 2; V.y = (r.height - V.h * V.s) / 2;
  apply();
}
// 縮小は「図面全体が見える大きさ」まで。図面が画面の外へ逃げないように位置もおさえる
const clampScale = s => Math.min(8, Math.max(V.minS || 0.05, s));
function clampPan() {
  const r = stage.getBoundingClientRect(), w = V.w * V.s, h = V.h * V.s;
  V.x = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, V.x));
  V.y = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, V.y));
}
function apply() {
  clampPan();
  layer.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.s})`;
  drawMarks();
}
new ResizeObserver(() => { if (!$('#vDraw').hidden) fit(); }).observe(stage);
$('#fitBtn').onclick = fit;

// 番号の丸の大きさ（極小〜大）。選んだ大きさはこのスマホに覚えておく
const SIZES = [{ name: '極小', k: 0.6 }, { name: '小', k: 0.8 }, { name: '中', k: 1 }, { name: '大', k: 1.5 }];
let sizeIdx = 2;
try { const v = parseInt(localStorage.getItem('jissoku.size')); if (SIZES[v]) sizeIdx = v; } catch (e) {}
const sizeK = () => SIZES[sizeIdx].k;
function renderSizeBtn() { $('#sizeBtn').textContent = `丸：${SIZES[sizeIdx].name}`; }
$('#sizeBtn').onclick = () => {
  sizeIdx = (sizeIdx + 1) % SIZES.length;
  try { localStorage.setItem('jissoku.size', sizeIdx); } catch (e) {}
  renderSizeBtn(); drawMarks();
};
renderSizeBtn();

function drawMarks() {
  const k = sizeK(), r = 9 * k / V.s, fs = 10 * k / V.s, sw = 1.5 * Math.max(0.7, k) / V.s;
  let h = '';
  S.positions.filter(p => p.page === S.page).forEach(p => {
    const active = S.pos && p.id === S.pos.id;
    p.points.forEach((pt, i) => {
      const x = pt.x * V.w, y = pt.y * V.h, sel = active && S.selPoint === pt.id;
      h += `<g opacity="${active ? 1 : .45}">`
        + (sel ? `<circle cx="${x}" cy="${y}" r="${r * 1.6}" fill="none" stroke="${p.color}" stroke-width="${sw}"/>` : '')
        + `<circle cx="${x}" cy="${y}" r="${r}" fill="${active ? p.color : '#fff'}" stroke="${p.color}" stroke-width="${sw}"/>`
        + `<text x="${x}" y="${y}" font-size="${fs}" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="${active ? '#fff' : p.color}" font-family="sans-serif">${i + 1}</text>`
        + (active && S.photos.some(ph => ph.pointId === pt.id) ? `<circle cx="${x + r * 0.85}" cy="${y - r * 0.85}" r="${r * 0.42}" fill="#1f2a36" stroke="#fff" stroke-width="${sw * 0.7}"/>` : '')
        + `</g>`;
    });
  });
  svg.innerHTML = h;
}

/* ---------- タッチ操作：タップで番号、2本指で拡大、ドラッグで移動 ---------- */
const ptrs = new Map();
let gest = null;
const toLayer = (cx, cy) => { const r = stage.getBoundingClientRect(); return { x: (cx - r.left - V.x) / V.s, y: (cy - r.top - V.y) / V.s }; };
function hitPoint(cx, cy) {
  if (!S.pos || S.pos.page !== S.page) return null;
  const p = toLayer(cx, cy), lim = 22 / V.s;
  let best = null, bd = lim;
  S.pos.points.forEach(pt => { const d = Math.hypot(pt.x * V.w - p.x, pt.y * V.h - p.y); if (d < bd) { bd = d; best = pt; } });
  return best;
}
stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.tools')) return;
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) {
    const hit = hitPoint(e.clientX, e.clientY);
    gest = { type: 'one', sx: e.clientX, sy: e.clientY, vx: V.x, vy: V.y, t: Date.now(), moved: false, hit, drag: hit && !S.addMode };
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    gest = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s: V.s, vx: V.x, vy: V.y };
  }
});
stage.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId) || !gest) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gest.type === 'one') {
    const dx = e.clientX - gest.sx, dy = e.clientY - gest.sy;
    if (Math.hypot(dx, dy) > 12) gest.moved = true;
    if (!gest.moved) return;
    // 1本指では図面を動かさない（誤って動くのを防ぐ）。移動は2本指で行う
    if (gest.drag) {
      const p = toLayer(e.clientX, e.clientY);
      gest.hit.x = Math.min(1, Math.max(0, p.x / V.w)); gest.hit.y = Math.min(1, Math.max(0, p.y / V.h));
      S.selPoint = gest.hit.id; drawMarks();
    }
  } else if (gest.type === 'pinch' && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const r = stage.getBoundingClientRect();
    const ns = clampScale(gest.s * d / gest.d);
    const lx = (gest.mx - r.left - gest.vx) / gest.s, ly = (gest.my - r.top - gest.vy) / gest.s;
    V.s = ns; V.x = mx - r.left - lx * ns; V.y = my - r.top - ly * ns; apply();
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (gest?.type === 'one' && ptrs.size === 0) {
    if (gest.drag && gest.moved) scheduleSave();
    else if (!gest.moved && Date.now() - gest.t < 600) onTap(e.clientX, e.clientY, gest.hit);
  }
  if (ptrs.size === 0) gest = null;
  else if (ptrs.size === 1) { const [p] = [...ptrs.values()]; gest = { type: 'one', sx: p.x, sy: p.y, vx: V.x, vy: V.y, t: 0, moved: true, hit: null, drag: false }; }
}
stage.addEventListener('pointerup', endPtr);
stage.addEventListener('pointercancel', endPtr);
stage.addEventListener('wheel', e => {
  e.preventDefault();
  const r = stage.getBoundingClientRect(), k = Math.exp(-e.deltaY * 0.0015);
  const ns = clampScale(V.s * k);
  const lx = (e.clientX - r.left - V.x) / V.s, ly = (e.clientY - r.top - V.y) / V.s;
  V.s = ns; V.x = e.clientX - r.left - lx * ns; V.y = e.clientY - r.top - ly * ns; apply();
}, { passive: false });

function onTap(cx, cy, hit) {
  if (hit) { selectPoint(hit.id, true); return; }
  if (!S.addMode) { S.selPoint = null; drawMarks(); renderGrid(); return; }
  if (!S.pos) { toast('先に「＋ 位置」で位置を作ってください'); return; }
  if (S.pos.page !== S.page) { toast(`${S.pos.name} は ${S.pos.page}ページの位置です`); return; }
  if (S.pos.points.length >= 30) { toast('1つの位置に打てる番号は30個までです'); return; }
  const p = toLayer(cx, cy);
  if (p.x < 0 || p.y < 0 || p.x > V.w || p.y > V.h) return;
  const pt = { id: uid(), x: p.x / V.w, y: p.y / V.h };
  S.pos.points.push(pt); S.undo.push(pt.id);
  S.selPoint = pt.id;
  drawMarks(); renderGrid(); scheduleSave();
  toast(`${circ(S.pos.points.length)} を打ちました`);
}
$('#modeBtn').onclick = () => {
  S.addMode = !S.addMode;
  const b = $('#modeBtn'); b.classList.toggle('on', S.addMode); b.setAttribute('aria-pressed', S.addMode);
  b.textContent = S.addMode ? '● 番号を打つ' : '✋ 移動・選択';
  toast(S.addMode ? 'タップした所に次の番号を打ちます' : '番号をドラッグして位置を直せます');
};
$('#undoBtn').onclick = () => {
  if (!S.pos) return;
  const id = S.undo.pop() || S.pos.points[S.pos.points.length - 1]?.id;
  if (!id) return;
  removePoint(id); toast('最後の番号を取り消しました');
};

/* ---------- 位置 ---------- */
async function openDrawing() {
  $('#drawTitle').textContent = S.drawing.name;
  S.positions = (await Store.byIndex('positions', 'drawing', S.drawing.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!S.pos) S.pos = S.positions.find(p => p.page === S.page) || null;
  S.selPoint = null; S.undo = [];
  renderPager(); renderChips(); renderPos();
  await renderPage();
}
function renderPager() {
  const n = S.drawing.pages;
  $('#pgLabel').textContent = `${S.page}/${n}`;
  $('#pgPrev').disabled = S.page <= 1; $('#pgNext').disabled = S.page >= n;
  document.querySelector('.pager').hidden = n <= 1;
}
async function gotoPage(p) {
  flushSave();
  S.page = p; S.drawing.lastPage = p; saveSite();
  if (S.pos && S.pos.page !== p) S.pos = S.positions.find(x => x.page === p) || null;
  S.selPoint = null; S.undo = [];
  renderPager(); renderChips(); renderPos(); await renderPage();
}
$('#pgPrev').onclick = () => gotoPage(S.page - 1);
$('#pgNext').onclick = () => gotoPage(S.page + 1);

function renderChips() {
  const box = $('#posChips'); box.innerHTML = '';
  S.positions.forEach(p => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.textContent = p.name + (S.drawing.pages > 1 && p.page !== S.page ? ` (p${p.page})` : '');
    b.style.borderColor = p.color;
    b.setAttribute('aria-pressed', S.pos?.id === p.id);
    b.onclick = async () => {
      flushSave(); S.pos = p; S.selPoint = null; S.undo = [];
      if (p.page !== S.page) { await gotoPage(p.page); S.pos = p; }
      renderChips(); renderPos(); drawMarks();
    };
    box.append(b);
  });
}
$('#addPos').onclick = () => {
  $('#pErr').hidden = true; $('#pName').value = '';
  $('#posDlg').showModal(); $('#pName').focus();
};
$('#posDlg form').addEventListener('submit', async e => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') { $('#posDlg').close(); return; }
  const name = $('#pName').value.trim().toUpperCase();
  const a = parseInt($('#pFrom').value) || 1, z = parseInt($('#pTo').value) || a;
  const err = $('#pErr');
  if (!name) { err.hidden = false; err.textContent = '位置の名前を入れてください'; return; }
  if (S.positions.some(p => p.name === name)) { err.hidden = false; err.textContent = `${name} はもうあります`; return; }
  $('#posDlg').close();
  const floors = []; for (let f = Math.min(a, z); f <= Math.max(a, z); f++) floors.push(f + 'F');
  const now = new Date().toISOString();
  const p = { id: uid(), siteId: S.site.id, drawingId: S.drawing.id, page: S.page, name, color: COLORS[S.positions.length % COLORS.length], floors, points: [], values: {}, memo: '', createdAt: now, updatedAt: now };
  S.positions.push(p); S.pos = p; S.selPoint = null; S.undo = [];
  await Store.put('positions', p);
  if (!S.addMode) $('#modeBtn').click();
  renderChips(); renderPos(); drawMarks();
  toast(`図面の測る場所をタップすると ① から番号が付きます`);
});
// Claudeが図面から読み取った符号一覧（JSON）を取り込んで、位置をまとめて作る
// 形式: { "drawing": "図面名", "positions": [ { "name": "KT-2", "page": 1, "from": 2, "to": 9, "note": "…" } ] }
$('#importIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (err) { toast('取り込めませんでした。符号ファイル（.json）を選んでください'); return; }
  const list = Array.isArray(data) ? data : data.positions;
  if (!Array.isArray(list)) { toast('符号の一覧が見つかりませんでした'); return; }
  if (data.drawing && data.drawing !== S.drawing.name && !await ask(`この符号ファイルは「${data.drawing}」用です。今の図面「${S.drawing.name}」に取り込みますか？`)) return;
  let added = 0, skipped = 0;
  for (const it of list) {
    const name = String(it.name || '').trim().toUpperCase();
    if (!name || S.positions.some(p => p.name === name)) { skipped++; continue; }
    const a = parseInt(it.from) || 1, z = parseInt(it.to) || a;
    const floors = []; for (let x = Math.min(a, z); x <= Math.max(a, z); x++) floors.push(x + 'F');
    const now = new Date().toISOString();
    const p = { id: uid(), siteId: S.site.id, drawingId: S.drawing.id, page: Math.min(S.drawing.pages, Math.max(1, parseInt(it.page) || 1)), name, color: COLORS[S.positions.length % COLORS.length], floors, points: [], values: {}, memo: it.note ? String(it.note) : '', createdAt: now, updatedAt: now };
    await Store.put('positions', p); S.positions.push(p); added++;
  }
  if (!S.pos) S.pos = S.positions.find(p => p.page === S.page) || S.positions[0] || null;
  renderChips(); renderPos(); drawMarks();
  toast(`符号を${added}件追加しました` + (skipped ? `（${skipped}件は登録済みのため省略）` : ''));
};
$('#delPos').onclick = async () => {
  if (!S.pos || !await ask(`位置「${S.pos.name}」の番号と実測値を削除します。元に戻せません。`)) return;
  clearTimeout(saveTimer); saveTimer = null;
  for (const ph of await Store.byIndex('photos', 'position', S.pos.id)) await Store.del('photos', ph.id);
  await Store.del('positions', S.pos.id);
  S.positions = S.positions.filter(p => p !== S.pos);
  S.pos = S.positions.find(p => p.page === S.page) || null;
  renderChips(); renderPos(); drawMarks(); toast('削除しました');
};

/* ---------- 実測値の表 ---------- */
function analyze(p) {
  const stats = {}, off = new Set();
  p.points.forEach(pt => {
    const vals = p.floors.map(f => num(p.values[f]?.[pt.id])).filter(Number.isFinite);
    if (!vals.length) { stats[pt.id] = null; return; }
    const med = median(vals), tol = Math.max(15, Math.abs(med) * 0.02);
    stats[pt.id] = { min: Math.min(...vals), max: Math.max(...vals), tol };
    if (vals.length >= 3) p.floors.forEach(f => { const v = num(p.values[f]?.[pt.id]); if (Number.isFinite(v) && Math.abs(v - med) > tol) off.add(f + '|' + pt.id); });
  });
  return { stats, off };
}
function renderPos() {
  $('#noPos').hidden = !!S.pos; $('#posBody').hidden = !S.pos;
  if (!S.pos) return;
  $('#posName').textContent = S.pos.name; $('#posName').style.color = S.pos.color;
  $('#posMeta').textContent = `${S.pos.floors[0] ?? ''}〜${S.pos.floors[S.pos.floors.length - 1] ?? ''}・番号 ${S.pos.points.length}個`;
  $('#memo').value = S.pos.memo || '';
  S.photos = [];
  renderGrid();
  const id = S.pos.id;
  Store.byIndex('photos', 'position', id).then(list => {
    if (S.pos?.id !== id) return;
    S.photos = list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    drawMarks(); renderPhotos();
  });
}
function renderGrid() {
  if (!S.pos) return;
  const p = S.pos, t = $('#grid'); t.innerHTML = '';
  $('#posMeta').textContent = `${p.floors[0] ?? ''}〜${p.floors[p.floors.length - 1] ?? ''}・番号 ${p.points.length}個`;
  const si = p.points.findIndex(x => x.id === S.selPoint);
  $('#selBar').hidden = si < 0;
  if (si >= 0) $('#selLabel').textContent = `${S.selFloor ? S.selFloor + ' ' : ''}${circ(si + 1)} を選択中`;
  renderPhotos();
  if (!p.points.length) { t.innerHTML = '<tbody><tr><td class="small muted" style="padding:14px 12px;text-align:left">図面をタップして番号を打つと、ここに入力欄が並びます。</td></tr></tbody>'; return; }
  const hr = t.createTHead().insertRow();
  const c0 = document.createElement('th'); c0.className = 'fl'; c0.textContent = '階'; hr.append(c0);
  p.points.forEach((pt, i) => {
    const th = document.createElement('th'); th.textContent = circ(i + 1); th.dataset.pid = pt.id;
    if (pt.id === S.selPoint) th.className = 'sel';
    th.onclick = () => selectPoint(pt.id, false);
    hr.append(th);
  });
  // 設計値（図面の寸法）の行。入れると各階の下に「実測−設計」の差が出る
  const dr = t.tHead.insertRow(); dr.className = 'design';
  const d0 = document.createElement('th'); d0.className = 'fl'; d0.textContent = '設計'; dr.append(d0);
  p.points.forEach((pt, ci) => {
    const td = document.createElement('td'), inp = document.createElement('input');
    if (pt.id === S.selPoint) td.className = 'sel';
    inp.id = `d_${ci}`; inp.inputMode = 'decimal'; inp.enterKeyHint = 'next'; inp.autocomplete = 'off';
    inp.placeholder = '図面値'; inp.value = p.design?.[pt.id] ?? '';
    inp.dataset.dpid = pt.id; inp.dataset.c = ci;
    inp.setAttribute('aria-label', `${circ(ci + 1)} の設計値`);
    td.append(inp); dr.append(td);
  });
  const tb = t.createTBody();
  p.floors.forEach((f, ri) => {
    const tr = tb.insertRow();
    const th = document.createElement('th'); th.className = 'fl'; th.scope = 'row'; th.textContent = f; tr.append(th);
    p.points.forEach((pt, ci) => {
      const td = tr.insertCell(), inp = document.createElement('input');
      if (pt.id === S.selPoint) td.className = 'sel';
      inp.id = `c_${ri}_${ci}`; inp.inputMode = 'decimal'; inp.enterKeyHint = 'next'; inp.autocomplete = 'off';
      inp.placeholder = '—'; inp.value = p.values[f]?.[pt.id] ?? '';
      inp.dataset.f = f; inp.dataset.pid = pt.id; inp.dataset.r = ri; inp.dataset.c = ci;
      inp.setAttribute('aria-label', `${f} ${circ(ci + 1)}`);
      const dv = document.createElement('span'); dv.className = 'dv';
      td.append(inp, dv);
    });
  });
  const tf = t.createTFoot();
  ['最小', '最大', '差'].forEach((lab, k) => {
    const tr = tf.insertRow(); const th = document.createElement('th'); th.className = 'fl'; th.textContent = lab; tr.append(th);
    p.points.forEach(pt => { const td = tr.insertCell(); td.id = `s${k}_${pt.id}`; });
  });
  refreshMarks();
}
function refreshMarks() {
  const { stats, off } = analyze(S.pos);
  document.querySelectorAll('#grid tbody input').forEach(i => {
    const td = i.parentElement, dv = td.querySelector('.dv');
    td.classList.toggle('off', off.has(i.dataset.f + '|' + i.dataset.pid));
    const v = num(i.value), d = num(S.pos.design?.[i.dataset.pid]);
    const diff = Number.isFinite(v) && Number.isFinite(d) ? Math.round((v - d) * 10) / 10 : null;
    dv.textContent = diff === null ? '' : (diff > 0 ? '+' : diff < 0 ? '−' : '±') + fmt(Math.abs(diff));
    dv.classList.toggle('over', diff !== null && Math.abs(diff) >= DIFF_LIMIT);
    td.classList.toggle('hasd', Number.isFinite(d));
  });
  S.pos.points.forEach(pt => {
    const s = stats[pt.id];
    $(`#s0_${pt.id}`).textContent = s ? fmt(s.min) : '–';
    $(`#s1_${pt.id}`).textContent = s ? fmt(s.max) : '–';
    const d = $(`#s2_${pt.id}`); d.textContent = s ? fmt(s.max - s.min) : '–'; d.classList.toggle('big', !!s && s.max - s.min > s.tol);
  });
}
function selectPoint(id, focusInput) {
  S.selPoint = id; drawMarks(); renderGrid();
  const ci = S.pos.points.findIndex(x => x.id === id);
  const th = document.querySelector(`#grid thead th[data-pid="${id}"]`);
  th?.scrollIntoView({ block: 'nearest', inline: 'center' });
  if (focusInput) {
    const empty = S.pos.floors.findIndex(f => !(S.pos.values[f]?.[id]));
    const inp = $(`#c_${empty < 0 ? 0 : empty}_${ci}`);
    inp?.focus({ preventScroll: true }); inp?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}
function removePoint(id) {
  const p = S.pos; p.points = p.points.filter(x => x.id !== id);
  S.photos.filter(ph => ph.pointId === id).forEach(ph => Store.del('photos', ph.id));
  S.photos = S.photos.filter(ph => ph.pointId !== id);
  Object.values(p.values).forEach(row => delete row[id]);
  if (p.design) delete p.design[id];
  S.undo = S.undo.filter(x => x !== id);
  if (S.selPoint === id) S.selPoint = null;
  drawMarks(); renderGrid(); scheduleSave();
}
$('#delPoint').onclick = async () => {
  const i = S.pos.points.findIndex(x => x.id === S.selPoint);
  if (i < 0) return;
  const hasVal = S.pos.floors.some(f => S.pos.values[f]?.[S.selPoint]);
  if (hasVal && !await ask(`${circ(i + 1)} と入力済みの実測値を削除します。後ろの番号は1つずつ繰り上がります。`)) return;
  removePoint(S.selPoint);
};

const grid = $('#grid');
grid.addEventListener('input', e => {
  const i = e.target; if (i.tagName !== 'INPUT') return;
  const v = i.value.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
  if (v !== i.value) i.value = v;
  if (i.dataset.dpid) {
    const dsg = S.pos.design ??= {};
    if (v === '') delete dsg[i.dataset.dpid]; else dsg[i.dataset.dpid] = v;
    refreshMarks(); scheduleSave(); return;
  }
  const row = S.pos.values[i.dataset.f] ??= {};
  if (v === '') delete row[i.dataset.pid]; else row[i.dataset.pid] = v;
  refreshMarks(); scheduleSave();
});
grid.addEventListener('focusin', e => {
  const i = e.target; if (i.tagName !== 'INPUT') return;
  const pid = i.dataset.pid || i.dataset.dpid;
  const si0 = S.pos.points.findIndex(x => x.id === pid);
  S.selFloor = i.dataset.f || null;
  const lab = `${S.selFloor ? S.selFloor + ' ' : ''}${circ(si0 + 1)} を選択中`;
  if (S.selPoint === pid) { $('#selLabel').textContent = lab; return; }
  S.selPoint = pid; drawMarks(); renderPhotos();
  document.querySelectorAll('#grid .sel').forEach(x => x.classList.remove('sel'));
  document.querySelectorAll(`#grid [data-pid="${pid}"], #grid [data-dpid="${pid}"]`).forEach(x => (x.tagName === 'INPUT' ? x.parentElement : x).classList.add('sel'));
  $('#selBar').hidden = false; $('#selLabel').textContent = lab;
});
grid.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  if (e.target.dataset.dpid) { // 設計値の行は右へ。最後まで行ったら2Fの①へ
    const nx = $(`#d_${+e.target.dataset.c + 1}`) || $('#c_0_0');
    nx?.focus(); nx?.select(); return;
  }
  let r = +e.target.dataset.r, c = +e.target.dataset.c + 1;
  if (c >= S.pos.points.length) { c = 0; r++; }
  const n = $(`#c_${r}_${c}`); if (n) { n.focus(); n.select(); } else e.target.blur();
});
$('#memo').addEventListener('input', e => { if (S.pos) { S.pos.memo = e.target.value; scheduleSave(); } });
$('#addFloor').onclick = () => {
  const p = S.pos, last = p.floors[p.floors.length - 1];
  let n = last ? parseInt(last) + 1 : 1; while (p.floors.includes(n + 'F')) n++;
  p.floors.push(n + 'F'); renderGrid(); scheduleSave();
};
// 一番上の階を減らす。数値が入っていたら確認してから
$('#delFloor').onclick = async () => {
  const p = S.pos; if (!p || p.floors.length <= 1) return;
  const f = p.floors[p.floors.length - 1];
  const hasVal = Object.values(p.values[f] || {}).some(v => v !== '');
  if (hasVal && !await ask(`${f} の実測値を削除します。元に戻せません。`)) return;
  p.floors.pop(); delete p.values[f];
  if (S.selFloor === f) S.selFloor = null;
  renderGrid(); scheduleSave(); toast(`${f} を減らしました`);
};

/* ---------- 番号ごとの現場写真 ---------- */
// 写真は長い辺1600pxのJPEGに縮めて保存（容量を抑える）
async function shrinkPhoto(file) {
  const img = await createImageBitmap(file), k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
}
const photoLabel = ph => { const i = S.pos ? S.pos.points.findIndex(x => x.id === ph.pointId) : -1; return `${ph.floor ? ph.floor + ' ' : ''}${i >= 0 ? circ(i + 1) : ''}`; };
let stripUrls = [];
function renderPhotos() {
  const box = $('#photoStrip');
  stripUrls.forEach(u => URL.revokeObjectURL(u)); stripUrls = [];
  box.innerHTML = '';
  const list = S.pos && S.selPoint ? S.photos.filter(ph => ph.pointId === S.selPoint) : [];
  box.hidden = !list.length;
  list.forEach(ph => {
    const b = document.createElement('button'), img = document.createElement('img'), cap = document.createElement('span');
    const u = URL.createObjectURL(ph.blob); stripUrls.push(u);
    b.type = 'button'; img.src = u; img.alt = `${photoLabel(ph)} の写真`; cap.textContent = ph.floor || '階なし';
    b.append(img, cap); b.onclick = () => openPhoto(ph); box.append(b);
  });
}
// 撮影後に「どの階の写真？」を選んでから保存する（前回選んだ階が強調される）
let pendingPhoto = null, prevUrl = null, lastPhotoFloor = null;
$('#photoCam').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !S.pos || !S.selPoint) return;
  try { pendingPhoto = { blob: await shrinkPhoto(f), pointId: S.selPoint }; }
  catch (err) { toast('写真を読み込めませんでした：' + (err.message || err)); return; }
  const i = S.pos.points.findIndex(x => x.id === S.selPoint);
  $('#floorTitle').textContent = `${circ(i + 1)} の写真。どの階？`;
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  prevUrl = URL.createObjectURL(pendingPhoto.blob); $('#floorPrev').src = prevUrl;
  const box = $('#floorBtns'); box.innerHTML = '';
  const guess = lastPhotoFloor ?? S.selFloor;
  [...S.pos.floors, null].forEach(fl => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.textContent = fl ?? '階なし'; b.setAttribute('aria-pressed', fl === guess && fl !== null);
    b.onclick = () => savePendingPhoto(fl);
    box.append(b);
  });
  $('#floorDlg').showModal();
};
async function savePendingPhoto(floor) {
  $('#floorDlg').close();
  if (!pendingPhoto) return;
  const ph = { id: uid(), siteId: S.site.id, positionId: S.pos.id, pointId: pendingPhoto.pointId, floor, blob: pendingPhoto.blob, createdAt: new Date().toISOString() };
  pendingPhoto = null; lastPhotoFloor = floor;
  try {
    await Store.put('photos', ph); S.photos.push(ph); persist();
    drawMarks(); renderPhotos();
    toast(`${photoLabel(ph)} に写真を付けました`);
  } catch (err) { toast('写真を保存できませんでした：' + (err.message || err)); }
}
$('#floorCancel').onclick = () => { pendingPhoto = null; $('#floorDlg').close(); toast('写真を保存しませんでした'); };
$('#photoFloor').onchange = async e => {
  if (!viewing) return;
  viewing.floor = e.target.value || null;
  await Store.put('photos', viewing);
  $('#photoCap').textContent = `${S.pos.name}　${photoLabel(viewing)}　${new Date(viewing.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  renderPhotos(); toast(`${photoLabel(viewing)} に変えました`);
};
let viewing = null, viewUrl = null;
function openPhoto(ph) {
  viewing = ph; if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = URL.createObjectURL(ph.blob); $('#photoImg').src = viewUrl;
  $('#photoCap').textContent = `${S.pos.name}　${photoLabel(ph)}　${new Date(ph.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  const sel = $('#photoFloor'); sel.innerHTML = '';
  [...S.pos.floors, ''].forEach(fl => { const o = document.createElement('option'); o.value = fl; o.textContent = fl || '階なし'; if ((ph.floor || '') === fl) o.selected = true; sel.append(o); });
  $('#photoDlg').showModal();
}
$('#photoClose').onclick = () => $('#photoDlg').close();
$('#photoDel').onclick = async () => {
  $('#photoDlg').close();
  if (!viewing || !await ask(`${photoLabel(viewing)} の写真を削除します。元に戻せません。`)) return;
  await Store.del('photos', viewing.id);
  S.photos = S.photos.filter(ph => ph.id !== viewing.id); viewing = null;
  drawMarks(); renderPhotos(); toast('写真を削除しました');
};

/* ---------- 保存 ---------- */
let saveTimer = null;
function scheduleSave() {
  $('#saveState').textContent = '保存待ち';
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  if (!saveTimer || !S.pos) return;
  clearTimeout(saveTimer); saveTimer = null;
  S.pos.updatedAt = new Date().toISOString();
  try { await Store.put('positions', structuredClone(S.pos)); $('#saveState').textContent = '保存済み'; }
  catch (e) { $('#saveState').textContent = '保存できませんでした'; toast('保存できませんでした。スマホの空き容量を確認してください'); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

/* ---------- 書き出し ---------- */
function rows() {
  const p = S.pos;
  return [['階', ...p.points.map((_, i) => circ(i + 1))], ['設計', ...p.points.map(pt => p.design?.[pt.id] ?? '')], ...p.floors.map(f => [f, ...p.points.map(pt => p.values[f]?.[pt.id] ?? '')])];
}
async function shareOrSave(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
const fileBase = () => `${S.site.name}_${S.pos.name}`.replace(/[\\/:*?"<>|]/g, '_');
$('#copyBtn').onclick = async () => {
  const tsv = rows().map(r => r.join('\t')).join('\n');
  try { await navigator.clipboard.writeText(tsv); toast('コピーしました。Excelに貼り付けできます'); }
  catch (e) { toast('コピーできませんでした。CSVで保存してください'); }
};
$('#csvBtn').onclick = () => {
  const q = c => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c;
  const csv = '﻿' + [['現場', S.site.name], ['位置', S.pos.name], ['図面', S.drawing.name], [], ...rows()].map(r => r.map(q).join(',')).join('\r\n');
  shareOrSave(new Blob([csv], { type: 'text/csv' }), fileBase() + '_実測.csv');
};
$('#pngBtn').onclick = () => {
  const out = document.createElement('canvas'); out.width = V.w; out.height = V.h;
  const g = out.getContext('2d'); g.drawImage(cv, 0, 0);
  const r = Math.max(9, V.w / 180) * sizeK();
  S.positions.filter(p => p.page === S.page).forEach(p => p.points.forEach((pt, i) => {
    const x = pt.x * V.w, y = pt.y * V.h;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = p.color; g.fill();
    g.lineWidth = r * 0.15; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `700 ${r * 1.1}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(i + 1), x, y + r * 0.05);
  }));
  g.font = `700 ${r * 1.4}px sans-serif`; g.textAlign = 'left'; g.textBaseline = 'top';
  const label = `${S.site.name}  ${S.positions.filter(p => p.page === S.page).map(p => p.name).join(' / ')}`;
  const w = g.measureText(label).width;
  g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(r, r, w + r, r * 2.2);
  g.fillStyle = '#1f2a36'; g.fillText(label, r * 1.5, r * 1.4);
  out.toBlob(b => shareOrSave(b, fileBase() + '_番号図.png'), 'image/png');
};

/* ---------- Excel（実測値記入表） ---------- */
const EXCELJS = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
const DIFF_LIMIT = 20; // 差がこれ以上なら赤字（mm）
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Excelを作る部品を読み込めませんでした。電波のある所でもう一度お試しください')); document.head.append(s); });
}
// 図面の1ページを、指定の符号の番号入りで画像にする
async function markedPage(d, page, pos, maxDim) {
  const c = document.createElement('canvas'), g = c.getContext('2d');
  if (d.type === 'pdf') {
    const doc = await getPdf(d), pg = await doc.getPage(page);
    const base = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: maxDim / Math.max(base.width, base.height) });
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await pg.render({ canvasContext: g, viewport: vp }).promise;
  } else {
    const img = await createImageBitmap((await Store.get('files', d.id)).blob), k = maxDim / Math.max(img.width, img.height);
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); g.drawImage(img, 0, 0, c.width, c.height);
  }
  const r = Math.max(8, c.width / 160);
  pos.points.forEach((pt, i) => {
    const x = pt.x * c.width, y = pt.y * c.height;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = pos.color; g.fill();
    g.lineWidth = r * 0.15; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `700 ${r * 1.1}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), x, y + r * 0.05);
  });
  return c;
}
const colName = n => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
$('#xlsxBtn').onclick = async () => {
  flushSave();
  const btn = $('#xlsxBtn'), label = btn.textContent; btn.disabled = true;
  try {
    btn.textContent = '準備しています…';
    if (!window.ExcelJS) await loadScript(EXCELJS);
    const poss = (await Store.byIndex('positions', 'site', S.site.id)).filter(p => p.points.length)
      .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
    const wb = new ExcelJS.Workbook(); wb.creator = '実測帳';
    const thin = { style: 'thin', color: { argb: 'FFB8BFB6' } }, box = { top: thin, left: thin, bottom: thin, right: thin };
    const head = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3EDF3' } };
    const offFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFECC4' } };
    // 空欄（""）は文字扱いで「20以上」に入ってしまうので、数値のときだけ赤字にする
    const redRule = ref => { const tl = ref.split(':')[0]; return { ref, rules: [{ type: 'expression', formulae: [`AND(ISNUMBER(${tl}),${tl}>=${DIFF_LIMIT})`], style: { font: { color: { argb: 'FFFF0000' }, bold: true } } }] }; };

    // 集計シート（先頭）
    const sum = wb.addWorksheet('集計');
    sum.columns = [{ width: 10 }, { width: 6 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 8 }, { width: 30 }];
    sum.getCell('A1').value = `${S.site.name}　実測値 集計`; sum.getCell('A1').font = { bold: true, size: 14 };
    sum.getCell('A2').value = `出力：${new Date().toLocaleString('ja-JP')}　単位：mm　差が${DIFF_LIMIT}mm以上は赤字。各符号のシートの数値を直すと自動で更新されます。`;
    sum.getCell('A2').font = { size: 9, color: { argb: 'FF5F6A73' } };
    const sh = sum.getRow(4); ['符号', '番号', '設計値', '中間値', '中間値−設計', '最大値', '最小値', '差', 'データ数', '図面'].forEach((t, i) => { const c = sh.getCell(i + 1); c.value = t; c.font = { bold: true }; c.fill = head; c.border = box; c.alignment = { horizontal: 'center' }; });
    let sr = 5;
    const used = new Set();
    for (const [pi, p] of poss.entries()) {
      btn.textContent = `作成中… ${pi + 1}/${poss.length}`;
      let nm = p.name.replace(/[\[\]:*?\/\\]/g, '_').slice(0, 28) || '符号'; while (used.has(nm)) nm += '_'; used.add(nm);
      const ws = wb.addWorksheet(nm), d = S.site.drawings.find(x => x.id === p.drawingId);
      const n = p.points.length, last = 2 + n - 1; // 列: A=階, B..=①..
      ws.getColumn(1).width = 8; for (let i = 0; i < n; i++) ws.getColumn(2 + i).width = 9;
      ws.getCell('A1').value = `符号 ${p.name}`; ws.getCell('A1').font = { bold: true, size: 14 };
      ws.getCell('A2').value = `${S.site.name}　図面：${d?.name ?? ''}（${p.page}ページ）　単位：mm`; ws.getCell('A2').font = { size: 9, color: { argb: 'FF5F6A73' } };
      if (p.memo) { ws.getCell('A3').value = `メモ：${p.memo}`; ws.getCell('A3').font = { size: 9 }; }
      const hr = ws.getRow(5); hr.getCell(1).value = '階';
      p.points.forEach((_, i) => hr.getCell(2 + i).value = circ(i + 1));
      for (let c = 1; c <= last; c++) { const x = hr.getCell(c); x.font = { bold: true }; x.fill = head; x.border = box; x.alignment = { horizontal: 'center' }; }
      const { off } = analyze(p);
      const DR = 6; // 設計値の行
      const drow = ws.getRow(DR); drow.getCell(1).value = '設計'; drow.getCell(1).font = { bold: true, color: { argb: 'FF24506E' } }; drow.getCell(1).border = box; drow.getCell(1).alignment = { horizontal: 'center' };
      p.points.forEach((pt, ci) => { const c = drow.getCell(2 + ci), v = num(p.design?.[pt.id]); c.value = Number.isFinite(v) ? v : null; c.font = { color: { argb: 'FF24506E' } }; c.border = box; c.alignment = { horizontal: 'center' }; c.numFmt = '0.#'; });
      p.floors.forEach((f, ri) => {
        const row = ws.getRow(DR + 1 + ri); row.getCell(1).value = f; row.getCell(1).border = box; row.getCell(1).alignment = { horizontal: 'center' };
        p.points.forEach((pt, ci) => {
          const cell = row.getCell(2 + ci), v = num(p.values[f]?.[pt.id]);
          cell.value = Number.isFinite(v) ? v : null; cell.border = box; cell.alignment = { horizontal: 'center' }; cell.numFmt = '0.#';
          if (off.has(f + '|' + pt.id)) cell.fill = offFill;
        });
      });
      const r0 = DR + 1, r1 = r0 + p.floors.length - 1, fr = r1 + 1;
      const { stats } = analyze(p);
      [['中間値', 'MEDIAN'], ['最大値', 'MAX'], ['最小値', 'MIN'], ['差', null]].forEach(([lab, fn], k) => {
        const row = ws.getRow(fr + k); row.getCell(1).value = lab; row.getCell(1).font = { bold: true }; row.getCell(1).fill = head; row.getCell(1).border = box;
        p.points.forEach((pt, ci) => {
          const col = colName(1 + ci), rng = `${col}${r0}:${col}${r1}`, s = stats[pt.id], cell = row.getCell(2 + ci);
          const res = !s ? null : fn === 'MEDIAN' ? median(p.floors.map(f => num(p.values[f]?.[pt.id])).filter(Number.isFinite)) : fn === 'MAX' ? s.max : fn === 'MIN' ? s.min : s.max - s.min;
          const formula = fn ? `IF(COUNT(${rng})=0,"",${fn}(${rng}))` : `IF(COUNT(${rng})=0,"",MAX(${rng})-MIN(${rng}))`;
          cell.value = { formula, result: res ?? '' }; cell.border = box; cell.alignment = { horizontal: 'center' }; cell.numFmt = '0.#';
        });
      });
      ws.addConditionalFormatting(redRule(`B${fr + 3}:${colName(last - 1)}${fr + 3}`));
      // 設計との差（実測−設計）の表。設計値か実測値が空なら空欄
      const hasDesign = p.points.some(pt => Number.isFinite(num(p.design?.[pt.id])));
      let tail = fr + 4; // 1始まりの、次に使える行
      if (hasDesign) {
        const tr0 = fr + 5;
        ws.getCell(`A${tr0}`).value = '設計との差（実測−設計）'; ws.getCell(`A${tr0}`).font = { bold: true };
        const hr2 = ws.getRow(tr0 + 1); hr2.getCell(1).value = '階';
        p.points.forEach((_, i) => hr2.getCell(2 + i).value = circ(i + 1));
        for (let c = 1; c <= last; c++) { const x = hr2.getCell(c); x.font = { bold: true }; x.fill = head; x.border = box; x.alignment = { horizontal: 'center' }; }
        p.floors.forEach((f, ri) => {
          const row = ws.getRow(tr0 + 2 + ri); row.getCell(1).value = f; row.getCell(1).border = box; row.getCell(1).alignment = { horizontal: 'center' };
          p.points.forEach((pt, ci) => {
            const col = colName(1 + ci), src = `${col}${r0 + ri}`, dsg = `${col}$${DR}`;
            const v = num(p.values[f]?.[pt.id]), dd = num(p.design?.[pt.id]);
            const cell = row.getCell(2 + ci);
            cell.value = { formula: `IF(OR(${src}="",${dsg}=""),"",${src}-${dsg})`, result: Number.isFinite(v) && Number.isFinite(dd) ? Math.round((v - dd) * 10) / 10 : '' };
            cell.border = box; cell.alignment = { horizontal: 'center' }; cell.numFmt = '+0.#;-0.#;0';
          });
        });
        const ref = `B${tr0 + 2}:${colName(last - 1)}${tr0 + 1 + p.floors.length}`, tl = ref.split(':')[0];
        ws.addConditionalFormatting({ ref, rules: [{ type: 'expression', formulae: [`AND(ISNUMBER(${tl}),ABS(${tl})>=${DIFF_LIMIT})`], style: { font: { color: { argb: 'FFFF0000' }, bold: true } } }] });
        tail = tr0 + 2 + p.floors.length;
      }
      // 集計シートに1番号1行で載せる
      p.points.forEach((pt, ci) => {
        const col = colName(1 + ci), rng = `'${nm}'!${col}${r0}:${col}${r1}`, dref = `'${nm}'!${col}${DR}`, s = stats[pt.id], row = sum.getRow(sr++);
        const vals = p.floors.map(f => num(p.values[f]?.[pt.id])).filter(Number.isFinite), dd = num(p.design?.[pt.id]);
        const med = s ? median(vals) : '';
        const cells = [p.name, circ(ci + 1),
          { formula: `IF(${dref}="","",${dref})`, result: Number.isFinite(dd) ? dd : '' },
          { formula: `IF(COUNT(${rng})=0,"",MEDIAN(${rng}))`, result: med },
          { formula: `IF(OR(COUNT(${rng})=0,${dref}=""),"",MEDIAN(${rng})-${dref})`, result: s && Number.isFinite(dd) ? Math.round((med - dd) * 10) / 10 : '' },
          { formula: `IF(COUNT(${rng})=0,"",MAX(${rng}))`, result: s ? s.max : '' },
          { formula: `IF(COUNT(${rng})=0,"",MIN(${rng}))`, result: s ? s.min : '' },
          { formula: `IF(COUNT(${rng})=0,"",MAX(${rng})-MIN(${rng}))`, result: s ? s.max - s.min : '' },
          { formula: `COUNT(${rng})`, result: vals.length }, `${d?.name ?? ''} p${p.page}`];
        cells.forEach((v, i) => { const c = row.getCell(i + 1); c.value = v; c.border = box; if (i < 9) c.alignment = { horizontal: 'center' }; if (i >= 2 && i <= 7) c.numFmt = i === 4 ? '+0.#;-0.#;0' : '0.#'; });
      });
      // 番号入りの図面を表の下に貼る
      let row = tail; // 0始まりの行番号（画像の置き場所）
      if (d) {
        try {
          const cv2 = await markedPage(d, p.page, p, 1600);
          const id = wb.addImage({ base64: cv2.toDataURL('image/png'), extension: 'png' });
          const w = 720, h = Math.round(w * cv2.height / cv2.width);
          ws.addImage(id, { tl: { col: 0, row }, ext: { width: w, height: h } });
          row += Math.ceil(h / 20) + 2;
        } catch (e) { ws.getCell(`A${row + 1}`).value = '（図面を画像にできませんでした）'; row += 2; }
      }
      // 番号ごとの現場写真を、その下に1枚ずつ貼る
      const photos = (await Store.byIndex('photos', 'position', p.id))
        .map(ph => ({ ph, i: p.points.findIndex(x => x.id === ph.pointId) })).filter(x => x.i >= 0)
        .sort((a, b) => a.i - b.i || a.ph.createdAt.localeCompare(b.ph.createdAt));
      if (photos.length) { ws.getCell(`A${row + 1}`).value = '現場写真'; ws.getCell(`A${row + 1}`).font = { bold: true, size: 12 }; row += 2; }
      for (const { ph, i } of photos) {
        ws.getCell(`A${row + 1}`).value = `${circ(i + 1)}${ph.floor ? '　' + ph.floor : ''}　${new Date(ph.createdAt).toLocaleString('ja-JP')}`;
        const img = await createImageBitmap(ph.blob), w = 360, h = Math.round(w * img.height / img.width);
        const id = wb.addImage({ base64: await blobToDataUrl(ph.blob), extension: 'jpeg' });
        ws.addImage(id, { tl: { col: 0, row: row + 1 }, ext: { width: w, height: h } });
        row += Math.ceil(h / 20) + 3;
      }
      ws.views = [{ state: 'frozen', xSplit: 1, ySplit: DR }];
      ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    }
    sum.addConditionalFormatting(redRule(`H5:H${Math.max(5, sr - 1)}`));
    sum.addConditionalFormatting({ ref: `E5:E${Math.max(5, sr - 1)}`, rules: [{ type: 'expression', formulae: [`AND(ISNUMBER(E5),ABS(E5)>=${DIFF_LIMIT})`], style: { font: { color: { argb: 'FFFF0000' }, bold: true } } }] });
    sum.views = [{ state: 'frozen', ySplit: 4 }];
    btn.textContent = 'ファイルを作っています…';
    const buf = await wb.xlsx.writeBuffer();
    const d = new Date(), pad = x => String(x).padStart(2, '0');
    const name = `${S.site.name}_実測値記入表_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    if (await shareOrSave(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name)) toast('Excelを保存しました（ダウンロード）');
  } catch (err) {
    toast('Excelを作れませんでした：' + (err.message || err));
  } finally { btn.disabled = false; btn.textContent = label; }
};

/* ---------- バックアップ ---------- */
// 現場・図面・番号・実測値をまとめて1つのファイルにし、ドライブなどへ保存する
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
function lastBackup() { try { return localStorage.getItem('jissoku.backupAt'); } catch (e) { return null; } }
async function renderBackupInfo() {
  const el = $('#backupInfo'), at = lastBackup();
  const hasData = (await Store.all('sites')).length > 0;
  const days = at ? Math.floor((Date.now() - new Date(at)) / 86400000) : null;
  el.classList.toggle('warn', hasData && (days === null || days >= 3));
  el.textContent = at
    ? `最後のバックアップ：${new Date(at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` + (days >= 3 ? `（${days}日前。そろそろ保存しましょう）` : '')
    : (hasData ? 'まだバックアップがありません。スマホをなくすとデータが消えるので、保存しておきましょう。' : 'データを入れたら、ここから保存できます。');
}
$('#backupBtn').onclick = async () => {
  flushSave();
  const btn = $('#backupBtn'); btn.disabled = true; btn.textContent = '準備しています…';
  try {
    const [sites, positions, files, photos] = await Promise.all([Store.all('sites'), Store.all('positions'), Store.all('files'), Store.all('photos')]);
    if (!sites.length) { toast('保存するデータがまだありません'); return; }
    const fileData = [], photoData = [];
    for (const f of files) fileData.push({ id: f.id, type: f.blob.type, data: await blobToDataUrl(f.blob) });
    for (const ph of photos) { const { blob, ...rest } = ph; photoData.push({ ...rest, data: await blobToDataUrl(blob) }); }
    const body = JSON.stringify({ app: 'jissokucho', version: 2, exportedAt: new Date().toISOString(), sites, positions, files: fileData, photos: photoData });
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `実測帳バックアップ_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.txt`;
    if (!await shareOrSave(new Blob([body], { type: 'text/plain' }), name)) { toast('保存をやめました'); return; }
    try { localStorage.setItem('jissoku.backupAt', d.toISOString()); } catch (e) {}
    toast('バックアップを作りました'); renderBackupInfo();
  } catch (err) {
    toast('バックアップを作れませんでした：' + (err.message || err));
  } finally { btn.disabled = false; btn.textContent = 'ドライブに保存'; }
};
$('#restoreIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (err) { toast('バックアップのファイルではないようです'); return; }
  if (data?.app !== 'jissokucho' || !Array.isArray(data.sites)) { toast('実測帳のバックアップではないようです'); return; }
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString('ja-JP') : '日時不明';
  if (!await ask(`${when} のバックアップ（現場${data.sites.length}件）を戻します。同じ現場・位置は、バックアップの内容で上書きされます。`)) return;
  try {
    for (const fd of data.files || []) await Store.put('files', { id: fd.id, blob: await (await fetch(fd.data)).blob() });
    for (const s of data.sites) await Store.put('sites', s);
    for (const p of data.positions || []) await Store.put('positions', p);
    for (const { data: url, ...rest } of data.photos || []) await Store.put('photos', { ...rest, blob: await (await fetch(url)).blob() });
    pdfCache.clear(); persist();
    toast(`現場${data.sites.length}件を戻しました`); renderHome();
  } catch (err) { toast('戻せませんでした：' + (err.message || err)); }
};

/* ---------- 起動 ---------- */
history.replaceState({ view: 'home' }, '');
renderHome();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
