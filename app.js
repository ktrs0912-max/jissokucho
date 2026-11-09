// ピタ測：図面をタップして①②③…と番号を打ち、階ごとの実測値を入れるアプリ
const $ = s => document.querySelector(s);
const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚';
const circ = n => CIRC[n - 1] || `(${n})`;
const COLORS = ['#c42f26', '#1f6fb2', '#2f8a3b', '#a54db8', '#d07a00', '#0f8b8d'];
// PDFを読む部品はアプリの中（lib/pdfjs）に入れてある。日本語の文字の対応表（cmaps）もいっしょ
const PDF_WORKER = 'lib/pdfjs/pdf.worker.min.js';
const pdfOpen = data => pdfjsLib.getDocument({ data, cMapUrl: 'lib/pdfjs/cmaps/', cMapPacked: true });
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

const S = { site: null, drawing: null, page: 1, pos: null, positions: [], selPoint: null, selFloor: null, addMode: true, undo: [], photos: [] };
const pdfCache = new Map();
// 符号の並び順：図面（現場に追加した順）→ページ（図番の順）→名前
const posOrder = (a, b) => {
  const di = p => S.site?.drawings.findIndex(x => x.id === p.drawingId) ?? 0;
  return di(a) - di(b) || a.page - b.page || a.name.localeCompare(b.name, 'ja', { numeric: true });
};

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
  if (push) history.pushState({ view, site: S.site?.id, drawing: S.drawing?.id, folder: S.folder }, '');
  if (view === 'home') { flushSave(); S.site = null; await renderHome(); show('vHome'); }
  if (view === 'site') { flushSave(); S.drawing = null; await renderSite(); show('vSite'); }
  if (view === 'draw') { show('vDraw'); await openDrawing(); }
}
window.addEventListener('popstate', e => {
  const v = e.state?.view || 'home';
  if (v === 'home') { S.folder = e.state?.folder || null; $('#siteSearch').value = ''; }
  if (v === 'home' || !S.site) go('home', false);
  else if (v === 'site' || !S.drawing) go('site', false);
  else go('draw', false);
});
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => history.back());

/* ---------- ホーム ---------- */
// 現場ごとの色（名前から決める。いつも同じ色になる）
const siteColor = name => COLORS[[...name].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7) % COLORS.length];
const shortDate = iso => { const d = new Date(iso), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ja-JP', d.getFullYear() === now.getFullYear() ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' }); };
/* ---------- フォルダ：現場をまとめる ----------
   フォルダは現場と同じ保存場所（sites）に kind:'folder' として入れる（ドライブ同期・バックアップにそのまま乗る）。
   現場の folderId に、入っているフォルダの id を持つ。 */
