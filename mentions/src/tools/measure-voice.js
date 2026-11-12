// measure-voice.js
// Structural tells across a batch of Poe's writing. Voice is subjective; uniformity
// is not, and uniformity is what reads as machine-written. The tells themselves, and
// where each one came from, are in ../voice-tells.js.
//
//   npm run measure-voice                      every voice-sample draft (tools/sample.js)
//   npm run measure-voice -- 120 180           voice-sample drafts with ids 120 to 180
//   npm run measure-voice -- --posted          what went out: replies and weather posts, from the db
//   npm run measure-voice -- --repo            the same, read from the account's public repo
//
//   --since 2026-11-10 --until 2026-12-01      a window of UTC dates, for --posted and --repo
//   --show contrast                            the lines behind one number, by the key in [brackets]
//
// --repo needs no database and no .env, so it runs anywhere:
//   node src/tools/measure-voice.js --repo poe.atpota.to --since 2026-11-10
// Without a name it reads ATPOTATO_DID's repo on PDS_URL.
//
// To see whether a change to the voice rules did anything, compare the same kind
// of batch before and after it: two sample runs of the same questions, or --repo
// with --until the day it deployed against --since that day. A rate from 20
// replies moves a lot by chance; read 100 or more before believing a small change.

import {
  measureReplies, measureWeather, questionRuns, formatReplies, formatWeather,
  examples, sortRepoPosts, byThread, REPLY_TELLS, REPLY_STRUCTURE, WEATHER_TELLS,
} from '../voice-tells.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
function option(name) {
  const i = argv.indexOf(name);
  const value = i === -1 ? null : argv[i + 1];
  return value && !value.startsWith('--') ? value : null;
}
const VALUE_FLAGS = ['--since', '--until', '--show', '--repo', '--pds'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));

const since = option('--since');
const until = option('--until');
const show = option('--show');
for (const [name, value] of [['--since', since], ['--until', until]]) {
  if (value && !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    console.error(`${name} takes a UTC date like 2026-11-10`);
    process.exit(64);
  }
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

/** The account's DID and the PDS its repo is on. */
async function locate(name) {
  const fromEnv = !name;
  let did = name ?? process.env.ATPOTATO_DID;
  if (!did) throw new Error('--repo needs a handle or DID, or ATPOTATO_DID in the environment');
  if (!did.startsWith('did:')) {
    const handle = did.replace(/^@/, '');
    did = (await getJson(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`)).did;
  }
  // PDS_URL goes with ATPOTATO_DID. A repo named on the command line can be anywhere.
  let pds = option('--pds') ?? (fromEnv ? process.env.PDS_URL : null);
  if (!pds) {
    const doc = await getJson(did.startsWith('did:web:')
      ? `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
      : `https://plc.directory/${did}`);
    pds = doc.service?.find((s) => s.id === '#atproto_pds')?.serviceEndpoint;
    if (!pds) throw new Error(`no PDS in the DID document of ${did}`);
  }
  return { did, pds: pds.replace(/\/+$/, '') };
}

async function repoPosts({ did, pds }) {
  const records = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ repo: did, collection: 'app.bsky.feed.post', limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const page = await getJson(`${pds}/xrpc/com.atproto.repo.listRecords?${query}`);
    records.push(...(page.records ?? []));
    cursor = page.records?.length ? page.cursor : null;
  } while (cursor);
  return records;
}

function printBatch({ title, answers, weather }) {
  const texts = answers.map((a) => a.text);
  const posts = weather.map((w) => w.text);
  if (show) {
    // A reply's tells are read off the replies and a weather post's off the weather posts.
    const replyTells = [...REPLY_TELLS, ...REPLY_STRUCTURE];
    const found = replyTells.some((t) => t.key === show) ? examples(texts, show, replyTells) : examples(posts, show, WEATHER_TELLS);
    if (!found) { console.error(`no tell called "${show}"; the keys are the names in [brackets]`); process.exit(64); }
    console.log(`\n  ${title}: ${found.length} with [${show}]\n`);
    for (const line of found) console.log(`  · ${line}`);
    console.log('');
    return;
  }
  console.log(`\n  ${title}\n`);
  const runs = answers.some((a) => a.thread) ? questionRuns(byThread(answers)) : null;
  console.log(formatReplies(measureReplies(texts), { runs }).join('\n'));
  if (posts.length) console.log(`\n${formatWeather(measureWeather(posts)).join('\n')}`);
  console.log('');
}

const windowLabel = [since ? `since ${since}` : null, until ? `until ${until}` : null].filter(Boolean).join(', ');

if (flag('--repo')) {
  const where = await locate(option('--repo'));
  const sorted = sortRepoPosts(await repoPosts(where), where.did, { since, until });
  printBatch({ title: `${where.did} on ${new URL(where.pds).host}${windowLabel ? `, ${windowLabel}` : ''}`, ...sorted });
} else {
  const { db } = await import('../db.js');
  if (flag('--posted')) {
    const lo = since ?? '';
    const hi = until ?? '9999';
    const answers = db.prepare(
      `SELECT r.text AS text, r.posted_at AS at, q.thread_root AS thread
       FROM replies r JOIN queue q ON q.id = r.queue_id
       WHERE r.posted_at >= ? AND r.posted_at < ? ORDER BY r.posted_at`
    ).all(lo, hi);
    let weather = [];
    try {
      weather = db.prepare(
        `SELECT post_text AS text, posted_at AS at FROM weather_post
         WHERE status = 'posted' AND post_text IS NOT NULL AND posted_at >= ? AND posted_at < ? ORDER BY posted_at`
      ).all(lo, hi);
    } catch { /* the table is made by the weather watcher; a db that never ran it has none */ }
    printBatch({ title: `posted${windowLabel ? `, ${windowLabel}` : ''}`, answers, weather });
  } else {
    // Takes a range, because "everything since id N" silently merges batches once
    // a second run lands, which is how the first comparison came out meaningless.
    const from = Number(positional[0] || 0);
    const to = Number(positional[1] || 1e9);
    const rows = db.prepare(
      "select draft_text d from queue where source='voice-sample' and id>=? and id<=? and draft_text is not null"
    ).all(from, to);
    printBatch({ title: `voice-sample drafts ${from} to ${to === 1e9 ? 'the newest' : to}`, answers: rows.map((r) => ({ text: r.d })), weather: [] });
  }
}
process.exit(0);
