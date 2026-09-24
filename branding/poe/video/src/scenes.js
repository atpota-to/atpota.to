// scenes.js: the Poe promo, ~35 s. Each scene paints the whole frame from t alone.
// Dialogue is quoted from @poe.atpota.to's real replies on Bluesky.
const CUTS = [0, 5.0, 10.0, 16.5, 23.0, 28.5, 35.0];
const DURATION = 35.0;

// ---------- shared bits ----------
function wavyBand(y0, amp, len, ph, col, bottom = H + 60) {
  const pts = [[-60, bottom]];
  for (let x = -60; x <= W + 60; x += 40) pts.push([x, y0 + amp * Math.sin(x / len * TAU + ph) + jit(2)]);
  pts.push([W + 60, bottom]);
  paint(pts, { wash: col, ink: null });
}
function sparkle(x, y, r, col, k = 1) {
  if (k <= 0.01) return; r *= k; const c = r * 0.18;
  paint([[x, y - r], [x + c, y - c], [x + r, y], [x + c, y + c], [x, y + r], [x - c, y + c], [x - r, y], [x - c, y - c]], { wash: col, ink: null });
}
const bounceAt = (t, amt = 14) => Math.abs(Math.sin(bp(t) * Math.PI)) * amt;

// ---------- 1. underground: asleep, a mention arrives, Poe pops out ----------
function sUnderground(t) {
  const G = 430;
  paint(rectPts(-40, -40, W + 80, G + 60), { wash: PAL.sky, ink: null });
  paint(ellPts(1560, 150, 70, 70, 24, 1.5), { wash: '#FFE08A', ink: null });                     // sun
  wavyBand(G + 16, 5, 700, 1.2, PAL.soil);
  wavyBand(G + 260, 10, 520, 0.4, '#6C4E32');
  wavyBand(G + 480, 10, 610, 2.2, PAL.soilDk);
  for (let i = 0; i < 14; i++) {                                                                 // pebbles
    const x = hash(i) * W, y = G + 80 + hash(i + 40) * 520;
    if (Math.abs(x - W / 2) > 260) paint(ellPts(x, y, 14 + hash(i + 7) * 16, 10 + hash(i + 9) * 8, 14, 1.5), { wash: i % 2 ? '#957352' : '#4A3322', ink: null });
  }
  // grass
  const g = [[-60, G + 30]]; for (let x = -60; x <= W + 60; x += 30) g.push([x, G - 6 - (x / 30 % 2 ? 0 : 14) + jit(2)]); g.push([W + 60, G + 30]);
  paint(g, { wash: PAL.green, ink: null });
  for (const [x, s] of [[520, 1], [1390, 0.8], [1600, 1.1]]) {                                 // seedlings
    inkLine([[x, G], [x + 2, G - 30 * s], [x, G - 55 * s]], 2.2, PAL.green);
    paint(ellPts(x - 17 * s, G - 62 * s, 18 * s, 9 * s, 14, 0.8, -0.5), { wash: PAL.leaf, ink: null });
    paint(ellPts(x + 17 * s, G - 62 * s, 18 * s, 9 * s, 14, 0.8, 0.5), { wash: PAL.leaf, ink: null });
  }
  const rise = kf(t, [[0, 0], [2.9, 0], [3.55, 1]], easeIn);
  const land = seg(t, 3.55, 4.2);
  const y = lerp(1010, G + 18, rise) - (land > 0 ? Math.sin(land * Math.PI) * 60 * (1 - land) : 0);
  const sq = land > 0 ? -0.18 * Math.sin(land * Math.PI * 2) * (1 - land) : rise > 0 && rise < 1 ? -0.15 : 0;
  if (t > 3.3) paint(ellPts(W / 2, G + 22, 190, 26, 24, 2), { wash: '#3D2A1A', ink: null });  // the hole
  if (t < 3.4) paint(ellPts(W / 2, 830, 230, 205, 30, 3), { wash: '#5A3F28', ink: null });    // Poe's burrow
  const asleep = t < 2.25, wake = seg(t, 2.25, 2.5);
  poe(W / 2, y, 0.86, {
    blink: asleep ? 1 : blinkAt(t, 1), sq: sq + (asleep ? 0.03 * Math.sin(t * 3) : 0) - (wake > 0 && wake < 1 ? 0.12 * Math.sin(wake * Math.PI) : 0),
    waveL: t > 4.0 ? Math.sin((t - 4) * 9) * 0.45 : 0, lookY: t > 2.3 && t < 3 ? -1 : 0,
  });
  // flying clods
  if (t > 3.45) for (let i = 0; i < 12; i++) {
    const a = t - 3.45, dir = (hash(i) - 0.5) * 2.2, v = 900 + hash(i + 3) * 600;
    const x = W / 2 + dir * 260 + dir * a * 500, yy = G - v * a * Math.cos(dir * 0.5) + 1600 * a * a;
    if (yy < H + 40) paint(ellPts(x, yy, 12 + hash(i + 5) * 12, 10 + hash(i + 6) * 8, 12, 2), { wash: i % 3 ? PAL.soil : PAL.soilDk, ink: null });
  }
  // sleeping z's and the mention
  if (asleep) for (let i = 0; i < 3; i++) { const a = frac(t / 1.6 + i / 3); letter('z', W / 2 + 190 + a * 70, 700 - a * 160, 40 + a * 30, PAL.creamLt, { alpha: Math.sin(a * Math.PI), shadow: false }); }
  if (t > 1.3 && t < 3.3) bubble({ x: W / 2 + 40, y: G - 60, w: 430, txt: '@poe.atpota.to', size: 44, dark: true, tail: 'b', pop: (t - 1.3) * 4, alpha: 1 - seg(t, 3.0, 3.3) });
  sfx('!', W / 2 + 150, 590, 120, PAL.gold, t - 2.3, { life: 0.9 });
  sfx('pop!', W / 2 + 330, 250, 110, PAL.creamLt, t - 3.5, { life: 1.1, rot: 0.1 });
}

