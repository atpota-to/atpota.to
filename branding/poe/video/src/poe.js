// poe.js: Poe, painted from the kawaii potato's own vector shapes (POE_SHAPES).
// poe(x, y, s, o): (x, y) is the point under the middle of the potato's bottom; s scales the 505 x 407 frame.
// o: sq (squash, + flattens), rot, waveL / waveR (arm swing, radians), blink 0..1, lookX / lookY (-1..1),
//    talk 0..1 (open mouth), happy (closed-eye smile), bounce (lift in frame units), hold (fn painted at left leaf).
const POE_PIVOT = [252, 405];
const SH_L = [205, 208], SH_R = [298, 286];      // where each arm meets the body
const EYE_L = [230, 88], EYE_R = [352, 124];
function poe(x, y, s, o = {}) {
  const S = POE_SHAPES, sq = o.sq || 0;
  push();
  translate(x, y - (o.bounce || 0) * s); rotate(o.rot || 0); scale(s * (1 + sq * 0.5), s * (1 - sq));
  translate(-POE_PIVOT[0], -POE_PIVOT[1]);
  const lw = 1.1 / s;                                     // outline weight stays constant on screen
  const P = (pts, col, ink, sw = lw) => paint(pts, { wash: col, ink: ink === null ? null : ink || PAL.ink, sw });
  const limb = (name, leaf, pivot, ang) => {
    push(); translate(pivot[0], pivot[1]); rotate(ang || 0); translate(-pivot[0], -pivot[1]);
    P(S[name].subs[0], S[name].fill, '#1F7A2E', lw * 0.8);
    P(S[leaf].subs[0], S[leaf].fill, '#003D20', lw);
    if (leaf === 'leafL' && o.hold) o.hold();
    pop();
  };
  limb('armR', 'leafR', SH_R, o.waveR);
  limb('armL', 'leafL', SH_L, o.waveL);
  P(S.ring.subs[1], S.ring.fill, PAL.ink, lw * 1.2);        // outer body
  P(S.ring.subs[0], S.face.fill, null);                      // face (the ring's hole)
  P(S.at.subs[1], S.at.fill, null); P(S.at.subs[0], S.face.fill, null);
  P(S.dot1.subs[0], S.dot1.fill, null); P(S.dot2.subs[0], S.dot2.fill, null);
  // face
  const lx = (o.lookX || 0) * 9, ly = (o.lookY || 0) * 7, bl = clamp(o.blink || 0);
  if (o.happy) {
    for (const [ex, ey] of [EYE_L, EYE_R]) inkLine([[ex - 22 + lx, ey + 6 + ly], [ex + lx, ey - 12 + ly], [ex + 22 + lx, ey + 6 + ly]], lw * 3.2, PAL.brown, 'ink', 0.6);
  } else {
    const eye = (name, c, hi) => {
      push(); translate(c[0] + lx, c[1] + ly); scale(1, 1 - bl * 0.92); translate(-c[0], -c[1]);
      P(S[name].subs[0], S[name].fill, null);
      if (bl < 0.5) for (const h of hi) P(S[h].subs[0], S[h].fill, null);
      pop();
    };
    eye('eyeL', EYE_L, ['hiL1', 'hiL2']); eye('eyeR', EYE_R, ['hiR1', 'hiR2']);
  }
  if (o.talk > 0.05) P(ellPts(283, 128, 17, 7 + 14 * o.talk, 16), PAL.brown, null);
  else P(S.mouth.subs[0], S.mouth.fill, null);
  pop();
}
// Blink roughly every 3 s, from the time alone.
function blinkAt(t, seed = 0) { const p = 3.1 + seed * 0.37, x = frac((t + seed) / p) * p; return x < 0.14 ? Math.sin((x / 0.14) * Math.PI) : 0; }