S.folder = null; // ホームで開いているフォルダ
const isFolder = r => r?.kind === 'folder';
const FOLDER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6c.6 0 1.2.3 1.6.7L12 7h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';
let homeCache = { folders: [], sites: [] };
async function renderHome() {
  const all = await Store.all('sites');
  const folders = all.filter(isFolder).sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  const sites = all.filter(r => !isFolder(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const fids = new Set(folders.map(f => f.id)), fname = new Map(folders.map(f => [f.id, f.name]));
  const folderOf = st => st.folderId && fids.has(st.folderId) ? st.folderId : null; // 消えたフォルダに入っていた現場は外に出す
  if (S.folder && !fids.has(S.folder)) S.folder = null;
  const cur = folders.find(f => f.id === S.folder);
  homeCache = { folders, sites };
  const posCount = new Map();
  for (const p of await Store.all('positions')) posCount.set(p.siteId, (posCount.get(p.siteId) || 0) + 1);
  // フォルダのカード（いちばん上の階層だけ）
  const fl = $('#folderList'); fl.innerHTML = '';
  if (!cur) folders.forEach(f => {
    const inside = sites.filter(st => folderOf(st) === f.id), latest = inside[0]?.updatedAt || f.updatedAt;
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.className = 'sitecard foldercard';
    b.innerHTML = `<i class="fico">${FOLDER_SVG}</i>
      <span class="sbody"><b>${esc(f.name)}</b><span class="meta"><span>現場 ${inside.length}件</span>${inside.length ? `<span>更新 ${shortDate(latest)}</span>` : ''}</span>
      <span class="peek">${inside.slice(0, 3).map(st => esc(st.name)).join('・')}${inside.length > 3 ? ' ほか' : ''}</span></span>
      <span class="chev" aria-hidden="true">›</span>`;
    b.onclick = () => openFolder(f.id);
    li.append(b); fl.append(li);
  });
  // 現場のカード。検索の時はフォルダの中の現場も出すので、全部作っておいて表示を切り替える
  const ul = $('#siteList'); ul.innerHTML = '';
  sites.forEach(st => {
    const li = document.createElement('li'), b = document.createElement('button'), fid = folderOf(st);
    li.className = 'siteli'; li.dataset.folder = fid || ''; li.dataset.name = st.name.toLowerCase();
    b.type = 'button'; b.className = 'sitecard';
    const n = posCount.get(st.id) || 0;
    b.innerHTML = `<i class="badge" style="--c:${siteColor(st.name)}">${esc([...st.name][0] || '？')}</i>
      <span class="sbody"><b>${esc(st.name)}</b><span class="meta">${fid ? `<span class="fchip">${FOLDER_SVG}${esc(fname.get(fid))}</span>` : ''}<span>図面 ${st.drawings.length}枚</span><span>位置 ${n}</span><span>更新 ${shortDate(st.updatedAt)}</span></span></span>`;
    b.onclick = () => { S.site = st; go('site'); };
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'more'; more.textContent = '…'; more.setAttribute('aria-label', `${st.name}をフォルダに入れる・移す`);
    more.onclick = () => moveSite(st);
    li.append(b, more); ul.append(li);
  });
  // 見出し・件数・ボタン
  $('#folderBar').hidden = !cur; $('#addFolder').hidden = !!cur;
  $('#homeTitle').textContent = cur ? cur.name : '現場';
  $('#homeFolderIcon').hidden = !cur; $('#homeFolderIcon').innerHTML = FOLDER_SVG;
  $('#newSiteName').placeholder = cur ? `「${cur.name}」に入れる現場の名前` : '現場の名前（例：みどりハイツ）';
  const here = cur ? sites.filter(st => folderOf(st) === cur.id).length : sites.length;
  $('#siteCount').textContent = cur ? (here ? `${here}件の現場` : 'まだ現場がありません') : sites.length || folders.length ? `${sites.length}件の現場` + (folders.length ? `・フォルダ ${folders.length}個` : '') : 'まだ現場がありません';
  $('#homeEmpty').hidden = !!cur || sites.length > 0 || folders.length > 0;
  $('#siteSearch').hidden = sites.length < 6;
  $('#siteSearch').placeholder = cur ? `「${cur.name}」の中をさがす` : '現場をさがす（フォルダの中もさがします）';
  filterSites();
  renderBackupInfo();
}
function filterSites() {
  const q = $('#siteSearch').value.trim().toLowerCase(), cur = S.folder;
  const main = $('.homemain'); main.classList.toggle('searching', !!q && !cur);
  let shown = 0, loose = 0;
  $('#siteList').querySelectorAll('li').forEach(li => {
    const f = li.dataset.folder;
    const inScope = cur ? f === cur : (q ? true : !f);
    const on = inScope && (!q || li.dataset.name.includes(q));
    li.hidden = !on; shown += on; if (!cur && !f) loose++;
  });
  $('#folderList').hidden = !!q || !!cur;
  $('#looseTitle').hidden = !!cur || !!q || !homeCache.folders.length || !loose;
  $('#siteNone').hidden = !q || shown > 0;
  $('#folderEmpty').hidden = !cur || !!q || shown > 0;
}
function openFolder(id) {
  S.folder = id; $('#siteSearch').value = '';
  history.pushState({ view: 'home', folder: id }, '');
  renderHome(); window.scrollTo(0, 0);
}
$('#folderUp').onclick = () => {
  if (history.state?.folder) history.back();
  else { S.folder = null; $('#siteSearch').value = ''; renderHome(); }
};
// 名前を入れる小さな画面
function askName(title, value = '') {
  return new Promise(res => {
    const d = $('#nameDlg'); $('#nameTitle').textContent = title; $('#nameIn').value = value;
    d.querySelector('form').onsubmit = e => { e.preventDefault(); const v = $('#nameIn').value.trim(); d.close(); res(e.submitter?.value === 'ok' && v ? v : null); };
    d.oncancel = () => res(null);
    d.showModal(); $('#nameIn').focus(); $('#nameIn').select();
  });
}
async function newFolder(name) {
  const now = new Date().toISOString();
  const f = { id: uid(), kind: 'folder', name, drawings: [], createdAt: now, updatedAt: now };
  await Store.put('sites', f); return f;
}
$('#addFolder').onclick = async () => {
  const name = await askName('新しいフォルダ');
  if (!name) return;
  const f = await newFolder(name);
  toast(`フォルダ「${name}」を作りました。現場の「…」から入れられます`);
  openFolder(f.id);
};
$('#folderRename').onclick = async () => {
  const f = homeCache.folders.find(x => x.id === S.folder); if (!f) return;
  const name = await askName('フォルダの名前を変える', f.name);
  if (!name || name === f.name) return;
  f.name = name; f.updatedAt = new Date().toISOString(); await Store.put('sites', f);
  renderHome(); toast('名前を変えました');
};
$('#folderDel').onclick = async () => {
  const f = homeCache.folders.find(x => x.id === S.folder); if (!f) return;
  const inside = homeCache.sites.filter(st => st.folderId === f.id);
  if (!await ask(`フォルダ「${f.name}」を消します。` + (inside.length ? `中の現場（${inside.length}件）は消さずに、フォルダの外に出します。` : ''))) return;
  const now = new Date().toISOString();
  for (const st of inside) { delete st.folderId; st.updatedAt = now; await Store.put('sites', st); }
  await Store.del('sites', f.id);
  toast('フォルダを消しました');
  $('#folderUp').onclick();
};
// 現場をフォルダに入れる・移す・出す
let moving = null;
function moveSite(st) {
  moving = st;
  $('#moveTitle').textContent = `「${st.name}」をどこに入れますか`;
  const box = $('#moveList'); box.innerHTML = '';
  const add = (label, fid, here) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'moveopt' + (here ? ' here' : '');
    b.innerHTML = (fid ? `<i class="fico">${FOLDER_SVG}</i>` : '<i class="fico out">↩</i>') + `<span>${esc(label)}</span>` + (here ? '<small>今ここ</small>' : '');
    b.disabled = here; b.onclick = () => doMove(fid);
    box.append(b);
  };
  homeCache.folders.forEach(f => add(f.name, f.id, st.folderId === f.id));
  if (st.folderId && homeCache.folders.some(f => f.id === st.folderId)) add('フォルダから出す', null, false);
  if (!homeCache.folders.length) box.innerHTML = '<p class="note">まだフォルダがありません。下のボタンで作れます。</p>';
  $('#moveDlg').showModal();
}
async function doMove(fid) {
  const st = moving; if (!st) return;
  if (fid) st.folderId = fid; else delete st.folderId;
  st.updatedAt = new Date().toISOString();
  await Store.put('sites', st);
  $('#moveDlg').close(); moving = null;
  toast(fid ? `「${homeCache.folders.find(f => f.id === fid)?.name}」に入れました` : 'フォルダから出しました');
  renderHome();
}
$('#moveNew').onclick = async () => {
  const st = moving; $('#moveDlg').close();
  const name = await askName('新しいフォルダ'); if (!name) return;
  const f = await newFolder(name); homeCache.folders.push(f); moving = st; await doMove(f.id);
};
$('#moveCancel').onclick = () => { $('#moveDlg').close(); moving = null; };
$('#siteSearch').oninput = filterSites;
$('#demoBtn').onclick = async () => {
  const b = $('#demoBtn'); b.disabled = true; b.textContent = '見本を用意しています…';
  try {
    const site = await Demo.create(); persist();
    S.site = site; await go('site');
    S.drawing = site.drawings[0]; S.page = 1; S.pos = null; go('draw');
    toast('見本の現場です。番号や数字をさわってみてください');
  } catch (err) { toast('見本を作れませんでした：' + (err.message || err)); }
  finally { b.disabled = false; b.textContent = '見本の現場で試してみる'; }
};
$('#newSiteForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('#newSiteName').value.trim();
  if (!name) { $('#newSiteName').focus(); return; }
  const now = new Date().toISOString();
  const s = { id: uid(), name, drawings: [], createdAt: now, updatedAt: now, ...(S.folder ? { folderId: S.folder } : {}) };
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
    const n = poss.filter(p => p.drawingId === d.id).sort(posOrder);
    const sp = document.createElement('span');
    sp.textContent = `${d.pages}ページ` + (n.length ? `・${n.map(p => p.name).join(' ')}` : '');
    b.append(sp);
    b.onclick = () => { S.drawing = d; S.page = d.lastPage || 1; S.pos = null; go('draw'); };
    b.className = 'open';
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'del danger'; del.textContent = '削除'; del.setAttribute('aria-label', `${d.name} を削除`);
    del.onclick = () => delDrawing(d, n);
    li.append(b, del); ul.append(li);
  });
  $('#siteEmpty').hidden = S.site.drawings.length > 0;
  $('#xlsxBox').hidden = !poss.some(p => p.points.length);
}
// 図面を1枚だけ消す（その図面の符号・実測値・写真もいっしょに）
async function delDrawing(d, poss) {
  const extra = poss.length ? `符号${poss.length}個と、その実測値・写真もいっしょに消えます。` : '';
  if (!await ask(`「${d.name}」を削除します。${extra}元に戻せません。`)) return;
  for (const p of poss) {
    for (const ph of await Store.byIndex('photos', 'position', p.id)) await Store.del('photos', ph.id);
    await Store.del('positions', p.id);
  }
  await Store.del('files', d.id); pdfCache.delete(d.id);
  S.site.drawings = S.site.drawings.filter(x => x.id !== d.id);
  await saveSite(); await renderSite();
  toast('図面を削除しました');
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
      if (!window.pdfjsLib) throw new Error('PDFを読む部品が読み込めていません。アプリを開き直してください');
      const doc = await pdfOpen(new Uint8Array(await f.arrayBuffer())).promise;
      pages = doc.numPages;
      // スキャンした図面（文字のデータがない）なら、文字を読み取る部品を裏で保存しておく
      try { const tc = await (await doc.getPage(1)).getTextContent(); if (tc.items.length < 20) OCR.prefetch(); } catch (e) {}
      doc.destroy();
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
  const p = pdfOpen(new Uint8Array(await rec.blob.arrayBuffer())).promise;
  pdfCache.set(d.id, p); return p;
}
// ページを素早く切り替えても、最後に選んだページだけを描く（裏の別キャンバスに描いてから差し替え）
let renderSeq = 0, renderTask = null;
async function renderPage() {
  const d = S.drawing, m = $('#stageMsg'), seq = ++renderSeq;
  m.hidden = false; m.textContent = '図面を表示しています…'; hiReset();
  try { renderTask?.cancel(); } catch (e) {}
  try {
    const tmp = document.createElement('canvas');
    if (d.type === 'pdf') {
      if (!window.pdfjsLib) throw new Error('PDFを読む部品が読み込めていません。アプリを開き直してください');
      const doc = await getPdf(d), page = await doc.getPage(S.page);
      if (seq !== renderSeq) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 2600 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      V.k = scale; V.pg = page;
      tmp.width = Math.round(vp.width); tmp.height = Math.round(vp.height);
      renderTask = page.render({ canvasContext: tmp.getContext('2d'), viewport: vp });
      await renderTask.promise;
    } else {
      V.pg = null;
      const rec = await Store.get('files', d.id);
      const img = await createImageBitmap(rec.blob);
      const k = Math.min(1, 3000 / Math.max(img.width, img.height));
      V.k = k; // 画面の図面1ドット＝写真の何ドットか（文字の読み取りで使う）
      tmp.width = Math.round(img.width * k); tmp.height = Math.round(img.height * k);
      tmp.getContext('2d').drawImage(img, 0, 0, tmp.width, tmp.height);
    }
    if (seq !== renderSeq) return;
    cv.width = tmp.width; cv.height = tmp.height; cv.getContext('2d').drawImage(tmp, 0, 0);
    V.w = cv.width; V.h = cv.height;
    svg.setAttribute('width', V.w); svg.setAttribute('height', V.h);
    svg.setAttribute('viewBox', `0 0 ${V.w} ${V.h}`);
    hiReset(); m.hidden = true; fit(); drawMarks();
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
  drawMarks(); hiSoon();
}
/* 拡大した時は、見えている所だけをPDFから細かく描きなおして重ねる（線や小さい文字もくっきり） */
const hi = $('#hi');
let hiTimer = null, hiSeq = 0, hiTask = null;
function hiReset() { hiSeq++; clearTimeout(hiTimer); try { hiTask?.cancel(); } catch (e) {} hi.hidden = true; }
function hiSoon() { clearTimeout(hiTimer); hiTimer = setTimeout(hiRender, 250); }
async function hiRender() {
  const pg = V.pg, seq = ++hiSeq;
  try { hiTask?.cancel(); } catch (e) {}
  const dpr = window.devicePixelRatio || 1;
  let f = V.s * dpr; // 図面の1点が画面の何ドットになるか
  if (!pg || f <= 1.1 || $('#vDraw').hidden) { hi.hidden = true; return; }
  // 画面に見えている範囲（図面の座標）。少し外側まで描いておく
  const r = stage.getBoundingClientRect(), mg = 0.15;
  const vw = r.width / V.s, vh = r.height / V.s, vx = -V.x / V.s, vy = -V.y / V.s;
  const x0 = Math.max(0, vx - vw * mg), y0 = Math.max(0, vy - vh * mg);
  const x1 = Math.min(V.w, vx + vw * (1 + mg)), y1 = Math.min(V.h, vy + vh * (1 + mg));
  if (x1 <= x0 || y1 <= y0) return;
  // スマホが扱えるキャンバスの大きさにおさえる（1辺4096・合計1600万ドットまで）
  f = Math.min(f, 4096 / (x1 - x0), 4096 / (y1 - y0), Math.sqrt(16e6 / ((x1 - x0) * (y1 - y0))));
  if (f <= 1.1) { hi.hidden = true; return; }
  const tmp = document.createElement('canvas');
  tmp.width = Math.ceil((x1 - x0) * f); tmp.height = Math.ceil((y1 - y0) * f);
  const vp = pg.getViewport({ scale: V.k * f, offsetX: -x0 * f, offsetY: -y0 * f });
  try {
    hiTask = pg.render({ canvasContext: tmp.getContext('2d'), viewport: vp });
    await hiTask.promise;
  } catch (e) { return; }
  if (seq !== hiSeq || pg !== V.pg) return;
  hi.width = tmp.width; hi.height = tmp.height; hi.getContext('2d').drawImage(tmp, 0, 0);
  Object.assign(hi.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
  hi.hidden = false;
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

/* ---------- お絵描き（図面のページごとに保存。道具の中身は annot.js） ---------- */
// 充電式のタッチペン（Apple Pencil・Sペンなど）でなぞると書き込み、指では番号を打つ・図面を動かす
// ペンを使ったことのない端末では「指で書く」の切り替えを出して、指でも書けるようにする
const isPen = e => e.pointerType === 'pen';
let penId = null; // 今書いているペン
let penSeen = false, fingerDraw = false;
try { penSeen = localStorage.getItem('jissoku.penSeen') === '1'; } catch (e) {}
function fingerBtns() {
  document.querySelectorAll('.fingerbtn').forEach(b => {
    b.hidden = penSeen; b.classList.toggle('on', fingerDraw); b.setAttribute('aria-pressed', fingerDraw);
    b.textContent = fingerDraw ? '☝ 指で書く：オン' : '☝ 指で書く';
  });
  stage.classList.toggle('fdraw', fingerDraw);
}
function setFingerDraw(on, say) {
  fingerDraw = on; drawAnnot.clearSel(); photoAnnot.clearSel(); fingerBtns(); drawMarks();
  if (say) toast(on ? '指で書けます。図面を動かすときは2本指' : '指では番号を打ち、図面を動かします');
}
// 充電式のペンが初めて使われたら覚えておき、以後は「ペンで書く・指で動かす」に固定する
function notePen(e) {
  if (!isPen(e) || penSeen) return;
  penSeen = true; try { localStorage.setItem('jissoku.penSeen', '1'); } catch (err) {}
  const was = fingerDraw; fingerDraw = false; fingerBtns();
  toast('タッチペンを見つけました。これからはペンで書き、指で図面を動かします');
  if (was) drawMarks();
}
function addFingerBtn(bar, cls) {
  const b = document.createElement('button'); b.type = 'button'; b.className = cls + ' fingerbtn';
  b.onclick = () => setFingerDraw(!fingerDraw, true);
  bar.prepend(b);
}
function drawStrokes(g, d, page, W, H) { drawItems(g, d.sketch?.[page] || [], W, H); }
const drawAnnot = new Annotator({
  items: () => ((S.drawing.sketch ??= {})[S.page] ??= []),
  peek: () => S.drawing?.sketch?.[S.page] || [],
  save: () => saveSite(),
  render: () => drawMarks(),
  size: () => ({ W: V.w || 1, H: V.h || 1 }),
  k: () => V.s,
  textF: 1,
  bar: $('#penBar'),
  extra: [{ label: '全部消す', run: async () => {
    const list = S.drawing?.sketch?.[S.page];
    if (!list?.length) { toast('消すものがありません'); return; }
    if (!await ask(`このページに書いた線・文字（${list.length}個）を全部消します。`)) return;
    drawAnnot.record(); list.splice(0); drawAnnot.clearSel(); saveSite(); drawMarks(); toast('全部消しました（「1つ戻す」で元に戻せます）');
  } }],
});
// 文字の入力画面（図面と写真で共用）
let textTarget = null;
function showTextDlg(edit, onSave, onDelete, after) {
  textTarget = { edit, onSave, onDelete, after };
  $('#textTitle').textContent = edit ? '文字を直す' : '文字を書く';
  $('#textIn').value = edit ? edit.s : '';
  $('#textOk').textContent = edit ? '直す' : '置く';
  $('#textDel').hidden = !edit;
  $('#textDlg').showModal(); $('#textIn').focus();
}
$('#textForm').onsubmit = e => {
  e.preventDefault();
  const s = $('#textIn').value.trim();
  $('#textDlg').close();
  if (s && textTarget) textTarget.onSave(s);
  textTarget?.after?.();
};
$('#textDel').onclick = () => { $('#textDlg').close(); if (textTarget?.edit) textTarget.onDelete(); textTarget?.after?.(); };
$('#textCancel').onclick = () => { $('#textDlg').close(); textTarget?.after?.(); };
$('#textDlg').addEventListener('cancel', () => textTarget?.after?.()); // 戻るボタンで閉じた時

function drawMarks() {
  const k = sizeK(), r = 9 * k / V.s, fs = 10 * k / V.s, sw = 1.5 * Math.max(0.7, k) / V.s;
  let h = S.drawing ? drawAnnot.svg() : '';
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
const annotPos = e => { const p = toLayer(e.clientX, e.clientY); return [p.x / V.w, p.y / V.h]; };
function hitPoint(cx, cy) {
  if (!S.pos || S.pos.page !== S.page) return null;
  const p = toLayer(cx, cy), lim = 22 / V.s;
  let best = null, bd = lim;
  S.pos.points.forEach(pt => { const d = Math.hypot(pt.x * V.w - p.x, pt.y * V.h - p.y); if (d < bd) { bd = d; best = pt; } });
  return best;
}
stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.tools')) return;
  notePen(e);
  if (isPen(e)) {
    if (penId !== null) return;
    // 手のひらが先に触れて始まった操作は取りやめて、ペンの書き込みを優先する
    if (gest) { if (gest.drag && gest.moved) scheduleSave(); ptrs.clear(); gest = null; }
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    penId = e.pointerId; drawAnnot.down(annotPos(e), e); return;
  }
  if (penId !== null) return; // ペンで書いている間は、画面に触れた手のひら・指を無視する
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (fingerDraw && ptrs.size === 1) { // 指で書く：1本指は書き込みの道具に渡す
    drawAnnot.down(annotPos(e), e); gest = { type: 'annot' }; return;
  }
  if (gest?.type === 'annot') { drawAnnot.cancel(); drawMarks(); } // 2本目の指が来たら書き込みはやめて拡大・移動へ
  if (ptrs.size === 1) {
    const hit = hitPoint(e.clientX, e.clientY);
    gest = { type: 'one', sx: e.clientX, sy: e.clientY, vx: V.x, vy: V.y, t: Date.now(), moved: false, hit, drag: hit && !S.addMode };
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    gest = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s: V.s, vx: V.x, vy: V.y };
  }
});
stage.addEventListener('pointermove', e => {
  if (e.pointerId === penId) { drawAnnot.move(annotPos(e), e); return; }
  if (!ptrs.has(e.pointerId) || !gest) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gest.type === 'annot') { drawAnnot.move(annotPos(e), e); return; }
  if (gest.type === 'one') {
    const dx = e.clientX - gest.sx, dy = e.clientY - gest.sy;
    if (Math.hypot(dx, dy) > 12) gest.moved = true;
    if (!gest.moved) return;
    // 全体表示のときは1本指で動かさない（誤って動くのを防ぐ）。拡大中だけ1本指で動かせる
    if (gest.drag) {
      const p = toLayer(e.clientX, e.clientY);
      gest.hit.x = Math.min(1, Math.max(0, p.x / V.w)); gest.hit.y = Math.min(1, Math.max(0, p.y / V.h));
      S.selPoint = gest.hit.id; drawMarks();
    } else if (V.s > (V.minS || 0) * 1.05) { V.x = gest.vx + dx; V.y = gest.vy + dy; apply(); }
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
  if (e.pointerId === penId) {
    penId = null;
    if (e.type === 'pointercancel') { drawAnnot.cancel(); drawMarks(); } else drawAnnot.up(annotPos(e), e);
    return;
  }
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (gest?.type === 'annot' && ptrs.size === 0) {
    gest = null;
    if (e.type === 'pointercancel') { drawAnnot.cancel(); drawMarks(); } else drawAnnot.up(annotPos(e), e);
    return;
  }
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
// 位置の名前の横に出す小さい文字（階の範囲・番号の数・符号が出てくるページ）
const posMeta = p => `${p.floors[0] ?? ''}〜${p.floors[p.floors.length - 1] ?? ''}・番号 ${p.points.length}個` + (p.foundPages?.length ? `・出てくるページ：${p.foundPages.join('・')}` : '');
// 以前の版が符号さがしでメモ欄に自動で入れた文は、出てくるページの記録に移してメモ欄を空にする（手で書き足していたら触らない）
const AUTO_MEMO = /^図面から見つけた符号（出てくるページ：([\d・]+)）$/;
async function moveAutoMemo(list) {
  for (const p of list) {
    const m = (p.memo || '').trim().match(AUTO_MEMO);
    if (!m) continue;
    p.foundPages = m[1].split('・').map(Number); p.memo = ''; p.updatedAt = new Date().toISOString();
    await Store.put('positions', p);
  }
}
async function openDrawing() {
  $('#drawTitle').textContent = S.drawing.name;
  S.positions = (await Store.byIndex('positions', 'drawing', S.drawing.id)).sort(posOrder);
  await moveAutoMemo(S.positions);
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
  S.positions.sort(posOrder).forEach(p => {
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
/* ---------- 図面から符号をさがす（PDFの文字から。スキャン図面は不可） ---------- */
// 「BT」の下に「1」のように上下に並んだ文字の組や、「KT-2」のような書き方を符号として拾う
const SYM_SKIP = new Set(['X', 'Y', 'FL', 'SL', 'GL', 'CL', 'W', 'H', 'R', 'M', 'P', 'TW', 'DW', 'PW', 'L', 'S', 'K', 'A', 'B', 'C', 'D', 'N', 'E', 'NO', 'MM', 'AL', 'SUS', 'RTB', 'PTW', 'PTH', 'ALC', 'RC', 'FAX', 'TEL']);
function findSymbols(pages) {
  const found = new Map(); // 符号 → Map(ページ→回数)
  const boxes = new Map(); // 符号 → Map(ページ→[文字の枠])（一覧から図面で確かめる時に丸で囲む）
  const stacked = new Set(), dashed = new Map(); // 上下に並んだ形の文字／「KT-2」形の候補
  const add = (map, name, page) => {
    if (!map.has(name)) map.set(name, new Map());
    const m = map.get(name); m.set(page, (m.get(page) || 0) + 1);
  };
  const box = (name, page, ...ts) => {
    if (!boxes.has(name)) boxes.set(name, new Map());
    const m = boxes.get(name); if (!m.has(page)) m.set(page, []);
    const x0 = Math.min(...ts.map(t => t.x)), x1 = Math.max(...ts.map(t => t.x + Math.max(t.w, t.h * 0.6)));
    const y0 = Math.min(...ts.map(t => -t.y - t.h)), y1 = Math.max(...ts.map(t => -t.y)); // 画面の向き（下向き）に戻す
    m.get(page).push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };
  for (const { page, items } of pages) {
    const letters = items.filter(t => /^[A-Z]{1,3}$/.test(t.s) && !SYM_SKIP.has(t.s));
    const nums = items.filter(t => /^\d{1,2}[ア-ン]?$/.test(t.s)); // 「1」や「1ア」
    const num = s => s.replace(/^0+(?=\d)/, '');
    for (const L of letters) {
      const lc = L.x + L.w / 2;
      const n = nums.find(N => { const dy = L.y - N.y, nc = N.x + N.w / 2; return Math.abs(nc - lc) < L.h * 1.2 && dy > L.h * 0.3 && dy < L.h * 2.2; });
      if (n) { const name = `${L.s}-${num(n.s)}`; add(found, name, page); box(name, page, L, n); stacked.add(L.s); }
    }
    for (const t of items) {
      const m = t.s.match(/^([A-Z]{1,3})\s*[-‐ー－]\s*(\d{1,2}[ア-ン]?)$/);
      if (m && !SYM_SKIP.has(m[1])) { const name = `${m[1]}-${num(m[2])}`; add(dashed, name, page); box(name, page, t); }
    }
  }
  // 「KT-2」形は、上下形の符号が無い図面か、同じ文字の符号がある時だけ採用（部品の型番 PKS-50 などを除くため）
  dashed.forEach((pg, name) => {
    if (stacked.size && !stacked.has(name.split('-')[0])) return;
    pg.forEach((c, p) => { if (!found.has(name)) found.set(name, new Map()); found.get(name).set(p, (found.get(name).get(p) || 0) + c); });
  });
  // 割り当てるページ：その符号が何度も出てきて、ほかの符号が少ないページ（その符号の立・平面図）を選ぶ
  const perPage = new Map();
  found.forEach(pg => pg.forEach((_, p) => perPage.set(p, (perPage.get(p) || 0) + 1)));
  return [...found.entries()].map(([name, pg]) => {
    const score = p => pg.get(p) / perPage.get(p);
    const best = [...pg.keys()].sort((a, b) => score(b) - score(a) || a - b)[0];
    return { name, page: best, pages: [...pg.keys()].sort((a, b) => a - b), boxes: boxes.get(name) || new Map() };
  }).sort((a, b) => a.page - b.page || a.name.localeCompare(b.name, 'ja', { numeric: true }));
}
// そのページの「2～7F」「3F」のような書き方から階の範囲を推測する
const FLOOR_RE = '(?<![A-Z0-9.])(\\d{1,2})(?:\\s*[～~〜̃˜\\-・,、]\\s*(\\d{1,2}))?\\s*[F階]';
// 「4~9F 11~22F」「5~9F、22F」のように並んでいれば、一番下〜一番上にまとめる
const FLOORS_RE = `(${FLOOR_RE}(?:\\s*[,、]?\\s*${FLOOR_RE.replace(/\((?!\?)/g, '(?:')})*)`;
const floorPair = m => {
  const ns = [...m[1].matchAll(/(\d{1,2})(?:\s*[～~〜̃˜\-・,、]\s*(\d{1,2}))?\s*[F階]/gi)].flatMap(x => x[2] ? [+x[1], +x[2]] : [+x[1]]);
  const a = Math.min(...ns), b = Math.max(...ns);
  return ns.length && a >= 1 && b <= 60 ? [a, b] : null;
};
function guessFloors(text, name) {
  const t = text.normalize('NFKC');
  if (name) {
    // 仕様の行「6~22F 西面 バルコニー … BT 20」のように、符号のすぐ近くに書かれた階を優先する
    const [L, N] = name.split('-'), sym = new RegExp(`(?<![A-Z])${L}\\s*[-‐ー－]?\\s*${N}(?!\\d)`, 'gi');
    let best = null;
    for (const s of t.matchAll(sym)) {
      for (const m of t.matchAll(new RegExp(FLOORS_RE + '\\s*[東西南北]面', 'gi'))) {
        const f = floorPair(m), dist = m.index < s.index ? s.index - m.index : m.index - s.index - s[0].length + 20;
        if (f && dist < 120 && (!best || dist < best.dist)) best = { f, dist };
      }
    }
    if (best) return best.f;
    // 図面の題名「品名 2~4F 西立・平面図」
    const ti = t.match(new RegExp(FLOORS_RE + '\\s*\\S*[立平断]面図', 'i'));
    if (ti && floorPair(ti)) return floorPair(ti);
  }
  // 「2～7F」のような範囲（前後が英数字の型番 PS50FAA などは除く）
  const m = t.match(/(?<![A-Z0-9])(\d{1,2})\s*[～~〜̃˜\-・]\s*(\d{1,2})\s*[F階](?![A-Z])/i);
  if (m && +m[1] <= +m[2] && +m[2] <= 60) return [+m[1], +m[2]];
  // 「1F」「5F」…がいくつも書いてあれば、その一番下〜一番上
  const fl = [...t.matchAll(/(?<![A-Z0-9])(\d{1,2})\s*[F階](?![A-Z])/gi)].map(x => +x[1]).filter(n => n >= 1 && n <= 60);
  return fl.length ? [Math.min(...fl), Math.max(...fl)] : [1, 1];
}
async function pdfPagesText(d, onProgress) {
  return docPagesText(await getPdf(d), onProgress);
}
async function docPagesText(doc, onProgress) {
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress?.(p, doc.numPages);
    const pg = await doc.getPage(p), vt = pg.getViewport({ scale: 1 }).transform, tc = await pg.getTextContent();
    // 回転して保存された図面でも、画面に見えている向きで上下左右を判断する（y は上向きにそろえる）
    const items = tc.items.filter(i => i.str && i.str.trim()).map(i => {
      const t = pdfjsLib.Util.transform(vt, i.transform);
      return { s: i.str.trim().normalize('NFKC').toUpperCase(), x: t[4], y: -t[5], h: Math.hypot(t[2], t[3]) || i.height || 10, w: i.width || 0 };
    });
    out.push({ page: p, items, text: tc.items.map(i => i.str).join(' ') });
  }
  return out;
}
let symFound = [], symPages = [];
const symChecks = () => [...$('#symList').querySelectorAll('input[type=checkbox]:not(:disabled)')];
function renderSymAll() {
  const cs = symChecks(), on = cs.filter(c => c.checked).length;
  $('#symAll').hidden = !cs.length;
  $('#symAll').textContent = on === cs.length ? '全部はずす' : '全部えらぶ';
  $('#symAdd').textContent = on ? `選んだ${on}個を追加` : '選んだ符号を追加';
}
// 図面の1ページを「元の大きさ」の座標（PDFは1倍、写真は元の画素）で描くための入れ物
// unitPt：1ポイント（1/72インチ）が何単位か。写真は大きさが分からないので、写真いっぱいにA3の図面が写っているとみなす
async function pageSource(d, page) {
  if (d.type === 'pdf') {
    const pg = await (await getPdf(d)).getPage(page), base = pg.getViewport({ scale: 1 });
    return { w: base.width, h: base.height, unitPt: 1,
      draw: (g, k, x0 = 0, y0 = 0) => pg.render({ canvasContext: g, viewport: pg.getViewport({ scale: k, offsetX: -x0 * k, offsetY: -y0 * k }) }).promise };
  }
  const img = await createImageBitmap((await Store.get('files', d.id)).blob);
  return { w: img.width, h: img.height, unitPt: Math.max(img.width, img.height) / 1190, photo: true,
    draw: async (g, k, x0 = 0, y0 = 0) => { g.imageSmoothingQuality = 'high'; g.drawImage(img, -x0 * k, -y0 * k, img.width * k, img.height * k); } };
}
// 写真は場所によって明るさが違う（影・照明のむら）ので、まわりの明るさで割ってならし、白い紙に黒い線の形にそろえる
function evenLight(c) {
  const W = c.width, H = c.height, s = Math.max(8, Math.round(Math.max(W, H) / 40));
  const sm = document.createElement('canvas'); sm.width = Math.ceil(W / s); sm.height = Math.ceil(H / s);
  const sg = sm.getContext('2d'); sg.imageSmoothingQuality = 'high'; sg.filter = 'blur(2px)'; sg.drawImage(c, 0, 0, sm.width, sm.height);
  const bgc = document.createElement('canvas'); bgc.width = W; bgc.height = H;
  const bg2 = bgc.getContext('2d'); bg2.imageSmoothingQuality = 'high'; bg2.drawImage(sm, 0, 0, W, H);
  const g = c.getContext('2d'), im = g.getImageData(0, 0, W, H), bg = bg2.getImageData(0, 0, W, H).data, d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11, b = Math.max(40, bg[i] * 0.3 + bg[i + 1] * 0.59 + bg[i + 2] * 0.11);
    const n = Math.min(255, Math.max(0, (v / b * 255 - 60) * 1.3)); // 紙の色を白に、線を濃く
    d[i] = d[i + 1] = d[i + 2] = n; d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
}
$('#findSym').onclick = async () => {
  const d = S.drawing, msg = $('#symMsg'), list = $('#symList');
  list.innerHTML = ''; $('#symAdd').hidden = true; $('#symAll').hidden = true; $('#symOcr').hidden = true; symPrevClose(); $('#symDlg').showModal();
  $('#ocrPage').textContent = d.type === 'pdf' ? 'このページ全体を読む' : '図面全体を読む';
  if (d.type !== 'pdf') { // 写真から取り込んだ図面：文字を読み取ってさがす
    msg.textContent = '写真の図面です。端末の中で文字を読み取って符号をさがせます。符号が書いてある辺りを拡大してから「今見えている範囲を読む」を押すと、速くて正確です。明るく、真上から、ピントの合った写真ほどよく読めます。';
    $('#ocrAll').hidden = true; $('#symOcr').hidden = false; OCR.prefetch();
    return;
  }
  try {
    const pages = await pdfPagesText(d, (p, n) => msg.textContent = `図面を調べています…（${p}/${n}ページ）`);
    if (!pages.some(p => p.items.length > 20)) {
      // スキャンした図面：端末の中で文字を読み取ってさがす
      msg.textContent = 'この図面には文字のデータが入っていません（スキャンした図面のようです）。端末の中で文字を読み取って符号をさがせます。符号が書いてある辺りを拡大してから「今見えている範囲を読む」を押すと、速くて正確です。';
      $('#ocrAll').textContent = `全ページを読む（${pages.length}ページ）`; $('#ocrAll').hidden = pages.length < 2;
      $('#symOcr').hidden = false; OCR.prefetch();
      return;
    }
    showSymResults(pages);
  } catch (err) { msg.textContent = '図面を読めませんでした：' + (err.message || err); }
};
// 見つかった符号の一覧を出す（PDFの文字からでも、読み取った文字からでも同じ）
function showSymResults(pages, ocr) {
  const d = S.drawing, msg = $('#symMsg'), list = $('#symList');
  list.innerHTML = ''; symPages = pages;
  symFound = findSymbols(pages).map(s => ({ ...s, floors: guessFloors(pages[s.page - 1].text, s.name) }));
  if (!symFound.length) {
    msg.textContent = ocr ? '読み取った文字の中に符号が見つかりませんでした。符号の辺りをもっと拡大して「今見えている範囲を読む」を試すか、「＋ 位置」で追加してください。' : '符号が見つかりませんでした。「＋ 位置」で追加してください。';
    if (ocr) $('#symOcr').hidden = false;
    return;
  }
  msg.textContent = `${symFound.length}個見つかりました。` + (ocr ? '読み取りは間違えることがあります。' : '') + '「見る」で図面の場所を確かめ、ページと階の範囲を直してから追加してください。';
  symFound.forEach((s, i) => {
    const exists = S.positions.some(p => p.name === s.name && p.drawingId === d.id);
    const opts = pages.map(({ page: n }) => `<option value="${n}" ${n === s.page ? 'selected' : ''}>${n}${s.pages.includes(n) ? ' ●' : ''}</option>`).join('');
    const row = document.createElement('div'); row.className = 'symrow' + (exists ? ' done' : '');
    row.innerHTML = `<input type="checkbox" ${exists ? 'disabled' : 'checked'} data-i="${i}" id="sym${i}" aria-label="${esc(s.name)}を追加する">
      <label for="sym${i}"><b>${esc(s.name)}</b><br><span class="meta">${exists ? '登録済み' : '出てくるページ：' + s.pages.join('・')}</span></label>
      <button type="button" class="chip" data-v="${i}">見る</button>
      <span class="pg"><select data-p="${i}" aria-label="${esc(s.name)}のページ" ${exists ? 'disabled' : ''}>${opts}</select>ページ</span>
      <span class="fl"><input type="number" inputmode="numeric" min="1" max="99" value="${s.floors[0]}" data-f="${i}" aria-label="${esc(s.name)}の開始階" ${exists ? 'disabled' : ''}>〜<input type="number" inputmode="numeric" min="1" max="99" value="${s.floors[1]}" data-t="${i}" aria-label="${esc(s.name)}の終了階" ${exists ? 'disabled' : ''}>F</span>`;
    list.append(row);
  });
  $('#symAdd').hidden = false; renderSymAll();
}
// スキャンした図面の文字を読み取る。mode：view＝今見えている範囲／page＝このページ全体／all＝全ページ
let ocrBusy = false;
async function ocrRun(mode) {
  if (ocrBusy) return; ocrBusy = true;
  const d = S.drawing, msg = $('#symMsg'); $('#symOcr').hidden = true;
  try {
    const n = d.type === 'pdf' ? (await getPdf(d)).numPages : 1;
    const pages = Array.from({ length: n }, (_, i) => ({ page: i + 1, items: [], text: '' }));
    const targets = mode === 'all' ? pages.map(p => p.page) : [S.page];
    for (const [ti, p] of targets.entries()) {
      msg.textContent = '図面を用意しています…';
      const src = await pageSource(d, p);
      let x0 = 0, y0 = 0, x1 = src.w, y1 = src.h;
      if (mode === 'view' && V.k) { // 画面に見えている範囲を、元の大きさの座標に直す
        const r = stage.getBoundingClientRect(), f = V.s * V.k;
        x0 = Math.max(0, -V.x / f); y0 = Math.max(0, -V.y / f);
        x1 = Math.min(src.w, (r.width - V.x) / f); y1 = Math.min(src.h, (r.height - V.y) / f);
      }
      const w = x1 - x0, h = y1 - y0;
      // 文字が読みやすい細かさで描く。読み取りの部品は大きすぎる画像だと何も読めないので、長い辺3200ドット・合計750万ドットまで
      // （写真は元の画素より大きくしても細かくならないので、3倍まで）
      const k = Math.min(src.photo ? 3 : 6, 3200 / Math.max(w, h), Math.sqrt(7.5e6 / (w * h)));
      const c = document.createElement('canvas'); c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await src.draw(g, k, x0, y0);
      if (src.photo) evenLight(c);
      const head = `文字を読み取っています…${targets.length > 1 ? `（${ti + 1}/${targets.length}ページ）` : ''}`;
      msg.textContent = head + '（準備中）';
      const res = await OCR.read(c, k, x0, y0, (pr, st) => { if (pr != null) msg.textContent = `${head} ${Math.round(pr * 100)}%`; else if (st?.startsWith('丸')) msg.textContent = `${head} ${st}`; }, { ptPx: k * src.unitPt });
      pages[p - 1] = { page: p, ...res };
    }
    showSymResults(pages, true);
  } catch (err) {
    msg.textContent = '文字を読み取れませんでした：' + (err.message || err) + (navigator.onLine === false ? '（読み取りの部品がまだ保存されていません。電波のある所で一度使ってください）' : '');
    $('#symOcr').hidden = false;
  } finally { ocrBusy = false; }
}
$('#ocrView').onclick = () => ocrRun('view');
$('#ocrPage').onclick = () => ocrRun('page');
$('#ocrAll').onclick = () => ocrRun('all');
$('#symDlg').addEventListener('close', () => { if (!ocrBusy) OCR.end(); }); // 読み取りの部品はメモリを使うので、閉じたら片付ける
$('#symList').addEventListener('change', e => {
  if (e.target.matches('input[type=checkbox]')) renderSymAll();
  // ページを変えたら、そのページの書き方から階を推測しなおす
  if (e.target.dataset.p) {
    const i = +e.target.dataset.p, s = symFound[i], f = guessFloors(symPages[+e.target.value - 1].text, s.name);
    $(`[data-f="${i}"]`).value = f[0]; $(`[data-t="${i}"]`).value = f[1];
  }
});
$('#symList').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) symPreview(+b.dataset.v); });
$('#symAll').onclick = () => { const cs = symChecks(), all = cs.every(c => c.checked); cs.forEach(c => c.checked = !all); renderSymAll(); };
$('#symClose').onclick = () => $('#symDlg').close();
$('#symAdd').onclick = async () => {
  let added = 0;
  for (const cb of $('#symList').querySelectorAll('input[type=checkbox]:checked:not(:disabled)')) {
    const i = +cb.dataset.i, s = symFound[i];
    const a = parseInt($(`[data-f="${i}"]`).value) || 1, z = parseInt($(`[data-t="${i}"]`).value) || a;
    const page = parseInt($(`[data-p="${i}"]`).value) || s.page;
    const floors = []; for (let f = Math.min(a, z); f <= Math.max(a, z); f++) floors.push(f + 'F');
    const now = new Date().toISOString();
    const p = { id: uid(), siteId: S.site.id, drawingId: S.drawing.id, page, name: s.name, color: COLORS[S.positions.length % COLORS.length], floors, points: [], values: {}, memo: '', foundPages: s.pages, createdAt: now, updatedAt: now };
    await Store.put('positions', p); S.positions.push(p); added++;
  }
  $('#symDlg').close();
  if (!S.pos) S.pos = S.positions.find(p => p.page === S.page) || S.positions[0] || null;
  renderChips(); renderPos(); drawMarks();
  toast(added ? `符号を${added}個追加しました` : '追加する符号が選ばれていません');
};
// 一覧から「見る」：そのページを描いて、符号の書いてある所を赤丸で囲む
let symPrevSeq = 0, symPrevAt = null;
function symPrevClose() { symPrevSeq++; symPrevAt = null; $('#symPrev').hidden = true; $('#symMain').hidden = false; }
async function symPreview(i, page) {
  const s = symFound[i], sel = $(`[data-p="${i}"]`), seq = ++symPrevSeq;
  page = page || +sel.value || s.page; symPrevAt = { i, page };
  $('#symMain').hidden = true; $('#symPrev').hidden = false;
  $('#symPrevTitle').textContent = `${s.name}　${page}ページ`;
  const bs = s.boxes.get(page) || [];
  $('#symPrevNote').textContent = bs.length ? `赤丸が「${s.name}」の書いてある所です（${bs.length}か所）。指で動かして見られます。` : `このページには「${s.name}」の文字が見つかりませんでした。`;
  $('#symPrevPages').innerHTML = s.pages.map(n => `<button type="button" class="chip${n === page ? ' on' : ''}" data-pp="${n}">${n}ページ</button>`).join('');
  $('#symPrevUse').hidden = sel.disabled || +sel.value === page;
  const box = $('#symPrevBox'), c = $('#symPrevCv');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  try {
    const src = await pageSource(S.drawing, page);
    if (seq !== symPrevSeq) return;
    // 画面の幅の2.5倍くらいで描いて、指でスクロールして見る（写真は元の大きさまで）
    const k = Math.min(src.photo ? 1 : 4, Math.max(src.photo ? 0.1 : 1, (box.clientWidth || 360) * 2.5 / src.w));
    const tmp = document.createElement('canvas'); tmp.width = Math.round(src.w * k); tmp.height = Math.round(src.h * k);
    await src.draw(tmp.getContext('2d'), k);
    if (seq !== symPrevSeq) return;
    c.width = tmp.width; c.height = tmp.height;
    const g = c.getContext('2d'); g.drawImage(tmp, 0, 0);
    g.strokeStyle = '#e5484d'; g.lineWidth = Math.max(3, 3 * k);
    for (const b of bs) {
      const cx = (b.x + b.w / 2) * k, cy = (b.y + b.h / 2) * k, r = Math.max(b.w, b.h) * k * 0.75 + 8 * k;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    }
    // 最初の赤丸が真ん中に来るように
    const b = bs[0];
    if (b) { box.scrollLeft = (b.x + b.w / 2) * k - box.clientWidth / 2; box.scrollTop = (b.y + b.h / 2) * k - box.clientHeight / 2; }
    else { box.scrollLeft = 0; box.scrollTop = 0; }
  } catch (err) { $('#symPrevNote').textContent = '図面を表示できませんでした：' + (err.message || err); }
}
$('#symPrevPages').addEventListener('click', e => { const b = e.target.closest('[data-pp]'); if (b && symPrevAt) symPreview(symPrevAt.i, +b.dataset.pp); });
$('#symPrevUse').onclick = () => {
  if (!symPrevAt) return;
  const sel = $(`[data-p="${symPrevAt.i}"]`); sel.value = symPrevAt.page;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  toast(`${symFound[symPrevAt.i].name}を${symPrevAt.page}ページに割り当てました`);
  symPrevClose();
};
$('#symPrevBack').onclick = symPrevClose;
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
  $('#posMeta').textContent = posMeta(S.pos);
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
  $('#posMeta').textContent = posMeta(p);
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
    const th = document.createElement('th'); th.className = 'fl rowh'; th.scope = 'row'; th.textContent = f; tr.append(th);
    th.title = 'タップで箇所の追加・名前の変更'; th.onclick = () => openRowMenu(f);
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
  const nums = p.floors.map(f => parseInt(f)).filter(Number.isFinite); // 「5F-イ」「5F X2〜X3」なども数字の部分で見る
  let n = nums.length ? Math.max(...nums) + 1 : 1; while (p.floors.includes(n + 'F')) n++;
  p.floors.push(n + 'F'); renderGrid(); scheduleSave();
};
/* ---------- 表の行（階）のメニュー：同じ階に箇所を増やす・名前を変える・削除 ---------- */
// 同じ階の箇所は「5F-ア」「5F-イ」…と名前を付けて、5F の行の下に並べる
const KANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワ';
const baseOf = f => f.split('-')[0];
let rowTarget = null;
function openRowMenu(f) {
  rowTarget = f;
  $('#rowTitle').textContent = `「${f}」の行`;
  $('#rowName').value = f;
  $('#rowDlg').showModal();
}
// 行の名前を変える時は、実測値・写真の階も一緒に付け替える
async function renameRow(from, to) {
  const p = S.pos;
  p.floors[p.floors.indexOf(from)] = to;
  if (p.values[from]) { p.values[to] = p.values[from]; delete p.values[from]; }
  for (const ph of S.photos.filter(x => x.floor === from)) { ph.floor = to; ph.updatedAt = new Date().toISOString(); await Store.put('photos', ph); }
  if (S.selFloor === from) S.selFloor = to;
}
$('#rowAddLoc').onclick = async () => {
  const p = S.pos, f = rowTarget, base = baseOf(f);
  if (!f.includes('-')) await renameRow(f, `${base}-ア`); // 最初の1つは「ア」にする
  const same = p.floors.filter(x => baseOf(x) === base);
  const used = new Set(same.map(x => x.split('-')[1]));
  const k = [...KANA].find(c => !used.has(c)) || String(same.length + 1);
  const name = `${base}-${k}`;
  p.floors.splice(p.floors.indexOf(same[same.length - 1]) + 1, 0, name);
  $('#rowDlg').close(); renderGrid(); renderPhotos(); scheduleSave();
  toast(`${name} を追加しました`);
};
$('#rowForm').onsubmit = async e => {
  e.preventDefault();
  const to = $('#rowName').value.trim(), from = rowTarget;
  if (!to || to === from) { $('#rowDlg').close(); return; }
  if (S.pos.floors.includes(to)) { toast(`「${to}」はもうあります`); return; }
  await renameRow(from, to);
  $('#rowDlg').close(); renderGrid(); renderPhotos(); scheduleSave();
  toast(`「${to}」に変えました`);
};
$('#rowDel').onclick = async () => {
  const p = S.pos, f = rowTarget;
  $('#rowDlg').close();
  if (p.floors.length <= 1) { toast('最後の1行は削除できません'); return; }
  const hasVal = Object.values(p.values[f] || {}).some(v => v !== '');
  if (hasVal && !await ask(`「${f}」の実測値を削除します。元に戻せません。`)) return;
  p.floors.splice(p.floors.indexOf(f), 1); delete p.values[f];
  for (const ph of S.photos.filter(x => x.floor === f)) { ph.floor = null; ph.updatedAt = new Date().toISOString(); await Store.put('photos', ph); }
  if (S.selFloor === f) S.selFloor = null;
  renderGrid(); renderPhotos(); scheduleSave(); toast(`「${f}」を削除しました`);
};
$('#rowCancel').onclick = () => $('#rowDlg').close();

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
  viewing.floor = e.target.value || null; viewing.updatedAt = new Date().toISOString();
  await Store.put('photos', viewing);
  $('#photoCap').textContent = `${S.pos.name}　${photoLabel(viewing)}　${new Date(viewing.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  renderPhotos(); toast(`${photoLabel(viewing)} に変えました`);
};
let viewing = null, viewUrl = null;
/* 写真への書き込み（道具の中身は annot.js）。写真の幅を1とした割合で ph.sketch に保存 */
const PH = { nw: 1, nh: 1, id: null, pen: false };
const phSvg = $('#photoSvg'), phWrap = $('#photoWrap');
async function savePhotoSketch() { if (viewing) { viewing.updatedAt = new Date().toISOString(); await Store.put('photos', viewing); renderPhotos(); } }
const photoAnnot = new Annotator({
  items: () => (viewing.sketch ??= []),
  peek: () => viewing?.sketch || [],
  save: () => savePhotoSketch(),
  render: () => renderPhotoSketch(),
  size: () => ({ W: PH.nw, H: PH.nh }),
  k: () => (phSvg.getBoundingClientRect().width || 1) / PH.nw,
  textF: 2,
  bar: $('#phTools'),
  btn: 'sm',
});
function renderPhotoSketch() {
  phSvg.setAttribute('viewBox', `0 0 ${PH.nw} ${PH.nh}`);
  phSvg.innerHTML = viewing ? photoAnnot.svg() : '';
}
const phPos = e => { const r = phSvg.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
phSvg.addEventListener('pointerdown', e => {
  notePen(e);
  if (PH.id !== null) { if (!isPen(e) && PH.pen === false) { photoAnnot.cancel(); renderPhotoSketch(); PH.id = null; } return; } // 指で書く時、2本目の指は取りやめ
  if (!isPen(e) && !fingerDraw) return; // ふだん写真に書けるのはペンだけ（指や手のひらは無視）
  PH.pen = isPen(e);
  try { phSvg.setPointerCapture(e.pointerId); } catch (err) {}
  PH.id = e.pointerId; photoAnnot.down(phPos(e), e);
});
addFingerBtn($('#penBar'), 'tool'); addFingerBtn($('#phTools'), 'sm'); fingerBtns();
phSvg.addEventListener('pointermove', e => { if (PH.id === e.pointerId) photoAnnot.move(phPos(e), e); });
function phEnd(e) {
  if (PH.id !== e.pointerId) return; PH.id = null;
  if (e.type === 'pointercancel') { photoAnnot.cancel(); renderPhotoSketch(); } else photoAnnot.up(phPos(e), e);
}
phSvg.addEventListener('pointerup', phEnd);
phSvg.addEventListener('pointercancel', phEnd);
function openPhoto(ph) {
  viewing = ph; if (viewUrl) URL.revokeObjectURL(viewUrl);
  photoAnnot.clearSel(); PH.id = null;
  viewUrl = URL.createObjectURL(ph.blob);
  const img = $('#photoImg');
  img.onload = () => { PH.nw = img.naturalWidth; PH.nh = img.naturalHeight; renderPhotoSketch(); };
  img.src = viewUrl;
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
  drawStrokes(g, S.drawing, S.page, V.w, V.h);
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
const EXCELJS = 'lib/exceljs/exceljs.min.js'; // Excelを作る部品（アプリの中に入れてある）
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
    const img = await createImageBitmap((await Store.get('files', d.id)).blob), k = Math.min(1, maxDim / Math.max(img.width, img.height)); // 写真の図面は元より大きくしない
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); g.drawImage(img, 0, 0, c.width, c.height);
  }
  drawStrokes(g, d, page, c.width, c.height);
  const r = Math.max(8, c.width / 160);
  pos.points.forEach((pt, i) => {
    const x = pt.x * c.width, y = pt.y * c.height;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = pos.color; g.fill();
    g.lineWidth = r * 0.15; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `700 ${r * 1.1}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), x, y + r * 0.05);
  });
  return c;
}
// Excelに貼る図面画像の大きさ（長い辺のドット数）。Excelで拡大しても寸法の文字が読めるように
const XLSX_IMG = 3200;
const colName = n => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
$('#xlsxBtn').onclick = async () => {
  flushSave();
  const btn = $('#xlsxBtn'), label = btn.textContent; btn.disabled = true;
  try {
    btn.textContent = '準備しています…';
    if (!window.ExcelJS) await loadScript(EXCELJS);
    const poss = (await Store.byIndex('positions', 'site', S.site.id)).filter(p => p.points.length).sort(posOrder);
    const wb = new ExcelJS.Workbook(); wb.creator = 'ピタ測';
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
      if (p.memo && !AUTO_MEMO.test(p.memo.trim())) { ws.getCell('A3').value = `メモ：${p.memo}`; ws.getCell('A3').font = { size: 9 }; }
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
          const cv2 = await markedPage(d, p.page, p, XLSX_IMG);
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
        let data = await blobToDataUrl(ph.blob);
        if (ph.sketch?.length) { // 書き込みがあれば写真に重ねてから貼る
          const cc = document.createElement('canvas'); cc.width = img.width; cc.height = img.height;
          const gg = cc.getContext('2d'); gg.drawImage(img, 0, 0); drawItems(gg, ph.sketch, cc.width, cc.height);
          data = cc.toDataURL('image/jpeg', 0.85);
        }
        const id = wb.addImage({ base64: data, extension: 'jpeg' });
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
    const xblob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    // ドライブとつながっていれば「ピタ測データ/Excel出力」へ。つながっていなければスマホのダウンロードへ
    if (Sync.connected() && navigator.onLine !== false) {
      btn.textContent = 'ドライブに保存しています…';
      try {
        const r = await Sync.saveExport(name, xblob);
        $('#savedName').textContent = name + (r.overwritten ? '（同じ名前のファイルを上書き）' : '');
        $('#savedLink').href = r.url; $('#savedAcct').textContent = Sync.email() || 'つないだアカウント';
        $('#savedDlg').showModal();
        return;
      } catch (err) { toast('ドライブに保存できなかったので、ダウンロードに保存します'); }
    }
    if (await shareOrSave(xblob, name)) toast('Excelを保存しました（ダウンロード）');
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
    const name = `ピタ測バックアップ_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.txt`;
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
  if (data?.app !== 'jissokucho' || !Array.isArray(data.sites)) { toast('ピタ測のバックアップではないようです'); return; }
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

$('#savedClose').onclick = () => $('#savedDlg').close();
$('#savedLink').addEventListener('click', () => $('#savedDlg').close());

/* ---------- 感想を送る（作者のGoogleフォームへ送信） ---------- */
const FB_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSesZkO76FKxH5ldJsN6y_B8qqY3POKJ84Q4qg9KK2Gk5vDjvw/formResponse';
const FB_ENTRY = { job: 'entry.157829829', scene: 'entry.1439691396', feat: 'entry.1667606356', trouble: 'entry.1980206129', price: 'entry.1787688409', wish: 'entry.43528767', contact: 'entry.1139231794' };
$('#fbOpen').onclick = () => $('#fbDlg').showModal();
$('#fbCancel').onclick = () => $('#fbDlg').close();
$('#fbForm').onsubmit = async e => {
  e.preventDefault();
  const body = new URLSearchParams();
  const put = (k, v) => { if (v && v.trim()) body.append(FB_ENTRY[k], v.trim()); };
  put('job', $('#fbJob').value); put('scene', $('#fbScene').value);
  document.querySelectorAll('input[name=fbFeat]:checked').forEach(c => body.append(FB_ENTRY.feat, c.value));
  put('trouble', $('#fbTrouble').value);
  put('price', document.querySelector('input[name=fbPrice]:checked')?.value || '');
  put('wish', ($('#fbWish').value || '') + ($('#fbWish').value.trim() ? `\n（${$('#appVer').textContent}）` : ''));
  put('contact', $('#fbContact').value);
  if (![...body.keys()].length) { toast('どこか1つでも書いてから送ってください'); return; }
  if (navigator.onLine === false) { toast('電波がないので送れませんでした。電波のある所でもう一度送ってください'); return; }
  const b = $('#fbSend'); b.disabled = true; b.textContent = '送っています…';
  try {
    // Googleフォームは別サイトなので返事の中身は読めない（no-cors）。届いたかは作者側の回答一覧で確認する
    await fetch(FB_URL, { method: 'POST', mode: 'no-cors', body });
    $('#fbForm').reset(); $('#fbDlg').close();
    toast('ありがとうございます！感想を送りました');
  } catch (err) { toast('送れませんでした。電波を確かめて、もう一度送ってください'); }
  finally { b.disabled = false; b.textContent = '送る'; }
};

/* ---------- ドライブと同期（中身は sync.js） ---------- */
function renderSync(st = Sync.state(), msg) {
  const info = $('#syncInfo'), last = st.last ? new Date(st.last).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  info.classList.toggle('err', !!st.error); info.classList.toggle('ok', st.connected && !st.error);
  info.textContent = !st.configured ? 'まだ使えません（Googleの設定待ち）'
    : st.wasOn && st.offline ? `電波がありません。電波が戻ったら自動で同期します${st.pending ? '（未送信の変更あり）' : ''}。最後の同期：${last ?? 'まだ'}`
    : st.error ? st.error
    : st.running ? (msg || '同期中…')
    : st.connected ? `つながっています${Sync.email() ? `（${Sync.email()}）` : ''}。最後の同期：${last ?? 'まだ'}`
    : st.wasOn ? `一時的に切れています。画面をタップすると自動でつなぎ直します。最後の同期：${last ?? 'まだ'}`
    : 'まだつないでいません';
  $('#syncConnect').hidden = st.connected; $('#syncConnect').textContent = st.wasOn ? 'つなぎ直す' : 'ドライブとつなぐ';
  $('#syncConnect').disabled = !st.configured;
  $('#syncNowBtn').hidden = !st.connected; $('#syncNowBtn').disabled = st.running;
  $('#syncOff').hidden = !st.wasOn;
  $('#syncBanner').hidden = !(st.configured && st.wasOn && !st.connected && !st.offline);
  // 上の帯の小さな表示：つながっている／切れている／電波なし
  const chip = $('#syncChip'), state = st.error ? 'err' : st.connected ? 'ok' : st.wasOn ? 'warn' : '';
  chip.hidden = !st.configured || !st.wasOn; chip.className = 'syncchip ' + state;
  chip.querySelector('span').textContent = st.running ? '同期中…' : st.error ? '同期エラー' : st.wasOn && st.offline ? '電波なし' : st.connected ? 'ドライブ同期中' : '同期が切れています';
}
$('#syncChip').onclick = () => $('#syncCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
async function doConnect() {
  try { await Sync.connect(); toast('ドライブとつながりました'); }
  catch (err) { toast(err.message || String(err)); }
  renderSync();
}
$('#syncConnect').onclick = doConnect;
$('#syncReconnect').onclick = doConnect;
$('#syncNowBtn').onclick = () => Sync.syncNow();
$('#syncOff').onclick = async () => {
  if (!await ask('ドライブとつなぐのをやめます。このスマホのデータはそのまま残ります。')) return;
  Sync.disconnect(); renderSync();
};
// 他の端末の変更が届いたら、今の画面を新しい中身で描き直す（入力中は邪魔しない）
async function applyRemote() {
  if (!$('#vHome').hidden) { renderHome(); return; }
  if (!S.site) return;
  const fresh = (await Store.all('sites')).find(s => s.id === S.site.id);
  if (!fresh) { toast('この現場は別の端末で削除されました'); history.back(); return; }
  if (!$('#vSite').hidden) { S.site = fresh; renderSite(); return; }
  if ($('#vDraw').hidden || saveTimer || $('#grid').contains(document.activeElement) || drawAnnot.g) return;
  S.site = fresh; S.drawing = fresh.drawings.find(d => d.id === S.drawing?.id) || S.drawing;
  S.positions = (await Store.byIndex('positions', 'drawing', S.drawing.id)).sort(posOrder);
  S.pos = S.positions.find(p => p.id === S.pos?.id) || S.positions.find(p => p.page === S.page) || null;
  renderChips(); renderPos(); drawMarks();
}
Sync.onChange(st => {
  renderSync(st, st.msg);
  if (st.pulled) { toast('他の端末の変更を取り込みました'); applyRemote(); }
});
renderSync();
if (Sync.connected()) Sync.syncNow();

/* ---------- Google Play版（有料）だけで使えるようにする ---------- */
// Playで公開したら only を true にし、pkg（パッケージ名）と url（ストアのページ）を入れる。
// Play版から開いた時はブラウザが「android-app://パッケージ名」から来たと教えてくれるので、それを覚えておく。
// 手元で試す時（localhost）は止めない。
const PLAY = { only: false, pkg: '', url: '' };
function playGate() {
  const ref = document.referrer || '';
  if (ref.startsWith('android-app://') && (!PLAY.pkg || ref.startsWith(`android-app://${PLAY.pkg}`))) {
    try { localStorage.setItem('jissoku.play', '1'); } catch (e) {}
  }
  let ok = false; try { ok = localStorage.getItem('jissoku.play') === '1'; } catch (e) {}
  if (!PLAY.only || ok || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  const g = $('#playGate'); g.hidden = false;
  if (PLAY.url) $('#playLink').href = PLAY.url; else $('#playLink').hidden = true;
}
playGate();

/* ---------- 起動 ---------- */
history.replaceState({ view: 'home' }, '');
renderHome();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // 初めて開いた時は、書体の文字ファイルが保存の仕組みより先に読まれるので、読んだ分をあとから保存しておく
  navigator.serviceWorker.ready.then(async () => {
    const urls = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/lib/fonts/files/'));
    if (!urls.length || !window.caches) return;
    const c = await caches.open('jissokucho-fonts');
    for (const u of urls) if (!await c.match(u)) await c.add(u).catch(() => {});
  }).catch(() => {});
}
