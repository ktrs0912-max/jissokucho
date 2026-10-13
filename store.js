// スマホの中（IndexedDB）にデータを保存する小さな倉庫
// sites: 現場 / files: 図面の中身 / positions: 位置ごとの番号と実測値
const Store = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('jissokucho', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('sites', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'id' });
        const p = d.createObjectStore('positions', { keyPath: 'id' });
        p.createIndex('drawing', 'drawingId');
        p.createIndex('site', 'siteId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    all: store => tx(store, 'readonly', s => req(s.getAll())),
    get: (store, id) => tx(store, 'readonly', s => req(s.get(id))),
    put: (store, v) => tx(store, 'readwrite', s => req(s.put(v))),
    del: (store, id) => tx(store, 'readwrite', s => req(s.delete(id))),
    byIndex: (store, idx, key) => tx(store, 'readonly', s => req(s.index(idx).getAll(key))),
  };
})();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
