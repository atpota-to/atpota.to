// memory.js
// What the potato remembers about each person, as the droplet last received it
// from the agent, and whether it is in the public repo.
//
//   npm run memory
//
// The agent's own copy lives in Vercel Blob. This one arrives every time the
// agent saves a note, so someone whose notes predate publishing shows up here
// once they next talk to the potato.

import * as db from '../db.js';
import { config } from '../config.js';
import { notesFrom, MEMORY_COLLECTION } from '../memory.js';

const { resolveHandleForDid } = await import('../atproto.js');
const docs = db.memoryDocs();
console.log(`${docs.length} ${docs.length === 1 ? 'person' : 'people'} with notes\n`);
for (const d of docs) {
  const handle = await resolveHandleForDid(d.did, { timeoutMs: 4000 });
  const all = notesFrom(d.content) ?? [];
  const shown = JSON.parse(d.notes);
  const state = d.published_at
    ? (d.publish_note ? `settled: ${d.publish_note}` : 'public')
    : `not yet public${d.publish_note ? `: ${d.publish_note}` : ''}`;
  console.log(`${handle ? '@' + handle : '(unresolved)'}  ${d.did}`);
  console.log(`  updated ${d.updated_at.slice(0, 16).replace('T', ' ')}, ${state}`);
  if (shown.length) console.log(`  at://${config.botDid}/${MEMORY_COLLECTION}/${d.did}`);
  for (const n of all) console.log(`   ${shown.includes(n) ? '·' : 'x'} ${n}`);
  console.log('');
}
if (docs.some((d) => (notesFrom(d.content) ?? []).length > JSON.parse(d.notes).length)) {
  console.log('x = held back from the public record by the publish rules (a link, or over 300 graphemes)');
}
db.closeDb();
