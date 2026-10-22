// config.js
// Environment for identity and secrets; a separate, hot-reloaded JSON file for
// the gate thresholds.
//
// The split is deliberate. Secrets belong in the unit's EnvironmentFile and
// change almost never. Thresholds are the numbers you actually want to move at
// 2am while watching the log, and the brief asks for them to be changeable
// without a deploy — so they live in gates.json, which is re-read when its mtime
// changes. A malformed edit keeps the last good values and logs loudly rather
// than taking the service down or, worse, silently reverting to defaults that
// are more permissive than what you had.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function req(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}`);
  return v.trim();
}
function opt(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}
function num(name, fallback) {
  const v = process.env[name];
  if (v == null || !String(v).trim()) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number: ${v}`);
  return n;
}

// --- Jetstream hosts -------------------------------------------------------
// The brief names wss://jetstream.us-east.bsky.network. On 2026-09-18 that host
// answered 503 to both the v2 xrpc path and the v1 /subscribe path from this
// droplet, while us-west served both. So the default is west-first with east as
// a fallback, and JETSTREAM_URL still accepts a single URL for an override.
//
// Consuming more than one host at a time is supported (comma-separate them) and
// is the pattern the other consumers on this box use, because a single instance
// has been observed silently dropping records. Duplicates cost nothing: the
// `seen` table de-dupes on (did, rkey) before anything else happens.
const DEFAULT_JETSTREAM = [
  'wss://jetstream.us-west.bsky.network',
  'wss://jetstream.us-east.bsky.network',
];

function parseJetstream() {
  const raw = opt('JETSTREAM_URL', '');
  if (!raw) return DEFAULT_JETSTREAM;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// --- Gate thresholds -------------------------------------------------------
// Defaults are the brief's numbers. Anything in gates.json overrides them.
export const GATE_DEFAULTS = {
  // Our own posts in one thread, then stop. null disables it.
  //
  // Disabled, because it was solving a problem that no longer exists. The brief
  // wrote this when a reply was always exactly one post, so "3 of our posts in
  // a thread" meant "3 exchanges". Now that a long answer can be split across
  // posts, maxPosts caps that, and this was instead ending conversations after
  // three questions -- which is a conversation going well, not a fault.
  //
  // The loop it was guarding against is better handled by botLoopReplies, which
  // is time-windowed and backs off for an hour whether or not the replies are
  // in the same thread.
  threadDepthMax: null,
  // > this many replies to one account inside botLoopWindowMin, then back off.
  //
  // This gate exists to catch another bot in a reply loop, and it has to do
  // that without catching a person who is enjoying the conversation. Rate is
  // the only signal it has, so the window is sized from both:
  //
  //   A person, measured 2026-09-23: testing.dame.is answered within 17-76s of
  //   each reply, 9 replies in 15 minutes, never more than 5 in any 5. At the
  //   old 8-in-15 that tripped the gate, the potato went quiet for an hour, and
  //   "how was your nap?" was dropped in silence.
  //
  //   A bot: the potato takes 5-33s to answer, so a loop with a fast bot on
  //   the other end runs 2 to 8 exchanges a minute, 10 or more in 5.
  //
  // A loop slower than that is left to perAccountPerHour.
  botLoopReplies: 8,
  botLoopWindowMin: 5,          // ... within this window ...
  botLoopBackoffMin: 60,        // ... and we go quiet toward them for this long
  perAccountPerHour: 20,
  // Raised alongside perAccountPerHour: at 15 per person a global of 10 binds
  // first and makes the per-account number decorative. Still far under the
  // protocol's 1,666 records/hour; this exists to stop a runaway, not to ration.
  globalPerHour: 60,
  stalenessMin: 15,             // ignore posts older than this at processing time
  supportedLangs: ['en'],       // a post with no langs at all is NOT filtered
  // The length catch-all in the substance gate, or null to disable it. Applies
  // to mentions only; a reply to one of our posts is judged on whether it is
  // only a pleasantry, which is code, not a threshold (gates/inbound.js).
  //
  // This number depends entirely on WHICH ACCOUNT is being watched, and it has
  // been wrong twice already by being set without that in mind.
  //
  //   A brand account (@atpota.to) gets tagged in roundups, sponsorship
  //   thanks and jokes. Measured 2026-09-21 over its whole 47-day notification
  //   history: a threshold of 80 passed 8 of 12 mentions and NONE was a
  //   question. null -- length off entirely -- passed 3, and later 1 once the
  //   crowd gate landed. For that population the catch-all was pure cost.
  //
  //   A dedicated bot account (@poe.atpota.to) is mentioned in order to be
  //   used. Roundups do not tag it, so the false positives that justified null
  //   mostly disappear, and the risk asymmetry inverts: ignoring a real
  //   question defeats the entire point, while answering a compliment is
  //   merely chatty. 40 lets an unpunctuated question through without
  //   answering "nice" or "cc".
  //
  // 40 is a PRIOR, not a measurement -- there is no traffic for the new
  // account yet. Sit at stage 1 or 2 long enough to collect some, then read
  // the sensitivity table in `npm run stats` and set it from data.
  substanceMinChars: 40,

  // Whether a mention that opens with our handle ("@poe.atpota.to hi", "hey
  // @poe.atpota.to") is judged like a reply to us, answered unless it is only
  // a pleasantry, instead of by the length catch-all above. Right for a bot
  // people tag in order to use: as of 2026-09-24 the length test had dropped
  // "hi" and "I have a question" from two different people, and nothing else.
  // Wrong for a brand account, where a post opening with the handle is as
  // likely to be a shoutout; set it false alongside substanceMinChars null.
  openingMentionsAreAddressed: true,

  // The longest reply, in graphemes, that may end in one of the potato's faces
  // (see faceRules in richtext.js). null lets a face go on anything.
  faceMaxGraphemes: 200,

  // How long to stay quiet toward one account after telling them we are out of
  // answers, so the notice is sent once rather than on every further question.
  cooldownNoticeMins: 60,

  // Likes Poe proposes with appreciate_post (likes.js). The prompt asks it to
  // like only a post that truly stands out; these make sure a chatty day or a
  // talked-into-it turn cannot turn into a stream of likes.
  likesPerHour: 10,
  likesPerAuthorPerDay: 3,

  // Poe's weather posts (weather-posts.js, gates/weather.js). Poe decides whether
  // a moment is worth a post; these decide how often it is asked and how often it
  // may post. A quiet weather vane is better than a chatty one.
  weatherPostsPerDay: 3,        // posted, rolling 24 hours, every kind together
  weatherMinGapMin: 120,        // between two weather posts
  weatherAsksPerDay: 8,         // moments handed to Poe in 24 hours, skips included: the model bill
  // Which moments Poe may be asked about. Remove one to stop it.
  weatherKinds: ['daily', 'storm', 'unusual', 'mixed', 'new_app'],
  // The daily report is asked for once a UTC day, from this hour. null turns it off.
  // 16 is noon in New York and 9 in San Francisco.
  weatherDailyHourUtc: 16,
  // After one of a kind is asked about, the next of that kind waits this long.
  weatherStormCooldownHours: 12,
  weatherUnusualCooldownHours: 12,
  weatherMixedCooldownHours: 24,
  weatherNewAppCooldownHours: 24,
  // An hour this much busier than usual for it (a ratio), or this much quieter.
  weatherUnusualBusier: 1.4,
  weatherUnusualQuieter: 0.65,
  // A new app is worth asking about once it has written this many records. The
  // station hears a few new apps a day, most of them a handful of test records.
  weatherNewAppMinRecords: 250,
  // The diversity index from which the sky counts as mixed: "high" on the page.
  // A usual minute in October 2026 was about 2.
  weatherMixedMinIndex: 6,

  maxOtherMentions: 2,
  maxGraphemes: 300,            // from the live app.bsky.feed.post lexicon
  maxBytes: 3000,               // ditto
  // How many posts one answer may become. 1 disables threading entirely.
  // Two is the intended ceiling in practice; three exists so a genuinely long
  // explanation is not silently dropped.
  maxPosts: 3,
  // Three, so an answer that lists a few records can link each on its own line
  // instead of inventing one URL that covers them all -- which is what it did
  // when the cap was two and it had four real ones in hand.
  maxLinks: 3,
  replyLangs: ['en'],
};

const gatesPath = path.resolve(root, opt('GATES_FILE', 'gates.json'));
let gateCache = { ...GATE_DEFAULTS };
let gateMtime = 0;
let gateWarned = false;

// The brief names GLOBAL_RATE_PER_HOUR as an environment variable. It is
// honoured under that name and wins over gates.json, so following either the
// brief or the JSON file gives the behaviour it describes. Applied inside
// gates() rather than alongside it, so there is exactly one way to read a
// threshold and no way for a caller to pick the wrong one.
function applyEnvOverrides(g) {
  const n = Number(process.env.GLOBAL_RATE_PER_HOUR);
  return Number.isFinite(n) && process.env.GLOBAL_RATE_PER_HOUR?.trim()
    ? { ...g, globalPerHour: n }
    : g;
}

/** Thresholds, re-read from gates.json whenever that file's mtime changes. */
export function gates() {
  let stat;
  try {
    stat = fs.statSync(gatesPath);
  } catch {
    return applyEnvOverrides(gateCache); // no file: defaults, or last loaded
  }
  if (stat.mtimeMs === gateMtime) return applyEnvOverrides(gateCache);
  try {
    const parsed = JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      gateCache = { ...GATE_DEFAULTS, ...parsed };
      gateMtime = stat.mtimeMs;
      gateWarned = false;
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ level: 'info', msg: 'gates reloaded', file: gatesPath }));
    } else throw new Error('gates.json must contain a JSON object');
  } catch (err) {
    if (!gateWarned) {
      gateWarned = true;
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        level: 'error',
        msg: 'gates.json unreadable; keeping last good thresholds',
        file: gatesPath,
        err: err.message,
      }));
    }
    gateMtime = stat.mtimeMs; // do not re-log every call for the same bad file
  }
  return applyEnvOverrides(gateCache);
}

// --- Kill switch -----------------------------------------------------------
// Checked immediately before every createRecord, never cached. Two ways to trip
// it, because the point is to go quiet in ten seconds without a deploy:
//   * KILL_SWITCH set in the environment (needs a restart, survives one)
//   * a file at KILL_SWITCH_FILE existing (takes effect on the next post, and
//     `touch` is faster than editing a unit file under pressure)
const killFile = path.resolve(root, opt('KILL_SWITCH_FILE', 'KILL'));

export function killSwitchEngaged() {
  if (process.env.KILL_SWITCH && process.env.KILL_SWITCH.trim() &&
      process.env.KILL_SWITCH.trim().toLowerCase() !== 'false') {
    return 'env';
  }
  try {
    fs.accessSync(killFile);
    return 'file';
  } catch {
    return null;
  }
}
export const killSwitchPath = killFile;

// --- weekly dispatch -------------------------------------------------------
// Issues live in atpota.to's repo, not the potato's, so publishing needs a
// second credential. It is used for site.standard.document writes in this one
// publication and nothing else (atproto.js enforces that), and it is optional:
// without it the announce command still posts, and tells the operator how to
// link the post to the issue by hand.
const DISPATCH_PUBLICATION =
  'at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n';
export const DISPATCH_PAGE_BASES = ['https://poe.leaflet.pub', 'https://atpota.to/blog'];

function flag(name) {
  return opt(name, 'false').toLowerCase() === 'true';
}

function parseDispatch() {
  const publicationUri = opt('DISPATCH_PUBLICATION_URI', DISPATCH_PUBLICATION);
  const pub = /^at:\/\/(did:(?:plc|web):[a-zA-Z0-9._:%-]+)\/site\.standard\.publication\/([a-zA-Z0-9._:~-]{1,512})$/
    .exec(publicationUri);
  if (!pub) throw new Error(`DISPATCH_PUBLICATION_URI is not a site.standard.publication at-uri: ${publicationUri}`);
  const announceUrlBase = opt('DISPATCH_ANNOUNCE_URL_BASE', 'https://atpota.to/blog').replace(/\/+$/, '');
  if (!DISPATCH_PAGE_BASES.includes(announceUrlBase)) {
    throw new Error(`DISPATCH_ANNOUNCE_URL_BASE must be one of ${DISPATCH_PAGE_BASES.join(', ')}`);
  }
  return {
    enabled: flag('DISPATCH_ENABLED'),
    publishEnabled: flag('DISPATCH_PUBLISH_ENABLED'),
    announceUrlBase,
    publicationUri,
    publisherDid: pub[1],
    publicationRkey: pub[2],
    // Signs in by DID when no identifier is given, for the reason createSession
    // in atproto.js gives. Either way the session's DID is checked.
    publisherIdentifier: opt('DISPATCH_PUBLISHER_IDENTIFIER', pub[1]),
    publisherAppPassword: opt('DISPATCH_PUBLISHER_APP_PASSWORD', ''),
    pagePollMs: num('DISPATCH_PAGE_POLL_MS', 20000),
    pageTimeoutMs: num('DISPATCH_PAGE_TIMEOUT_MS', 600000),
  };
}

// --- weather posts ---------------------------------------------------------
// Poe posting the Atmosphere's weather on its own account (weather-posts.js).
//   post   gated drafts are posted (the default, chosen by the operator on
//          2026-10-21; stage 4 only)
//   draft  the watcher asks Poe and gates its drafts, and holds every one: read
//          them in the log or with `npm run weather`
//   off    nothing runs
function parseWeatherPosts() {
  const mode = opt('WEATHER_POSTS', 'post').toLowerCase();
  if (!['off', 'draft', 'post'].includes(mode)) throw new Error(`WEATHER_POSTS must be off, draft or post, got ${mode}`);
  const apiBase = opt('WEATHER_API_BASE', 'https://atpota.to/api').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+(\/.*)?$/.test(apiBase)) throw new Error(`WEATHER_API_BASE must be an https URL: ${apiBase}`);
  return {
    mode,
    apiBase,
    pollMs: Math.max(num('WEATHER_POLL_MS', 300000), 60000),
    // A moment with no draft after this long is given up on.
    draftTimeoutMs: num('WEATHER_DRAFT_TIMEOUT_MS', 900000),
  };
}

export function isAdmin(did) {
  return typeof did === 'string' && config.adminDids.includes(did);
}

// --- Stage -----------------------------------------------------------------
// The brief's milestones, as a runtime dial rather than four branches:
//   1 detect only      - match and queue, touch nothing else
//   2 detect + gates   - run the inbound gates, record the verdict, stop
//   3 + draft          - call the agent, store drafts, run outbound gates, never post
//   4 + post           - actually reply
// Every stage below 4 is incapable of posting: the poster is not merely skipped,
// it is never reached, and stage is re-checked at the post call itself.
const stage = num('STAGE', 1);
if (![1, 2, 3, 4].includes(stage)) throw new Error(`STAGE must be 1..4, got ${stage}`);

export const config = {
  stage,

  botDid: req('ATPOTATO_DID'),
  botHandle: opt('ATPOTATO_HANDLE', 'atpota.to'),
  pdsUrl: opt('PDS_URL', 'https://pds.atpota.to').replace(/\/+$/, ''),
  appPassword: stage >= 4 ? req('ATPROTO_APP_PASSWORD') : opt('ATPROTO_APP_PASSWORD', ''),

  agentUrl: stage >= 3 ? req('AGENT_URL').replace(/\/+$/, '') : opt('AGENT_URL', '').replace(/\/+$/, ''),
  sharedSecret: stage >= 3 ? req('DROPLET_SHARED_SECRET') : opt('DROPLET_SHARED_SECRET', ''),
  callbackUrl: opt('DROPLET_CALLBACK_URL', ''),
  dmEnabled: opt('OPERATOR_DM_ENABLED', 'false').toLowerCase() === 'true',
  dmPollMs: num('OPERATOR_DM_POLL_MS', 60000),
  callbackPort: num('CALLBACK_PORT', 8787),
  callbackHost: opt('CALLBACK_HOST', '127.0.0.1'),

  jetstreamHosts: parseJetstream(),
  jetstreamPath: opt('JETSTREAM_PATH', '/xrpc/network.bsky.jetstream.subscribeEvents'),
  // v2 replays from a `seq`, exactly: cursor=seq-N lands N events back. Rewind a
  // little on reconnect so an event mid-flight is redelivered rather than skipped.
  // Redelivery is free; the `seen` table collapses it.
  cursorRewindSeq: num('CURSOR_REWIND_SEQ', 200),
  cursorSaveMs: num('CURSOR_SAVE_MS', 5000),
  reconnectBaseMs: num('RECONNECT_BASE_MS', 1000),
  reconnectMaxMs: num('RECONNECT_MAX_MS', 60000),

  notifyPollMs: num('NOTIFY_POLL_MS', 180000),     // the safety-net sweep
  reconcileMs: num('RECONCILE_MS', 120000),        // stuck-queue sweep
  reconcileStuckMin: num('RECONCILE_STUCK_MIN', 20),
  reconcileMaxRetries: num('RECONCILE_MAX_RETRIES', 2),

  // ':memory:' is passed through untouched so tests get a private database.
  dbFile: opt('DB_FILE', 'mentions.db') === ':memory:'
    ? ':memory:'
    : path.resolve(root, opt('DB_FILE', 'mentions.db')),
  logLevel: opt('LOG_LEVEL', 'info'),
  statsEveryMs: num('STATS_EVERY_MS', 300000),
  dryRun: !!opt('DRY_RUN', ''),

  // The people who run the potato. A post from one of these DIDs is taken as
  // direction rather than as a stranger's claim, and "remember: ..." from one
  // is saved for every future conversation. Matched against the DID on the
  // signed record, which a post cannot fake by saying who it is from.
  // Comma-separated; empty means nobody.
  adminDids: opt('ADMIN_DIDS', '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('did:')),

  dispatch: parseDispatch(),
  weather: parseWeatherPosts(),
};
