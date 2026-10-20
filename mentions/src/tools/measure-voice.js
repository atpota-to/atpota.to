// Structural tells across a batch of drafts. Voice is subjective; uniformity
// is not, and uniformity is what reads as machine-written.
import { db } from '../db.js';
// Takes a range, because "everything since id N" silently merges batches once
// a second run lands, which is how the first comparison came out meaningless.
const from = Number(process.argv[2] || 0);
const to = Number(process.argv[3] || 1e9);
const rows = db.prepare(
  "select draft_text d from queue where source='voice-sample' and id>=? and id<=? and draft_text is not null"
).all(from, to);
const t = rows.map((r) => r.d.trim());
const anti = /[;,] (?:the |an |a |your |few|most|nobody|none)?[a-z]+ (?:is|are|does|do|moves|reads|can't|cannot|changes?|allows?|makes?)\b|\b\w+, not \w+\b|\bleast \w+, most \w+\b/i;
const pct = (n) => `${n} of ${t.length} (${Math.round((n / t.length) * 100)}%)`;
const lens = t.map((x) => x.length).sort((a, b) => a - b);
console.log(`\n  replies                    ${t.length}`);
console.log(`  balanced clauses           ${pct(t.filter((x) => anti.test(x)).length)}`);
console.log(`  questions asked back       ${pct(t.filter((x) => /\?/.test(x)).length)}`);
console.log(`  self-justifying clause     ${pct(t.filter((x) => /which is (how|why) i\b|so treat|rather than guessing/i.test(x)).length)}`);
console.log(`  ending on a link           ${pct(t.filter((x) => /https?:\/\/\S+\s*$/.test(x)).length)}`);
console.log(`  under 120 chars            ${pct(t.filter((x) => x.length < 120).length)}`);
console.log(`  length  min ${lens[0]}  median ${lens[Math.floor(lens.length / 2)]}  max ${lens.at(-1)}`);
console.log(`  spread  ${lens.at(-1) - lens[0]} chars between shortest and longest\n`);
process.exit(0);