// ---------- 2. meet poe ----------
function sMeet(t, lt) {
  sunburst(700, 560, PAL.gold, PAL.goldLt, t * 0.06);
  for (let i = 0; i < 5; i++) sparkle(420 + hash(i) * 600, 180 + hash(i + 3) * 300, 22 + hash(i + 8) * 18, PAL.creamLt, Math.max(0, Math.sin((t * 1.3 + hash(i) * 3) * Math.PI)));
  const happy = lt > 2.6 && lt < 3.4;
  poe(700, 960, 1.28, { bounce: bounceAt(t, 18), sq: -0.05 * pulse(t, 8) + 0.03, waveL: Math.sin(lt * 7) * 0.45 + 0.1, blink: blinkAt(t, 2), happy });
  letter('meet', 1390, 330, 150, '#4F3B20', { pop: (lt - 0.5) * 3, shadow: false });
  letter('poe', 1390, 505, 250, '#4F3B20', { pop: (lt - 0.9) * 3, shadow: false });
  letter('a helpful potato that answers', 1390, 690, 50, '#5A4426', { alpha: seg(lt, 1.7, 2.2), weight: 500, shadow: false });
  letter('questions about the atmosphere', 1390, 752, 50, '#5A4426', { alpha: seg(lt, 1.9, 2.4), weight: 500, shadow: false });
}

