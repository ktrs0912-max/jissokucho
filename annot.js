// 図面・写真への書き込みを1つの仕組みで扱う
// 道具：線（0.5秒止めると直線）／文字／選択（移動・コピー・貼り付け・削除）／消しゴム
// 位置・太さはすべて「書き込む先の幅（または高さ）を1とした割合」で記録する
const PEN_W = { 細: 0.0018, 太: 0.0045 };
const TEXT_F = { 細: 0.012, 太: 0.02 };
const STRAIGHT_MS = 500, SNAP_DEG = 15;
const PEN_COLORS = [['赤', '#d7261e'], ['青', '#1f5fd1'], ['黒', '#111111']];
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const strokeD = (st, W, H) => { const pts = st.pts.length === 1 ? [st.pts[0], st.pts[0]] : st.pts; return pts.map((p, i) => (i ? 'L' : 'M') + (p[0] * W).toFixed(1) + ' ' + (p[1] * H).toFixed(1)).join(''); };
const r4 = v => Math.round(v * 1e4) / 1e4;
const clone = it => JSON.parse(JSON.stringify(it));
const measure = document.createElement('canvas').getContext('2d');
let annotClipboard = null; // コピーした線・文字。図面⇔写真の間でも貼り付けられる

function itemSvg(it, W, H) {
  if (it.t === 'text') return `<text x="${it.x * W}" y="${it.y * H}" font-size="${it.f * W}" font-weight="700" fill="${it.c}" stroke="#fff" stroke-width="${it.f * W * 0.18}" paint-order="stroke" dominant-baseline="middle" font-family="sans-serif">${esc(it.s)}</text>`;
  return `<path d="${strokeD(it, W, H)}" fill="none" stroke="${it.c}" stroke-width="${it.w * W}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function drawItems(g, items, W, H) {
  items.forEach(st => {
    if (st.t === 'text') {
      g.font = `700 ${st.f * W}px sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.lineWidth = st.f * W * 0.18; g.strokeStyle = '#fff'; g.lineJoin = 'round'; g.strokeText(st.s, st.x * W, st.y * H);
      g.fillStyle = st.c; g.fillText(st.s, st.x * W, st.y * H); return;
    }
    const pts = st.pts.length === 1 ? [st.pts[0], st.pts[0]] : st.pts;
    g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0] * W, p[1] * H) : g.moveTo(p[0] * W, p[1] * H));
    g.strokeStyle = st.c; g.lineWidth = st.w * W; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
  });
}

