// core.js: canvas, timing helpers, paper, painting wrapper, lettering, compositing.
// Every frame is a pure function of t, so frames can render in parallel and in any order.
const W = 1920, H = 1080, TAU = Math.PI * 2;
const BPM = 100, BEAT = 60 / BPM, BOIL = 12;   // linework re-randomises 12x a second ("boil")
const PAL = {
  paper: '#FBF3E1', ink: '#4A3620', brown: '#725B36', clay: '#A58650', cream: '#E3CE90', creamLt: '#FFF7E6',
  green: '#39B54A', leaf: '#006837', gold: '#FFCB52', goldLt: '#FFD978', sky: '#BFE3FF', blue: '#2F7FD0',
  soil: '#7A5A3A', soilDk: '#5B4029', night: '#23304F', rose: '#E88A8A'
};

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, x) => a + (b - a) * x;
const ease = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
const easeIn = (x) => Math.pow(clamp(x), 3);
const backOut = (x) => { x = clamp(x); const s = 1.9; return 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); };
const elasticOut = (x) => { x = clamp(x); return x === 0 || x === 1 ? x : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * (TAU / 3)) + 1; };
const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const seg = (t, a, b) => clamp((t - a) / (b - a));
const frac = (x) => x - Math.floor(x);
const bp = (t) => t / BEAT;
const pulse = (t, k = 6) => Math.exp(-frac(bp(t)) * k);
const wob = (t, f = 1, ph = 0) => Math.sin((t * f + ph) * TAU);
const jit = (a) => (random() * 2 - 1) * a;   // seeded per boil frame
function kf(t, keys, e = ease) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) {
    const [a, va] = keys[i - 1], [b, vb] = keys[i], k = e((t - a) / (b - a));
    return Array.isArray(va) ? va.map((v, j) => lerp(v, vb[j], k)) : lerp(va, vb, k);
  }
  return keys[keys.length - 1][1];
}
function mixCol(a, b, k) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16), c = (i) => Math.round(lerp((pa >> i) & 255, (pb >> i) & 255, clamp(k)));
  return '#' + ((1 << 24) + (c(16) << 16) + (c(8) << 8) + c(0)).toString(16).slice(1);
}

// ---------- geometry ----------
function rectPts(x, y, w, h, j = 0) {
  return [[x + jit(j), y + jit(j)], [x + w / 2, y + jit(j)], [x + w + jit(j), y + jit(j)], [x + w + jit(j), y + h / 2],
          [x + w + jit(j), y + h + jit(j)], [x + w / 2, y + h + jit(j)], [x + jit(j), y + h + jit(j)], [x + jit(j), y + h / 2]];
}
function ellPts(cx, cy, rx, ry, n = 28, j = 0, rot = 0) {
  const p = []; for (let i = 0; i < n; i++) { const a = rot + (i / n) * TAU; p.push([cx + Math.cos(a) * rx + jit(j), cy + Math.sin(a) * ry + jit(j)]); } return p;
}
function rrPts(x, y, w, h, r, j = 0) {
  const p = [], corner = (cx, cy, a0) => { for (let i = 0; i <= 5; i++) { const a = a0 + (i / 5) * Math.PI / 2; p.push([cx + Math.cos(a) * r + jit(j), cy + Math.sin(a) * r + jit(j)]); } };
  corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
  return p;
}
function heartPts(cx, cy, r) {
  const p = []; for (let i = 0; i < 30; i++) { const a = (i / 30) * TAU; p.push([cx + r * 0.06 * 16 * Math.pow(Math.sin(a), 3), cy - r * 0.06 * (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a))]); } return p;
}

// ---------- painting ----------
// One call paints one shape: flat wash and/or watercolour fill, then an optional tapered ink outline.
function paint(pts, o = {}) {
  if (o.wash || o.fill) {
    if (o.wash) brush.wash(o.wash, o.washOp ?? 255); else brush.noWash();
    if (o.fill) { brush.fill(o.fill, o.fillOp ?? 170); brush.fillBleed(o.bleed ?? 0.12); brush.fillTexture(o.tex ?? 0.45, o.border ?? 0.35); } else brush.noFill();
    brush.noHatch(); brush.noStroke();
    brush.polygon(pts);
  }
  if (o.ink !== null) {
    brush.noWash(); brush.noFill(); brush.noHatch(); brush.set(o.br || 'ink', o.ink || PAL.ink, o.sw ?? 1);
    brush.beginShape(o.curv || 0); for (const p of pts) brush.vertex(p[0], p[1]); brush.endShape(true);
  }
}
function inkLine(pts, sw = 1, col = PAL.ink, br = 'ink', curv = 0.5) { brush.noFill(); brush.noWash(); brush.noHatch(); brush.set(br, col, sw); brush.spline(pts, curv); }

