// 製作日報：作業員がその日に製作した物件をタブレットで入力する
// データはこのタブレットの中（localStorage）に保存する
//   workers  … 作業員 [{id, name, active}]（並び順は配列の順）
//   projects … 物件   [{id, code, name, active, createdAt}]
//   processes… 工程   [{id, name, active}]（手配・バラ図・切断・プレス・組み立て・部品・梱包・出荷。管理で変えられる）
//   entries  … 記録   {"YYYY-MM-DD|作業員id": {items:[{pid, procs:[工程id], hours}], note, at}}
//            休みの日は {items:[], off:'休み'|'有給'|'欠勤', note, at}
//   tombs    … 消した印 {id または "e:記録のキー": 消した時刻}（ドライブ同期で、消した物がよみがえらないように）
// 作業員・物件・工程には at（書き換えた時刻）と、作業員・工程には ord（並び順）を持たせる
'use strict';
const KEY = 'nippo.data.v1', PINKEY = 'nippo.pin';
const $ = s => document.querySelector(s);
const WD = ['日', '月', '火', '水', '木', '金', '土'];

// ---------- 保存 ----------
// 初めの工程。どの端末でも同じid・同じ時刻にして、ドライブ同期で二重にならないようにする（切断は前の版と同じ p0）
const PROC_AT = '2026-11-11T00:00:00.000Z';
const DEFAULT_PROCS = [['q0', '手配'], ['q1', 'バラ図'], ['p0', '切断'], ['q3', 'プレス'], ['q4', '組み立て'], ['q5', '部品'], ['q6', '梱包'], ['q7', '出荷']];
let db = load();
function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!d || !d.workers) d = { workers: [], projects: [], entries: {} };
  if (!d.processes) d.processes = defaultProcs(); // 工程を入れる前の版のデータにも足す
  if (!d.tombs) d.tombs = {};
  if (migrateProcs(d)) localStorage.setItem(KEY, JSON.stringify(d));
  for (const k of ['workers', 'processes']) d[k].forEach((x, i) => { if (x.ord == null) x.ord = i; });
  sortOrd(d);
  return d;
}
function sortOrd(d) { for (const k of ['workers', 'processes']) d[k].sort((a, b) => a.ord - b.ord); }
const nowIso = () => new Date().toISOString();
const nextOrd = list => list.reduce((m, x) => Math.max(m, x.ord ?? 0), -1) + 1;
function defaultProcs() { return DEFAULT_PROCS.map(([id, name], i) => ({ id, name, active: true, ord: i, at: PROC_AT })); }
// 前の版の初めの工程（切断・溶接・塗装）を一度も変えていなければ、新しい工程に入れかえる。
// 溶接・塗装は前の記録で使っているかもしれないので、消さずに「使わない」にする（管理→工程から消せる）
function migrateProcs(d) {
  const ps = d.processes;
  const old = ps.length === 3 && ps.every(x => !x.at) && ['p0:切断', 'p1:溶接', 'p2:塗装'].every(k => ps.some(x => `${x.id}:${x.name}` === k));
  if (!old) return false;
  const keep = ps.filter(x => x.id !== 'p0').map(x => ({ ...x, active: false, ord: 100 + Number(x.id.slice(1)), at: PROC_AT }));
  d.processes = [...defaultProcs(), ...keep];
  return true;
}
// 保存する。書き換えた物を渡すと、書き換えた時刻を付ける（ドライブ同期で新しいほうを残すため）
function save(...touched) {
  const t = nowIso(); for (const x of touched) x.at = t;
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { alert('保存できませんでした。タブレットの空きが足りないか、ブラウザが保存を止めています。このまま閉じると今の入力が消えるので、管理の人に知らせてください。'); return; }
  if (typeof Sync !== 'undefined') Sync.changed();
}
// 消す時は「消した印」を残す
function tomb(id) { db.tombs[id] = nowIso(); }

