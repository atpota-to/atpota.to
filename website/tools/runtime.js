(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var reduce = matchMedia('(prefers-reduced-motion: reduce)');

  /* ─────────────────────────────────────────────────────────────── theme ── */
  var root = document.documentElement;
  document.getElementById('theme').addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  });

  /* ───────────────────────────────────── authored control-point table ──── */
  /* Fractions of the underground height. Non-periodic on purpose: a wave
     reads as a decoration, a drift reads as a thing that grew. */
  var DRIFT = [
    [0.00,   0], [0.12,  10], [0.26,  -8], [0.41,  11],
    [0.58,  -9], [0.74,   7], [0.92,  -3], [1.00,   0]
  ];
  var TRUNK_W = [24, 20, 16.5, 13.5, 11, 8.5, 6.5, 4.5, 2.5];
  var LAT_W   = [14, 10, 6.5, 3.5];
  var SEC_W   = [6, 3.5, 2];
  var KINKS   = [{ f: 0.42, dx: 9, w: 44, h: 30 }, { f: 0.72, dx: -6, w: 22, h: 16 }];

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  var f1 = function (v) { return Math.round(v * 10) / 10; };

  /* Catmull-Rom through the drift anchors → one smooth centreline. */
  function centreline(spineX, top, bottom) {
    var pts = DRIFT.map(function (d) {
      return { x: spineX + d[1], y: top + (bottom - top) * d[0] };
    });
    // two authored kinks routing the root around stones
    KINKS.forEach(function (k) {
      pts.push({ x: spineX + k.dx, y: top + (bottom - top) * k.f, kink: true });
    });
    pts.sort(function (a, b) { return a.y - b.y; });

    var d = 'M' + f1(pts[0].x) + ' ' + f1(pts[0].y);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      d += ' C' + f1(p1.x + (p2.x - p0.x) / 6) + ' ' + f1(p1.y + (p2.y - p0.y) / 6) +
           ' ' + f1(p2.x - (p3.x - p1.x) / 6) + ' ' + f1(p2.y - (p3.y - p1.y) / 6) +
           ' ' + f1(p2.x) + ' ' + f1(p2.y);
    }
    return d;
  }

  /* Sample an arc-length slice of a path back out as its own path. */
  function slice(path, l0, l1, steps) {
    var d = '', i, p;
    for (i = 0; i <= steps; i++) {
      p = path.getPointAtLength(l0 + (l1 - l0) * (i / steps));
      d += (i ? ' L' : 'M') + f1(p.x) + ' ' + f1(p.y);
    }
    return d;
  }

  function xAtY(path, y) {
    var L = path.getTotalLength(), lo = 0, hi = L, m, p;
    for (var i = 0; i < 22; i++) {
      m = (lo + hi) / 2; p = path.getPointAtLength(m);
      if (p.y < y) lo = m; else hi = m;
    }
    p = path.getPointAtLength((lo + hi) / 2);
    return { x: p.x, y: p.y, frac: ((lo + hi) / 2) / L };
  }

  /* ──────────────────────────────────────────────────── the root system ── */
  var svg = document.getElementById('rootlayer');
  var under = document.querySelector('.under');
  var rowsWrap = document.getElementById('rows');
  var defs = svg.querySelector('defs');
  var grad = defs.querySelector('linearGradient');
  var uid = 0;

  function buildRoot() {
    // ---- one batched read phase; never interleave reads and writes --------
    var W = under.clientWidth;
    var H = under.offsetHeight;
    var uTop = under.getBoundingClientRect().top + window.scrollY;
    var bandW = parseFloat(getComputedStyle(root).getPropertyValue('--band')) || 0;
    var rw = rowsWrap.getBoundingClientRect();
    var uLeft0 = function () { return under.getBoundingClientRect().left; };
    var spineX = bandW > 0
      ? (rw.left + rw.width / 2 - uLeft0())
      : 46;
    if (bandW <= 0) spineX = 46;

    var uLeft = under.getBoundingClientRect().left;
    var nodes = [].map.call(document.querySelectorAll('.row .node'), function (n) {
      var r = n.getBoundingClientRect();
      return {
        x: r.left - uLeft,
        y: r.top + window.scrollY - uTop,
        side: n.closest('.row').getAttribute('data-side')
      };
    });

    // ---- write phase ------------------------------------------------------
    // keep <defs> and the crown gradient; drop everything else by reference,
    // never by index — whitespace text nodes make index arithmetic a trap.
    [].slice.call(svg.childNodes).forEach(function (nd) {
      if (nd !== defs) svg.removeChild(nd);
    });
    [].slice.call(defs.childNodes).forEach(function (nd) {
      if (nd !== grad) defs.removeChild(nd);
    });
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    // deliberately NO viewBox: 1 user unit === 1 CSS pixel at every width and DPR.

    var layerCast = el('g', {}), layerHair = el('g', {}), layerBody = el('g', {});
    var rnd = mulberry32(0x9E3779B9);

    /* helper: register a stroked segment as three <use> passes ------------- */
    function seg(d, width, s, e, cls) {
      var id = 'r' + (uid++);
      defs.appendChild(el('path', { id: id, d: d, pathLength: 1 }));
      var common = { href: '#' + id, style: '--s:' + f1(s * 1000) / 1000 + ';--e:' + f1(e * 1000) / 1000 };

      var cast = el('use', common);
      cast.setAttribute('class', 'r-cast');
      cast.setAttribute('stroke-width', width * 1.3);
      cast.setAttribute('transform', 'translate(3,4)');
      layerCast.appendChild(cast);

      var body = el('use', common);
      body.setAttribute('class', cls || 'r-body');
      body.setAttribute('stroke-width', width);
      layerBody.appendChild(body);

      if (width > 5) {
        var rim = el('use', common);
        rim.setAttribute('class', 'r-rim');
        rim.setAttribute('stroke-width', width * 0.45);
        rim.setAttribute('transform', 'translate(-2.5,-1.5)');
        layerBody.appendChild(rim);

        var tip = el('use', common);
        tip.setAttribute('class', 'r-tip');
        tip.setAttribute('stroke-width', width * 0.6);
        layerBody.appendChild(tip);
      }
      return id;
    }

    /* helper: fibrous hairs along a path, concatenated into ONE element ---- */
    function hairs(path, s, e, density, skipTail) {
      var L = path.getTotalLength(), d = '', step = density;
      for (var l = step; l < L - (skipTail || 0); l += step) {
        if (rnd() < 0.42) continue;
        var p = path.getPointAtLength(l), q = path.getPointAtLength(Math.min(L, l + 2));
        var tx = q.x - p.x, ty = q.y - p.y, m = Math.hypot(tx, ty) || 1;
        var nx = -ty / m, ny = tx / m;
        var dir = rnd() < 0.5 ? 1 : -1;
        var len = 4 + rnd() * 10;
        var ax = nx * dir, ay = ny * dir;
        // 55–75° off the normal, so hairs trail downward like real ones
        var k = 0.5 + rnd() * 0.5;
        d += 'M' + f1(p.x) + ' ' + f1(p.y) +
             ' Q' + f1(p.x + ax * len * 0.6) + ' ' + f1(p.y + ay * len * 0.6 + len * 0.2) +
             ' ' + f1(p.x + ax * len) + ' ' + f1(p.y + ay * len + len * k);
      }
      if (!d) return;
      var h = el('path', { d: d, class: 'hairs', 'stroke-width': 1.3 });
      h.style.setProperty('--s', s);
      h.style.setProperty('--e', e);
      layerHair.appendChild(h);
    }

    /* ---- trunk ---------------------------------------------------------- */
    var trunk = el('path', { d: centreline(spineX, 0, H - 60), fill: 'none', stroke: 'none' });
    svg.appendChild(trunk);
    var TL = trunk.getTotalLength();
    var nSeg = TRUNK_W.length;

    for (var i = 0; i < nSeg; i++) {
      var l0 = TL * (i / nSeg), l1 = TL * ((i + 1) / nSeg);
      var d = slice(trunk, l0, l1, 14);
      // the crown — and only the crown — carries brand green
      seg(d, TRUNK_W[i], i / nSeg, (i + 1) / nSeg, i === 0 ? 'r-body r-crown' : 'r-body');
      var tmp = el('path', { d: d });
      svg.appendChild(tmp);
      hairs(tmp, i / nSeg, (i + 1) / nSeg, 11, i === nSeg - 1 ? 200 : 0);
      svg.removeChild(tmp);
    }

    /* ---- laterals to every tuber ---------------------------------------- */
    nodes.forEach(function (nd, idx) {
      var att = xAtY(trunk, Math.max(4, nd.y - 30));
      var dx = nd.x - att.x, dy = nd.y - att.y;
      var d = 'M' + f1(att.x) + ' ' + f1(att.y) +
              ' C' + f1(att.x + dx * 0.30) + ' ' + f1(att.y + dy * 0.10) +
              ' ' + f1(att.x + dx * 0.55) + ' ' + f1(nd.y + 10) +
              ' ' + f1(nd.x) + ' ' + f1(nd.y);
      var lp = el('path', { d: d, fill: 'none', stroke: 'none' });
      svg.appendChild(lp);
      var LL = lp.getTotalLength();
      var s0 = Math.min(0.97, att.frac + 0.006);
      var s1 = Math.min(1, s0 + 0.075);

      for (var j = 0; j < LAT_W.length; j++) {
        var a = LL * (j / LAT_W.length), b = LL * ((j + 1) / LAT_W.length);
        seg(slice(lp, a, b, 10), LAT_W[j],
            s0 + (s1 - s0) * (j / LAT_W.length),
            s0 + (s1 - s0) * ((j + 1) / LAT_W.length));
      }
      hairs(lp, s0, s1, 13, 40);

      /* two secondaries off each lateral, never mirrored ------------------ */
      for (var k = 0; k < 2; k++) {
        var at = LL * (0.34 + k * 0.3);
        var p = lp.getPointAtLength(at);
        var up = (idx + k) % 3 === 0 ? -1 : 1;                 // a few curve back upward
        var out = (nd.side === 'right' ? 1 : -1) * (k ? 0.7 : 1);
        var len = 44 + rnd() * 46;
        var sd = 'M' + f1(p.x) + ' ' + f1(p.y) +
                 ' Q' + f1(p.x + out * len * 0.5) + ' ' + f1(p.y + up * len * 0.34) +
                 ' ' + f1(p.x + out * len) + ' ' + f1(p.y + up * len * 0.8);
        var sp = el('path', { d: sd, fill: 'none', stroke: 'none' });
        svg.appendChild(sp);
        var SL = sp.getTotalLength();
        for (var m2 = 0; m2 < SEC_W.length; m2++) {
          seg(slice(sp, SL * (m2 / 3), SL * ((m2 + 1) / 3), 8), SEC_W[m2],
              s1 - 0.02 + 0.02 * (m2 / 3), s1 + 0.02);
        }
        hairs(sp, s1 - 0.02, s1 + 0.02, 15, 26);
        svg.removeChild(sp);
      }
      svg.removeChild(lp);
    });

    /* ---- eleven rootlets so the deep column is never bare --------------- */
    for (var q = 0; q < 11; q++) {
      var fy = 0.08 + (q / 11) * 0.86 + (rnd() - 0.5) * 0.03;
      var pt = trunk.getPointAtLength(TL * fy);
      var dir2 = rnd() < 0.5 ? 1 : -1;
      var ln = 40 + rnd() * 70;
      var rd = 'M' + f1(pt.x) + ' ' + f1(pt.y) +
               ' Q' + f1(pt.x + dir2 * ln * 0.55) + ' ' + f1(pt.y + ln * 0.18) +
               ' ' + f1(pt.x + dir2 * ln) + ' ' + f1(pt.y + ln * 0.66);
      var rp = el('path', { d: rd, fill: 'none', stroke: 'none' });
      svg.appendChild(rp);
      var RL = rp.getTotalLength();
      seg(slice(rp, 0, RL * 0.55, 8), 5, fy, fy + 0.03);
      seg(slice(rp, RL * 0.55, RL, 8), 2.6, fy + 0.02, fy + 0.05);
      hairs(rp, fy, fy + 0.05, 16, 22);
      svg.removeChild(rp);
    }

    /* ---- the two stones the root routes around -------------------------- */
    KINKS.forEach(function (k) {
      var p = trunk.getPointAtLength(TL * k.f);
      var sx = p.x + (k.dx > 0 ? -1 : 1) * (k.w * 0.75), sy = p.y;
      var g = el('g', { transform: 'translate(' + f1(sx) + ' ' + f1(sy) + ') rotate(' + f1(rnd() * 40 - 20) + ')' });
      g.appendChild(el('path', {
        class: 'stone-a',
        d: 'M' + (-k.w / 2) + ' 0 L' + (-k.w * 0.3) + ' ' + (-k.h / 2) + ' L' + (k.w * 0.34) + ' ' + (-k.h * 0.42) +
           ' L' + (k.w / 2) + ' ' + (k.h * 0.12) + ' L' + (k.w * 0.1) + ' ' + (k.h / 2) + ' L' + (-k.w * 0.36) + ' ' + (k.h * 0.4) + 'Z'
      }));
      g.appendChild(el('path', {
        class: 'stone-b',
        d: 'M' + (-k.w * 0.42) + ' ' + (-k.h * 0.08) + ' L' + (-k.w * 0.28) + ' ' + (-k.h * 0.42) +
           ' L' + (k.w * 0.2) + ' ' + (-k.h * 0.34) + ' L' + (-k.w * 0.05) + ' ' + (k.h * 0.02) + 'Z'
      }));
      layerCast.appendChild(g);
    });

    /* ---- exactly two critters, and one absence -------------------------- */
    (function critters() {
      var wy = H * 0.30, wx = spineX - 150;
      var w = el('g', { class: 'critter' });
      w.appendChild(el('path', { class: 'burrow', d: 'M' + f1(wx - 60) + ' ' + f1(wy + 26) + ' Q' + f1(wx + 10) + ' ' + f1(wy - 10) + ' ' + f1(wx + 70) + ' ' + f1(wy + 18) }));
      for (var i2 = 0; i2 < 12; i2++) {
        var t = i2 / 11;
        var x = wx - 46 + t * 96, y = wy + 20 - Math.sin(t * Math.PI) * 26;
        w.appendChild(el('ellipse', {
          class: i2 === 5 || i2 === 6 ? 'worm-saddle' : 'worm-seg',
          cx: f1(x), cy: f1(y), rx: f1(6 - Math.abs(t - 0.5) * 3), ry: 4.6
        }));
      }
      layerBody.appendChild(w);

      var by = H * 0.66, bx = spineX + 120;
      var b = el('g', { class: 'critter', transform: 'translate(' + f1(bx) + ' ' + f1(by) + ') rotate(8)' });
      b.appendChild(el('path', { class: 'beetle-leg', d: 'M-6 4 l-7 5 M0 5 l-2 7 M6 4 l7 5' }));
      b.appendChild(el('ellipse', { class: 'beetle-body', cx: 0, cy: 0, rx: 9, ry: 6 }));
      b.appendChild(el('ellipse', { class: 'beetle-lit', cx: -2.5, cy: -2, rx: 3.6, ry: 2.2 }));
      b.appendChild(el('circle', { class: 'beetle-body', cx: 0, cy: -7, r: 3.4 }));
      layerBody.appendChild(b);

      // a mole tunnel with no mole in it
      var my = H * 0.86;
      var t2 = el('g', { class: 'critter' });
      t2.appendChild(el('path', { class: 'tunnel', d: 'M-30 ' + f1(my) + ' Q' + f1(spineX * 0.42) + ' ' + f1(my - 26) + ' ' + f1(spineX * 0.74) + ' ' + f1(my + 6) }));
      t2.appendChild(el('path', { class: 'scratch', d: 'M' + f1(spineX * 0.55) + ' ' + f1(my - 14) + ' l14 -7 M' + f1(spineX * 0.58) + ' ' + f1(my - 6) + ' l15 -5' }));
      layerCast.appendChild(t2);
    })();

    svg.removeChild(trunk);
    svg.appendChild(layerCast);
    svg.appendChild(layerHair);
    svg.appendChild(layerBody);
  }

  /* ──────────────────────────────────────────── honest depth reporting ── */
  var readout = document.getElementById('readout');
  var gauge = document.getElementById('gauge');
  var geom = { top: 0, h: 1 };

  function measure() {
    var r = under.getBoundingClientRect();
    geom.top = r.top + window.scrollY;
    geom.h = under.offsetHeight;

    // ticks, drawn once against the measured box
    [].forEach.call(gauge.querySelectorAll('.tick,.num'), function (n) { n.remove(); });
    for (var cm = 4; cm < 100; cm += 4) {
      var t = document.createElement('div');
      t.className = 'tick ' + (cm % 20 === 0 ? 'major' : 'minor');
      t.style.top = (cm) + '%';
      gauge.appendChild(t);
    }
    for (var maj = 20; maj <= 100; maj += 20) {
      var n2 = document.createElement('div');
      n2.className = 'num';
      n2.style.top = maj + '%';
      n2.textContent = maj;
      gauge.appendChild(n2);
    }

    // every printed depth is derived from where the row actually is
    [].forEach.call(document.querySelectorAll('.row'), function (row) {
      var node = row.querySelector('.node');
      var y = node.getBoundingClientRect().top + window.scrollY - geom.top;
      var cmv = Math.round(Math.max(0, Math.min(100, (y / geom.h) * 100)));
      var slot = row.querySelector('[data-depth]');
      if (slot) slot.textContent = cmv + ' cm below the surface';
      var authored = Number(row.getAttribute('data-cm'));
      // the authored value is the desktop target; narrow viewports legitimately
      // compress the descent, so this only guards against gross desync
      if (authored && Math.abs(authored - cmv) > 12) {
        console.warn('[root] row drifted from its authored depth', row.href || row.className, authored, '->', cmv);
      }
    });
  }

  /* ────────────────────────────────────────────────────── scroll driver ── */
  var ticking = false, lastCm = -1, swapped = false;
  var buried = document.getElementById('buried');
  var bedrock = document.getElementById('bedrock');

  function frame() {
    ticking = false;
    var y = window.scrollY, vh = window.innerHeight;

    var p = (y + vh * 0.75 - geom.top) / geom.h;
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    root.style.setProperty('--p', Math.round(p * 1000) / 1000);

    var d = (y + vh * 0.5 - geom.top) / geom.h;
    var on = d > -0.02 && d < 1.06;
    gauge.classList.toggle('on', on);
    if (on) {
      var cm = Math.round(Math.max(0, Math.min(100, d * 100)));
      if (cm !== lastCm) { lastCm = cm; readout.textContent = cm + ' cm'; }
    }

    // the mascot lags the scroll for its first stretch — felt, never noticed
    if (y < 300) buried.style.transform = 'translate(-50%, ' + (y * 0.06).toFixed(1) + 'px)';

    if (!swapped && p > 0.02) { swapped = true; buried.src = '/atpotato-waow.png'; }

    document.body.classList.toggle('on-soil', y + vh * 0.65 > geom.top);

    if (!bedrock.classList.contains('lit') &&
        bedrock.getBoundingClientRect().top < vh * 0.8) bedrock.classList.add('lit');
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }

  /* ──────────────────────────────────────────────────────── row reveals ── */
  function watchRows() {
    if (!('IntersectionObserver' in window)) {
      [].forEach.call(document.querySelectorAll('.row'), function (r) { r.classList.add('grown'); });
      return;
    }
    // never unobserved: scrolling back up genuinely reverses the reveal
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle('grown', e.isIntersecting); });
    }, { threshold: 0, rootMargin: '0px 0px -22% 0px' });
    [].forEach.call(document.querySelectorAll('.row'), function (r) { io.observe(r); });
  }

  /* ─────────────────────────────────────────────────────────────── boot ── */
  function layout() { buildRoot(); measure(); frame(); }

  function boot() {
    if (reduce.matches) {
      // complete, not degraded: everything is already drawn by CSS
      [].forEach.call(document.querySelectorAll('.row'), function (r) { r.classList.add('grown'); });
      buildRoot(); measure();
      // the gauge is information, not decoration — it keeps working
      addEventListener('scroll', function () {
        if (ticking) return; ticking = true;
        requestAnimationFrame(function () {
          ticking = false;
          var d = (window.scrollY + innerHeight * 0.5 - geom.top) / geom.h;
          gauge.classList.toggle('on', d > -0.02 && d < 1.06);
          var cm = Math.round(Math.max(0, Math.min(100, d * 100)));
          if (cm !== lastCm) { lastCm = cm; readout.textContent = cm + ' cm'; }
        });
      }, { passive: true });
      buried.addEventListener('mouseenter', function () { buried.src = '/atpotato-waow.png'; });
      buried.addEventListener('mouseleave', function () { buried.src = '/atpotato-normal.png'; });
      return;
    }
    layout();
    watchRows();
    addEventListener('scroll', onScroll, { passive: true });

    var rt;
    function relayout() { clearTimeout(rt); rt = setTimeout(layout, 140); }
    addEventListener('resize', relayout);
    if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(under);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
  else boot();
})();