// ---------- 3. the firehose ----------
const REC = [['heart', '#E27A92'], ['post', '#2F7FD0'], ['repost', '#39B54A'], ['follow', '#E8AA38']];
function record(x, y, s, kind, col) {
  if (kind === 'heart') paint(heartPts(x, y, 26 * s), { wash: col, ink: PAL.ink, sw: 0.8 });
  else if (kind === 'post') { paint(rrPts(x - 34 * s, y - 24 * s, 68 * s, 48 * s, 10 * s, 1), { wash: '#FFFBF0', ink: PAL.ink, sw: 0.8 }); paint(rectPts(x - 22 * s, y - 10 * s, 44 * s, 6 * s), { wash: col, ink: null }); paint(rectPts(x - 22 * s, y + 4 * s, 30 * s, 6 * s), { wash: col, ink: null }); }
  else if (kind === 'repost') { paint(ellPts(x, y, 26 * s, 26 * s, 18, 1), { wash: col, ink: PAL.ink, sw: 0.8 }); paint([[x - 12 * s, y + 6 * s], [x + 12 * s, y + 6 * s], [x, y - 12 * s]], { wash: '#FFFBF0', ink: null }); }
  else { paint(ellPts(x, y, 26 * s, 26 * s, 18, 1), { wash: col, ink: PAL.ink, sw: 0.8 }); paint(rectPts(x - 4 * s, y - 14 * s, 8 * s, 28 * s), { wash: '#FFFBF0', ink: null }); paint(rectPts(x - 14 * s, y - 4 * s, 28 * s, 8 * s), { wash: '#FFFBF0', ink: null }); }
}
function sFirehose(t, lt) {
  paint(rectPts(-40, -40, W + 80, H + 80), { wash: '#D6ECFF', ink: null });
  for (let i = 0; i < 5; i++) paint(ellPts(hash(i) * W, hash(i + 9) * H, 260, 160, 20, 8), { wash: '#E6F3FF', washOp: 170, ink: null });
  const on = seg(lt, 1.2, 1.5), off = seg(lt, 5.0, 5.6), blast = on * (1 - off);
  // the stream of records
  if (lt > 1.2) for (let i = 0; i < 46; i++) {
    const born = 1.2 + i * 0.09 + hash(i) * 0.05, age = lt - born; if (age < 0 || born > 5.2) continue;
    const x = 470 + age * 1150, y = 560 + (hash(i + 2) - 0.5) * 300 * Math.min(1, age * 2) + Math.sin(age * 6 + i) * 18;
    if (x < W + 80) record(x, y, 0.9 + hash(i + 4) * 0.5, ...REC[i % 4]);
  }
  // hose
  const hx = kf(lt, [[0.8, -520], [1.2, 0]], backOut);
  paint(rrPts(hx - 120, 520, 520, 80, 38, 2), { wash: '#C0463A', ink: PAL.ink, sw: 1.2 });
  paint(rrPts(hx + 380, 490, 90, 140, 24, 2), { wash: '#8C8C94', ink: PAL.ink, sw: 1.2 });
  const [sx, sy] = t > 11.2 && t < 15 ? [...shakeXY(t, 6 * blast)] : [0, 0];
  poe(1520 + sx, 1000 + sy, 1.02, {
    rot: 0.06 * blast, lookX: lt < 1.2 ? -1 : -0.6, lookY: lt < 1.2 ? -0.8 : 0.2, blink: blast > 0.5 ? 0 : blinkAt(t, 3),
    waveL: -0.5 * blast + (lt > 5.4 ? Math.sin(lt * 8) * 0.3 : 0), waveR: 0.3 * blast, sq: blast * 0.05, talk: lt > 4.6 ? Math.abs(Math.sin(lt * 14)) * (1 - seg(lt, 5.6, 5.8)) : 0,
  });
  bubble({ x: 1180, y: 250, w: 640, txt: 'gm, how’s the network looking?', size: 44, dark: true, tail: 'r', pop: (lt - 0.2) * 4 });
  letter('last 24h', 300, 740, 40, '#4F3B20', { pop: (lt - 1.8) * 4, weight: 500, shadow: false, align: 'left' });
  ['19.2M likes', '3.4M posts', '3.2M reposts', '1.7M follows'].forEach((s, i) => letter(s, 300, 800 + i * 64, 58, REC[i][1], { pop: (lt - 2.0 - i * 0.55) * 4, align: 'left', stroke: '#FFFBF0' }));
  bubble({ x: 1160, y: 560, w: 470, txt: 'the place is very awake (◕ᗜ◕)', size: 44, tail: 'r', pop: (lt - 4.6) * 4, type: seg(lt, 4.7, 5.6) });
}

