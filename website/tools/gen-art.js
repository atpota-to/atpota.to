/* Deterministic art generator for the atpota.to homepage.
   Emits static SVG fragments (horizon band + tubers) that get pasted into index.html.
   Everything is seeded, so the drawing is identical on every run. */

const fs = require('fs');

function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const n = (v, d = 1) => Number(v.toFixed(d));
const rng = (r, lo, hi) => lo + r() * (hi - lo);

/* ------------------------------------------------------------------ tubers */
/* A perturbed 4-cubic circle: the silhouette is the whole personality. */
function tuberOutline(r, cx, cy, rx, ry, lobe){
  const k = 0.5523;
  const A = [
    { u: [ 1, 0], t: [0,  1] },   // right  anchor, handles run vertically
    { u: [ 0, 1], t: [-1, 0] },   // bottom anchor, handles run horizontally
    { u: [-1, 0], t: [0, -1] },
    { u: [ 0,-1], t: [1,  0] },
  ].map((a, i) => {
    let s = 1 + (r() - 0.5) * 0.28;
    if (i === lobe) s *= 1.30;
    return {
      x: cx + a.u[0] * rx * s,
      y: cy + a.u[1] * ry * s,
      tx: a.t[0], ty: a.t[1],
      hOut: k * (a.t[0] ? rx : ry) * (1 + (r() - 0.5) * 0.44),
      hIn:  k * (a.t[0] ? rx : ry) * (1 + (r() - 0.5) * 0.44),
    };
  });
  let d = `M${n(A[0].x)} ${n(A[0].y)}`;
  for (let i = 0; i < 4; i++){
    const a = A[i], b = A[(i + 1) % 4];
    const c1x = a.x + a.tx * a.hOut, c1y = a.y + a.ty * a.hOut;
    const c2x = b.x - b.tx * b.hIn,  c2y = b.y - b.ty * b.hIn;
    d += ` C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(b.x)} ${n(b.y)}`;
  }
  return d + 'Z';
}

/* The mascot's own sprout: a green stem with a dark heart-leaf, redrawn at scale. */
function sprout(r, x, y, ang, len, flip){
  const rad = ang * Math.PI / 180;
  const ex = x + Math.cos(rad) * len, ey = y + Math.sin(rad) * len;
  const bow = flip ? 1 : -1;
  const mx = x + Math.cos(rad) * len * 0.5 + Math.sin(rad) * len * 0.34 * bow;
  const my = y + Math.sin(rad) * len * 0.5 - Math.cos(rad) * len * 0.34 * bow;
  const s = len / 30;
  const leaf =
    `M0 6 C-9 -4 -3 -13 0 -7 C3 -13 9 -4 0 6Z`;
  return (
    `<path class="sp-stem" d="M${n(x)} ${n(y)} Q${n(mx)} ${n(my)} ${n(ex)} ${n(ey)}"/>` +
    `<g transform="translate(${n(ex)} ${n(ey)}) rotate(${n(ang + 90)}) scale(${n(s * 1.15, 2)})">` +
      `<path class="sp-leaf" d="${leaf}"/></g>`
  );
}

/* The @ swirl lifted off the mascot's belly — the brand fingerprint. */
function swirl(cx, cy, R){
  const turns = 1.85, steps = 46;
  let d = '';
  for (let i = 0; i <= steps; i++){
    const t = i / steps;
    const a = t * turns * Math.PI * 2 - Math.PI / 2;
    const rr = R * (0.20 + 0.80 * t);
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.94;
    d += (i ? 'L' : 'M') + n(x) + ' ' + n(y) + ' ';
  }
  // the @'s tail: sweeps out right then hooks down
  const a0 = turns * Math.PI * 2 - Math.PI / 2;
  const tx = cx + Math.cos(a0) * R, ty = cy + Math.sin(a0) * R * 0.94;
  d += `C${n(tx + R * 0.55)} ${n(ty + R * 0.30)} ${n(tx + R * 0.62)} ${n(ty + R * 0.95)} ${n(tx + R * 0.18)} ${n(ty + R * 1.06)}`;
  return d.trim();
}