// ---------- ドライブ同期とのやりとり ----------
// 中身を比べるための形（キーの並びをそろえる）
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])]));
  return v;
}
const App = {
  exportDb: () => db,
  normalize: d => canon({ workers: [...(d.workers || [])].sort((a, b) => a.id < b.id ? -1 : 1), projects: [...(d.projects || [])].sort((a, b) => a.id < b.id ? -1 : 1), processes: [...(d.processes || [])].sort((a, b) => a.id < b.id ? -1 : 1), entries: d.entries || {}, tombs: d.tombs || {} }),
  // ドライブの中身を手元に合わせ入れる。手元が変わったら true
  mergeRemote(r) {
    const before = JSON.stringify(App.normalize(db));
    if (r.processes) migrateProcs(r); // まだ前の版のままの端末から来た工程も、新しい工程に入れかえてから合わせる
    // 初めてつないだ端末で、まだ見本の作業員しかいない時は、見本を捨ててドライブの中身を使う
    const pristine = !db.projects.length && !Object.keys(db.entries).length && db.workers.every(w => !w.at);
    if (pristine && (r.workers || []).length) db.workers = [];
    const tombs = { ...(r.tombs || {}) };
    for (const [id, t] of Object.entries(db.tombs)) if (!tombs[id] || t > tombs[id]) tombs[id] = t;
    const dead = (id, at) => tombs[id] && tombs[id] >= (at || '');
    for (const k of ['workers', 'projects', 'processes']) {
      const m = new Map(db[k].map(x => [x.id, x]));
      for (const x of r[k] || []) { const l = m.get(x.id); if (!l || (x.at || '') > (l.at || '')) m.set(x.id, x); }
      db[k] = [...m.values()].filter(x => !dead(x.id, x.at));
    }
    for (const [key, e] of Object.entries(r.entries || {})) { const l = db.entries[key]; if (!l || (e.at || '') > (l.at || '')) db.entries[key] = e; }
    for (const [key, e] of Object.entries(db.entries)) if (dead('e:' + key, e.at)) delete db.entries[key];
    const old = new Date(Date.now() - 400 * 864e5).toISOString(); // 古すぎる消した印は整理
    for (const id of Object.keys(tombs)) if (tombs[id] < old) delete tombs[id];
    db.tombs = tombs;
    sortOrd(db);
    localStorage.setItem(KEY, JSON.stringify(db));
    const changed = JSON.stringify(App.normalize(db)) !== before;
    if (changed) refresh();
    return changed;
  },
};
// ドライブから新しい入力が来たら、いま見ている画面を描き直す（入力中の画面はそのまま）
function refresh() {
  if (!$('#vHome').hidden) renderHome();
  else if (!$('#vAdmin').hidden) renderAdmin();
}
// 名前の比べ方：全角・半角や空白のちがいは同じとみなす（「5丁目」と「５丁目」など）
const normName = v => (v || '').normalize('NFKC').replace(/[\s　]/g, '').toLowerCase();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const proj = id => db.projects.find(p => p.id === id);
const worker = id => db.workers.find(w => w.id === id);
const pLabel = p => p ? (p.code ? `${p.code} ${p.name}` : p.name) : '（消された物件）';
const procName = id => db.processes.find(x => x.id === id)?.name || '（消された工程）';
const procText = i => (i.procs || []).map(procName).join('・');
// 1物件分の書き方：「24-101 ○○マンション【切断・溶接】(5h)」
const OFF_TYPES = ['休み', '有給', '欠勤'];
const entryText = (e, short, sep) => e.off ? `（${e.off}）` : e.items.map(i => itemText(i, short)).join(sep);
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
    // 頭文字の丸は、人ごとに色を変える（並び順で決まる）
    const hue = [221, 262, 190, 24, 334, 152, 45, 285][db.workers.indexOf(w) % 8];
    g.append(el('button', { type: 'button', class: 'wcard' + (e ? (e.off ? ' off' : ' done') : ''), onclick: () => openEntry(w.id) },
      el('span', { class: 'whead' }, el('span', { class: 'av', style: `--h:${hue}` }, [...w.name][0] || '?'), el('span', { class: 'nm' }, w.name)),
      el('span', { class: 'st' }, e ? (e.off ? e.off : '✓ 入力済み') : '未入力'),
      e && !e.off ? el('span', { class: 'pj' }, entryText(e, false, '\n')) : null));
  }
  // 上の進みぐあい（何人中 何人 入力済み）
  $('#hero').hidden = !ws.length;
  $('#heroDay').textContent = curDate === today() ? '今日の入力' : `${jp(curDate)} の入力`;
  $('#progDone').textContent = done; $('#progAll').textContent = `/ ${ws.length}人`;
  $('#progBar').style.width = (ws.length ? Math.round(done / ws.length * 100) : 0) + '%';
  $('#prog').classList.toggle('full', ws.length > 0 && done === ws.length);
  renderForgot();
}
// ---------- 入れ忘れ ----------
// 入れ忘れとみなす日：日曜以外で、だれかが作業を入れている（＝工場が動いていた）のに、その人の入力がない日。
// 今日はまだ入れる途中なので数えない。その人の最初の入力より前の日も数えない（あとから来た人のため）
function forgotDays(w, from, to) {
  const keys = Object.keys(db.entries);
  const mine = keys.filter(k => k.endsWith('|' + w.id)).map(k => k.split('|')[0]).sort();
  if (!mine.length) return [];
  const open = new Set(keys.filter(k => !db.entries[k].off).map(k => k.split('|')[0]));
  const out = [];
  for (let d = from > mine[0] ? from : mine[0]; d <= to && d < today(); d = addDays(d, 1)) {
    if (parse(d).getDay() !== 0 && open.has(d) && !db.entries[`${d}|${w.id}`]) out.push(d);
  }
  return out;
}
const md = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; };
function goEntry(d, wid) { curDate = d; show('vHome'); renderHome(); openEntry(wid); }
// ホーム：この2週間の入れ忘れ。タップでその日の入力へ
function renderForgot() {
  const box = $('#forgot'), list = $('#forgotList'); list.textContent = '';
  const from = addDays(today(), -14);
  for (const w of db.workers.filter(x => x.active)) {
    const ds = forgotDays(w, from, today());
    if (ds.length) list.append(el('div', { class: 'frow' }, el('span', { class: 'fnm' }, w.name),
      ...ds.map(d => el('button', { type: 'button', class: 'fchip', onclick: () => goEntry(d, w.id) }, md(d)))));
  }
  box.hidden = !list.children.length;
}
$('#dPrev').onclick = () => { curDate = addDays(curDate, -1); renderHome(); };
$('#dNext').onclick = () => { if (curDate < today()) { curDate = addDays(curDate, 1); renderHome(); } };
$('#dToday').onclick = () => { curDate = today(); renderHome(); };
// 日付をタップ：カレンダーからえらぶ（カレンダーを出せないブラウザでは文字で入れる）
$('#dLabel').onclick = () => {
  const pick = $('#dPick'); pick.max = today(); pick.value = curDate;
  try { pick.showPicker(); }
  catch (e) {
    const s = prompt('日付を入れてください（例：2026-11-05）', curDate);
    if (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && s <= today()) { curDate = s; renderHome(); }
  }
};
$('#dPick').onchange = ev => { const s = ev.target.value; if (s && s <= today()) { curDate = s; renderHome(); } };

