// Googleドライブとの同期：どの端末で開いても同じ実測値・図面・写真が見られるようにする
// ドライブの「実測帳データ」フォルダに
//   data.json      … 現場・符号・実測値・写真の情報（写真そのものは別ファイル）と「消した印」
//   file_<id>      … 図面（PDF・画像）
//   photo_<id>     … 現場写真
// を置く。同じ物が両方にあれば、新しく書き換えたほうを残す。
const Sync = (() => {
  const CLIENT_ID = '950333121100-mr2lv09h1bokm5vpcbdj622qak0a0bed.apps.googleusercontent.com'; // Google Cloud プロジェクト jissokucho の OAuth クライアントID
  const SCOPE = 'https://www.googleapis.com/auth/drive.file'; // このアプリが作ったファイルだけ触れる
  const FOLDER = '実測帳データ';
  const TRACK = new Set(['sites', 'positions', 'photos', 'files']);
  const K = { email: 'jissoku.sync.email', tok: 'jissoku.sync.tok', on: 'jissoku.sync.on', last: 'jissoku.sync.last', tombs: 'jissoku.sync.tombs', folder: 'jissoku.sync.folder' };
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  let token = null, tokenExp = 0, folderId = LS.get(K.folder), running = false, again = false, timer = null, listeners = [];
  { const t = LS.get(K.tok); if (t && t.exp > Date.now()) { token = t.token; tokenExp = t.exp; } }

  // ---- 変更の見張り：保存・削除があったら少し待って同期。削除は「消した印」を残す ----
  const rawPut = Store.put, rawDel = Store.del;
  Store.put = async (s, v) => { const r = await rawPut(s, v); if (TRACK.has(s)) changed(); return r; };
  Store.del = async (s, id) => { const r = await rawDel(s, id); if (TRACK.has(s)) { const t = LS.get(K.tombs) || {}; t[id] = new Date().toISOString(); LS.set(K.tombs, t); changed(); } return r; };
  function changed() { if (!wasOn()) return; pending = true; if (connected()) schedule(4000); else emit(); }
  // 電波が戻ったらすぐ同期（1時間を過ぎて切れていたら、次のタップで自動つなぎ直し→同期）
  window.addEventListener('online', () => { state.netDown = false; emit(); if (connected()) syncNow(); });
  window.addEventListener('offline', () => emit());
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => syncNow(), ms); }

  // ---- 状態 ----
  const configured = () => !!CLIENT_ID;
  const wasOn = () => !!LS.get(K.on);
  const connected = () => wasOn() && !!token && Date.now() < tokenExp;
  const offline = () => navigator.onLine === false;
  let pending = false; // 電波がない間に書き換えた物がある
  const state = () => ({ configured: configured(), wasOn: wasOn(), connected: connected(), running, last: LS.get(K.last), error: state.error || null, offline: offline() || !!state.netDown, pending });
  function emit(extra) { listeners.forEach(f => { try { f({ ...state(), ...extra }); } catch (e) {} }); }

  // ---- Googleへのログイン（1時間ごとにつなぎ直しが必要） ----
  function loadGis() {
    return new Promise((res, rej) => {
      if (window.google?.accounts?.oauth2) return res();
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res; s.onerror = () => rej(new Error('Googleにつなげませんでした。電波を確認してください')); document.head.append(s);
    });
  }
  async function connect(silent) {
    if (!configured()) throw new Error('まだ準備中です（Googleの設定待ち）');
    await loadGis();
    await new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE,
        hint: LS.get(K.email) || undefined, // 前に使ったアカウントを自動で選ぶ
        callback: r => {
          if (r.error) return rej(new Error('許可されませんでした'));
          token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
          LS.set(K.tok, { token, exp: tokenExp }); LS.set(K.on, true); res();
        },
        error_callback: e => rej(new Error(e?.type === 'popup_closed' ? 'ログイン画面が閉じられました' : 'Googleにつなげませんでした')),
      });
      client.requestAccessToken({ prompt: silent || wasOn() ? '' : 'consent' });
    });
    state.error = null; emit();
    if (!LS.get(K.email)) { // 次から自動で選べるように、つないだアカウントを覚える
      try { const u = await (await api('about?fields=user(emailAddress)')).json(); if (u.user?.emailAddress) LS.set(K.email, u.user.emailAddress); } catch (e) {}
    }
    await syncNow();
  }
  // 切れていたら（または切れる5分前なら）、次に画面をタップした時に自動でつなぎ直す。
  // タップがきっかけでないとGoogleの小さな画面が開けないため
  let reconnecting = false, lastTry = 0;
  document.addEventListener('click', e => {
    if (!configured() || !wasOn() || reconnecting || offline()) return;
    if (e.target.closest?.('#syncConnect,#syncReconnect,#syncOff')) return; // つなぐボタン自体は別で処理
    if (token && tokenExp - Date.now() > 5 * 60e3) return;
    if (Date.now() - lastTry < 30e3) return; // うまくいかない時に何度も開かない
    reconnecting = true; lastTry = Date.now();
    connect(true).catch(() => { state.error = null; emit(); }).finally(() => { reconnecting = false; });
  }, true);
  function disconnect() {
    try { if (token) google?.accounts?.oauth2?.revoke?.(token, () => {}); } catch (e) {}
    token = null; tokenExp = 0; LS.set(K.tok, null); LS.set(K.on, false); LS.set(K.email, null); LS.set(K.folder, null); folderId = null; outFolderId = null; emit(); // 別のアカウントでつなぎ直せるように
  }

  // ---- ドライブの操作 ----
  async function api(url, opts = {}) {
    if (!url.startsWith('http')) url = 'https://www.googleapis.com/drive/v3/' + url;
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    if (!r.ok) { const e = new Error('ドライブ ' + r.status); e.status = r.status; throw e; }
    return r;
  }
  async function ensureFolder() {
    if (folderId) return folderId;
    const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = (await (await api(`files?q=${q}&fields=files(id)&spaces=drive`)).json()).files;
    if (found?.length) folderId = found[0].id;
    else folderId = (await (await api('files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).json()).id;
    LS.set(K.folder, folderId); return folderId;
  }
  async function listFolder() {
    const out = {}; let page = '';
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const j = await (await api(`files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000${page ? '&pageToken=' + page : ''}`)).json();
      (j.files || []).forEach(f => out[f.name] = f.id); page = j.nextPageToken || '';
    } while (page);
    return out;
  }
  async function upload(name, blob, existingId) {
    if (existingId) { await api(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`, { method: 'PATCH', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' } }); return existingId; }
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name, parents: [folderId] })], { type: 'application/json' }));
    form.append('file', blob);
    return (await (await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form })).json()).id;
  }
  const download = async id => (await api(`files/${id}?alt=media`)).blob();

  // ---- 同期の本体 ----
  const stamp = r => r?.updatedAt || r?.createdAt || '';
  async function syncNow() {
    if (!connected() || offline()) { emit(); return; }
    if (running) { again = true; return; }
    running = true; emit({ msg: '同期中…' });
    let pulled = 0;
    try {
      try { await ensureFolder(); var names = await listFolder(); }
      catch (e) { if (e.status === 404) { folderId = null; LS.set(K.folder, null); await ensureFolder(); names = await listFolder(); } else throw e; }
      let remote = { sites: [], positions: [], photos: [], tombs: {} };
      if (names['data.json']) remote = await (await download(names['data.json'])).text().then(JSON.parse);
      // 消した印は両方を合わせる
      const tombs = { ...(remote.tombs || {}) };
      Object.entries(LS.get(K.tombs) || {}).forEach(([id, t]) => { if (!tombs[id] || t > tombs[id]) tombs[id] = t; });
      // 現場・符号・写真の情報：新しいほうを残す
      for (const kind of ['sites', 'positions', 'photos']) {
        const local = new Map((await Store.all(kind)).map(r => [r.id, r]));
        for (const r of remote[kind] || []) {
          if (tombs[r.id] && tombs[r.id] >= stamp(r)) continue;
          const l = local.get(r.id);
          if (l && stamp(l) >= stamp(r)) continue;
          if (kind === 'photos') {
            const blob = l?.blob || (names['photo_' + r.id] ? await download(names['photo_' + r.id]) : null);
            if (!blob) continue;
            await rawPut('photos', { ...r, blob });
          } else await rawPut(kind, r);
          pulled++;
        }
        for (const [id, l] of local) if (tombs[id] && tombs[id] >= stamp(l)) { await rawDel(kind, id); pulled++; }
      }
      // 図面ファイル：手元にない物はドライブから取る
      const haveFiles = new Set((await Store.all('files')).map(f => f.id));
      for (const s of await Store.all('sites')) for (const d of s.drawings || []) {
        if (!haveFiles.has(d.id) && names['file_' + d.id]) { emit({ msg: `図面を受け取っています（${d.name}）` }); await rawPut('files', { id: d.id, blob: await download(names['file_' + d.id]) }); pulled++; }
      }
      for (const id of Object.keys(tombs)) if (haveFiles.has(id)) await rawDel('files', id);
      // 手元にしかない図面・写真をドライブへ
      for (const f of await Store.all('files')) if (!names['file_' + f.id] && !tombs[f.id]) { emit({ msg: '図面を送っています…' }); names['file_' + f.id] = await upload('file_' + f.id, f.blob); }
      const photos = await Store.all('photos');
      for (const ph of photos) if (!names['photo_' + ph.id]) { emit({ msg: '写真を送っています…' }); names['photo_' + ph.id] = await upload('photo_' + ph.id, ph.blob); }
      // 消した物の図面・写真はドライブからも消す
      for (const id of Object.keys(tombs)) for (const n of ['file_' + id, 'photo_' + id]) if (names[n]) { try { await api(`files/${names[n]}`, { method: 'DELETE' }); } catch (e) {} delete names[n]; }
      // 最後に data.json を最新にする（古すぎる消した印は整理）
      const old = new Date(Date.now() - 180 * 864e5).toISOString();
      Object.keys(tombs).forEach(id => { if (tombs[id] < old) delete tombs[id]; });
      const data = { app: 'jissokucho', version: 1, updatedAt: new Date().toISOString(),
        sites: await Store.all('sites'), positions: await Store.all('positions'), photos: photos.map(({ blob, ...r }) => r), tombs };
      await upload('data.json', new Blob([JSON.stringify(data)], { type: 'application/json' }), names['data.json']);
      LS.set(K.tombs, tombs); LS.set(K.last, new Date().toISOString()); state.error = null; state.netDown = false; pending = false;
    } catch (e) {
      if (e.status === 401 || e.status === 403) { token = null; tokenExp = 0; LS.set(K.tok, null); state.error = null; }
      else if (offline() || e instanceof TypeError) { state.netDown = true; state.error = null; pending = true; } // 電波がない・弱い
      else state.error = '同期できませんでした（' + (e.message || e) + '）';
    } finally {
      running = false; emit({ pulled });
      if (again) { again = false; schedule(1500); }
    }
  }
  // 開いている間は1分ごと、画面に戻った時にも他の端末の変更を取りに行く
  setInterval(() => { if (connected() && !document.hidden) syncNow(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && connected()) syncNow(); });

  // Excelなどの書き出しファイルを「実測帳データ/Excel出力」に保存（同じ名前があれば上書き）
  let outFolderId = null;
  async function saveExport(name, blob) {
    if (!connected() || offline()) throw new Error('ドライブとつながっていません');
    await ensureFolder();
    if (!outFolderId) {
      const q = encodeURIComponent(`name='Excel出力' and '${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
      const f = (await (await api(`files?q=${q}&fields=files(id)`)).json()).files;
      outFolderId = f?.length ? f[0].id : (await (await api('files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Excel出力', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] }) })).json()).id;
    }
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and '${outFolderId}' in parents and trashed=false`);
    const same = (await (await api(`files?q=${q}&fields=files(id)`)).json()).files;
    let id;
    if (same?.length) id = await upload(name, blob, same[0].id);
    else {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name, parents: [outFolderId] })], { type: 'application/json' }));
      form.append('file', blob);
      id = (await (await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form })).json()).id;
    }
    return { id, url: `https://drive.google.com/file/d/${id}/view`, overwritten: !!same?.length };
  }

  const email = () => LS.get(K.email) || '';
  return { connect, disconnect, syncNow, state, saveExport, email, onChange: f => listeners.push(f), connected, wasOn, configured,
    _test: { setToken(t) { token = t; tokenExp = Date.now() + 3600e3; LS.set(K.on, true); folderId = null; } } }; // 動作確認用
})();
