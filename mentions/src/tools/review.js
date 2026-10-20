// review.js
// Reads matches next to the post that prompted them, which is the thing
// milestones 1 and 3 ask you to sit down and actually do.
//
//   npm run review                  the 30 most recent
//   npm run review -- 100           the 100 most recent
//   npm run review -- 50 drafted    only rows in one status
//   npm run review -- 50 rejected

import { db } from '../db.js';
import { gates, config } from '../config.js';
import { lacksSubstance } from '../gates/inbound.js';

const limit = Number(process.argv[2]) || 30;
const status = process.argv.slice(3).find((a) => !a.startsWith('--')) ?? null;
// Voice-bench rows are real drafts but not real traffic; --with-samples shows them.
const withSamples = process.argv.includes('--with-samples');

const where = [
  status ? 'status = ?' : null,
  withSamples ? null : "source <> 'voice-sample'",
].filter(Boolean);
const rows = db.prepare(`
  SELECT * FROM queue ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  ORDER BY matched_at DESC LIMIT ?
`).all(...(status ? [status, limit] : [limit]));

const g = gates();
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

if (!rows.length) {
  console.log(`\nnothing queued${status ? ` with status ${status}` : ''} yet.\n`);
} else {
  console.log(`\n${rows.length} rows${status ? ` (${status})` : ''}, newest first\n`);
}

for (const r of rows) {
  const { lacks, signals } = lacksSubstance(r.text, config.botHandle, g.substanceMinChars);
  const sig = Object.entries(signals).filter(([, v]) => v).map(([k]) => k).join(' ') || 'none';
  const who = r.author_handle ? `@${r.author_handle}` : r.author_did;

  console.log(`${bold(`#${r.id}`)}  ${r.status}${r.gate ? ` (${r.gate})` : ''}  ${dim(r.matched_at)}`);
  console.log(`  ${dim(`${r.reason} from`)} ${who} ${dim(`via ${r.source}`)}`);
  console.log(`  ${dim('post   ')} ${r.text.replace(/\n/g, ' ')}`);
  console.log(`  ${dim('signals')} ${sig}${lacks ? dim('  → would be dropped as noise') : ''}`);
  if (r.gate_detail) console.log(`  ${dim('why    ')} ${r.gate_detail}`);
  if (r.draft_text) console.log(`  ${bold('draft  ')} ${r.draft_text.replace(/\n/g, ' ')}`);
  console.log(`  ${dim('link   ')} https://bsky.app/profile/${r.author_did}/post/${r.rkey}`);
  console.log('');
}
