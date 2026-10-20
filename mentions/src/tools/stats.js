// stats.js
// The milestone-1 numbers, read straight off the database.
//
//   npm run stats              since the beginning
//   npm run stats -- 24        the last 24 hours

import { db } from '../db.js';
import { gates } from '../config.js';
import { lacksSubstance } from '../gates/inbound.js';
import { config } from '../config.js';

// Rows created by `npm run sample` are synthetic questions put to the agent for
// voice work. They are real drafts and real gate verdicts, so they are worth
// keeping and worth reading, but they are not traffic and they would skew every
// rate below. Pass --with-samples to include them.
const withSamples = process.argv.includes('--with-samples');
const SAMPLES = withSamples ? '' : " AND source <> 'voice-sample'";

const hours = Number(process.argv[2]) || null;
const since = hours ? new Date(Date.now() - hours * 3600000).toISOString() : '1970-01-01';
const label = hours ? `last ${hours}h` : 'all time';

const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

const total = one(`SELECT COUNT(*) n FROM queue WHERE matched_at >= ?${SAMPLES}`, since).n;
const bySource = all(`SELECT source, COUNT(*) n FROM queue WHERE matched_at >= ?${SAMPLES} GROUP BY source`, since);
const byReason = all(`SELECT reason, COUNT(*) n FROM queue WHERE matched_at >= ?${SAMPLES} GROUP BY reason`, since);
const byStatus = all(`SELECT status, COUNT(*) n FROM queue WHERE matched_at >= ?${SAMPLES} GROUP BY status ORDER BY n DESC`, since);
const byGate = all(`SELECT gate, COUNT(*) n FROM queue WHERE matched_at >= ?${SAMPLES} AND gate IS NOT NULL GROUP BY gate ORDER BY n DESC`, since);
const rejections = all(`SELECT direction, gate, COUNT(*) n FROM rejections WHERE rejected_at >= ? GROUP BY direction, gate ORDER BY n DESC`, since);
const posted = one(`SELECT COUNT(*) n FROM replies WHERE posted_at >= ?`, since).n;

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const line = (k, v, extra = '') => console.log(`  ${String(k).padEnd(22)} ${String(v).padStart(7)} ${extra}`);

console.log(`\natpotato mentions — ${label}   (stage ${config.stage})`);
console.log(`\nMATCHES`);
line('total', total);
for (const r of byReason) line(`  ${r.reason}`, r.n, pct(r.n, total));

// The number the sweep exists to justify: how many matches only the
// notification poll found. A high number means Jetstream is dropping or the
// cursor keeps aging out; a zero means the sweep is pure insurance.
console.log(`\nDETECTION PATH  (is the notification sweep earning its place?)`);
for (const s of bySource) line(`  ${s.source}`, s.n, pct(s.n, total));
const viaNotif = bySource.find((s) => s.source === 'notification')?.n ?? 0;
line('  gap rate', pct(viaNotif, total), '← found ONLY by the sweep');

console.log(`\nSTATUS`);
for (const s of byStatus) line(`  ${s.status}`, s.n, pct(s.n, total));

if (byGate.length) {
  console.log(`\nGATE THAT STOPPED IT`);
  for (const g of byGate) line(`  ${g.gate}`, g.n, pct(g.n, total));
}

if (rejections.length) {
  console.log(`\nREJECTIONS LOGGED`);
  for (const r of rejections) line(`  ${r.direction}/${r.gate}`, r.n);
}

// The question the brief says milestone 1 exists to answer. Recomputed from the
// stored text rather than read off the gate verdict, so it is still meaningful
// at stage 1 where no gate has run.
const rows = all(`SELECT text FROM queue WHERE matched_at >= ?${SAMPLES}`, since);
const g = gates();
let questions = 0;
const signalCount = { question: 0, identifier: 0, request: 0, long: 0 };
for (const r of rows) {
  const { lacks, signals } = lacksSubstance(r.text, config.botHandle, g.substanceMinChars);
  if (!lacks) questions++;
  for (const k of Object.keys(signalCount)) if (signals[k]) signalCount[k]++;
}
console.log(`\nSUBSTANCE  (what fraction of mentions are real questions?)`);
line('would pass', questions, pct(questions, rows.length));
line('would be dropped', rows.length - questions, pct(rows.length - questions, rows.length));
for (const [k, v] of Object.entries(signalCount)) line(`  has ${k}`, v, pct(v, rows.length));

// How the one tunable in that gate behaves against the traffic actually seen.
// This is the table to read at the end of milestone 1 before choosing a value.
if (rows.length) {
  console.log(`\nSUBSTANCE THRESHOLD SENSITIVITY  (substanceMinChars, currently ${g.substanceMinChars})`);
  for (const n of [12, 30, 60, 80, 120, 200, Infinity]) {
    let pass = 0;
    for (const r of rows) if (!lacksSubstance(r.text, config.botHandle, n).lacks) pass++;
    const name = n === Infinity ? 'length signal off' : String(n);
    line(`  ${name}`, pass, `${pct(pass, rows.length)} would pass`);
  }
}

console.log(`\nPOSTED`);
line('replies sent', posted);
const lastHour = one(`SELECT COUNT(*) n FROM replies WHERE posted_at >= ?`, new Date(Date.now() - 3600000).toISOString()).n;
line('in the last hour', lastHour, `cap ${g.globalPerHour}`);
console.log('');