function tuber(spec){
  const r = mulberry32(spec.seed);
  const W = 200, H = 140, cx = 100, cy = 70;
  const rx = 82, ry = 54;
  const outline = tuberOutline(r, cx, cy, rx, ry, spec.lobe);

  // eyes: seated on the surface, angled to follow it
  let eyes = '';
  for (let i = 0; i < spec.eyes; i++){
    const a = rng(r, 0, Math.PI * 2);
    const rr = rng(r, 0.30, 0.74);
    const x = cx + Math.cos(a) * rx * rr, y = cy + Math.sin(a) * ry * rr;
    const rot = n(a * 180 / Math.PI + rng(r, -28, 28));
    eyes +=
      `<g transform="translate(${n(x)} ${n(y)}) rotate(${rot})">` +
        `<ellipse class="eye" rx="5.2" ry="2.7"/>` +
        `<path class="brow" d="M-5.6 -3.4 Q0 -6.4 5.6 -3.4"/>` +
      `</g>`;
  }

  // sprouts grow from the rim, never from the middle
  let sprouts = '';
  for (let i = 0; i < spec.sprouts; i++){
    const a = spec.sproutAngles[i] * Math.PI / 180;
    const x = cx + Math.cos(a) * rx * 0.94, y = cy + Math.sin(a) * ry * 0.94;
    sprouts += sprout(r, x, y, spec.sproutAngles[i], spec.sproutLens[i], i % 2 === 0);
  }

  const body =
    `<path class="tb-fill" d="${outline}"/>` +
    `<path class="tb-shade" d="${outline}"/>` +
    `<ellipse class="tb-lit" cx="${n(cx - rx * 0.34)}" cy="${n(cy - ry * 0.40)}" rx="${n(rx * 0.40)}" ry="${n(ry * 0.34)}"/>` +
    `<path class="tb-swirl" d="${swirl(cx + spec.swirlDx, cy + spec.swirlDy, 26)}"/>` +
    eyes;

  return (
`<svg class="tuber" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">
<g transform="rotate(${spec.tilt} ${cx} ${cy})">${sprouts}${body}</g>
</svg>`);
}

/* A seed potato cut in half — the guide is the thing you open up to learn from. */
function halfTuber(seed){
  const r = mulberry32(seed);
  const W = 200, H = 140, cx = 100, cy = 70;
  const outline = tuberOutline(r, cx, cy, 78, 56, 3);
  const inner = tuberOutline(mulberry32(seed + 7), cx, cy, 62, 42, 1);
  return (
`<svg class="tuber tuber-cut" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">
<g transform="rotate(-7 ${cx} ${cy})">
<path class="tb-fill" d="${outline}"/>
<path class="tb-shade" d="${outline}"/>
<path class="cut-face" d="${inner}"/>
<path class="cut-ring" d="${inner}"/>
<path class="tb-swirl cut-swirl" d="${swirl(cx, cy, 20)}"/>
<g class="anno">
<path d="M138 42 L176 26"/><path d="M146 70 L188 70"/><path d="M136 100 L174 116"/>
</g>
</g>
</svg>`);
}

/* An unfilled nubbin: dashed means inferred, not observed. */
function nubbin(seed, size){
  const r = mulberry32(seed);
  const outline = tuberOutline(r, 60, 42, 44, 30, 2);
  return (
`<svg class="nub" viewBox="0 0 120 84" width="${size}" height="${n(size * 0.7)}" aria-hidden="true" focusable="false">
<path class="nub-path" d="${outline}"/>
</svg>`);
}