class Annotator {
  // o: { items(), peek(), save(), render(), size()->{W,H}, k()->画面px/書き込み先px, textF, bar, btn, extra:[{label,run}] }
  constructor(o) {
    Object.assign(this, { o, tool: 'line', color: '#d7261e', w: '細', cur: null, sel: [], g: null, rect: null, eraser: null });
    this.buildBar();
  }
  // ---- 道具バー ----
  buildBar() {
    const b = this.o.btn || 'tool', bar = this.o.bar;
    bar.innerHTML = `
      <div class="seg">
        <button type="button" class="${b}" data-tool="line">✎ 線</button>
        <button type="button" class="${b}" data-tool="text">あ 文字</button>
        <button type="button" class="${b}" data-tool="select">⬚ 選択</button>
        <button type="button" class="${b}" data-tool="erase">消しゴム</button>
      </div>
      ${PEN_COLORS.map(([n, c]) => `<button type="button" class="${b} pc" data-c="${c}" aria-label="${n}"><i style="background:${c}"></i></button>`).join('')}
      <button type="button" class="${b}" data-act="w"></button>
      <button type="button" class="${b}" data-act="undo">1つ戻す</button>
      <span class="selacts">
        <button type="button" class="${b}" data-act="copy">コピー</button>
        <button type="button" class="${b}" data-act="paste">貼り付け</button>
        <button type="button" class="${b}" data-act="del">削除</button>
      </span>
      ${(this.o.extra || []).map((x, i) => `<button type="button" class="${b}" data-extra="${i}">${x.label}</button>`).join('')}`;
    bar.querySelectorAll('[data-tool]').forEach(x => x.onclick = () => this.setTool(x.dataset.tool, true));
    bar.querySelectorAll('.pc').forEach(x => x.onclick = () => this.setColor(x.dataset.c));
    bar.querySelector('[data-act=w]').onclick = () => this.toggleW();
    bar.querySelector('[data-act=undo]').onclick = () => this.undo();
    bar.querySelector('[data-act=copy]').onclick = () => this.copy();
    bar.querySelector('[data-act=paste]').onclick = () => this.paste();
    bar.querySelector('[data-act=del]').onclick = () => this.delSel();
    bar.querySelectorAll('[data-extra]').forEach(x => x.onclick = () => this.o.extra[+x.dataset.extra].run());
    this.syncBar();
  }
  syncBar() {
    const bar = this.o.bar;
    bar.querySelectorAll('[data-tool]').forEach(x => { const on = x.dataset.tool === this.tool; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
    bar.querySelectorAll('.pc').forEach(x => x.classList.toggle('on', x.dataset.c === this.color));
    const t = this.tool === 'text';
    bar.querySelector('[data-act=w]').textContent = `${t ? '文字' : '線'}：${this.w === '細' ? (t ? '小' : '細') : (t ? '大' : '太')}`;
    bar.querySelector('.selacts').hidden = this.tool !== 'select';
    bar.querySelector('[data-act=copy]').disabled = !this.sel.length;
    bar.querySelector('[data-act=del]').disabled = !this.sel.length;
    bar.querySelector('[data-act=paste]').disabled = !annotClipboard;
  }
  setTool(t, say) {
    this.tool = t; this.cancel(); if (t !== 'select') this.sel = [];
    this.syncBar(); this.o.render();
    if (say) toast({ line: '指でなぞると線。途中で0.5秒止めると直線', text: '文字を置きたい所をタップ。置いた文字をタップすると直せます', select: '線や文字をタップで選んで、ドラッグで移動。囲むと複数選べます', erase: 'なぞった線・文字を消します' }[t]);
  }
  setColor(c) {
    this.color = c;
    if (this.sel.length) { this.sel.forEach(it => it.c = c); this.o.save(); this.o.render(); }
    this.syncBar();
  }
  toggleW() {
    this.w = this.w === '細' ? '太' : '細';
    if (this.sel.length) { // 選んでいる物の太さ・大きさも変える
      this.sel.forEach(it => { if (it.t === 'text') it.f = TEXT_F[this.w] * (this.o.textF || 1); else it.w = PEN_W[this.w]; });
      this.o.save(); this.o.render();
    }
    this.syncBar();
  }
  // ---- 形の計算 ----
  bbox(it) {
    const { W, H } = this.o.size();
    if (it.t === 'text') {
      measure.font = `700 ${it.f * W}px sans-serif`;
      const w = measure.measureText(it.s).width / W, h = it.f * W / H;
      return [it.x, it.y - h / 2, it.x + w, it.y + h / 2];
    }
    const xs = it.pts.map(p => p[0]), ys = it.pts.map(p => p[1]), px = it.w / 2, py = it.w * W / H / 2;
    return [Math.min(...xs) - px, Math.min(...ys) - py, Math.max(...xs) + px, Math.max(...ys) + py];
  }
  hit(p, tolScreen) {
    const { W, H } = this.o.size(), tol = tolScreen / this.o.k(), list = this.o.peek();
    const X = p[0] * W, Y = p[1] * H;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (it.t === 'text') {
        const [a, b, c, d] = this.bbox(it);
        if (X >= a * W - tol && X <= c * W + tol && Y >= b * H - tol && Y <= d * H + tol) return it;
        continue;
      }
      const lim = tol + it.w * W / 2, pts = it.pts.length === 1 ? [it.pts[0], it.pts[0]] : it.pts;
      for (let j = 1; j < pts.length; j++) {
        const ax = pts[j - 1][0] * W, ay = pts[j - 1][1] * H, bx = pts[j][0] * W, by = pts[j][1] * H;
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / L)) : 0;
        if (Math.hypot(X - (ax + t * dx), Y - (ay + t * dy)) <= lim) return it;
      }
    }
    return null;
  }
  snap(a, b) {
    const { W, H } = this.o.size(), dx = (b[0] - a[0]) * W, dy = (b[1] - a[1]) * H, t = Math.tan(SNAP_DEG * Math.PI / 180);
    if (Math.abs(dy) <= Math.abs(dx) * t) return [b[0], a[1]];
    if (Math.abs(dx) <= Math.abs(dy) * t) return [a[0], b[1]];
    return b;
  }
  armStraight() {
    const g = this.g; if (!g) return;
    clearTimeout(g.timer);
    g.timer = setTimeout(() => {
      if (this.g !== g || !this.cur || this.cur.pts.length < 2) return;
      const { W, H } = this.o.size(), a = this.cur.pts[0], b = this.cur.pts[this.cur.pts.length - 1];
      if (Math.hypot((b[0] - a[0]) * W, (b[1] - a[1]) * H) * this.o.k() < 15) return;
      g.straight = true; this.cur.pts = [a, this.snap(a, b)]; this.o.render();
      try { navigator.vibrate?.(15); } catch (e) {}
    }, STRAIGHT_MS);
  }
  // ---- 指の動き（p は割合の座標、e は元のイベント） ----
  down(p, e) {
    const s = { x: e.clientX, y: e.clientY };
    if (this.tool === 'line') {
      this.cur = { c: this.color, w: PEN_W[this.w], pts: [p] };
      this.g = { type: 'line', ax: s.x, ay: s.y, straight: false }; this.armStraight();
    } else if (this.tool === 'text') {
      this.g = { type: 'tap', s, p, moved: false };
    } else if (this.tool === 'select') {
      const hit = this.hit(p, 14);
      if (hit) {
        if (!this.sel.includes(hit)) this.sel = [hit];
        this.g = { type: 'move', s, start: p, orig: this.sel.map(clone), moved: false };
      } else { this.g = { type: 'rect', s, start: p }; this.rect = [p, p]; }
    } else if (this.tool === 'erase') {
      this.g = { type: 'erase', changed: false }; this.eraseAt(p);
    }
    this.syncBar(); this.o.render();
  }
  move(p, e) {
    const g = this.g; if (!g) return;
    if (g.type === 'line') {
      if (Math.hypot(e.clientX - g.ax, e.clientY - g.ay) > 6) { g.ax = e.clientX; g.ay = e.clientY; if (!g.straight) this.armStraight(); }
      if (g.straight) this.cur.pts = [this.cur.pts[0], this.snap(this.cur.pts[0], p)];
      else {
        const { W, H } = this.o.size(), last = this.cur.pts[this.cur.pts.length - 1];
        if (Math.hypot((p[0] - last[0]) * W, (p[1] - last[1]) * H) * this.o.k() < 2) return;
        this.cur.pts.push(p);
      }
    } else if (g.type === 'tap') {
      if (Math.hypot(e.clientX - g.s.x, e.clientY - g.s.y) > 12) g.moved = true; return;
    } else if (g.type === 'move') {
      if (Math.hypot(e.clientX - g.s.x, e.clientY - g.s.y) > 4) g.moved = true;
      const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
      this.sel.forEach((it, i) => {
        const o = g.orig[i];
        if (it.t === 'text') { it.x = o.x + dx; it.y = o.y + dy; } else it.pts = o.pts.map(q => [q[0] + dx, q[1] + dy]);
      });
    } else if (g.type === 'rect') {
      this.rect = [g.start, p];
    } else if (g.type === 'erase') {
      this.eraseAt(p);
    }
    this.o.render();
  }
  up(p, e) {
    const g = this.g; if (!g) return;
    this.g = null; clearTimeout(g.timer);
    if (g.type === 'line' && this.cur) {
      this.cur.pts = this.cur.pts.map(q => [r4(q[0]), r4(q[1])]);
      this.o.items().push(this.cur); this.cur = null; this.o.save();
    } else if (g.type === 'tap' && !g.moved) {
      this.openText(g.p);
    } else if (g.type === 'move' && g.moved) {
      this.sel.forEach(it => { if (it.t === 'text') { it.x = r4(it.x); it.y = r4(it.y); } else it.pts = it.pts.map(q => [r4(q[0]), r4(q[1])]); });
      this.o.save();
    } else if (g.type === 'rect') {
      const [a, b] = this.rect, x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      const { W } = this.o.size();
      this.sel = (x1 - x0) * W * this.o.k() < 8 ? [] // ただのタップは選択解除
        : this.o.peek().filter(it => { const [c0, d0, c1, d1] = this.bbox(it); return c0 < x1 && c1 > x0 && d0 < y1 && d1 > y0; });
      this.rect = null;
      if (this.sel.length) toast(`${this.sel.length}個選びました。ドラッグで移動できます`);
    } else if (g.type === 'erase') {
      this.eraser = null; if (g.changed) this.o.save();
    }
    this.syncBar(); this.o.render();
  }
  // 2本目の指が来た時など、途中の操作を取りやめる
  cancel() {
    const g = this.g; this.g = null; if (g) clearTimeout(g.timer);
    if (g?.type === 'move') this.sel.forEach((it, i) => Object.assign(it, clone(g.orig[i])));
    if (g?.type === 'erase' && g.changed) this.o.save();
    this.cur = null; this.rect = null; this.eraser = null;
  }
  eraseAt(p) {
    this.eraser = p;
    let it; const list = this.o.peek();
    while ((it = this.hit(p, 14))) { list.splice(list.indexOf(it), 1); this.sel = this.sel.filter(x => x !== it); this.g.changed = true; }
  }
  openText(p) {
    const edit = this.hit(p, 8); const target = edit?.t === 'text' ? edit : null;
    showTextDlg(target,
      s => { if (target) { target.s = s; target.c = this.color; } else this.o.items().push({ t: 'text', x: r4(p[0]), y: r4(p[1]), s, c: this.color, f: TEXT_F[this.w] * (this.o.textF || 1) }); this.o.save(); this.o.render(); },
      () => { const l = this.o.items(), i = l.indexOf(target); if (i >= 0) l.splice(i, 1); this.o.save(); this.o.render(); toast('文字を消しました'); },
      () => this.setTool('line')); // 文字を置いたら線に戻す
  }
  // ---- 選択した物の操作 ----
  copy() { if (!this.sel.length) return; annotClipboard = this.sel.map(clone); this.syncBar(); toast(`${this.sel.length}個コピーしました。貼り付けたい図面や写真で「貼り付け」`); }
  paste() {
    if (!annotClipboard) return;
    const items = annotClipboard.map(clone), d = 0.03;
    items.forEach(it => { if (it.t === 'text') { it.x = r4(it.x + d); it.y = r4(it.y + d); } else it.pts = it.pts.map(q => [r4(q[0] + d), r4(q[1] + d)]); });
    this.o.items().push(...items); this.sel = items;
    if (this.tool !== 'select') this.tool = 'select';
    this.o.save(); this.syncBar(); this.o.render();
    toast('貼り付けました。ドラッグで好きな場所へ動かせます');
  }
  delSel() {
    if (!this.sel.length) return;
    const l = this.o.items(); this.sel.forEach(it => { const i = l.indexOf(it); if (i >= 0) l.splice(i, 1); });
    toast(`${this.sel.length}個消しました`); this.sel = []; this.o.save(); this.syncBar(); this.o.render();
  }
  undo() {
    const l = this.o.peek(); if (!l.length) { toast('戻すものがありません'); return; }
    const it = l.pop(); this.sel = this.sel.filter(x => x !== it); this.o.save(); this.syncBar(); this.o.render();
  }
  clearSel() { this.cancel(); this.sel = []; this.syncBar(); }
  // ---- 画面に描く（書いた物＋書いている途中の線＋選択枠など） ----
  svg() {
    const { W, H } = this.o.size(), k = this.o.k(), lw = 1.5 / k;
    let h = this.o.peek().map(it => itemSvg(it, W, H)).join('');
    if (this.cur) h += itemSvg(this.cur, W, H);
    this.sel.forEach(it => { const [a, b, c, d] = this.bbox(it), pad = 4 / k; h += `<rect x="${a * W - pad}" y="${b * H - pad}" width="${(c - a) * W + pad * 2}" height="${(d - b) * H + pad * 2}" fill="rgba(31,95,209,.06)" stroke="#1f5fd1" stroke-width="${lw}" stroke-dasharray="${4 / k} ${3 / k}"/>`; });
    if (this.rect) { const [a, b] = this.rect; h += `<rect x="${Math.min(a[0], b[0]) * W}" y="${Math.min(a[1], b[1]) * H}" width="${Math.abs(b[0] - a[0]) * W}" height="${Math.abs(b[1] - a[1]) * H}" fill="rgba(31,95,209,.08)" stroke="#1f5fd1" stroke-width="${lw}" stroke-dasharray="${4 / k} ${3 / k}"/>`; }
    if (this.eraser) h += `<circle cx="${this.eraser[0] * W}" cy="${this.eraser[1] * H}" r="${14 / k}" fill="rgba(255,255,255,.35)" stroke="#555" stroke-width="${lw}"/>`;
    return h;
  }
}