// ---------- 4. the weather ----------
function umbrella() {
  inkLine([[46, 150], [52, 40], [60, -120]], 3, PAL.ink);
  const pts = []; for (let i = 0; i <= 16; i++) { const a = Math.PI + (i / 16) * Math.PI; pts.push([60 + Math.cos(a) * 170, -120 + Math.sin(a) * 100]); }
  for (let i = 3; i >= 0; i--) pts.push([60 + 170 - (i + 0.5) * 340 / 4 - 0, -120 + 18 * Math.sin(i * Math.PI)]);
  paint(pts, { wash: '#E88A8A', ink: PAL.ink, sw: 1.2 });
}
function sWeather(t, lt) {
  paint(rectPts(-40, -40, W + 80, H + 80), { wash: '#2B3A67', ink: null });
  wavyBand(930, 8, 800, 0.3, '#35467A');
  // server racks across the sky
  for (let r = 0; r < 7; r++) {
    const x = 60 + r * 270;
    paint(rrPts(x, -20, 230, 250, 12, 1.5), { wash: '#1C2544', ink: '#0F1528', sw: 1 });
    for (let u = 0; u < 5; u++) {
      paint(rectPts(x + 18, 14 + u * 44, 194, 30, 0.8), { wash: '#26315A', ink: null });
      const on = hash(r * 7 + u + Math.floor(t * 4) * 0.13) > 0.4;
      paint(ellPts(x + 190, 29 + u * 44, 6, 6, 10), { wash: on ? '#6BE07A' : '#3A4A3A', ink: null });
      paint(ellPts(x + 170, 29 + u * 44, 6, 6, 10), { wash: hash(r + u * 3 + Math.floor(t * 3)) > 0.5 ? '#FFCB52' : '#4A4430', ink: null });
    }
  }
  // drizzle of commits
  const gust = seg(lt, 3.7, 4.2) * (1 - seg(lt, 5.2, 5.8));
  for (let i = 0; i < 60; i++) {
    const sp = 380 + hash(i) * 160, y = frac(hash(i + 1) + (t * sp) / 1100) * 1100 - 40, x = hash(i + 2) * (W + 400) - 200 + (y / 1100) * 120 + gust * y * 0.5;
    paint(rrPts(x - 7, y - 7, 14, 14, 3), { wash: i % 5 ? '#DCE6FF' : '#FFCB52', washOp: 220, ink: null });
  }
  if (gust > 0) for (let i = 0; i < 5; i++) { const y = 380 + i * 110, x0 = -300 + seg(lt, 3.7 + i * 0.1, 5.3) * 2600; inkLine([[x0, y], [x0 + 200, y - 20], [x0 + 380, y + 10]], 2.5, '#CFE0FF', 'ink', 0.8); }
  poe(1360, 950, 1.0, {
    hold: umbrella, rot: -0.1 * gust * Math.sin(lt * 9) - 0.05 * gust, waveL: -0.15 + 0.1 * Math.sin(lt * 2), blink: blinkAt(t, 4),
    lookX: lt < 1.4 ? -0.8 : 0, lookY: lt < 1.4 ? -0.6 : 0, happy: lt > 5.4, talk: lt > 4.9 && lt < 5.4 ? Math.abs(Math.sin(lt * 14)) : 0,
  });
  bubble({ x: 1100, y: 330, w: 700, txt: 'hey poe, what’s the weather like by you?', size: 44, dark: true, tail: 'r', pop: (lt - 0.3) * 4, alpha: 1 - seg(lt, 4.6, 4.85) });
  ['100% chance of records', 'light drizzle of commits', 'occasional jetstream gusts'].forEach((s, i) => letter(s, 110, 560 + i * 90, 64, i === 2 ? '#CFE0FF' : '#FFF3D6', { pop: (lt - 1.6 - i * 1.0) * 4, align: 'left', shadow: false }));
  bubble({ x: 1100, y: 330, w: 640, txt: 'any weather app has me beat! ( ᐛ )', size: 44, tail: 'r', pop: (lt - 4.9) * 4, type: seg(lt, 5.0, 5.8) });
}

