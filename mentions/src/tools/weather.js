// weather.js
// Poe's weather posts, newest first: what the watcher asked about, what Poe wrote
// (or why it skipped), and what the gates did with it. The thing to read while
// WEATHER_POSTS=draft, before going live.
//
//   npm run weather                 the 20 most recent
//   npm run weather -- 50           the 50 most recent
//   npm run weather -- 50 held      only rows in one status

import { db } from '../db.js';
import '../weather-posts.js';   // creates the table on a database that has never had one

const limit = Number(process.argv[2]) || 20;
const status = process.argv[3] ?? null;
const rows = db.prepare(`SELECT * FROM weather_post ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`)
  .all(...(status ? [status, limit] : [limit]));

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

console.log(rows.length ? `\n${rows.length} weather moments${status ? ` (${status})` : ''}, newest first\n`
  : `\nno weather moments${status ? ` with status ${status}` : ''} yet.\n`);

for (const r of rows) {
  const facts = JSON.parse(r.facts);
  console.log(`${bold(`#${r.id}`)}  ${r.kind} ${dim(r.subject)}  ${r.status}${r.gate ? ` (${r.gate})` : ''}  ${dim(r.created_at)}`);
  console.log(`  ${dim('why    ')} ${JSON.stringify(facts.trigger)}`);
  if (r.draft_text) console.log(`  ${bold('draft  ')} ${r.draft_text.replace(/\n/g, ' ')}`);
  if (r.post_text && r.post_text !== r.draft_text) console.log(`  ${dim('posted ')} ${r.post_text.replace(/\n/g, ' ')}`);
  if (r.draft_text) console.log(`  ${dim('card   ')} ${r.page ? `/weather/${r.page}` : '/weather'}`);
  if (r.detail) console.log(`  ${dim('detail ')} ${r.detail}`);
  if (r.post_uri) console.log(`  ${dim('link   ')} ${r.post_uri}`);
  console.log('');
}
