// lessons.js
// The standing corrections the potato is given on every turn.
//
//   npm run lessons                     list the active ones
//   npm run lessons -- add "some text"  add one without posting anything
//   npm run lessons -- remove 3         retire one (it stays in the table)
//
// From Bluesky, an account on ADMIN_DIDS adds one by opening a post with
// "remember:" or "lesson:". Lessons are quick fixes: when a few pile up, fold
// them into skills/bluesky-reply.md and retire them here.

import * as db from '../db.js';
import { publishLesson, retireLesson, LESSON_COLLECTION } from '../memory.js';

const api = await import('../atproto.js');

const [cmd = 'list', ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const text = rest.join(' ').trim();
  if (!text) { console.error('usage: npm run lessons -- add "the lesson"'); process.exit(64); }
  const id = db.addLesson(text);
  await publishLesson(id, { api });
  console.log(`added lesson #${id}${db.getLesson(id).rkey ? ', published' : ', not published yet (the service will retry)'}`);
} else if (cmd === 'remove') {
  const id = Number(rest[0]);
  if (!Number.isInteger(id)) { console.error('usage: npm run lessons -- remove <id>'); process.exit(64); }
  const removed = db.removeLesson(id);
  if (removed) await retireLesson(id, { api });
  console.log(removed ? `retired lesson #${id}` : `no active lesson #${id}`);
} else if (cmd !== 'list') {
  console.error('usage: npm run lessons [-- add "text" | -- remove <id>]');
  process.exit(64);
}

const active = db.activeLessons();
console.log(`\n${active.length} active lesson${active.length === 1 ? '' : 's'} (the newest ${db.MAX_LESSONS} go to the agent):`);
for (const l of active) {
  const where = l.rkey ? `at://${api.currentSession()?.did ?? 'poe'}/${LESSON_COLLECTION}/${l.rkey}` : 'not in the repo yet';
  console.log(`  #${l.id}  ${l.added_at.slice(0, 16).replace('T', ' ')}  ${l.author_did ? 'from a post' : 'from the CLI'}  ${where}`);
  console.log(`       ${l.text}`);
}
db.closeDb();
