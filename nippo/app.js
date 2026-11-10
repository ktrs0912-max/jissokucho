// 製作日報：作業員がその日に製作した物件をタブレットで入力する
// データはこのタブレットの中（localStorage）に保存する
//   workers  … 作業員 [{id, name, active}]（並び順は配列の順）
//   projects … 物件   [{id, code, name, active, createdAt}]
//   processes… 工程   [{id, name, active}]（切断・溶接・塗装。管理で増やせる）
//   entries  … 記録   {"YYYY-MM-DD|作業員id": {items:[{pid, procs:[工程id], hours}], note, at}}
'use strict';
const KEY = 'nippo.data.v1', PINKEY = 'nippo.pin';
const $ = s => document.querySelector(s);
const WD = ['日', '月', '火', '水', '木', '金', '土'];

// ---------- 保存 ----------
let db = load();
function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!d || !d.workers) d = { workers: [], projects: [], entries: {} };
  if (!d.processes) d.processes = defaultProcs(); // 工程を入れる前の版のデータにも足す
  return d;
}
function defaultProcs() { return ['切断', '溶接', '塗装'].map((name, i) => ({ id: 'p' + i, name, active: true })); }
function save() { localStorage.setItem(KEY, JSON.stringify(db)); }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const proj = id => db.projects.find(p => p.id === id);
const worker = id => db.workers.find(w => w.id === id);
const pLabel = p => p ? (p.code ? `${p.code} ${p.name}` : p.name) : '（消された物件）';
const procName = id => db.processes.find(x => x.id === id)?.name || '（消された工程）';
const procText = i => (i.procs || []).map(procName).join('・');
// 1物件分の書き方：「24-101 ○○マンション【切断・溶接】(5h)」
const itemText = (i, short) => (short ? proj(i.pid)?.name || '（消された物件）' : pLabel(proj(i.pid))) + (i.procs?.length ? `【${procText(i)}】` : '') + (i.hours ? `(${i.hours}h)` : '');

// ---------- 日付 ----------
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const jp = s => { const d = parse(s); return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
let curDate = today();

// ---------- 画面の切り替え ----------
function show(id) { for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id; window.scrollTo(0, 0); }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 1800); }
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

// ---------- ホーム ----------
function renderHome() {
  // 日付が変わったまま開きっぱなしでも、ホームに戻ったら今日に合わせる（手で日付を動かした時はそのまま）
  const lbl = $('#dLabel');
  lbl.textContent = jp(curDate);
  lbl.classList.toggle('past', curDate !== today());
  $('#dNext').disabled = curDate >= today();
  const g = $('#workerGrid'); g.textContent = '';
  const ws = db.workers.filter(w => w.active);
  $('#homeEmpty').hidden = ws.length > 0;
  let done = 0;
  for (const w of ws) {
    const e = db.entries[`${curDate}|${w.id}`];
    if (e) done++;
    g.append(el('button', { type: 'button', class: 'wcard' + (e ? ' done' : ''), onclick: () => openEntry(w.id) },
      el('span', { class: 'nm' }, w.name),
      el('span', { class: 'st' }, e ? '✓ 入力済み' : '未入力'),
      e ? el('span', { class: 'pj' }, e.items.map(i => itemText(i)).join('\n')) : null));
  }
  $('#homeCount').textContent = ws.length ? `${jp(curDate)}：${ws.length}人中 ${done}人 入力済み` : '';
}
$('#dPrev').onclick = () => { curDate = addDays(curDate, -1); renderHome(); };
$('#dNext').onclick = () => { if (curDate < today()) { curDate = addDays(curDate, 1); renderHome(); } };
$('#dToday').onclick = () => { curDate = today(); renderHome(); };
$('#dLabel').onclick = () => {
  const s = prompt('日付を入れてください（例：2026-11-05）', curDate);
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && s <= today()) { curDate = s; renderHome(); }
};