// Sunburst: n wedges of colour b over a wash of colour a, turning slowly. Washes, not fills, to keep frames fast.
function sunburst(cx, cy, a, b, rot, n = 18, r = 2400) {
  paint(rectPts(-40, -40, W + 80, H + 80), { wash: a, ink: null });
  for (let i = 0; i < n; i++) {
    const a0 = rot + (i / n) * TAU, a1 = a0 + TAU / n / 2, pts = [[cx, cy]];
    for (let k = 1; k <= 6; k++) pts.push([cx + Math.cos(a0) * r * k / 6 + jit(4), cy + Math.sin(a0) * r * k / 6 + jit(4)]);
    for (let k = 6; k >= 1; k--) pts.push([cx + Math.cos(a1) * r * k / 6 + jit(4), cy + Math.sin(a1) * r * k / 6 + jit(4)]);
    paint(pts, { wash: b, washOp: 235, ink: null });
  }
}

// ---------- camera ----------
let CAM = null;
function camBegin(cx = W / 2, cy = H / 2, zoom = 1, rot = 0) { push(); translate(W / 2, H / 2); rotate(rot); scale(zoom); translate(-cx, -cy); CAM = { cx, cy, zoom, rot }; }
function camEnd() { pop(); CAM = null; }
function toScreen(x, y) {
  if (!CAM) return [x, y];
  const c = Math.cos(CAM.rot), s = Math.sin(CAM.rot), dx = (x - CAM.cx) * CAM.zoom, dy = (y - CAM.cy) * CAM.zoom;
  return [W / 2 + dx * c - dy * s, H / 2 + dx * s + dy * c];
}
const shakeXY = (t, amt) => { const f = Math.floor(t * 24); return [(hash(f * 1.7) - 0.5) * 2 * amt, (hash(f * 2.3 + 9) - 0.5) * 2 * amt]; };

// ---------- lettering and bubbles (drawn on the 2D compositor) ----------
let LETTERS = [];
const FONT = '"Fredoka", "DejaVu Sans", "IPAGothic", sans-serif';
// letter(txt, x, y, size, colour, { pop, rot, alpha, weight, align, shadow, maxW })
function letter(txt, x, y, size, color, o = {}) {
  if (CAM && !o.screen) { [x, y] = toScreen(x, y); size *= CAM.zoom; }
  LETTERS.push({ kind: 'text', txt, x, y, size, color, ...o });
}
function sfx(txt, x, y, size, color, age, o = {}) {
  const life = o.life ?? 1.2; if (age < 0 || age > life) return;
  letter(txt, x, y, size, color, { pop: age * 5, rot: (o.rot ?? -0.08) + Math.sin(age * 20) * 0.03 * (1 - age / life), alpha: 1 - seg(age, life - 0.25, life), ...o });
}
// Chat bubble: { x, y, w, txt, size, pop, dark (question) or light (Poe), tail: 'l' | 'r' | 'b' | null, label }
function bubble(o) { LETTERS.push({ kind: 'bubble', ...o }); }

