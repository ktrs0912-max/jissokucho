// 体験用の見本の現場をつくる（図面もここで描くので、実在の図面は使わない）
const Demo = (() => {
  // 見本の図面：バルコニー手摺の立面図と平面図（架空の建物）
  function drawSample() {
    const W = 2000, H = 1300, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#222'; g.fillStyle = '#222'; g.lineWidth = 3;
    g.strokeRect(30, 30, W - 60, H - 60);
    // 表題欄
    g.strokeRect(30, H - 150, W - 60, 120);
    g.font = '700 44px sans-serif'; g.fillText('見本図面　バルコニー手摺　立面図・平面図', 60, H - 80);
    g.font = '28px sans-serif'; g.fillText('（体験用の架空の図面です）　縮尺 1/50', 60, H - 42);
    g.fillText('みどりハイツ（見本）', W - 420, H - 80);
    // 立面図：手摺
    const x0 = 200, x1 = 1800, top = 260, bot = 520;
    g.lineWidth = 4; g.strokeRect(x0, top, x1 - x0, bot - top);
    g.lineWidth = 2;
    for (let x = x0 + 40; x < x1; x += 40) { g.beginPath(); g.moveTo(x, top + 20); g.lineTo(x, bot - 20); g.stroke(); }
    g.lineWidth = 5; [x0, 600, 1000, 1400, x1].forEach(x => { g.beginPath(); g.moveTo(x, top - 10); g.lineTo(x, bot + 30); g.stroke(); });
    // 寸法線
    g.lineWidth = 2; g.font = '30px sans-serif';
    const dim = (a, b, y, t) => { g.beginPath(); g.moveTo(a, y); g.lineTo(b, y); g.moveTo(a, y - 15); g.lineTo(a, y + 15); g.moveTo(b, y - 15); g.lineTo(b, y + 15); g.stroke(); g.fillText(t, (a + b) / 2 - g.measureText(t).width / 2, y - 12); };
    dim(x0, 600, 600, '1,000'); dim(600, 1000, 600, '1,000'); dim(1000, 1400, 600, '1,000'); dim(1400, x1, 600, '1,000');
    dim(x0, x1, 680, 'W=4,000');
    g.beginPath(); g.moveTo(x1 + 60, top); g.lineTo(x1 + 60, bot); g.stroke(); g.save(); g.translate(x1 + 100, (top + bot) / 2 + 60); g.rotate(-Math.PI / 2); g.fillText('H=1,100', 0, 0); g.restore();
    g.font = '700 34px sans-serif'; g.fillText('立面図', 940, 220);
    // 平面図：壁とバルコニー
    const py = 820;
    g.lineWidth = 8; g.beginPath(); g.moveTo(x0, py); g.lineTo(x1, py); g.stroke();
    g.lineWidth = 3; g.strokeRect(x0, py, x1 - x0, 230);
    g.lineWidth = 5; g.beginPath(); g.moveTo(x0, py + 230); g.lineTo(x1, py + 230); g.stroke();
    [x0, 600, 1000, 1400, x1].forEach(x => { g.fillRect(x - 10, py + 220, 20, 20); });
    g.font = '700 34px sans-serif'; g.fillText('平面図', 940, py - 30);
    // 符号の丸
    g.lineWidth = 3; g.beginPath(); g.arc(120, 390, 50, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(75, 390); g.lineTo(165, 390); g.stroke();
    g.font = '700 32px sans-serif'; g.fillText('B', 108, 380); g.fillText('1', 110, 425);
    return new Promise(res => c.toBlob(res, 'image/png'));
  }

  async function create() {
    const now = new Date().toISOString();
    const siteId = uid(), drawId = uid();
    const blob = await drawSample();
    await Store.put('files', { id: drawId, blob });
    const site = { id: siteId, name: 'みどりハイツ（見本）', createdAt: now, updatedAt: now, demo: true,
      drawings: [{ id: drawId, name: '見本図面（バルコニー手摺）', type: 'image', pages: 1, lastPage: 1,
        sketch: { 1: [
          { c: '#d7261e', w: 0.0018, pts: [[0.1, 0.17], [0.1, 0.2], [0.3, 0.2], [0.3, 0.17]] },
          { t: 'text', x: 0.31, y: 0.15, s: 'ここ要確認', c: '#d7261e', f: 0.016 },
        ] } }] };
    await Store.put('sites', site);
    // 番号：4か所を2F〜5Fで測った例（4Fの②だけズレている、設計は1000）
    const pts = [[0.2, 0.31], [0.4, 0.31], [0.6, 0.31], [0.8, 0.31]].map(([x, y]) => ({ id: uid(), x, y }));
    const vals = { '2F': [1002, 998, 1001, 999], '3F': [1001, 999, 1003, 1000], '4F': [999, 1024, 1000, 1001], '5F': [1000, 997, 1002, 998] };
    const values = {}; Object.entries(vals).forEach(([f, arr]) => { values[f] = {}; arr.forEach((v, i) => values[f][pts[i].id] = String(v)); });
    const design = {}; pts.forEach(p => design[p.id] = '1000');
    await Store.put('positions', { id: uid(), siteId, drawingId: drawId, page: 1, name: 'B-1', color: '#c42f26',
      floors: ['2F', '3F', '4F', '5F'], points: pts, values, design,
      memo: '見本：4Fの②だけ他の階とズレています（オレンジ色）。「設計」に1000を入れてあるので、差も表示されます。', createdAt: now, updatedAt: now });
    return site;
  }
  return { create };
})();
