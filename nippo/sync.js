// Googleドライブとの同期：何台のタブレット・パソコンで開いても同じ記録が見られるようにする
// ドライブの「製作日報データ」フォルダに nippo.json（作業員・物件・工程・記録と「消した印」）を置く。
// 同じ物が両方にあれば、あとから書き換えたほうを残す。
// 製作日報専用のGoogleのログイン設定（Google Cloud プロジェクト seisaku-nippo）。このアプリが作ったファイルだけ触れる。
'use strict';
const Sync = (() => {
  const CLIENT_ID = '944235510828-ndgp5f29gsi1v5t5t3ba8pf1946cih25.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER = '製作日報データ', FILE = 'nippo.json';
  const K = { on: 'nippo.sync.on', tok: 'nippo.sync.tok', email: 'nippo.sync.email', last: 'nippo.sync.last', folder: 'nippo.sync.folder', cid: 'nippo.sync.cid' };
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  // ログイン設定が変わったら、前の設定でもらった鍵と、前の設定で作ったフォルダの覚えを捨てる（つなぎ直すと新しい設定で続ける）
  if (LS.get(K.cid) !== CLIENT_ID) { if (LS.get(K.cid) || LS.get(K.on)) { LS.set(K.tok, null); LS.set(K.folder, null); } LS.set(K.cid, CLIENT_ID); }
  let token = null, tokenExp = 0, folderId = LS.get(K.folder), running = false, again = false, timer = null, pending = false, error = null, netDown = false;
  const listeners = [];
  { const t = LS.get(K.tok); if (t && t.exp > Date.now()) { token = t.token; tokenExp = t.exp; } }

  const wasOn = () => !!LS.get(K.on);
  const connected = () => wasOn() && !!token && Date.now() < tokenExp;
  const offline = () => navigator.onLine === false || netDown;
  const state = () => ({ wasOn: wasOn(), connected: connected(), running, pending, error, offline: offline(), last: LS.get(K.last), email: LS.get(K.email) || '' });
  const emit = (extra = {}) => listeners.forEach(f => { try { f({ ...state(), ...extra }); } catch (e) {} });

  // ---- 変更があったら少し待って送る ----
  function changed() { if (!wasOn()) return; pending = true; if (connected()) schedule(2500); emit(); }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(syncNow, ms); }
  window.addEventListener('online', () => { netDown = false; emit(); if (connected()) syncNow(); });
  window.addEventListener('offline', () => emit());

  // ---- Googleへのログイン（1時間ごとにつなぎ直しが必要。タップがきっかけでないと開けない） ----
  function loadGis() {
    return new Promise((res, rej) => {
      if (window.google?.accounts?.oauth2) return res();
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res; s.onerror = () => rej(new Error('Googleにつなげませんでした。電波を確認してください')); document.head.append(s);
    });
  }
  if (wasOn()) loadGis().catch(() => {}); // 先に読んでおくと、つなぎ直しの画面がすぐ開ける
  async function connect(silent) {
    await loadGis();
    await new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE, hint: LS.get(K.email) || undefined,
        callback: r => {
          if (r.error) return rej(new Error('許可されませんでした'));
          token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
          LS.set(K.tok, { token, exp: tokenExp }); LS.set(K.on, true); res();
        },
        error_callback: e => rej(new Error(e?.type === 'popup_closed' ? 'ログイン画面が閉じられました' : 'Googleにつなげませんでした')),
      });
      client.requestAccessToken({ prompt: silent || wasOn() ? '' : 'consent' });
    });
    error = null; emit();
    if (!LS.get(K.email)) { try { const u = await (await api('about?fields=user(emailAddress)')).json(); if (u.user?.emailAddress) LS.set(K.email, u.user.emailAddress); } catch (e) {} }
    pending = true;
    await syncNow();
  }
  // 切れていたら（切れる5分前でも）つなぎ直す。保存・管理などのボタンを押した時に呼ぶ
  let lastTry = 0;
  function ensure() {
    if (!wasOn() || offline() || (token && tokenExp - Date.now() > 5 * 60e3)) return;
    if (Date.now() - lastTry < 60e3) return; // うまくいかない時に何度も開かない
    lastTry = Date.now();
    connect(true).catch(() => { error = null; emit(); });
  }
  function disconnect() {
    try { if (token) google?.accounts?.oauth2?.revoke?.(token, () => {}); } catch (e) {}
    token = null; tokenExp = 0; folderId = null;
    for (const k of [K.tok, K.on, K.email, K.folder]) LS.set(k, null);
    emit();
  }

  // ---- ドライブの操作 ----
  async function api(url, opts = {}) {
    if (!url.startsWith('http')) url = 'https://www.googleapis.com/drive/v3/' + url;
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    if (!r.ok) { const e = new Error('ドライブ ' + r.status); e.status = r.status; throw e; }
    return r;
  }
  async function findOrMakeFolder(name, parent) {
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : ''));
    const f = (await (await api(`files?q=${q}&fields=files(id)&spaces=drive`)).json()).files;
    if (f?.length) return f[0].id;
    return (await (await api('files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }) })).json()).id;
  }
  async function ensureFolder() { if (!folderId) { folderId = await findOrMakeFolder(FOLDER); LS.set(K.folder, folderId); } return folderId; }
  async function findFile(name, parent) {
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and '${parent}' in parents and trashed=false`);
    return (await (await api(`files?q=${q}&fields=files(id)`)).json()).files?.[0]?.id || null;
  }
  async function upload(name, blob, parent, id) {
    if (id) { await api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' } }); return id; }
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name, parents: [parent] })], { type: 'application/json' }));
    form.append('file', blob);
    return (await (await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form })).json()).id;
  }

  // ---- 同期の本体：ドライブの nippo.json と手元を合わせて、両方を同じにする ----
  async function syncNow() {
    if (!connected() || offline()) { emit(); return; }
    if (running) { again = true; return; }
    running = true; emit({ msg: '同期中…' });
    let changedLocal = false;
    try {
      let fid;
      try { await ensureFolder(); fid = await findFile(FILE, folderId); }
      catch (e) { if (e.status === 404) { folderId = null; await ensureFolder(); fid = await findFile(FILE, folderId); } else throw e; }
      const remote = fid ? await (await api(`files/${fid}?alt=media`)).json() : null;
      if (remote) changedLocal = App.mergeRemote(remote.db || remote);
      // 手元に変更がある時・ドライブにまだない時・合わせた結果がドライブと違う時に送る
      const mine = App.exportDb();
      if (pending || !remote || JSON.stringify(App.normalize(remote.db || remote)) !== JSON.stringify(App.normalize(mine))) {
        await upload(FILE, new Blob([JSON.stringify({ app: 'nippo', v: 1, savedAt: new Date().toISOString(), db: mine })], { type: 'application/json' }), folderId, fid);
      }
      pending = false; error = null; netDown = false; LS.set(K.last, new Date().toISOString());
    } catch (e) {
      if (e.status === 401 || e.status === 403) { token = null; tokenExp = 0; LS.set(K.tok, null); error = null; }
      else if (navigator.onLine === false || e instanceof TypeError) { netDown = true; error = null; } // 電波がない・弱い（電波が戻ったら送る）
      else error = '同期できませんでした（' + (e.message || e) + '）';
    } finally {
      running = false; emit({ pulled: changedLocal });
      if (again) { again = false; schedule(1000); }
    }
  }
  // 開いている間は1分ごと、画面に戻った時にも、他の端末の入力を取りに行く
  setInterval(() => { if (connected() && !document.hidden) syncNow(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && connected()) syncNow(); });

  // Excelを「製作日報データ/Excel出力」に保存（同じ名前があれば上書き）
  async function saveExport(name, blob) {
    if (!connected() || offline()) throw new Error('ドライブとつながっていません');
    await ensureFolder();
    const out = await findOrMakeFolder('Excel出力', folderId);
    const same = await findFile(name, out);
    const id = await upload(name, blob, out, same);
    return { id, url: `https://drive.google.com/file/d/${id}/view`, overwritten: !!same };
  }

  return { connect, disconnect, ensure, syncNow, changed, saveExport, state, connected, wasOn, onChange: f => listeners.push(f) };
})();