// ---------- 5. the questions keep coming ----------
function sQuestions(t, lt) {
  sunburst(W / 2, 760, '#F7EFDA', '#EEDFB6', -t * 0.05);
  const Q = [[1.1, 90, 230, 460, 'what is teal.fm?', 'l', [-1, -1]], [1.7, 1830, 250, 640, 'does any other account on the network use this lexicon?', 'r', [1, -1]],
             [2.3, 110, 600, 200, 'hi', 'l', [-1, 0.2]], [2.9, 1830, 640, 620, 'do you, as a potato, like talking about this stuff?', 'r', [1, 0]]];
  const cur = Q.filter((q) => lt > q[0]).pop();
  const answered = lt > 3.9;
  poe(W / 2, 1010, 1.05, {
    bounce: bounceAt(t, 16), sq: -0.05 * pulse(t, 8) + 0.03, blink: blinkAt(t, 5), happy: answered,
    lookX: cur && !answered ? cur[6][0] : 0, lookY: cur && !answered ? cur[6][1] : 0, waveL: answered ? Math.sin(lt * 9) * 0.5 : 0.1, talk: lt > 3.9 && lt < 4.4 ? Math.abs(Math.sin(lt * 14)) : 0,
  });
  if (answered) for (let i = 0; i < 7; i++) { const a = lt - 4.0 - i * 0.18; if (a > 0 && a < 1.6) paint(heartPts(W / 2 + (hash(i) - 0.5) * 560 + Math.sin(a * 5 + i) * 20, 560 - a * 260, 22 + hash(i + 2) * 14), { wash: '#E27A92', washOp: 255 * (1 - a / 1.6), ink: null }); }
  for (const [at, x, y, w, txt, tail] of Q) bubble({ x, y, w, txt, size: 40, dark: true, tail: tail === 'l' ? null : null, pop: (lt - at) * 4, alignX: tail });
  bubble({ x: W / 2, y: 520, w: 380, txt: 'i really do!', size: 50, tail: 'b', pop: (lt - 3.9) * 4 });
}

// ---------- 6. end card ----------
function sEnd(t, lt) {
  sunburst(620, 600, PAL.gold, PAL.goldLt, t * 0.06);
  poe(620, 970, 1.3, { bounce: bounceAt(t, 12), sq: -0.04 * pulse(t, 8) + 0.02, waveL: Math.sin(lt * 7) * 0.45 + 0.1, blink: blinkAt(t, 6) });
  letter('ask poe', 1370, 400, 170, '#4F3B20', { pop: (lt - 0.4) * 3, shadow: false });
  LETTERS.push({ kind: 'pill', txt: 'mention @poe.atpota.to on bluesky', x: 1370, y: 590, size: 46, pop: (lt - 1.1) * 3 });
  LETTERS.push({ kind: 'img', src: 'wordmark.png', x: 1370, y: 760, w: 300, pop: (lt - 1.7) * 3 });
}

// ---------- timeline ----------
const SCENES = [sUnderground, sMeet, sFirehose, sWeather, sQuestions, sEnd];
function drawWorld(t) {
  let i = 0; while (i < SCENES.length - 1 && t >= CUTS[i + 1]) i++;
  SCENES[i](t, t - CUTS[i]);
}
// Paint wipes between scenes and the closing iris, on top of everything (lettering included).
window.POST_FX = (c, t) => {
  for (let k = 1; k < CUTS.length - 1; k++) {
    const p = seg(t, CUTS[k] - 0.28, CUTS[k] + 0.28); if (p <= 0 || p >= 1) continue;
    const a = p < 0.5 ? -200 : lerp(-200, W + 400, (p - 0.5) / 0.5), b = p < 0.5 ? lerp(-200, W + 400, p / 0.5) : W + 400;
    c.fillStyle = k % 2 ? '#725B36' : '#A58650'; c.beginPath(); c.moveTo(a, -20);
    for (let y = -20; y <= H + 20; y += 60) c.lineTo(b - y * 0.35 + Math.sin(y * 0.02 + k) * 30, y);
    for (let y = H + 20; y >= -20; y -= 60) c.lineTo(a - y * 0.35 + Math.sin(y * 0.025 + k * 2) * 30, y);
    c.closePath(); c.fill();
  }
  const ir = seg(t, DURATION - 1.2, DURATION - 0.3);
  if (ir > 0) { const r = lerp(1400, 0, easeIn(ir)); c.fillStyle = '#4A3620'; c.beginPath(); c.rect(0, 0, W, H); c.arc(620, 560, Math.max(r, 0.1), 0, TAU, true); c.fill(); }
};