// ---------- 入力 ----------
let ed = null; // 入力中 {wid, items:[{pid,hours}]}
function openEntry(wid) {
  const e = db.entries[`${curDate}|${wid}`];
  ed = { wid, items: e ? e.items.map(i => ({ ...i, procs: [...(i.procs || [])] })) : [], off: e?.off || '', showAll: false };
  $('#entryTitle').textContent = `${worker(wid).name}さん　${jp(curDate)}`;
  $('#entryNote').value = e ? e.note || '' : '';
  $('#projFilter').value = '';
  $('#entryClear').hidden = !e;
  renderEntry();
  ed.snap = edSnap();
  show('vEntry');
}
// 入力の中身（開いた時とくらべて、書きかえたかどうかを見る）
const edSnap = () => JSON.stringify([ed.items.map(i => [i.pid, i.procs, i.hours || 0]), $('#entryNote').value.trim()]);
function leaveEntry() {
  if (ed && ed.snap !== edSnap() && !confirm('保存していない入力があります。保存しないで戻りますか？')) return;
  show('vHome'); renderHome();
}
// えらべる物件。物件が多い時（受注残から何十件も登録した時）は、この人が最近使った物件だけを先に出す
const MANY = 12, RECENT_MAX = 8;
function entryProjects() {
  const mine = new Map(), any = new Map(); // 物件id → 最後に使った日（自分／だれか）
  for (const [k, e] of Object.entries(db.entries)) {
    const [d, w] = k.split('|');
    for (const i of e.items) { if (w === ed.wid && !(mine.get(i.pid) >= d)) mine.set(i.pid, d); if (!(any.get(i.pid) >= d)) any.set(i.pid, d); }
  }
  const sel = new Set(ed.items.map(i => i.pid));
  const byName = (a, b) => (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja');
  const all = db.projects.filter(p => p.active || sel.has(p.id))
    .sort((a, b) => (mine.get(b.id) || '').localeCompare(mine.get(a.id) || '') || (any.get(b.id) || '').localeCompare(any.get(a.id) || '') || byName(a, b));
  const recent = all.filter(p => mine.has(p.id)).slice(0, RECENT_MAX);
  return { all, recent };
}
function renderEntry() {
  const q = normName($('#projFilter').value);
  const g = $('#projGrid'); g.textContent = '';
  const { all, recent } = entryProjects();
  const sel = new Set(ed.items.map(i => i.pid));
  $('#projEmpty').hidden = all.length > 0;
  const btn = p => el('button', { type: 'button', class: 'pbtn' + (sel.has(p.id) ? ' on' : ''), onclick: () => toggle(p.id) },
    p.code ? el('span', { class: 'cd' }, p.code) : null, el('span', { class: 'nm' }, p.name));
  const head = t => el('p', { class: 'ghead' }, t);
  const more = $('#projMore'); more.hidden = true; $('#projNone').hidden = true;
  if (q) { // さがしている時：全部の物件から
    const hit = all.filter(p => normName(`${p.code} ${p.name}`).includes(q));
    for (const p of hit) g.append(btn(p));
    $('#projNone').hidden = hit.length > 0 || !all.length;
  } else if (all.length <= MANY || !recent.length) { // 少ない時、またはこの人がまだ何も入れていない時：全部
    for (const p of all) g.append(btn(p));
  } else {
    const rest = all.filter(p => !recent.includes(p));
    g.append(head('よく使う物件'));
    for (const p of recent) g.append(btn(p));
    // えらんだ物件は、たたんでいても見えるようにする
    const selRest = rest.filter(p => sel.has(p.id));
    if (ed.showAll) { g.append(head(`ほかの物件（${rest.length}件）`)); for (const p of rest) g.append(btn(p)); }
    else for (const p of selRest) g.append(btn(p));
    more.hidden = !rest.length;
    more.textContent = ed.showAll ? 'ほかの物件をたたむ' : `ほかの物件も見る（${rest.length}件）`;
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
        b.closest('li').classList.toggle('need', it.need = !it.procs.length && !!it.need);
      } }, pr.name);
      procs.append(b);
    }
    ul.append(el('li', { class: it.need ? 'need' : '' },
      el('span', { class: 'nm' }, pLabel(proj(it.pid))),
      procs,
      el('span', { class: 'hours' },
        el('button', { type: 'button', onclick: () => step(-0.5), 'aria-label': '30分へらす' }, '−'), out,
        el('button', { type: 'button', onclick: () => step(0.5), 'aria-label': '30分ふやす' }, '＋')),
      el('button', { type: 'button', class: 'sm danger', onclick: () => toggle(it.pid) }, 'はずす')));
  }
  $('#copyLast').hidden = !lastEntry();
  // 休みのボタン
  const ob = $('#offBtns'); ob.textContent = '';
  for (const t of OFF_TYPES) ob.append(el('button', { type: 'button', class: 'offbtn' + (ed.off === t ? ' on' : ''), onclick: () => setOff(t) }, t));
  $('#offNow').hidden = !ed.off;
  $('#offNow').textContent = ed.off ? `いまは「${ed.off}」で入っています。作業した場合は物件をえらんで保存してください。` : '';
}
// 休みを押したら、その場で保存してホームへ（物件をえらんでいたら確かめる）
function setOff(t) {
  if (ed.items.length && !confirm(`えらんだ物件を消して「${t}」にしますか？`)) return;
  delete db.tombs[`e:${curDate}|${ed.wid}`];
  db.entries[`${curDate}|${ed.wid}`] = { items: [], off: t, note: $('#entryNote').value.trim(), at: nowIso() };
  save(); toast(`${worker(ed.wid).name}さん　${t}で保存しました`);
  show('vHome'); renderHome();
}
function toggle(pid) {
  const i = ed.items.findIndex(x => x.pid === pid);
  if (i >= 0) ed.items.splice(i, 1); else ed.items.push({ pid, procs: [], hours: 0 });
  renderEntry();
  // えらんだ時は、その物件の工程をえらぶ欄が見える所まで画面を動かす
  if (i < 0) { const li = $('#selList').lastElementChild; li?.classList.add('fresh'); li?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}
$('#projMore').onclick = () => { ed.showAll = !ed.showAll; renderEntry(); };
// この人の、今の日付より前でいちばん新しい記録
function lastEntry() {
  let best = null;
  for (const [k, e] of Object.entries(db.entries)) {
    const [d, w] = k.split('|');
    if (w === ed.wid && d < curDate && !e.off && (!best || d > best.d)) best = { d, e };
  }
  return best;
}
$('#copyLast').onclick = () => {
  const l = lastEntry(); if (!l) return;
  ed.items = l.e.items.filter(i => proj(i.pid)).map(i => ({ pid: i.pid, procs: (i.procs || []).filter(id => db.processes.some(x => x.id === id && x.active)), hours: 0 }));
  renderEntry(); toast(`${jp(l.d)}と同じ物件・工程をえらびました`);
};
$('#projFilter').oninput = renderEntry;
$('#entryBack').onclick = leaveEntry;
$('#entrySave').onclick = () => {
  if (typeof Sync !== 'undefined') Sync.ensure(); // 同期が切れていたらつなぎ直す（ボタンを押した時でないとGoogleの画面が開けない）
  if (!ed.items.length) { toast('物件をえらんでください'); return; }
  // 工程は必ずえらぶ。えらんでいない物件は赤くして、そこまで画面を動かす
  const miss = ed.items.filter(i => !i.procs.length);
  if (miss.length) {
    for (const i of ed.items) i.need = !i.procs.length;
    renderEntry();
    document.querySelector('#selList li.need')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(miss.length === 1 ? `「${proj(miss[0].pid)?.name}」の工程をえらんでください` : `工程をえらんでいない物件が${miss.length}つあります`);
    return;
  }
  delete db.tombs[`e:${curDate}|${ed.wid}`];
  db.entries[`${curDate}|${ed.wid}`] = { items: ed.items.map(i => { const o = { pid: i.pid }; if (i.procs.length) o.procs = i.procs; if (i.hours) o.hours = i.hours; return o; }), note: $('#entryNote').value.trim(), at: new Date().toISOString() };
  save(); toast(`${worker(ed.wid).name}さん　保存しました`);
  show('vHome'); renderHome();
};
$('#entryClear').onclick = () => {
  if (!confirm('この日の入力を消しますか？')) return;
  delete db.entries[`${curDate}|${ed.wid}`]; tomb(`e:${curDate}|${ed.wid}`); save(); toast('消しました');
  show('vHome'); renderHome();
};

// ---------- 管理 ----------
$('#toAdmin').onclick = () => {
  if (typeof Sync !== 'undefined') Sync.ensure();
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
  const np = { id: uid(), code, name, active: true, createdAt: nowIso() };
  db.projects.push(np); save(np); $('#pName').value = ''; $('#pCode').value = ''; $('#pCode').focus(); renderProjAdmin(); toast('追加しました');
};
$('#showDone').onchange = renderProjAdmin;
$('#projSearch').oninput = renderProjAdmin;
function renderProjAdmin() {
  const ul = $('#projAdmin'); ul.textContent = '';
  const all = $('#showDone').checked;
  const pq = normName($('#projSearch').value);
  const list = db.projects.filter(p => (all || p.active) && (!pq || normName(`${p.code} ${p.name}`).includes(pq))).sort((a, b) => (b.active - a.active) || (a.code || '').localeCompare(b.code || '', 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja'));
  if (!list.length) ul.append(el('li', {}, el('span', { class: 'muted' }, pq ? 'さがした文字に合う物件がありません' : '物件がありません')));
  for (const p of list) {
    ul.append(el('li', { class: p.active ? '' : 'off' },
      el('span', { class: 'cd' }, p.code || '―'), el('span', { class: 'nm' }, p.name), p.active ? null : el('span', { class: 'tag' }, '完了'),
      el('button', { type: 'button', class: 'sm', onclick: () => {
        const code = prompt('工事番号', p.code); if (code === null) return;
        const name = prompt('物件名', p.name); if (!name || !name.trim()) return;
        p.code = code.trim(); p.name = name.trim(); save(p); renderProjAdmin();
      } }, 'なおす'),
      el('button', { type: 'button', class: 'sm', onclick: () => { p.active = !p.active; save(p); renderProjAdmin(); toast(p.active ? '入力画面に戻しました' : '完了にしました（入力画面に出なくなります）'); } }, p.active ? '完了にする' : '戻す'),
      el('button', { type: 'button', class: 'sm danger', onclick: () => {
        if (usedP(p.id)) { alert('この物件は記録に使われているので消せません。「完了にする」を使ってください。'); return; }
        if (confirm(`「${p.name}」を消しますか？`)) { db.projects = db.projects.filter(x => x !== p); tomb(p.id); save(); renderProjAdmin(); }
      } }, '消す')));
  }
}

// 工程
const usedPr = id => Object.values(db.entries).some(e => e.items.some(i => (i.procs || []).includes(id)));
$('#procForm').onsubmit = ev => {
  ev.preventDefault();
  const name = $('#prName').value.trim(); if (!name) return;
  if (db.processes.some(x => x.name === name)) { toast('同じ工程があります'); return; }
  const nx = { id: uid(), name, active: true, ord: nextOrd(db.processes) };
  db.processes.push(nx); save(nx); $('#prName').value = ''; renderProcAdmin(); toast('追加しました');
};
function renderProcAdmin() {
  const ul = $('#procAdmin'); ul.textContent = '';
  if (!db.processes.length) ul.append(el('li', {}, el('span', { class: 'muted' }, '工程がありません')));
  db.processes.forEach((x, i) => {
    const move = d => { const j = i + d; if (j < 0 || j >= db.processes.length) return; const a = db.processes[i], b = db.processes[j]; [a.ord, b.ord] = [b.ord, a.ord]; if (a.ord === b.ord) b.ord = a.ord + d; sortOrd(db); save(a, b); renderProcAdmin(); };
    ul.append(el('li', { class: x.active ? '' : 'off' },
      el('span', { class: 'nm' }, x.name), x.active ? null : el('span', { class: 'tag' }, '使わない'),
      el('button', { type: 'button', class: 'sm', onclick: () => move(-1), 'aria-label': '上へ' }, '↑'),
      el('button', { type: 'button', class: 'sm', onclick: () => move(1), 'aria-label': '下へ' }, '↓'),
      el('button', { type: 'button', class: 'sm', onclick: () => { const n = prompt('工程の名前', x.name); if (n && n.trim()) { x.name = n.trim(); save(x); renderProcAdmin(); } } }, '名前をなおす'),
      el('button', { type: 'button', class: 'sm', onclick: () => { x.active = !x.active; save(x); renderProcAdmin(); } }, x.active ? '使わない' : '戻す'),
      el('button', { type: 'button', class: 'sm danger', onclick: () => {
        if (usedPr(x.id)) { alert('この工程は記録に使われているので消せません。「使わない」にしてください。'); return; }
        if (confirm(`「${x.name}」を消しますか？`)) { db.processes = db.processes.filter(y => y !== x); tomb(x.id); save(); renderProcAdmin(); }
      } }, '消す')));
  });
}

// 作業員
$('#workForm').onsubmit = ev => {
  ev.preventDefault();
  const name = $('#wName').value.trim(); if (!name) return;
  const nw = { id: uid(), name, active: true, ord: nextOrd(db.workers) };
  db.workers.push(nw); save(nw); $('#wName').value = ''; renderWorkAdmin(); toast('追加しました');
};
function renderWorkAdmin() {
  const ul = $('#workAdmin'); ul.textContent = '';
  if (!db.workers.length) ul.append(el('li', {}, el('span', { class: 'muted' }, '作業員がいません')));
  db.workers.forEach((w, i) => {
    const move = d => { const j = i + d; if (j < 0 || j >= db.workers.length) return; const a = db.workers[i], b = db.workers[j]; [a.ord, b.ord] = [b.ord, a.ord]; if (a.ord === b.ord) b.ord = a.ord + d; sortOrd(db); save(a, b); renderWorkAdmin(); };
    ul.append(el('li', { class: w.active ? '' : 'off' },
      el('span', { class: 'nm' }, w.name), w.active ? null : el('span', { class: 'tag' }, '休み中'),
      el('button', { type: 'button', class: 'sm', onclick: () => move(-1), 'aria-label': '上へ' }, '↑'),
      el('button', { type: 'button', class: 'sm', onclick: () => move(1), 'aria-label': '下へ' }, '↓'),
      el('button', { type: 'button', class: 'sm', onclick: () => { const n = prompt('名前', w.name); if (n && n.trim()) { w.name = n.trim(); save(w); renderWorkAdmin(); } } }, '名前をなおす'),
      el('button', { type: 'button', class: 'sm', onclick: () => { w.active = !w.active; save(w); renderWorkAdmin(); } }, w.active ? '休み中にする' : '戻す'),
      el('button', { type: 'button', class: 'sm danger', onclick: () => {
        if (usedW(w.id)) { alert('この人の記録があるので消せません。「休み中にする」を使ってください。'); return; }
        if (confirm(`${w.name}さんを消しますか？`)) { db.workers = db.workers.filter(x => x !== w); tomb(w.id); save(); renderWorkAdmin(); }
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
      return el('td', { class: 'tap ' + (e ? (e.off ? 'offc' : '') : 'empty'), onclick: () => { if (d <= today()) goEntry(d, w.id); } }, e ? entryText(e, true, ' / ') : '');
    })));
  }
  t.append(tb);
  // この月の入れ忘れ
  const fl = $('#recForgot'); fl.textContent = '';
  for (const w of ws) {
    const ds = forgotDays(w, m + '-01', monthDays(m).at(-1));
    if (ds.length) fl.append(el('div', { class: 'frow' }, el('span', { class: 'fnm' }, w.name),
      ...ds.map(d => el('button', { type: 'button', class: 'fchip', onclick: () => goEntry(d, w.id) }, md(d)))));
  }
  if (!fl.children.length) fl.append(el('p', { class: 'note' }, 'この月の入れ忘れはありません。'));
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
    if (e.off) { rows.push({ d, w: w.name, off: e.off, code: '', name: '', procs: [], proc: '', hours: 0, man: 0, note: e.note || '' }); continue; }
    for (const s of shares(e)) { const p = proj(s.pid); rows.push({ d, w: w.name, code: p?.code || '', name: p?.name || '（消された物件）', procs: s.procs, proc: s.procs.map(procName).join('・'), hours: s.hours, man: s.man, note: e.note || '' }); }
  }
  return rows;
}
function download(blob, name) { const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
$('#csvOut').onclick = () => {
  const m = $('#recMonth').value; const rows = monthRows(m);
  if (!rows.length) { toast('この月の記録がありません'); return; }
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [['日付', '曜日', '作業員', '区分', '工事番号', '物件名', '工程', '時間', '人工', 'ひとこと'].map(q).join(','),
    ...rows.map(r => [r.d, WD[parse(r.d).getDay()], r.w, r.off || '作業', r.code, r.name, r.proc, r.hours || '', r.off ? '' : Math.round(r.man * 100) / 100, r.note].map(q).join(','))].join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv' }), `製作日報_${m}.csv`);
};
function loadExcel() {
  if (window.ExcelJS) return Promise.resolve();
  return new Promise((ok, ng) => { const s = el('script', { src: '../lib/exceljs/exceljs.min.js' }); s.onload = ok; s.onerror = () => ng(new Error('Excelの部品を読めませんでした')); document.head.append(s); });
}
$('#xlsxOut').onclick = () => makeXlsx(false);
$('#xlsxDrive').onclick = () => makeXlsx(true);
async function makeXlsx(toDrive) {
  const m = $('#recMonth').value; const rows = monthRows(m);
  if (!rows.length) { toast('この月の記録がありません'); return; }
  try { await loadExcel(); } catch (e) { alert(e.message); return; }
  const wb = new ExcelJS.Workbook();
  const head = r => { r.font = { bold: true }; r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4EEFA' } }; c.border = { bottom: { style: 'thin' } }; }); };
  // 明細
  const s1 = wb.addWorksheet('明細', { views: [{ state: 'frozen', ySplit: 1 }] });
  s1.columns = [{ header: '日付', width: 12 }, { header: '曜日', width: 6 }, { header: '作業員', width: 14 }, { header: '区分', width: 8 }, { header: '工事番号', width: 12 }, { header: '物件名', width: 32 }, { header: '工程', width: 16 }, { header: '時間', width: 8 }, { header: '人工', width: 8 }, { header: 'ひとこと', width: 30 }];
  for (const r of rows) s1.addRow([parse(r.d), WD[parse(r.d).getDay()], r.w, r.off || '作業', r.code, r.name, r.proc, r.hours || null, r.off ? null : Math.round(r.man * 100) / 100, r.note]);
  s1.getColumn(1).numFmt = 'yyyy/mm/dd'; head(s1.getRow(1)); s1.autoFilter = { from: 'A1', to: 'J1' };
  // 日別（日付×作業員）
  const ws = monthWorkers(m);
  const s2 = wb.addWorksheet('日別', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  s2.addRow(['日付', ...ws.map(w => w.name)]); head(s2.getRow(1));
  s2.getColumn(1).width = 16; ws.forEach((_, i) => s2.getColumn(i + 2).width = 24);
  for (const d of monthDays(m)) {
    const r = s2.addRow([jp(d), ...ws.map(w => { const e = db.entries[`${d}|${w.id}`]; return e ? entryText(e, false, '\n') : ''; })]);
    r.alignment = { wrapText: true, vertical: 'top' };
    const wd = parse(d).getDay(); if (wd === 0 || wd === 6) r.getCell(1).font = { color: { argb: wd === 0 ? 'FFD64545' : 'FF2F6FB5' } };
  }
  // 物件別（物件×作業員の人工と時間）
  const s3 = wb.addWorksheet('物件別', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const agg = new Map();
  for (const r of rows) {
    if (r.off) continue;
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
  const NONE = '（工程なし）', hasNone = rows.some(r => !r.off && !r.procs.length);
  const pagg = new Map();
  for (const r of rows) {
    if (r.off) continue;
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
  // 人別（作業した日・休み・入れ忘れの日数）
  const s5 = wb.addWorksheet('人別', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  s5.addRow(['作業員', '作業した日', ...OFF_TYPES, '入れ忘れ', '入れ忘れの日']); head(s5.getRow(1));
  s5.getColumn(1).width = 14; s5.getColumn(OFF_TYPES.length + 4).width = 40;
  for (const w of ws) {
    const es = monthDays(m).map(d => db.entries[`${d}|${w.id}`]).filter(Boolean);
    const fd = forgotDays(w, m + '-01', monthDays(m).at(-1));
    s5.addRow([w.name, es.filter(e => !e.off).length, ...OFF_TYPES.map(t => es.filter(e => e.off === t).length || null), fd.length || null, fd.map(md).join('、')]);
  }
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name = `製作日報_${m}.xlsx`;
  if (!toDrive) { download(blob, name); return; }
  try {
    toast('ドライブに保存しています…');
    const r = await Sync.saveExport(name, blob);
    toast(r.overwritten ? 'ドライブのExcelを新しくしました' : 'ドライブに保存しました');
    const a = $('#xlsxLink'); a.href = r.url; a.hidden = false;
  } catch (e) { alert('ドライブに保存できませんでした：' + e.message); }
}

// ---------- 物件をExcel・CSVからまとめて登録 ----------
let imp = null; // {sheets:[{name, rows:[[文字,...]]}], si, head(見出しの行 or -1), code, name, checked:Set}
const cellText = v => {
  if (v == null) return '';
  if (v instanceof Date) return `${v.getFullYear()}/${v.getMonth() + 1}/${v.getDate()}`;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(t => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    return '';
  }
  return String(v);
};
// CSVを行と列に分ける（"…" で囲んだ中の , や改行もそのまま）
function parseCsv(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
// ExcelのCSVはShift_JISのことが多いので、UTF-8で読めなければShift_JISで読む
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch (e) { return new TextDecoder('shift_jis').decode(buf); }
}
$('#impFile').onchange = async ev => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    let sheets;
    if (/\.(csv|txt)$/i.test(f.name)) sheets = [{ name: f.name, rows: parseCsv(decodeText(buf)) }];
    else if (/\.xls$/i.test(f.name)) throw new Error('古い形式のExcel（.xls）は読めません。Excelで「名前を付けて保存」→「Excelブック（.xlsx）」にしてから読み込んでください。');
    else {
      await loadExcel();
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
      sheets = wb.worksheets.filter(ws => ws.state !== 'hidden').map(ws => {
        const rows = []; // 横につないだセル（「【岩手県】」の見出しなど）は左の1マスだけ読む
        ws.eachRow({ includeEmpty: true }, (r, n) => { const vals = []; r.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = c.isMerged && c.master.row === c.row && c.master.col !== c.col ? '' : cellText(c.value).trim(); }); rows[n - 1] = vals; });
        return { name: ws.name, rows: Array.from(rows, r => Array.from(r || [], v => v || '')) };
      });
    }
    sheets = sheets.map(sh => ({ ...sh, rows: sh.rows.map(r => r.map(v => String(v).replace(/[\r\n]+/g, ' ').trim())) })).filter(sh => sh.rows.some(r => r.some(v => v)));
    if (!sheets.length) throw new Error('表の中に文字が見つかりませんでした。');
    imp = { sheets, cols: sheets.map(sh => guessCols(sh.rows)) };
    // 物件名の見出しがあるシートが2枚以上（受注残報告書のように担当ごとのシート）なら、はじめは全部のシートを読む
    imp.multi = imp.cols.filter(c => c.found).length >= 2;
    imp.si = imp.multi ? -1 : Math.max(0, imp.cols.findIndex(c => c.found));
    imp.checked = null; imp.doneChecked = new Set();
    renderImp();
    $('#impBox').hidden = false; $('#impBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { alert('読み込めませんでした：' + (e.message || e)); }
};
// 見出しの行と、工事番号・物件名・製品名の列をさがす
function guessCols(rows) {
  const ncol = Math.max(0, ...rows.map(r => r.length));
  const c = { head: -1, code: -1, name: -1, prod: -1, found: false };
  // 見出しは短い言葉だけのセル（「物件一覧（11月）」のような表題の行はとばす）
  const clean = v => v.replace(/[\s　・:：()（）]/g, '');
  const isName = v => /^(物件名?(称)?|工事名(称)?|工事件名|現場名(称)?|件名|名称)$/.test(clean(v));
  const isCode = v => /^(工事(番号|No\.?|NO\.?|ｺｰﾄﾞ|コード)|物件(番号|No\.?|NO\.?|コード)|番号|コード|ｺｰﾄﾞ|管理番号|受注番号|現場番号)$/i.test(clean(v));
  const isProd = v => /^(製品名?|品名|商品名?)$/.test(clean(v));
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i], n = r.findIndex(isName);
    if (n >= 0) { Object.assign(c, { head: i, name: n, code: r.findIndex((v, j) => j !== n && isCode(v)), prod: r.findIndex(isProd), found: true }); break; }
  }
  if (!c.found) { // 見出しがない：2列以上なら 1列目=工事番号・2列目=物件名、1列なら物件名だけ
    const filled = [...Array(ncol).keys()].filter(k => rows.some(r => r[k]));
    if (filled.length >= 2) { c.code = filled[0]; c.name = filled[1]; } else c.name = filled[0] ?? 0;
  }
  return c;
}
const colName = c => { let s = ''; c++; while (c) { s = String.fromCharCode(65 + (c - 1) % 26) + s; c = Math.floor((c - 1) / 26); } return s; };
const sameProject = (p, code, name) => code ? p.code === code : normName(p.name) === normName(name);
// 取り込む候補：見出しより下で、物件名がある行。同じ物件（工事番号、なければ物件名が同じ）は1つにまとめる
function impRows() {
  const idx = imp.si < 0 ? imp.cols.map((c, i) => c.found ? i : -1).filter(i => i >= 0) : [imp.si];
  const groups = new Map();
  for (const si of idx) {
    const sh = imp.sheets[si], c = imp.cols[si];
    sh.rows.forEach((r, i) => {
      if (i <= c.head) return;
      const name = (r[c.name] || '').trim(), code = c.code >= 0 ? (r[c.code] || '').trim() : '';
      if (!name || /^[\d.,\s]+$/.test(name) || /^[【\[［〔<＜].*[】\]］〕>＞]$/.test(name)) return; // 数字だけのセル（合計など）や「【岩手県】」のような区切りの見出しはとばす
      const key = code ? 'c:' + code : 'n:' + normName(name);
      if (!groups.has(key)) groups.set(key, { key, code, name, where: [], prods: [] });
      const g = groups.get(key);
      g.where.push(imp.si < 0 ? `${sh.name} ${i + 1}行` : `${i + 1}行`);
      const prod = c.prod >= 0 ? (r[c.prod] || '').trim() : '';
      if (prod && !g.prods.includes(prod)) g.prods.push(prod);
    });
  }
  return [...groups.values()].map(g => {
    const same = db.projects.find(p => sameProject(p, g.code, g.name));
    g.dup = same ? (normName(same.name) === normName(g.name) ? (same.active ? '登録済み' : '登録済み（完了）') : `工事番号が同じ物件あり（${same.name}）`) : '';
    return g;
  });
}
// 報告書に載っていない、入力画面に出ている物件（製作が終わったのかもしれない）
function impGone(rows) {
  return db.projects.filter(p => p.active && !rows.some(g => sameProject(p, g.code, g.name)));
}
function renderImp() {
  const multi = imp.si < 0;
  const sel = $('#impSheet'); sel.textContent = '';
  if (imp.multi) sel.append(el('option', { value: -1 }, `すべてのシート（${imp.cols.filter(c => c.found).length}枚）`));
  imp.sheets.forEach((s, i) => sel.append(el('option', { value: i }, s.name)));
  sel.value = imp.si; $('#impSheetL').hidden = imp.sheets.length < 2;
  // 列は1枚のシートの時だけえらべる（すべてのシートの時は、それぞれのシートの見出しから自動）
  for (const id of ['#impCode', '#impName']) $(id).closest('label').hidden = multi;
  if (!multi) {
    const sh = imp.sheets[imp.si], c = imp.cols[imp.si], ncol = Math.max(1, ...sh.rows.map(r => r.length)), head = sh.rows[c.head] || [];
    for (const [id, allowNone] of [['#impCode', true], ['#impName', false]]) {
      const s = $(id); s.textContent = '';
      if (allowNone) s.append(el('option', { value: -1 }, 'なし'));
      for (let k = 0; k < ncol; k++) s.append(el('option', { value: k }, `${colName(k)}列` + (head[k] ? `（${head[k]}）` : '')));
    }
    $('#impCode').value = c.code; $('#impName').value = c.name;
  }
  const rows = impRows();
  if (!imp.checked) imp.checked = new Set(rows.filter(r => !r.dup).map(r => r.key));
  const hasCode = rows.some(r => r.code), hasProd = rows.some(r => r.prods.length);
  const t = $('#impTable'); t.textContent = '';
  // 新しい物件を上に
  const order = [...rows.filter(r => !r.dup), ...rows.filter(r => r.dup)];
  const all = el('input', { type: 'checkbox' });
  all.checked = rows.some(r => !r.dup) && rows.filter(r => !r.dup).every(r => imp.checked.has(r.key));
  all.onchange = () => { for (const r of rows) if (!r.dup) all.checked ? imp.checked.add(r.key) : imp.checked.delete(r.key); renderImp(); };
  t.append(el('thead', {}, el('tr', {}, el('th', {}, all), hasCode ? el('th', {}, '工事番号') : null, el('th', {}, '物件名'), hasProd ? el('th', {}, '製品') : null, el('th', {}, '場所'), el('th', {}, ''))));
  const tb = el('tbody');
  for (const r of order) {
    const cb = el('input', { type: 'checkbox' }); cb.checked = !r.dup && imp.checked.has(r.key); cb.disabled = !!r.dup;
    cb.onchange = () => { cb.checked ? imp.checked.add(r.key) : imp.checked.delete(r.key); updImpInfo(rows); };
    tb.append(el('tr', { class: r.dup ? 'dup' : '' }, el('td', {}, cb), hasCode ? el('td', {}, r.code) : null, el('td', { class: 'impname' }, r.name),
      hasProd ? el('td', { class: 'small' }, r.prods.join('、')) : null, el('td', { class: 'small muted' }, r.where.join('、')), el('td', { class: 'muted' }, r.dup ? (r.dup.startsWith('登録済み') ? '✓ ' : '') + r.dup : '新しい物件')));
  }
  t.append(tb);
  updImpInfo(rows);
  // 報告書にない物件：完了にするか確かめる（はじめはチェックなし）
  const gone = multi ? impGone(rows) : [], gb = $('#impGone'), gl = $('#impGoneList');
  gb.hidden = !gone.length; gl.textContent = '';
  for (const p of gone) {
    const cb = el('input', { type: 'checkbox' }); cb.checked = imp.doneChecked.has(p.id);
    cb.onchange = () => { cb.checked ? imp.doneChecked.add(p.id) : imp.doneChecked.delete(p.id); updGone(); };
    gl.append(el('label', { class: 'chk goneitem' }, cb, ` ${pLabel(p)}`));
  }
  updGone();
}
function updGone() { const n = imp.doneChecked.size; $('#impDoneDo').disabled = !n; $('#impDoneDo').textContent = n ? `えらんだ ${n}件を完了にする` : '完了にする物件をえらんでください'; }
function updImpInfo(rows) {
  const n = rows.filter(r => !r.dup && imp.checked.has(r.key)).length, d = rows.filter(r => r.dup).length, nw = rows.filter(r => !r.dup).length;
  $('#impInfo').textContent = rows.length ? `物件 ${rows.length}件のうち、新しい物件 ${nw}件（登録済み ${d}件はとばします）。` + (imp.si < 0 ? '同じ物件名の行は1つにまとめています。' : '列がちがう時は上でえらびなおしてください。') : '物件名が見つかりません。シートや列をえらびなおしてください。';
  $('#impDo').disabled = !n; $('#impDo').textContent = n ? `えらんだ ${n}件を登録する` : (nw ? '登録する物件をえらんでください' : '新しい物件はありません');
}
$('#impSheet').onchange = () => { imp.si = +$('#impSheet').value; imp.checked = null; renderImp(); };
$('#impCode').onchange = () => { imp.cols[imp.si].code = +$('#impCode').value; imp.checked = null; renderImp(); };
$('#impName').onchange = () => { imp.cols[imp.si].name = +$('#impName').value; imp.checked = null; renderImp(); };
$('#impCancel').onclick = () => { imp = null; $('#impBox').hidden = true; };
$('#impDo').onclick = () => {
  const add = impRows().filter(r => !r.dup && imp.checked.has(r.key));
  if (!add.length) return;
  const t = nowIso();
  for (const r of add) db.projects.push({ id: uid(), code: r.code, name: r.name, active: true, createdAt: t, at: t });
  save(); imp.checked = new Set(); renderImp(); renderProjAdmin(); toast(`${add.length}件の物件を登録しました`);
};
$('#impDoneDo').onclick = () => {
  const ps = db.projects.filter(p => imp.doneChecked.has(p.id)); if (!ps.length) return;
  for (const p of ps) p.active = false;
  save(...ps); imp.doneChecked = new Set(); renderImp(); renderProjAdmin(); toast(`${ps.length}件を完了にしました（入力画面に出なくなります）`);
};
$('#impSample').onclick = async () => {
  try { await loadExcel(); } catch (e) { alert(e.message); return; }
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('物件');
  ws.columns = [{ header: '工事番号', width: 14 }, { header: '物件名', width: 40 }];
  ws.addRow(['24-101', '○○マンション新築工事']); ws.addRow(['24-102', '△△ビル改修工事']);
  ws.getRow(1).font = { bold: true };
  download(new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '物件の登録用_見本.xlsx');
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
    // バックアップの中身を「いま書き換えた」ことにする（同期しても戻した内容が勝つように）。今あってバックアップにない物は消す
    const t = nowIso(), keep = new Set();
    for (const k of ['workers', 'projects', 'processes']) for (const x of j.db[k] || []) { x.at = t; keep.add(x.id); }
    for (const e of Object.values(j.db.entries || {})) e.at = t;
    const tombs = {};
    for (const k of ['workers', 'projects', 'processes']) for (const x of db[k]) if (!keep.has(x.id)) tombs[x.id] = t;
    for (const key of Object.keys(db.entries)) if (!(j.db.entries || {})[key]) tombs['e:' + key] = t;
    db = { workers: [], projects: [], processes: defaultProcs(), entries: {}, ...j.db, tombs };
    for (const k of ['workers', 'processes']) db[k].forEach((x, i) => { if (x.ord == null) x.ord = i; });
    sortOrd(db); save(); renderAdmin(); toast('バックアップから戻しました');
  } catch (e) { alert('このファイルは製作日報のバックアップではないようです'); }
};

// ---------- はじめに ----------
// 最後に画面をさわった時刻
let lastTouch = Date.now();
for (const ev of ['pointerdown', 'keydown', 'input']) document.addEventListener(ev, () => { lastTouch = Date.now(); }, true);
const IDLE_MS = 5 * 60e3;
// 日付が変わったら（夜通し開きっぱなしでも）ホームを今日に戻す
let lastToday = today(), wantReload = false;
setInterval(() => {
  const idle = Date.now() - lastTouch;
  // 入力や管理の画面を開いたまま5分さわらなければ、ホームに戻す（次の人が他の人の画面で入れてしまわないように。管理画面も閉じる）
  if ($('#vHome').hidden && idle > IDLE_MS) { ed = null; imp = null; $('#impBox').hidden = true; show('vHome'); renderHome(); }
  if (today() !== lastToday) { if (curDate === lastToday) curDate = today(); lastToday = today(); wantReload = true; if (!$('#vHome').hidden) renderHome(); }
  // 日付が変わったあと、だれもさわっていなければ読み込み直す（開きっぱなしのタブレットでも新しい版になるように）
  if (wantReload && !$('#vHome').hidden && idle > 60e3 && navigator.onLine !== false) { wantReload = false; location.reload(); }
}, 30000);
// 初めて開いた時は、見本の作業員5人を入れておく（管理で名前をなおせる）
if (!db.workers.length && !db.projects.length && !Object.keys(db.entries).length) {
  db.workers = ['作業員A', '作業員B', '作業員C', '作業員D', '作業員E'].map((name, i) => ({ id: 'w' + i, name, active: true, ord: i }));
  save();
}
renderHome();

// ---------- ドライブ同期の表示とボタン ----------
const hm = s => { const d = new Date(s); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
function renderSync(st = Sync.state()) {
  const chip = $('#syncChip'), info = $('#syncInfo');
  let text = '', cls = '';
  if (!st.wasOn) text = '';
  else if (st.running) text = '同期中…';
  else if (st.error) { text = st.error; cls = 'err'; }
  else if (st.offline) { text = '電波なし（電波が戻ったら送ります）'; cls = 'warn'; }
  else if (!st.connected) { text = 'ドライブ同期が切れています（タップでつなぎ直す）'; cls = 'warn'; }
  else text = st.last ? `ドライブ同期済み ${hm(st.last)}` : 'ドライブにつながりました';
  chip.hidden = !st.wasOn; chip.textContent = text; chip.className = 'syncchip ' + cls;
  info.textContent = st.wasOn ? (st.email ? `${st.email} とつながっています。` : '') + text : 'まだつないでいません。';
  info.className = 'note ' + cls;
  $('#syncConnect').hidden = st.wasOn && st.connected;
  $('#syncConnect').textContent = st.wasOn ? 'つなぎ直す' : 'Googleドライブにつなぐ';
  $('#syncNow').hidden = !st.connected; $('#syncOff').hidden = !st.wasOn;
  $('#xlsxDrive').hidden = !st.connected;
}
Sync.onChange(renderSync); renderSync();
const doConnect = () => Sync.connect(Sync.wasOn()).catch(e => { toast(e.message); renderSync(); });
$('#syncChip').onclick = () => { const st = Sync.state(); if (!st.connected) doConnect(); else Sync.syncNow(); };
$('#syncConnect').onclick = doConnect;
$('#syncNow').onclick = () => Sync.syncNow();
$('#syncOff').onclick = () => { if (confirm('ドライブとの同期をやめますか？（このタブレットとドライブのデータは消えません）')) Sync.disconnect(); };
if (Sync.connected()) Sync.syncNow();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
