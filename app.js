// 実測帳：図面をタップして①②③…と番号を打ち、階ごとの実測値を入れるアプリ
const $ = s => document.querySelector(s);
const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚';
const circ = n => CIRC[n - 1] || `(${n})`;
const COLORS = ['#c42f26', '#1f6fb2', '#2f8a3b', '#a54db8', '#d07a00', '#0f8b8d'];
const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

const S = { site: null, drawing: null, page: 1, pos: null, positions: [], selPoint: null, addMode: true, undo: [] };
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
}
async function saveSite() { S.site.updatedAt = new Date().toISOString(); await Store.put('sites', S.site); }

$('#fileIn').onchange = async e => {
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
  V.s = Math.min(r.width / V.w, r.height / V.h) * 0.96;
  V.x = (r.width - V.w * V.s) / 2; V.y = (r.height - V.h * V.s) / 2;
  apply();
}
function apply() {
  layer.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.s})`;
  drawMarks();
}
new ResizeObserver(() => { if (!$('#vDraw').hidden) fit(); }).observe(stage);
$('#fitBtn').onclick = fit;

function drawMarks() {
  const r = 15 / V.s, fs = 15 / V.s, sw = 2.5 / V.s;
  let h = '';
  S.positions.filter(p => p.page === S.page).forEach(p => {
    const active = S.pos && p.id === S.pos.id;
    p.points.forEach((pt, i) => {
      const x = pt.x * V.w, y = pt.y * V.h, sel = active && S.selPoint === pt.id;
      h += `<g opacity="${active ? 1 : .45}">`
        + (sel ? `<circle cx="${x}" cy="${y}" r="${r * 1.6}" fill="none" stroke="${p.color}" stroke-width="${sw}"/>` : '')
        + `<circle cx="${x}" cy="${y}" r="${r}" fill="${active ? p.color : '#fff'}" stroke="${p.color}" stroke-width="${sw}"/>`
        + `<text x="${x}" y="${y}" font-size="${fs}" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="${active ? '#fff' : p.color}" font-family="sans-serif">${i + 1}</text></g>`;
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
    if (Math.hypot(dx, dy) > 8) gest.moved = true;
    if (!gest.moved) return;
    if (gest.drag) {
      const p = toLayer(e.clientX, e.clientY);
      gest.hit.x = Math.min(1, Math.max(0, p.x / V.w)); gest.hit.y = Math.min(1, Math.max(0, p.y / V.h));
      S.selPoint = gest.hit.id; drawMarks();
    } else { V.x = gest.vx + dx; V.y = gest.vy + dy; apply(); }
  } else if (gest.type === 'pinch' && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const r = stage.getBoundingClientRect();
    const ns = Math.min(8, Math.max(0.05, gest.s * d / gest.d));
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
  const ns = Math.min(8, Math.max(0.05, V.s * k));
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
$('#delPos').onclick = async () => {
  if (!S.pos || !await ask(`位置「${S.pos.name}」の番号と実測値を削除します。元に戻せません。`)) return;
  clearTimeout(saveTimer); saveTimer = null;
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
  renderGrid();
}
function renderGrid() {
  if (!S.pos) return;
  const p = S.pos, t = $('#grid'); t.innerHTML = '';
  $('#posMeta').textContent = `${p.floors[0] ?? ''}〜${p.floors[p.floors.length - 1] ?? ''}・番号 ${p.points.length}個`;
  const si = p.points.findIndex(x => x.id === S.selPoint);
  $('#selBar').hidden = si < 0;
  if (si >= 0) $('#selLabel').textContent = `${circ(si + 1)} を選択中`;
  if (!p.points.length) { t.innerHTML = '<tbody><tr><td class="small muted" style="padding:14px 12px;text-align:left">図面をタップして番号を打つと、ここに入力欄が並びます。</td></tr></tbody>'; return; }
  const hr = t.createTHead().insertRow();
  const c0 = document.createElement('th'); c0.className = 'fl'; c0.textContent = '階'; hr.append(c0);
  p.points.forEach((pt, i) => {
    const th = document.createElement('th'); th.textContent = circ(i + 1); th.dataset.pid = pt.id;
    if (pt.id === S.selPoint) th.className = 'sel';
    th.onclick = () => selectPoint(pt.id, false);
    hr.append(th);
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
      td.append(inp);
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
  document.querySelectorAll('#grid tbody input').forEach(i => i.parentElement.classList.toggle('off', off.has(i.dataset.f + '|' + i.dataset.pid)));
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
  Object.values(p.values).forEach(row => delete row[id]);
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
  const row = S.pos.values[i.dataset.f] ??= {};
  if (v === '') delete row[i.dataset.pid]; else row[i.dataset.pid] = v;
  refreshMarks(); scheduleSave();
});
grid.addEventListener('focusin', e => {
  const i = e.target; if (i.tagName !== 'INPUT' || S.selPoint === i.dataset.pid) return;
  S.selPoint = i.dataset.pid; drawMarks();
  document.querySelectorAll('#grid .sel').forEach(x => x.classList.remove('sel'));
  document.querySelectorAll(`#grid [data-pid="${i.dataset.pid}"]`).forEach(x => (x.tagName === 'INPUT' ? x.parentElement : x).classList.add('sel'));
  const si = S.pos.points.findIndex(x => x.id === i.dataset.pid);
  $('#selBar').hidden = false; $('#selLabel').textContent = `${circ(si + 1)} を選択中`;
});
grid.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
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
  return [['階', ...p.points.map((_, i) => circ(i + 1))], ...p.floors.map(f => [f, ...p.points.map(pt => p.values[f]?.[pt.id] ?? '')])];
}
async function shareOrSave(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
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
  const r = Math.max(14, V.w / 110);
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

/* ---------- 起動 ---------- */
history.replaceState({ view: 'home' }, '');
renderHome();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
