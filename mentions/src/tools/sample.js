// sample.js
// Ask the live agent a list of questions and collect the real drafts.
//
//   node --env-file=.env src/tools/sample.js questions.json
//
// buildPrompt() on the agent side uses only authorHandle, authorDid, reason and
// text, and never fetches the post, so a synthetic mention produces a genuine
// turn. That makes voice tuning testable against the actual model rather than
// against an impression of it.
//
// Every question is a real turn with real tool calls behind it. This costs
// money. Six questions is a sample; six hundred is a bill.

import fs from 'node:fs';
import { config, gates } from '../config.js';
import * as db from '../db.js';
import { sendMention } from '../agent.js';
import { evaluateOutbound } from '../gates/outbound.js';
import { graphemeLength } from '../richtext.js';

const file = process.argv[2];
if (!file) { console.error('usage: sample.js <questions.json>'); process.exit(64); }
const questions = JSON.parse(fs.readFileSync(file, 'utf8'));
const stamp = Date.now().toString(36);
const SYNTH_DID = 'did:plc:voicesample00000000000';

const ids = [];
for (const [i, q] of questions.entries()) {
  const rkey = `sample-${stamp}-${i}`;
  const uri = `at://${SYNTH_DID}/app.bsky.feed.post/${rkey}`;
  const id = db.enqueue({
    did: SYNTH_DID, rkey, uri, cid: `bafysample${i}`,
    authorDid: SYNTH_DID, authorHandle: q.handle ?? 'curious.bsky.social',
    text: q.text, reason: q.reason ?? 'mention', langs: ['en'],
    recordCreated: new Date().toISOString(),
    threadRoot: uri, rootUri: uri, rootCid: `bafysample${i}`,
    parentUri: uri, parentCid: `bafysample${i}`, source: 'voice-sample',
  }, 'sent_to_agent');
  if (id == null) { console.error(`  could not queue #${i}`); continue; }
  // attempts = 1, as the pipeline sets on a first dispatch. The search and
  // budget routes only serve a turn whose attempt matches its queue row, and
  // refuse attempt 0, so a sample without this could not use those tools.
  db.setStatus(id, 'sent_to_agent', { sent_at: db.nowIso(), attempts: 1 });
  const row = db.getQueueRow(id);
  const res = await sendMention(row);
  console.log(`  dispatched #${id}  ${res.ok ? '202' : 'FAILED ' + res.status + ' ' + res.detail}  ${q.text.slice(0, 58)}`);
  ids.push(id);
}

console.log('\n  waiting for drafts (agent turns take 15-60s)...');
const deadline = Date.now() + 240000;
const pending = new Set(ids);
while (pending.size && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  for (const id of [...pending]) {
    const row = db.getQueueRow(id);
    if (row.draft_text != null || ['rejected', 'failed', 'drafted', 'posted'].includes(row.status)) pending.delete(id);
  }
}

const g = gates();
console.log('\n' + '='.repeat(78));
for (const id of ids) {
  const row = db.getQueueRow(id);
  console.log(`\nQ: ${row.text}`);
  if (!row.draft_text) {
    console.log(`   NO DRAFT  (status ${row.status}${row.gate ? ', ' + row.gate : ''})`);
    // Do not claim this was a decision. The agent's turn.completed handler
    // returns early on an empty draft and never calls back, so a deliberate
    // silence, a model error and a callback that failed to deliver all arrive
    // here as the same nothing. Only the agent's own logs can separate them.
    console.log('   no callback arrived. could be deliberate silence, a failed turn,');
    console.log('   or a callback that never got through -- indistinguishable from here.');
    continue;
  }
  const v = evaluateOutbound(row.draft_text, {
    gates: g, botHandle: config.botHandle,
    replyingToDid: row.author_did, replyingToHandle: row.author_handle,
    lastReplyText: null,
    // The turn's real tool-result links, so the bench judges a draft the way
    // production will rather than falling back to the host allowlist.
    allowedLinks: row.draft_links ? new Set(JSON.parse(row.draft_links)) : null,
    killSwitch: () => null,
  });
  const gr = graphemeLength(row.draft_text.trim());
  if (!v.ok) {
    console.log(`   REJECT ${v.gate}  ${gr}g written  (limit ${g.maxGraphemes})`);
    console.log(`   ${v.detail}`);
    console.log(`   ${row.draft_text}`);
    continue;
  }
  // Print per post. The total across a thread is meaningless against a limit
  // that applies per post, and printing it next to "limit 300" reads as a
  // violation when it is a pass.
  const shape = v.posts.length === 1 ? '1 post' : `${v.posts.length} posts`;
  console.log(`   PASS  ${gr}g written, ${shape}  (limit ${g.maxGraphemes} each)`);
  v.posts.forEach((post, i) => {
    const label = v.posts.length === 1 ? '  ' : `${i + 1}/${v.posts.length}`;
    console.log(`   ${label} ${String(post.graphemes).padStart(3)}g  ${post.text.replace(/\n+/g, ' ⏎ ')}`);
  });
}
console.log(`\n  clean up:  DELETE FROM queue WHERE author_did = '${SYNTH_DID}';\n`);
process.exit(0);
