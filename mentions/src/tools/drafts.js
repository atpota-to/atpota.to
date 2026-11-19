// drafts.js
// Poe's dispatch drafts, newest first: when each was asked for, where it got to,
// how many versions it went through, and the issue it became.
//
//   npm run drafts                the 10 most recent
//   npm run drafts -- 30          the 30 most recent
//   npm run drafts -- <draft id>  one draft: every version, and its log

import { db } from '../db.js';
import { previewUrl } from '../dispatch-drafts.js';   // creates the tables on a database that has never had them
import { pageUrls } from '../dispatch.js';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const arg = process.argv[2];

function line(d) {
  console.log(`${bold(d.id)}  ${d.kind}  ${d.status}${d.version ? `  v${d.version}` : ''}  ${dim(d.created_at)}`);
  if (d.title) console.log(`  ${dim('title  ')} ${d.title}`);
  console.log(`  ${dim('covers ')} ${d.window_start} → ${d.window_end}`);
  if (d.status !== 'skipped') console.log(`  ${dim('preview')} ${previewUrl(d)}`);
  if (d.document_rkey && d.status === 'published') console.log(`  ${dim('issue  ')} ${pageUrls(d.document_rkey)[0]}`);
  if (d.detail) console.log(`  ${dim('detail ')} ${d.detail}`);
}

if (arg && !/^\d+$/.test(arg)) {
  const d = db.prepare('SELECT * FROM dispatch_draft WHERE id = ?').get(arg);
  if (!d) {
    console.log(`\nno draft ${arg}\n`);
  } else {
    console.log('');
    line(d);
    if (d.guidance) console.log(`  ${dim('asked  ')} ${d.guidance.replace(/\n/g, ' ')}`);
    if (d.note) console.log(`  ${dim('note   ')} ${d.note.replace(/\n/g, ' ')}`);
    console.log(`\n${bold('versions')}`);
    for (const v of db.prepare('SELECT * FROM dispatch_draft_version WHERE draft_id = ? ORDER BY version').all(d.id)) {
      console.log(`  v${v.version}  ${dim(v.created_at)}  ${v.saved_by}  ${v.markdown.length} chars  ${v.title}`);
    }
    console.log(`\n${bold('log')}`);
    for (const e of db.prepare('SELECT * FROM dispatch_event WHERE issue = ? ORDER BY id').all(d.id)) {
      console.log(`  ${dim(e.created_at)}  ${e.kind}${e.detail ? `  ${dim(e.detail)}` : ''}`);
    }
    console.log('');
  }
} else {
  const rows = db.prepare('SELECT * FROM dispatch_draft ORDER BY created_at DESC LIMIT ?').all(Number(arg) || 10);
  console.log(rows.length ? `\n${rows.length} dispatch drafts, newest first\n` : '\nno dispatch drafts yet.\n');
  for (const d of rows) { line(d); console.log(''); }
}
