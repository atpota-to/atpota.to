const fs = require('fs');
const art = JSON.parse(fs.readFileSync(__dirname + '/art.json', 'utf8'));
let html = fs.readFileSync(__dirname + '/index.tpl.html', 'utf8');
const runtime = fs.readFileSync(__dirname + '/runtime.js', 'utf8');

const NUB_LABELS = ['anisota cocoon', 'mothing', 'habit tracker', 'types'];
const nubs = art.nubs.map((svg, i) =>
  `<span class="nub-item">${svg}<span class="eyebrow">${NUB_LABELS[i]}</span></span>`).join('');

const map = {
  '{{HORIZON_BACK}}': art.horizonBack,
  '{{HORIZON_FRONT}}': art.horizonFront,
  '{{TUBER_CRED}}': art.tubers.cred,
  '{{TUBER_ANISOTA}}': art.tubers.anisota,
  '{{TUBER_ATURI}}': art.tubers.aturi,
  '{{TUBER_FLUSHES}}': art.tubers.flushes,
  '{{TUBER_HALF}}': art.half,
  '{{NUBS}}': nubs,
  '{{SCRIPT}}': '<script>\n' + runtime + '</script>',
};
for (const k in map) {
  if (!html.includes(k)) throw new Error('missing token ' + k);
  html = html.split(k).join(map[k]);
}
const left = html.match(/\{\{[A-Z_]+\}\}/g);
if (left) throw new Error('unsubstituted: ' + left.join(','));

fs.writeFileSync(process.argv[2] || (__dirname + '/index.html'), html);
console.log('wrote', (html.length / 1024).toFixed(1) + 'kb');