/* ---------------------------------------------------------------- horizon */
/* Crops, never stretches. The middle 390 units carry the best of the drawing. */
function horizon(){
  const r = mulberry32(0x9E3779B9);
  const VW = 1440, VH = 170;

  // a crumbling edge built from arcs of genuinely varying radius
  function edge(baseY, amp, minW, maxW){
    let x = -30, d = `M-30 ${VH} L-30 ${n(baseY)}`;
    let y = baseY;
    while (x < VW + 30){
      const w = rng(r, minW, maxW);
      const ny = baseY + rng(r, -amp, amp);
      const lift = rng(r, 0.55, 1.5);
      d += ` Q${n(x + w * 0.5)} ${n(Math.min(y, ny) - w * 0.14 * lift)} ${n(x + w)} ${n(ny)}`;
      x += w; y = ny;
    }
    return d + ` L${n(x)} ${VH} Z`;
  }

  const back  = edge(54, 8, 28, 66);   // far wall, sits behind the mascot
  const mid   = edge(86, 6, 18, 44);   // the mass that buries it
  // the lit rim of the mass, stroked not filled
  const midLine = mid.replace(/^M-30 170 L/, 'M').replace(/ L-?\d+(\.\d+)? 170 Z$/, '');

  // loose crumbs breaking upward, clustered, with one deliberately bare stretch
  let crumbs = '';
  // one deliberately bare stretch between 700 and 980 so the scatter never reads as a pattern
  const clusters = [[-10, 190], [230, 470], [520, 700], [980, 1180], [1230, 1450]];
  for (const [a, b] of clusters){
    const count = Math.round(rng(r, 4, 8));
    for (let i = 0; i < count; i++){
      const x = rng(r, a, b), s = rng(r, 5, 12);
      // straddle the mass edge: some sunk, some fully detached above it
      const y = 84 - rng(r, -6, 26);
      const p = tuberOutline(r, x, y, s, s * rng(r, 0.6, 0.95), Math.floor(rng(r, 0, 4)));
      crumbs += `<path class="crumb${r() < 0.42 ? ' crumb-dark' : ''}" d="${p}"/>`;
    }
  }

  // half-buried pebbles, each lit from the upper left
  let pebbles = '';
  for (let i = 0; i < 9; i++){
    const x = rng(r, 20, 1420), y = rng(r, 104, 158), s = rng(r, 7, 16);
    const p = tuberOutline(r, x, y, s, s * rng(r, 0.62, 0.9), Math.floor(rng(r, 0, 4)));
    pebbles += `<path class="pebble" d="${p}"/>` +
               `<path class="pebble-lit" d="${tuberOutline(mulberry32(i * 31 + 5), x - s * 0.22, y - s * 0.26, s * 0.52, s * 0.34, 3)}"/>`;
  }

  // overhanging foliage: tapered filled slivers, never strokes
  function blade(x, base, h, lean, w){
    const tipX = x + lean, tipY = base - h;
    const midX = x + lean * 0.35;
    return `M${n(x - w)} ${n(base)} Q${n(midX - w * 0.5)} ${n(base - h * 0.55)} ${n(tipX)} ${n(tipY)} ` +
           `Q${n(midX + w * 0.5)} ${n(base - h * 0.55)} ${n(x + w)} ${n(base)} Z`;
  }
  let grass = '';
  const bladeXs = [];
  for (let i = 0; i < 15; i++){
    const x = i < 4 ? rng(r, 560, 900) : rng(r, 10, 1430);   // keep the centre populated
    bladeXs.push(x);
    const h = rng(r, 16, 46), lean = rng(r, -20, 20), w = rng(r, 2.2, 4.2);
    const cls = r() < 0.3 ? 'blade blade-dark' : (r() < 0.25 ? 'blade blade-dry' : 'blade');
    grass += `<path class="${cls}" d="${blade(x, rng(r, 74, 90), h, lean, w)}"/>`;
  }
  // one bent stem carrying the chrysalis, one leaf carrying the caterpillar
  const stemX = 742;
  const foliage =
    `<path class="stem" d="M${stemX} 88 C${stemX + 4} 54 ${stemX + 22} 36 ${stemX + 46} 32"/>` +
    `<path class="leaf" d="M${stemX + 46} 32 C${stemX + 66} 20 ${stemX + 86} 26 ${stemX + 92} 37 C${stemX + 78} 47 ${stemX + 56} 45 ${stemX + 46} 32Z"/>` +
    // caterpillar on the leaf
    `<g class="cat" transform="translate(${stemX + 60} 33)">` +
      [0,1,2,3,4].map(i => `<circle cx="${i * 7}" cy="${n(Math.sin(i * 1.1) * 1.6)}" r="${n(4 - i * 0.35)}"/>`).join('') +
      `<circle class="cat-head" cx="-6" cy="0" r="4.4"/>` +
    `</g>` +
    // chrysalis hanging off the bend
    `<g class="chry" transform="translate(${stemX + 14} 50) rotate(8)">` +
      `<path d="M0 0 C7 2 8 12 4 20 C1 25 -3 25 -5 20 C-8 12 -6 3 0 0Z"/>` +
      `<path class="chry-line" d="M-1 6 L2 16"/>` +
    `</g>` +
    // dandelion + clover
    `<g class="dand" transform="translate(1180 74)">` +
      `<path class="stem" d="M0 18 C-2 8 0 2 1 -4"/>` +
      Array.from({length: 11}, (_, i) => {
        const a = (-160 + i * 16) * Math.PI / 180;
        return `<path class="fluff" d="M1 -4 L${n(1 + Math.cos(a) * 9)} ${n(-4 + Math.sin(a) * 9)}"/>`;
      }).join('') +
    `</g>` +
    `<g class="clover" transform="translate(342 76)">` +
      [0, 120, 240].map(a => `<ellipse class="leaf" rx="6" ry="4.4" transform="rotate(${a}) translate(6 0)"/>`).join('') +
      `<path class="stem" d="M0 2 C1 10 0 14 -1 18"/>` +
    `</g>`;

  // root filaments crossing up through the line: the root and the ground are one object
  let filaments = '';
  for (let i = 0; i < 11; i++){
    const x = rng(r, 600, 860), top = rng(r, 34, 72), bend = rng(r, -16, 16);
    filaments += `<path class="filament" d="M${n(x)} 168 C${n(x + bend)} ${n(120)} ${n(x - bend)} ${n(top + 26)} ${n(x + bend * 0.6)} ${n(top)}"/>`;
  }

  const open = cls =>
    `<svg class="horizon-art ${cls}" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">`;
  return {
    back: open('h-layer-back') + `<path class="h-back" d="${back}"/></svg>`,
    front: open('h-layer-front') +
      `<path class="h-mid" d="${mid}"/>` +
      `<path class="h-lip" d="${midLine}"/>` +
      `<g class="h-pebbles">${pebbles}</g>` +
      `<g class="h-filaments">${filaments}</g>` +
      `<g class="h-crumbs">${crumbs}</g>` +
      `<g class="h-grass">${grass}</g>` +
      `<g class="h-foliage">${foliage}</g>` +
      `</svg>`,
  };
}

