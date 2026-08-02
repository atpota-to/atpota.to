/* Generates redesign/nav-lab.html and redesign/nav-lab-guide.html from the two
   live pages, with a switcher for five nav treatments (and, on the guide, two
   reading-progress treatments) layered on top.
   Run: node redesign/build-nav-lab.js
   Throwaway prototype — not wired into the site build. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const STYLE = `
<meta name="robots" content="noindex">
<style>
/* ══════════════════════════════════════════════════════ nav lab overlays ══
   Every variant works from the same markup as the real page; only the
   presentation of .topbar changes.
   ═════════════════════════════════════════════════════════════════════════ */

.progress-bar{
  display:block; height:100%; width:100%;
  background:linear-gradient(90deg, var(--green-deep), var(--green));
  transform:scaleX(0); transform-origin:left center;
}
[data-theme="dark"] .progress-bar{ background:linear-gradient(90deg, var(--green), #7ede8b) }

/* the line living on the bar's own bottom edge (variants C, D, E) */
.rp-edge{ position:absolute; left:0; right:0; bottom:-1px; height:2px; pointer-events:none }
/* the line living inside the capsule (variant A) */
.rp-pill{
  position:absolute; left:0; right:0; bottom:0; height:3px; pointer-events:none;
  opacity:0; transition:opacity .22s ease;
}
[data-nav="a"] .topbar.stuck .rp-pill{ opacity:1 }
[data-nav="a"] .rp-edge, [data-nav="b"] .rp-edge{ display:none }
[data-nav="b"] .rp-pill, [data-nav="c"] .rp-pill,
[data-nav="d"] .rp-pill, [data-nav="e"] .rp-pill{ display:none }

/* ─────────────────────────────────────────── A · floating capsule ── */
[data-nav="a"] .topbar{ background:none; border-bottom:0; box-shadow:none }
[data-nav="a"] .topbar .inner{
  position:relative; overflow:hidden; height:auto; padding:9px 10px 9px 16px;
  margin:12px auto 0; max-width:min(1000px, calc(100% - 36px));
  border:1px solid transparent; border-radius:999px;
  transition:background .22s ease, border-color .22s ease, box-shadow .22s ease;
}
[data-nav="a"] .topbar.stuck .inner{
  background:var(--card); border-color:var(--card-line);
  box-shadow:0 18px 38px -24px rgba(40,28,10,.55);
}
/* On a page with one flat background, a scrim in that same colour lets the
   text dissolve before it reaches the capsule instead of sliding past it.
   Only workable where the backdrop does not change — so, the guide. */
[data-page="guide"][data-nav="a"] .topbar::before,
[data-page="guide"][data-nav="b"] .topbar::before{
  content:""; position:absolute; inset:0 0 -40px 0; z-index:-1; opacity:0;
  background:linear-gradient(var(--sky-2) 62%, transparent);
  transition:opacity .22s ease;
}
[data-page="guide"] .topbar.stuck::before{ opacity:1 }

/* ──────────────────────────────────────────────── B · two orbs ── */
[data-nav="b"] .topbar{ background:none; border-bottom:0; box-shadow:none }
[data-nav="b"] .topbar .inner{ height:auto; padding:14px 18px; max-width:none }
[data-nav="b"] .topbar b{ display:none }
[data-nav="b"] .topbar .home{
  position:relative; width:52px; height:52px; border-radius:50%; justify-content:center;
  background:var(--card); border:1px solid var(--card-line);
  box-shadow:0 14px 30px -18px rgba(40,28,10,.7);
}
[data-nav="b"] .topbar .home .mark{ width:31px; height:31px }
/* the ring is the reading progress: the potato fills up as you read */
[data-nav="b"] .topbar .home::after{
  content:""; position:absolute; inset:-6px; border-radius:50%; pointer-events:none;
  background:conic-gradient(var(--green) calc(var(--rp, 0) * 1turn), transparent 0);
  -webkit-mask:radial-gradient(closest-side, transparent calc(100% - 4px), #000 calc(100% - 4px));
          mask:radial-gradient(closest-side, transparent calc(100% - 4px), #000 calc(100% - 4px));
}
[data-nav="b"] .tt{ width:52px; height:52px; box-shadow:0 14px 30px -18px rgba(40,28,10,.7) }
[data-nav="b"] .tt svg{ width:20px; height:20px }

/* ────────────────────────────────────────────── C · ground line ── */
/* the bar is the surface: its underside is the same wave as the horizon, and
   the progress line is a root creeping along just beneath it */
[data-nav="c"] .topbar{ border-bottom:0; box-shadow:none }
[data-nav="c"] .topbar.stuck{ background:var(--sky-2) }
[data-nav="c"] .fringe{ display:block }
[data-nav="c"] .topbar.stuck .fringe{ opacity:1 }
[data-nav="c"] .rp-edge{ bottom:-25px; height:3px }
[data-nav="c"] .topbar:not(.stuck) .rp-edge{ opacity:0 }
.fringe{
  display:none; position:absolute; top:100%; left:0; width:100%; height:22px;
  opacity:0; transition:opacity .22s ease; pointer-events:none;
}
.fringe svg{ display:block; width:100%; height:22px }

/* ────────────────────────────────────────────── D · auto-hide ── */
[data-nav="d"] .topbar{
  transition:transform .3s cubic-bezier(.4,0,.2,1), background .22s ease,
             border-color .22s ease, box-shadow .22s ease;
}
[data-nav="d"] .topbar.hide{ transform:translateY(-102%) }

/* ══════════════════════════════ guide only · reading-progress styles ══ */
/* "margin root" — the progress leaves the nav entirely and grows down the
   page margin, the same taproot as the homepage */
.rp-root{ display:none }
[data-rp="root"] .rp-edge, [data-rp="root"] .rp-pill{ display:none !important }
[data-rp="root"] .rp-root{
  display:block; position:fixed; z-index:40; pointer-events:none;
  left:max(18px, calc(50% - 560px)); top:calc(var(--bar) + 22px); bottom:22px; width:12px;
}
[data-rp="root"] .rp-root svg{ width:12px; height:100%; overflow:visible }
[data-rp="root"] .rp-root .track{ stroke:var(--card-line); stroke-width:2; fill:none }
[data-rp="root"] .rp-root .grow{
  stroke:var(--green); stroke-width:3; fill:none; stroke-linecap:round;
  stroke-dasharray:1; stroke-dashoffset:calc(1 - var(--rp, 0));
}
@media (max-width:1200px){ [data-rp="root"] .rp-root{ display:none } }

/* ─────────────────────────────────────── the switcher itself ── */
.lab{
  position:fixed; z-index:200; left:50%; transform:translateX(-50%); bottom:18px;
  display:flex; align-items:center; gap:6px; padding:7px 8px; flex-wrap:wrap;
  justify-content:center; max-width:calc(100% - 24px);
  background:#1b1b1bee; color:#fff; border-radius:22px;
  box-shadow:0 20px 44px -18px rgba(0,0,0,.7);
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px;
  -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px);
}
.lab span{ padding:0 8px 0 6px; opacity:.55; letter-spacing:.08em; text-transform:uppercase }
.lab button{
  border:0; cursor:pointer; padding:7px 12px; border-radius:999px; font:inherit;
  background:#ffffff1a; color:#fff;
}
.lab button:hover{ background:#ffffff33 }
.lab button[aria-pressed="true"]{ background:var(--green); color:#062d10; font-weight:700 }
.lab .rule{ width:1px; align-self:stretch; background:#ffffff26; margin:0 4px }
@media (max-width:620px){
  .lab{ font-size:11px; gap:4px; padding:6px }
  .lab span{ display:none }
  .lab button{ padding:7px 9px }
  .lab .rule{ display:none }
}
</style>
`;

const script = (isGuide) => `
<div class="lab" role="group" aria-label="Nav direction">
  <span>nav</span>
  <button type="button" data-v="a" title="Floating capsule">A</button>
  <button type="button" data-v="b" title="Two orbs">B</button>
  <button type="button" data-v="c" title="Ground line">C</button>
  <button type="button" data-v="d" title="Auto-hide band">D</button>
  <button type="button" data-v="e" title="Full-width band (current)">E</button>
  ${isGuide ? `<i class="rule"></i><span>progress</span>
  <button type="button" data-p="bar" title="On the nav">bar</button>
  <button type="button" data-p="root" title="Down the page margin">root</button>` : ''}
</div>
<script>
(function () {
  var html = document.documentElement;
  var bar = document.getElementById('topbar');
  var isGuide = ${isGuide ? 'true' : 'false'};
  if (isGuide) html.setAttribute('data-page', 'guide');

  /* the wave underside, only used by variant C — same shape as the horizon */
  var fringe = document.createElement('div');
  fringe.className = 'fringe';
  fringe.setAttribute('aria-hidden', 'true');
  fringe.innerHTML =
    '<svg viewBox="0 0 1440 22" preserveAspectRatio="none">' +
    '<path d="M0,0 L1440,0 L1440,8 C1320,20 1200,2 1080,10 C960,19 840,3 720,11' +
    ' C600,20 480,2 360,10 C240,19 120,3 0,9 Z" fill="var(--sky-2)"/></svg>';
  bar.appendChild(fringe);

  function progressEl(cls) {
    var d = document.createElement('div');
    d.className = cls;
    d.setAttribute('aria-hidden', 'true');
    d.innerHTML = '<i class="progress-bar"></i>';
    return d;
  }
  var edge = progressEl('rp-edge');
  var pill = progressEl('rp-pill');
  bar.appendChild(edge);
  bar.querySelector('.inner').appendChild(pill);
  var fills = [edge.firstChild, pill.firstChild];

  /* the margin root, guide only */
  if (isGuide) {
    var rt = document.createElement('div');
    rt.className = 'rp-root';
    rt.setAttribute('aria-hidden', 'true');
    rt.innerHTML =
      '<svg viewBox="0 0 12 1000" preserveAspectRatio="none">' +
      '<path class="track" d="M6 0 C10 250 2 620 6 1000" vector-effect="non-scaling-stroke"/>' +
      '<path class="grow" d="M6 0 C10 250 2 620 6 1000" pathLength="1" vector-effect="non-scaling-stroke"/>' +
      '</svg>';
    document.body.appendChild(rt);
  }

  var last = window.scrollY, ticking = false;
  function frame() {
    ticking = false;
    var y = window.scrollY;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var p = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
    fills.forEach(function (f) { f.style.transform = 'scaleX(' + p + ')'; });
    html.style.setProperty('--rp', p);
    // variant D: away on the way down, back on the way up
    if (y > 140 && y > last + 4) bar.classList.add('hide');
    else if (y < last - 4 || y < 140) bar.classList.remove('hide');
    last = y;
  }
  addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(frame); }
  }, { passive: true });

  var navBtns = document.querySelectorAll('.lab button[data-v]');
  var rpBtns = document.querySelectorAll('.lab button[data-p]');
  function pick(attr, key, val, btns) {
    html.setAttribute(attr, val);
    try { localStorage.setItem(key, val); } catch (e) {}
    [].forEach.call(btns, function (b) {
      b.setAttribute('aria-pressed', (b.dataset.v || b.dataset.p) === val ? 'true' : 'false');
    });
  }
  [].forEach.call(navBtns, function (b) {
    b.addEventListener('click', function () { pick('data-nav', 'navlab', b.dataset.v, navBtns); });
  });
  [].forEach.call(rpBtns, function (b) {
    b.addEventListener('click', function () { pick('data-rp', 'rplab', b.dataset.p, rpBtns); });
  });
  var savedNav = 'a', savedRp = 'bar';
  try {
    savedNav = localStorage.getItem('navlab') || 'a';
    savedRp = localStorage.getItem('rplab') || 'bar';
  } catch (e) {}
  pick('data-nav', 'navlab', savedNav, navBtns);
  if (isGuide) pick('data-rp', 'rplab', savedRp, rpBtns);
  frame();
})();
<\/script>
`;

function build(srcFile, outFile, title, isGuide, fixups) {
  let s = fs.readFileSync(srcFile, 'utf8');
  (fixups || []).forEach(function (f) { s = s.replace(f[0], f[1]); });
  s = s.replace(/<title>[^<]*<\/title>/, '<title>' + title + '</title>')
       .replace('</head>', STYLE + '</head>')
       .replace('</body>', script(isGuide) + '</body>');
  fs.writeFileSync(path.join(__dirname, outFile), s);
  console.log('wrote redesign/' + outFile + ' (' + s.length + ' bytes)');
}

build(path.join(root, 'index.html'), 'nav-lab.html',
      'Nav directions — atpotato lab', false);

// the guide loads its stylesheet and markdown by relative path; from
// /redesign/ those need to point back into /guides/
build(path.join(root, 'guides', 'bluesky-for-brands.html'), 'nav-lab-guide.html',
      'Nav directions on the guide — atpotato lab', true, [
        ['href="guide-styles.css"', 'href="/guides/guide-styles.css"'],
        ['src="marked.min.js"', 'src="/guides/marked.min.js"'],
        ['src="guide-components.js"', 'src="/guides/guide-components.js"'],
        ["fetch('how-to-use-bluesky-to-grow-your-brand.md')",
         "fetch('/guides/how-to-use-bluesky-to-grow-your-brand.md')"],
        ['href="how-to-use-bluesky-to-grow-your-brand.md"',
         'href="/guides/how-to-use-bluesky-to-grow-your-brand.md"'],
        // the lab supplies its own progress elements, one per treatment
        ['<div class="reading-progress" aria-hidden="true"><i class="progress-bar"></i></div>', ''],
      ]);