function wrapLines(c, txt, maxW) {
  const words = txt.split(' '), lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (c.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
}
function drawLetters(c) {
  for (const L of LETTERS) {
    const k = L.pop != null ? backOut(L.pop) : 1; if (k <= 0.01) continue;
    c.save(); c.translate(L.x, L.y); c.rotate(L.rot || 0); c.scale(k, k); c.globalAlpha = clamp(L.alpha ?? 1);
    if (L.kind === 'pill') {
      c.font = `600 ${L.size}px ${FONT}`; const w = c.measureText(L.txt).width + L.size * 1.3, h = L.size * 1.7;
      c.fillStyle = '#4F3B20'; roundRect(c, -w / 2, -h / 2, w, h, h / 2); c.fill();
      c.fillStyle = '#FFF3D6'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(L.txt, 0, L.size * 0.05);
    } else if (L.kind === 'img') {
      const im = window.IMAGES[L.src]; c.drawImage(im, -L.w / 2, -L.w * im.height / im.width / 2, L.w, L.w * im.height / im.width);
    } else if (L.kind === 'text') {
      c.font = `${L.weight || 600} ${L.size}px ${FONT}`; c.textAlign = L.align || 'center'; c.textBaseline = 'middle';
      if (L.stroke) { c.lineJoin = 'round'; c.lineWidth = L.size * 0.16; c.strokeStyle = L.stroke; c.strokeText(L.txt, 0, 0); }
      if (L.shadow !== false) { c.fillStyle = 'rgba(74,54,32,0.9)'; c.fillText(L.txt, L.size * 0.04, L.size * 0.06); }
      c.fillStyle = L.color; c.fillText(L.txt, 0, 0);
    } else {
      const size = L.size || 40, pad = size * 0.65, lh = size * 1.28;
      c.font = `500 ${size}px ${FONT}`; const lines = wrapLines(c, L.txt, L.w - pad * 2), h = lines.length * lh + pad * 1.4;
      const bg = L.dark ? '#4F3B20' : '#FFFBF0', fg = L.dark ? '#FFF3D6' : '#4F3B20';
      // bubble anchored at its tail point (0,0); body placed relative to it
      const bx = L.tail === 'r' ? -L.w - 30 : L.tail === 'l' ? 30 : L.alignX === 'l' ? 0 : L.alignX === 'r' ? -L.w : -L.w / 2, by = L.tail === 'b' ? -h - 34 : -h * 0.35;
      c.fillStyle = 'rgba(74,54,32,0.18)'; roundRect(c, bx + 6, by + 10, L.w, h, size * 0.8); c.fill();
      c.fillStyle = bg; roundRect(c, bx, by, L.w, h, size * 0.8); c.fill();
      c.beginPath();
      if (L.tail === 'r') { c.moveTo(-40, by + 30); c.quadraticCurveTo(-12, by + 38, 0, by + 70); c.quadraticCurveTo(-30, by + 66, -44, by + 80); }
      else if (L.tail === 'l') { c.moveTo(40, by + 30); c.quadraticCurveTo(12, by + 38, 0, by + 70); c.quadraticCurveTo(30, by + 66, 44, by + 80); }
      else if (L.tail === 'b') { c.moveTo(-30, -36); c.quadraticCurveTo(-10, -14, 0, 0); c.quadraticCurveTo(14, -18, 30, -36); }
      c.fill();
      c.fillStyle = fg; c.textAlign = 'left'; c.textBaseline = 'top';
      const shown = L.type != null ? Math.floor(L.txt.length * clamp(L.type)) : Infinity; let used = 0;
      lines.forEach((ln, i) => { const part = ln.slice(0, Math.max(0, shown - used)); used += ln.length + 1; c.fillText(part, bx + pad, by + pad * 0.75 + i * lh); });
    }
    c.restore();
  }
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

// ---------- paper and grain ----------
function lcg(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function makePaper() {
  const g = createGraphics(W, H); g.pixelDensity(1); const c = g.drawingContext, rnd = lcg(11);
  c.fillStyle = PAL.paper; c.fillRect(0, 0, W, H);
  for (let i = 0; i < 60; i++) { const x = rnd() * W, y = rnd() * H, r = 120 + rnd() * 380, gr = c.createRadialGradient(x, y, 0, x, y, r), a = 0.04 * rnd(); gr.addColorStop(0, `rgba(160,125,80,${a})`); gr.addColorStop(1, 'rgba(160,125,80,0)'); c.fillStyle = gr; c.fillRect(x - r, y - r, 2 * r, 2 * r); }
  return g;
}
function makeGrain() {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d'), rnd = lcg(5);
  const id = c.createImageData(W, H), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const v = 255 - (rnd() < 0.5 ? rnd() * rnd() * 30 : 0); d[i] = v; d[i + 1] = v - 1; d[i + 2] = v - 3; d[i + 3] = 255; }
  c.putImageData(id, 0, 0);
  const g = c.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(120,95,70,.3)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  return cv;
}
function defineBrushes() {
  brush.add('ink', { type: 'default', weight: 5, scatter: 0.25, sharpness: 0.8, grain: 40, opacity: 235, spacing: 0.2, pressure: [1.15, 0.75], rotate: 'natural', noise: 0.15 });
  brush.add('dry', { type: 'default', weight: 14, scatter: 3, sharpness: 0.3, grain: 6, opacity: 90, spacing: 0.6, pressure: [1, 0.6], rotate: 'natural', noise: 0.4 });
}

// ---------- frame loop ----------
let T = 0, paperG, grainC, outC, outX;
async function setup() {
  createCanvas(W, H, WEBGL); pixelDensity(1); noLoop();
  brush.scaleBrushes(5); defineBrushes();
  paperG = makePaper(); grainC = makeGrain();
  outC = document.getElementById('out'); outX = outC.getContext('2d');
  await document.fonts.load(`600 100px Fredoka`);
  window.IMAGES = {}; await Promise.all(['wordmark.png'].map((f) => new Promise((ok) => { const i = new Image(); i.onload = () => { window.IMAGES[f] = i; ok(); }; i.src = f; })));
  window.ready = true;
}
function draw() {
  if (!window.ready) return;
  LETTERS = []; CAM = null;
  push(); translate(-W / 2, -H / 2);
  randomSeed(1000 + Math.floor(T * BOIL)); noiseSeed(77);
  image(paperG, 0, 0);
  drawWorld(T);
  pop();
}
function composite() {
  const c = outX;
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  c.drawImage(drawingContext.canvas, 0, 0, W, H);
  c.globalCompositeOperation = 'multiply'; c.drawImage(grainC, 0, 0);
  c.globalCompositeOperation = 'source-over';
  drawLetters(c);
  if (window.POST_FX) window.POST_FX(c, T);
}
window.renderAt = async (t, type = 'image/png', q = 0.92) => { T = t; await redraw(); composite(); return outC.toDataURL(type, q); };