/* ------------------------------------------------------------------- emit */
const TUBERS = {
  cred:    { seed: 101, eyes: 7, tilt: -6,  lobe: 0, sprouts: 2, sproutAngles: [-118, -52], sproutLens: [30, 24], swirlDx: 6,  swirlDy: 4 },
  anisota: { seed: 202, eyes: 5, tilt: 11,  lobe: 1, sprouts: 1, sproutAngles: [-96],       sproutLens: [34],     swirlDx: -4, swirlDy: 2 },
  aturi:   { seed: 303, eyes: 4, tilt: -3,  lobe: 2, sprouts: 0, sproutAngles: [],          sproutLens: [],       swirlDx: 2,  swirlDy: 0 },
  flushes: { seed: 404, eyes: 6, tilt: 17,  lobe: 3, sprouts: 1, sproutAngles: [-70],       sproutLens: [20],     swirlDx: 0,  swirlDy: 5 },
};

const H = horizon();
const out = {
  horizonBack: H.back, horizonFront: H.front,
  tubers: Object.fromEntries(Object.entries(TUBERS).map(([k, v]) => [k, tuber(v)])),
  half: halfTuber(505),
  nubs: [40, 34, 30, 26].map((s, i) => nubbin(600 + i * 17, s)),
};

fs.writeFileSync(__dirname + '/art.json', JSON.stringify(out, null, 0));
console.log('horizon back', out.horizonBack.length, 'front', out.horizonFront.length);
for (const k in out.tubers) console.log('tuber', k, out.tubers[k].length);
console.log('half', out.half.length, 'nubs', out.nubs.map(n => n.length).join(','));