// ---------- 入力 ----------
let ed = null; // 入力中 {wid, items:[{pid,hours}]}
function openEntry(wid) {
  const e = db.entries[`${curDate}|${wid}`];
  ed = { wid, items: e ? e.items.map(i => ({ ...i, procs: [...(i.procs || [])] })) : [] };
  $('#entryTitle').textContent = `${worker(wid).name}さん　${jp(curDate)}`;
  $('#entryNote').value = e ? e.note || '' : '';
  $('#projFilter').value = '';
  $('#entryClear').hidden = !e;
  renderEntry();
  show('vEntry');
}
// えらべる物件：使っている物件と、この人が最近使った物件を先に並べる
function entryProjects() {
  const recent = new Map();
  for (const [k, e] of Object.entries(db.entries)) {
    const [d, w] = k.split('|');
    for (const i of e.items) { const score = (w === ed.wid ? 1e9 : 0) + Number(d.replace(/-/g, '')); if (!recent.has(i.pid) || recent.get(i.pid) < score) recent.set(i.pid, score); }
  }
  const sel = new Set(ed.items.map(i => i.pid));
  return db.projects.filter(p => p.active || sel.has(p.id))
    .sort((a, b) => (recent.get(b.id) || 0) - (recent.get(a.id) || 0) || (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja'));
}
function renderEntry() {
  const q = $('#projFilter').value.trim().toLowerCase();
  const g = $('#projGrid'); g.textContent = '';
  const list = entryProjects();
  $('#projEmpty').hidden = list.length > 0;
  for (const p of list) {
    const on = ed.items.some(i => i.pid === p.id);
    if (q && !on && !`${p.code} ${p.name}`.toLowerCase().includes(q)) continue;
    g.append(el('button', { type: 'button', class: 'pbtn' + (on ? ' on' : ''), onclick: () => toggle(p.id) },
      p.code ? el('span', { class: 'cd' }, p.code) : null, el('span', { class: 'nm' }, p.name)));
  }
  const box = $('#selBox'), ul = $('#selList'); ul.textContent = '';
  box.hidden = !ed.items.length;
  for (const it of ed.items) {
    const out = el('output', {}, it.hours ? `${it.hours} 時間` : '― 時間');
    const step = d => { it.hours = Math.max(0, Math.min(24, (it.hours || 0) + d)); out.textContent = it.hours ? `${it.hours} 時間` : '― 時間'; };
    // 工程：押すたびに入れる／はずす（いくつでも）。使わなくなった工程も、この記録で使っていれば出す
    const procs = el('div', { class: 'procs' }, el('span', { class: 'plabel' }, '工程'));
    for (const pr of db.processes.filter(x => x.active || it.procs.includes(x.id))) {
      const b = el('button', { type: 'button', class: 'pchip' + (it.procs.includes(pr.id) ? ' on' : ''), onclick: () => {
        const k = it.procs.indexOf(pr.id);
        if (k >= 0) it.procs.splice(k, 1); else { it.procs.push(pr.id); it.procs.sort((a, c) => db.processes.findIndex(x => x.id === a) - db.processes.findIndex(x => x.id === c)); }
        b.classList.toggle('on', k < 0);
      } }, pr.name);
      procs.append(b);
    }
    ul.append(el('li', {},
      el('span', { class: 'nm' }, pLabel(proj(it.pid))),
      procs,
      el('span', { class: 'hours' },
        el('button', { type: 'button', onclick: () => step(-0.5), 'aria-label': '30分へらす' }, '−'), out,
        el('button', { type: 'button', onclick: () => step(0.5), 'aria-label': '30分ふやす' }, '＋')),
      el('button', { type: 'button', class: 'sm danger', onclick: () => toggle(it.pid) }, 'はずす')));
  }
  $('#copyLast').hidden = !lastEntry();
}
function toggle(pid) {
  const i = ed.items.findIndex(x => x.pid === pid);
  if (i >= 0) ed.items.splice(i, 1); else ed.items.push({ pid, procs: [], hours: 0 });
  renderEntry();
}
// この人の、今の日付より前でいちばん新しい記録
function lastEntry() {
  let best = null;
  for (const [k, e] of Object.entries(db.entries)) {
    const [d, w] = k.split('|');
    if (w === ed.wid && d < curDate && (!best || d > best.d)) best = { d, e };
  }
  return best;
}
$('#copyLast').onclick = () => {
  const l = lastEntry(); if (!l) return;
  ed.items = l.e.items.filter(i => proj(i.pid)).map(i => ({ pid: i.pid, procs: (i.procs || []).filter(id => db.processes.some(x => x.id === id && x.active)), hours: 0 }));
  renderEntry(); toast(`${jp(l.d)}と同じ物件・工程をえらびました`);
};
$('#projFilter').oninput = renderEntry;
$('#entryBack').onclick = () => { show('vHome'); renderHome(); };
$('#entrySave').onclick = () => {
  if (!ed.items.length) { toast('物件をえらんでください'); return; }
  db.entries[`${curDate}|${ed.wid}`] = { items: ed.items.map(i => { const o = { pid: i.pid }; if (i.procs.length) o.procs = i.procs; if (i.hours) o.hours = i.hours; return o; }), note: $('#entryNote').value.trim(), at: new Date().toISOString() };
  save(); toast(`${worker(ed.wid).name}さん　保存しました`);
  show('vHome'); renderHome();
};
$('#entryClear').onclick = () => {
  if (!confirm('この日の入力を消しますか？')) return;
  delete db.entries[`${curDate}|${ed.wid}`]; save(); toast('消しました');
  show('vHome'); renderHome();
};

// ---------- 管理 ----------
$('#toAdmin').onclick = () => {
  const pin = localStorage.getItem(PINKEY);
  if (pin && prompt('管理画面のパスワードを入れてください') !== pin) { toast('パスワードがちがいます'); return; }
  show('vAdmin'); renderAdmin();
};
$('#adminBack').onclick = () => { show('vHome'); renderHome(); };
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => {
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== b.dataset.tab;
  renderAdmin();
};
function renderAdmin() { renderProjAdmin(); renderWorkAdmin(); renderProcAdmin(); renderRec(); $('#pinInfo').textContent = localStorage.getItem(PINKEY) ? 'いまはパスワードあり' : 'いまはパスワードなし'; }
const usedP = id => Object.values(db.entries).some(e => e.items.some(i => i.pid === id));
const usedW = id => Object.keys(db.entries).some(k => k.endsWith('|' + id));

// 物件
$('#projForm').onsubmit = ev => {
  ev.preventDefault();
  const name = $('#pName').value.trim(), code = $('#pCode').value.trim();
  if (!name) return;
  if (db.projects.some(p => p.name === name && p.code === code)) { toast('同じ物件があります'); return; }
  db.projects.push({ id: uid(), code, name, active: true, createdAt: new Date().toISOString() });
  save(); $('#pName').value = ''; $('#pCode').value = ''; $('#pCode').focus(); renderProjAdmin(); toast('追加しました');
};
$('#showDone').onchange = renderProjAdmin;
function renderProjAdmin() {
  const ul = $('#projAdmin'); ul.textContent = '';
  const all = $('#showDone').checked;
  const list = db.projects.filter(p => all || p.active).sort((a, b) => (b.active - a.active) || (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja'));
  if (!list.length) ul.append(el('li', {}, el('span', { class: 'muted' }, '物件がありません')));
  for (const p of list) {
    ul.append(el('li', { class: p.active ? '' : 'off' },
      el('span', { class: 'cd' }, p.code || '―'), el('span', { class: 'nm' }, p.name), p.active ? null : el('span', { class: 'tag' }, '完了'),
      el('button', { type: 'button', class: 'sm', onclick: () => {
        const code = prompt('工事番号', p.code); if (code === null) return;
        const name = prompt('物件名', p.name); if (!name || !name.trim()) return;
        p.code = code.trim(); p.name = name.trim(); save(); renderProjAdmin();
      } }, 'なおす'),
      el('button', { type: 'button', class: 'sm', onclick: () => { p.active = !p.active; save(); renderProjAdmin(); toast(p.active ? '入力画面に戻しました' : '完了にしました（入力画面に出なくなります）'); } }, p.active ? '完了にする' : '戻す'),
      el('button', { type: 'button', class: 'sm danger', onclick: () => {
        if (usedP(p.id)) { alert('この物件は記録に使われているので消せません。「完了にする」を使ってください。'); return; }
        if (confirm(`「${p.name}」を消しますか？`)) { db.projects = db.projects.filter(x => x !== p); save(); renderProjAdmin(); }
      } }, '消す')));
  }
}

// 工程
const usedPr = id => Object.values(db.entries).some(e => e.items.some(i => (i.procs || []).includes(id)));
$('#procForm').onsubmit = ev => {
  ev.preventDefault();
  const name = $('#prName').value.trim(); if (!name) return;
  if (db.processes.some(x => x.name === name)) { toast('同じ工程があります'); return; }
  db.processes.push({ id: uid(), name, active: true }); save(); $('#prName').value = ''; renderProcAdmin(); toast('追加しました');
};
function renderProcAdmin() {
  const ul = $('#procAdmin'); ul.textContent = '';
  if (!db.processes.length) ul.append(el('li', {}, el('span', { class: 'muted' }, '工程がありません')));
  db.processes.forEach((x, i) => {
    const move = d => { const j = i + d; if (j < 0 || j >= db.processes.length) return; [db.processes[i], db.processes[j]] = [db.processes[j], db.processes[i]]; save(); renderProcAdmin(); };
    ul.append(el('li', { class: x.active ? '' : 'off' },
      el('span', { class: 'nm' }, x.name), x.active ? null : el('span', { class: 'tag' }, '使わない'),
      el('button', { type: 'button', class: 'sm', onclick: () => move(-1), 'aria-label': '上へ' }, '↑'),
      el('button', { type: 'button', class: 'sm', onclick: () => move(1), 'aria-label': '下へ' }, '↓'),
      el('button', { type: 'button', class: 'sm', onclick: () => { const n = prompt('工程の名前', x.name); if (n && n.trim()) { x.name = n.trim(); save(); renderProcAdmin(); } } }, '名前をなおす'),
      el('button', { type: 'button', class: 'sm', onclick: () => { x.active = !x.active; save(); renderProcAdmin(); } }, x.active ? '使わない' : '戻す'),
      el('button', { type: 'button', class: 'sm danger', onclick: () => {
        if (usedPr(x.id)) { alert('この工程は記録に使われているので消せません。「使わない」にしてください。'); return; }
        if (confirm(`「${x.name}」を消しますか？`)) { db.processes = db.processes.filter(y => y !== x); save(); renderProcAdmin(); }
      } }, '消す')));
  });
}

// 作業員
$('#workForm').onsubmit = ev => {
  ev.preventDefault();
  const name = $('#wName').value.trim(); if (!name) return;
  db.workers.push({ id: uid(), name, active: true }); save(); $('#wName').value = ''; renderWorkAdmin(); toast('追加しました');
};
function renderWorkAdmin() {
  const ul = $('#workAdmin'); ul.textContent = '';
  if (!db.workers.length) ul.append(el('li', {}, el('span', { class: 'muted' }, '作業員がいません')));
  db.workers.forEach((w, i) => {
    const move = d => { const j = i + d; if (j < 0 || j >= db.workers.length) return; [db.workers[i], db.workers[j]] = [db.workers[j], db.workers[i]]; save(); renderWorkAdmin(); };
    ul.append(el('li', { class: w.active ? '' : 'off' },
      el('span', { class: 'nm' }, w.name), w.active ? null : el('span', { class: 'tag' }, '休み中'),
      el('button', { type: 'button', class: 'sm', onclick: () => move(-1), 'aria-label': '上へ' }, '↑'),
      el('button', { type: 'button', class: 'sm', onclick: () => move(1), 'aria-label': '下へ' }, '↓'),
      el('button', { type: 'button', class: 'sm', onclick: () => { const n = prompt('名前', w.name); if (n && n.trim()) { w.name = n.trim(); save(); renderWorkAdmin(); } } }, '名前をなおす'),
      el('button', { type: 'button', class: 'sm', onclick: () => { w.active = !w.active; save(); renderWorkAdmin(); } }, w.active ? '休み中にする' : '戻す'),
      el('button', { type: 'button', class: 'sm danger', onclick: () => {
        if (usedW(w.id)) { alert('この人の記録があるので消せません。「休み中にする」を使ってください。'); return; }
        if (confirm(`${w.name}さんを消しますか？`)) { db.workers = db.workers.filter(x => x !== w); save(); renderWorkAdmin(); }
      } }, '消す')));
  });
}

// ---------- 記録・出力 ----------
$('#recMonth').value = today().slice(0, 7);
$('#recMonth').onchange = renderRec;
function monthDays(m) { const [y, mo] = m.split('-').map(Number); const n = new Date(y, mo, 0).getDate(); return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`); }
// その月に出てくる作業員（休み中でも記録があれば出す）
function monthWorkers(m) { return db.workers.filter(w => w.active || Object.keys(db.entries).some(k => k.startsWith(m) && k.endsWith('|' + w.id))); }
function renderRec() {
  const m = $('#recMonth').value; const t = $('#recTable'); t.textContent = '';
  if (!m) return;
  const ws = monthWorkers(m);
  t.append(el('thead', {}, el('tr', {}, el('th', {}, '日付'), ...ws.map(w => el('th', {}, w.name)))));
  const tb = el('tbody');
  for (const d of monthDays(m)) {
    const wd = parse(d).getDay(), cls = wd === 0 ? 'sun' : wd === 6 ? 'sat' : '';
    tb.append(el('tr', {}, el('th', { class: cls }, jp(d)), ...ws.map(w => {
      const e = db.entries[`${d}|${w.id}`];
      return el('td', { class: e ? '' : 'empty' }, e ? e.items.map(i => itemText(i, true)).join(' / ') : '');
    })));
  }
  t.append(tb);
}
// 1件の記録を物件ごとの人工に分ける（時間があれば時間の割合、なければ等分）
function shares(e) {
  const tot = e.items.reduce((s, i) => s + (i.hours || 0), 0);
  const allH = e.items.every(i => i.hours);
  return e.items.map(i => ({ pid: i.pid, procs: i.procs || [], hours: i.hours || 0, man: allH && tot ? i.hours / tot : 1 / e.items.length }));
}
function monthRows(m) {
  const rows = [];
  for (const d of monthDays(m)) for (const w of monthWorkers(m)) {
    const e = db.entries[`${d}|${w.id}`]; if (!e) continue;
    for (const s of shares(e)) { const p = proj(s.pid); rows.push({ d, w: w.name, code: p?.code || '', name: p?.name || '（消された物件）', procs: s.procs, proc: s.procs.map(procName).join('・'), hours: s.hours, man: s.man, note: e.note || '' }); }
  }
  return rows;
}
function download(blob, name) { const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
$('#csvOut').onclick = () => {
  const m = $('#recMonth').value; const rows = monthRows(m);
  if (!rows.length) { toast('この月の記録がありません'); return; }
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [['日付', '曜日', '作業員', '工事番号', '物件名', '工程', '時間', '人工', 'ひとこと'].map(q).join(','),
    ...rows.map(r => [r.d, WD[parse(r.d).getDay()], r.w, r.code, r.name, r.proc, r.hours || '', Math.round(r.man * 100) / 100, r.note].map(q).join(','))].join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv' }), `製作日報_${m}.csv`);
};
function loadExcel() {
  if (window.ExcelJS) return Promise.resolve();
  return new Promise((ok, ng) => { const s = el('script', { src: '../lib/exceljs/exceljs.min.js' }); s.onload = ok; s.onerror = () => ng(new Error('Excelの部品を読めませんでした')); document.head.append(s); });
}
$('#xlsxOut').onclick = async () => {
  const m = $('#recMonth').value; const rows = monthRows(m);
  if (!rows.length) { toast('この月の記録がありません'); return; }
  try { await loadExcel(); } catch (e) { alert(e.message); return; }
  const wb = new ExcelJS.Workbook();
  const head = r => { r.font = { bold: true }; r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4EEFA' } }; c.border = { bottom: { style: 'thin' } }; }); };
  // 明細
  const s1 = wb.addWorksheet('明細', { views: [{ state: 'frozen', ySplit: 1 }] });
  s1.columns = [{ header: '日付', width: 12 }, { header: '曜日', width: 6 }, { header: '作業員', width: 14 }, { header: '工事番号', width: 12 }, { header: '物件名', width: 32 }, { header: '工程', width: 16 }, { header: '時間', width: 8 }, { header: '人工', width: 8 }, { header: 'ひとこと', width: 30 }];
  for (const r of rows) s1.addRow([parse(r.d), WD[parse(r.d).getDay()], r.w, r.code, r.name, r.proc, r.hours || null, Math.round(r.man * 100) / 100, r.note]);
  s1.getColumn(1).numFmt = 'yyyy/mm/dd'; head(s1.getRow(1)); s1.autoFilter = { from: 'A1', to: 'I1' };
  // 日別（日付×作業員）
  const ws = monthWorkers(m);
  const s2 = wb.addWorksheet('日別', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  s2.addRow(['日付', ...ws.map(w => w.name)]); head(s2.getRow(1));
  s2.getColumn(1).width = 16; ws.forEach((_, i) => s2.getColumn(i + 2).width = 24);
  for (const d of monthDays(m)) {
    const r = s2.addRow([jp(d), ...ws.map(w => { const e = db.entries[`${d}|${w.id}`]; return e ? e.items.map(i => itemText(i)).join('\n') : ''; })]);
    r.alignment = { wrapText: true, vertical: 'top' };
    const wd = parse(d).getDay(); if (wd === 0 || wd === 6) r.getCell(1).font = { color: { argb: wd === 0 ? 'FFD64545' : 'FF2F6FB5' } };
  }
  // 物件別（物件×作業員の人工と時間）
  const s3 = wb.addWorksheet('物件別', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const agg = new Map();
  for (const r of rows) {
    const k = r.code + '\t' + r.name;
    if (!agg.has(k)) agg.set(k, { code: r.code, name: r.name, man: {}, hours: 0, days: new Set() });
    const a = agg.get(k); a.man[r.w] = (a.man[r.w] || 0) + r.man; a.hours += r.hours; a.days.add(r.d);
  }
  s3.addRow(['工事番号', '物件名', ...ws.map(w => w.name + '（人工）'), '人工 合計', '時間 合計', '製作した日数']); head(s3.getRow(1));
  s3.getColumn(1).width = 12; s3.getColumn(2).width = 32; ws.forEach((_, i) => s3.getColumn(i + 3).width = 12);
  [...agg.values()].sort((a, b) => a.code.localeCompare(b.code, 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja')).forEach(a => {
    const man = ws.map(w => a.man[w.name] ? Math.round(a.man[w.name] * 100) / 100 : null);
    s3.addRow([a.code, a.name, ...man, Math.round(man.reduce((s, v) => s + (v || 0), 0) * 100) / 100, a.hours || null, a.days.size]);
  });
  // 工程別（物件×工程の人工。1物件に工程が2つなら半分ずつ）
  const s4 = wb.addWorksheet('工程別', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const pcols = db.processes.filter(x => x.active || rows.some(r => r.procs.includes(x.id)));
  const NONE = '（工程なし）', hasNone = rows.some(r => !r.procs.length);
  const pagg = new Map();
  for (const r of rows) {
    const k = r.code + '\t' + r.name;
    if (!pagg.has(k)) pagg.set(k, { code: r.code, name: r.name, man: {} });
    const a = pagg.get(k), ks = r.procs.length ? r.procs : [NONE];
    for (const id of ks) a.man[id] = (a.man[id] || 0) + r.man / ks.length;
  }
  s4.addRow(['工事番号', '物件名', ...pcols.map(x => x.name + '（人工）'), ...(hasNone ? [NONE] : []), '合計']); head(s4.getRow(1));
  s4.getColumn(1).width = 12; s4.getColumn(2).width = 32; for (let i = 0; i <= pcols.length + 1; i++) s4.getColumn(i + 3).width = 12;
  const r2 = v => v ? Math.round(v * 100) / 100 : null;
  [...pagg.values()].sort((a, b) => a.code.localeCompare(b.code, 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja')).forEach(a => {
    const vals = [...pcols.map(x => a.man[x.id]), ...(hasNone ? [a.man[NONE]] : [])];
    s4.addRow([a.code, a.name, ...vals.map(r2), r2(vals.reduce((t, v) => t + (v || 0), 0))]);
  });
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `製作日報_${m}.xlsx`);
};

// ---------- その他 ----------
$('#pinSave').onclick = () => {
  const v = $('#pinInput').value.trim();
  if (v) localStorage.setItem(PINKEY, v); else localStorage.removeItem(PINKEY);
  $('#pinInput').value = ''; renderAdmin(); toast(v ? 'パスワードを決めました' : 'パスワードを無しにしました');
};
$('#bkSave').onclick = () => download(new Blob([JSON.stringify({ app: 'nippo', v: 1, savedAt: new Date().toISOString(), db }, null, 1)], { type: 'application/json' }), `製作日報_バックアップ_${today()}.json`);
$('#bkLoad').onchange = async ev => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.app !== 'nippo' || !j.db || !Array.isArray(j.db.workers)) throw 0;
    if (!confirm('いまのデータをバックアップの内容に置きかえます。よろしいですか？')) return;
    db = j.db; save(); renderAdmin(); toast('バックアップから戻しました');
  } catch (e) { alert('このファイルは製作日報のバックアップではないようです'); }
};

// ---------- はじめに ----------
// 日付が変わったら（夜通し開きっぱなしでも）ホームを今日に戻す
let lastToday = today();
setInterval(() => { if (today() !== lastToday) { if (curDate === lastToday) curDate = today(); lastToday = today(); if (!$('#vHome').hidden) renderHome(); } }, 60000);
// 初めて開いた時は、見本の作業員5人を入れておく（管理で名前をなおせる）
if (!db.workers.length && !db.projects.length && !Object.keys(db.entries).length) {
  db.workers = ['作業員A', '作業員B', '作業員C', '作業員D', '作業員E'].map(name => ({ id: uid(), name, active: true }));
  save();
}
renderHome();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
