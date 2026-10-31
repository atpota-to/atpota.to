// weather-posts.js
// Poe's weather posts, the droplet's half. Every few minutes the watcher reads the
// weather station through atpota.to's public endpoints (the ones /weather reads),
// and when gates/weather.js finds a moment worth a post (the daily report, a
// storm, an hour well off usual, a more mixed sky, a new app) and the caps allow
// one, it hands Poe that moment. Poe reads the station and answers with a post or
// "skip" on the callback URL replies use. The draft goes through the weather gates and, when
// WEATHER_POSTS=post, is posted from Poe's account with a link card to the weather
// report, or to the page of it Poe said the post is about, with that page's live
// weather card.
//
// One moment at a time, one row per moment in weather_post, and every step
// records its result before the next one starts. Like the dispatch, the post's
// TID record key is stored before createRecord is called, so a post whose fate a
// crash left unknown is looked up under that key rather than posted again.
//
// The kill switch, a nap and STAGE below 4 all stop a post. The kill switch and a
// nap also stop the watcher asking Poe at all, so a quiet potato costs nothing.

import { config, gates, killSwitchEngaged } from './config.js';
import { db, nowIso } from './db.js';
import { logger } from './logger.js';
import { isNapping } from './nap.js';
import { faceRules } from './richtext.js';
import { buildAnnouncement, defaultDeps as dispatchDeps, nextTid, ogContent, postUrl } from './dispatch.js';
import {
  MOMENT_KINDS, WEATHER_PAGES, askGate, dueMoments, evaluateWeatherDraft, isSkip, perSecond, pickMoment, postGate,
  weatherPageOf, weatherPageUrl,
} from './gates/weather.js';

db.exec(`
  -- One row per moment Poe was asked about (or the watcher tried to ask about).
  CREATE TABLE IF NOT EXISTS weather_post (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,             -- daily | storm | unusual | mixed | new_app
    subject     TEXT NOT NULL,             -- what it is about: a UTC date or hour, an app
    facts       TEXT NOT NULL,             -- JSON, as Poe was shown it
    status      TEXT NOT NULL,             -- dispatched|failed|expired|drafted|skipped|rejected|held|posting|posted|post_failed
    gate        TEXT,                      -- which gate stopped it
    detail      TEXT,
    draft_key   TEXT UNIQUE,
    draft_text  TEXT,
    page        TEXT,                      -- the report's page Poe said it's about (gates/weather.js WEATHER_PAGES), or null
    post_text   TEXT,                      -- what was (or would have been) posted
    post_rkey   TEXT UNIQUE,               -- claimed before posting
    post_uri    TEXT,
    post_cid    TEXT,
    posted_at   TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS weather_post_created_idx ON weather_post(created_at);
  CREATE INDEX IF NOT EXISTS weather_post_status_idx ON weather_post(status);
`);
// Added after the table shipped; harmless when it already exists.
try { db.exec('ALTER TABLE weather_post ADD COLUMN page TEXT'); }
catch { /* column already present */ }

const CARD_TITLE = 'the atmosphere weather report · atpotato';
const CARD_DESCRIPTION = "how busy bluesky is right now, how much of the network isn't bluesky at all, " +
  'and which other apps are writing records, read live from the firehose.';
const FETCH_MS = 8000;
const MAX_JSON_BYTES = 1_000_000;
/** A post whose fate is unknown this long is looked up under its key. */
const POSTING_STUCK_MS = 10 * 60_000;
const DAY = 86_400_000;

/**
 * The weather report's live card (website/server/og-weather.ts). Every weather post
 * goes out under it or not at all, fetched here by its own address: the page's
 * og:image is not trusted for it. On 2026-10-21 the droplet deployed a few minutes
 * before the website, and the first post went out under the home page's card,
 * which the page still named.
 */
export const WEATHER_CARD = 'https://atpota.to/og/weather.png';
/** How long a draft waits for the card (the website mid-deploy, say) before it is dropped. */
export const CARD_WAIT_MS = 30 * 60_000;
const CARD_MAX_BYTES = 1_000_000;   // app.bsky.embed.external#external.thumb maxSize

/**
 * Which of the weather card's designs (website/server/og-weather-cards.ts) goes
 * under each kind of post: the sky for a storm, the barometer for an hour off
 * usual, the other apps for a mixed sky or a new one, the day's chart for the
 * daily report. A post Poe said is about one page of the report gets that page's
 * design instead (WEATHER_PAGES), whatever the moment was.
 */
export const CARD_FOR = { daily: 'trend', storm: 'forecast', unusual: 'today', mixed: 'mix', new_app: 'mix' };

/**
 * The card as of this minute, in the design for this post: its page's, or its
 * kind's. The CDN keeps the bare URL for several minutes, and a storm post under a
 * card from before the storm would say the opposite of the post.
 */
export function freshCardUrl(url, kind, nowMs = Date.now(), page = null) {
  const u = new URL(url);
  const design = weatherPageOf(page) ? WEATHER_PAGES[page] : CARD_FOR[kind];
  if (design) u.searchParams.set('card', design);
  u.searchParams.set('v', String(Math.floor(nowMs / 60_000)));
  return u.href;
}

// --- reading the weather ------------------------------------------------------

// The same checks the bot's lib/weather.ts makes: app names are other people's
// text, so only a domain-shaped name and NSID-shaped collections reach Poe.
const DOMAIN = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}$/;
const NSID = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62}){1,}\.[a-z][a-z0-9]{0,62}$/i;
const CONDITIONS = new Set(['calm', 'light', 'breezy', 'gusty', 'stormy']);
const LEVELS = new Set(['low', 'moderate', 'high', 'very high', 'extreme']);

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const list = (x) => (Array.isArray(x) ? x : []);

function count(x) {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function iso(x) {
  if (typeof x !== 'string') return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const domainOf = (x) => (typeof x === 'string' && DOMAIN.test(x) ? x : null);
const collectionsOf = (x) => list(x).filter((c) => typeof c === 'string' && c.length <= 253 && NSID.test(c)).slice(0, 3);

/** The last 60 seconds (/api/atmosphere), checked, or null. */
export function parseReading(body) {
  if (!isObject(body) || !isObject(body.records)) return null;
  const measuredAt = iso(body.measuredAt);
  const total = count(body.records.perSecond);
  const condition = CONDITIONS.has(body.condition) ? body.condition : null;
  if (!measuredAt || total === null || !condition) return null;
  const d = isObject(body.diversity) ? body.diversity : null;
  const index = count(d?.index);
  const rates = isObject(body.perSecond) ? body.perSecond : {};
  const accounts = isObject(body.accounts) ? body.accounts : null;
  return {
    measuredAt,
    source: body.source === 'station' ? 'station' : 'sample',
    perSecond: total,
    condition,
    blueskyPerSecond: count(body.records.bluesky),
    elsewherePerSecond: count(body.records.elsewhere),
    bluesky: {
      postsPerSecond: count(rates.posts), likesPerSecond: count(rates.likes),
      repostsPerSecond: count(rates.reposts), followsPerSecond: count(rates.follows),
    },
    diversity: index === null ? null : {
      index,
      level: LEVELS.has(d.level) ? d.level : null,
      accountSharePercent: count(d.share),
      spreadAcrossApps: count(d.spread),
      apps: count(d.apps),
    },
    apps: list(body.apps).flatMap((a) => {
      const domain = isObject(a) ? domainOf(a.domain) : null;
      const records = isObject(a) ? count(a.count) : null;
      return domain && records !== null ? [{ domain, recordsLastMinute: records, collections: collectionsOf(a.collections) }] : [];
    }).slice(0, 5),
    accounts: accounts && count(accounts.active) !== null
      ? { active: count(accounts.active), writingElsewhere: count(accounts.elsewhere) }
      : null,
  };
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

/** Today in UTC, the last hour against usual and the new apps (/api/weather-almanac?tz=UTC), checked, or null. */
export function parseAlmanac(body, nowMs = Date.now()) {
  if (!isObject(body)) return null;
  const out = { today: null, lastHour: null, newApps: [] };

  const t = isObject(body.today) ? body.today : null;
  const start = iso(t?.start);
  const seconds = count(t?.seconds);
  const creates = count(t?.creates);
  if (start && seconds && creates !== null) {
    const extreme = (x) => (isObject(x) && iso(x.minute) && count(x.perSecond) !== null
      ? { minute: iso(x.minute), perSecond: count(x.perSecond) } : null);
    out.today = {
      since: start,
      heardPercent: Math.min(100, Math.round((seconds * 1000 / Math.max(nowMs - Date.parse(start), 1)) * 100)),
      perSecond: perSecond(creates, seconds),
      high: extreme(t.high),
      low: extreme(t.low),
    };
  }

  // The last hour against the same hour before, as the page words it: on the same
  // weekday once the station has weeks of them, otherwise on the days before. Only
  // when the station heard most of the last hour, so an outage of its own never
  // reads as a quiet sky.
  const n = isObject(body.normal) ? body.normal : null;
  const now = n && count(n.now?.seconds) >= 2700 && count(n.now?.creates) !== null ? n.now : null;
  const basis = [['weeks', n?.weeks], ['days', n?.days]]
    .find(([, b]) => isObject(b) && count(b.windows) > 0 && count(b.seconds) >= 1800 && count(b.creates) !== null);
  if (now && basis) {
    const [kind, b] = basis;
    const windows = count(b.windows);
    const weekday = WEEKDAY.format(new Date(nowMs)).toLowerCase();
    out.lastHour = {
      perSecond: perSecond(count(now.creates), count(now.seconds)),
      usualPerSecond: perSecond(count(b.creates), count(b.seconds)),
      comparedWith: kind === 'weeks'
        ? windows === 1 ? `this hour last ${weekday}` : `this hour on the last ${windows} ${weekday}s`
        : windows === 1 ? 'this hour yesterday' : `this hour on the last ${windows} days`,
    };
  }

  const apps = isObject(body.newApps) && body.newApps.warmingUp === false ? list(body.newApps.apps) : [];
  out.newApps = apps.flatMap((a) => {
    const domain = isObject(a) ? domainOf(a.domain) : null;
    const firstSeen = isObject(a) ? iso(a.firstSeen) : null;
    const records = isObject(a) ? count(a.creates) : null;
    return domain && firstSeen && records !== null ? [{ domain, firstSeen, records, collections: collectionsOf(a.collections) }] : [];
  }).slice(0, 20);
  return out;
}

async function fetchJson(url, fetcher) {
  const res = await fetcher(url, {
    headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => undefined);
    throw new Error(`${url} answered ${res.status}`);
  }
  const text = await res.text();
  if (text.length > MAX_JSON_BYTES) throw new Error(`${url} is too large`);
  return JSON.parse(text);
}

/** What Poe is shown with a moment: why it was asked, and the sky around it. */
export function factsFor(moment, reading, almanac) {
  return {
    timeZone: 'UTC',
    trigger: moment.trigger,
    ...(reading ? { lastMinute: reading } : {}),
    ...(almanac?.today ? { today: almanac.today } : {}),
    ...(almanac?.lastHour ? { lastHour: almanac.lastHour } : {}),
    ...(almanac?.newApps?.length
      ? { newToday: [...almanac.newApps].sort((a, b) => b.records - a.records).slice(0, 3) }
      : {}),
  };
}

// --- state --------------------------------------------------------------------

const getRow = (id) => db.prepare('SELECT * FROM weather_post WHERE id = ?').get(id);

/** The last two days of moments, enough for every cap and cooldown. */
function recentRows(nowMs) {
  return db.prepare('SELECT * FROM weather_post WHERE created_at >= ? ORDER BY id')
    .all(new Date(nowMs - 2 * DAY).toISOString());
}

/** Move a row on, only from the status `from` when given, so two hands can't both settle it. */
function finish(id, status, extra = {}, from = null) {
  const cols = Object.keys(extra);
  return db.prepare(`UPDATE weather_post SET status = ?, ${cols.map((c) => `${c} = ?, `).join('')}updated_at = ?
    WHERE id = ?${from ? ' AND status = ?' : ''}`)
    .run(status, ...cols.map((c) => extra[c]), nowIso(), id, ...(from ? [from] : [])).changes > 0;
}

/** Poe's last few weather posts, newest first, so it doesn't repeat itself. */
function recentPosts() {
  // Only the watcher's own kinds: the agent's schema refuses any other, and an
  // operator's weather post (operator-posts.js, kind 'operator') is here for the caps.
  return db.prepare(`SELECT kind, post_text AS text, posted_at AS postedAt FROM weather_post
    WHERE status = 'posted' AND kind IN (${MOMENT_KINDS.map(() => '?').join(', ')})
    ORDER BY posted_at DESC LIMIT 8`).all(...MOMENT_KINDS);
}

/**
 * The weather card, or a throw. Redirects are refused, not followed: when the card
 * can't be drawn at all, the website redirects to the home page's card, and that is
 * the one card a weather post must never carry.
 */
async function fetchCard(url) {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (res.status !== 200 || type !== 'image/png' || Number(res.headers.get('content-length')) > CARD_MAX_BYTES) {
    await res.body?.cancel?.().catch(() => undefined);
    throw new Error(`the weather card answered ${res.status} ${type || 'untyped'}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > CARD_MAX_BYTES) throw new Error('the weather card is over 1 MB');
  return { bytes, mimeType: 'image/png' };
}

export const defaultDeps = {
  fetcher: (...args) => fetch(...args),
  fetchPage: dispatchDeps.fetchPage,
  fetchCard,
  uploadBlob: dispatchDeps.uploadBlob,
  createPost: dispatchDeps.createPost,
  getOwnPost: dispatchDeps.getOwnPost,
};

// --- asking Poe -------------------------------------------------------------------

async function dispatchMoment(payload, fetcher) {
  const res = await fetcher(`${config.agentUrl}/weather/moment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atpotato-secret': config.sharedSecret },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  await res.body?.cancel?.().catch(() => undefined);
  if (res.status !== 202) throw new Error(`agent answered ${res.status}`);
}

/**
 * Settle what a crash or a lost draft left behind: a moment with no draft after
 * WEATHER_DRAFT_TIMEOUT_MS expires, a draft never processed is processed, and a
 * post whose fate is unknown is looked up under its record key.
 */
async function settle(nowMs, deps) {
  db.prepare(`UPDATE weather_post SET status = 'expired', updated_at = ? WHERE status = 'dispatched' AND created_at < ?`)
    .run(nowIso(), new Date(nowMs - config.weather.draftTimeoutMs).toISOString());
  // A minute old, so the callback's own run of a fresh draft isn't raced.
  for (const { id } of db.prepare(`SELECT id FROM weather_post WHERE status = 'drafted' AND updated_at < ?`)
    .all(new Date(nowMs - 60_000).toISOString())) {
    await handleWeatherDraft(id, deps);
  }
  const stuck = db.prepare(`SELECT * FROM weather_post WHERE status = 'posting' AND updated_at < ?`)
    .all(new Date(nowMs - POSTING_STUCK_MS).toISOString());
  for (const row of stuck) {
    const found = await deps.getOwnPost(row.post_rkey).catch(() => undefined);
    if (found === undefined) continue;   // couldn't tell; try again next time
    if (found) finish(row.id, 'posted', { post_uri: found.uri, post_cid: found.cid, posted_at: row.updated_at }, 'posting');
    else finish(row.id, 'post_failed', { detail: 'the post never appeared under its key' }, 'posting');
  }
}

/**
 * One look at the sky. Returns what happened, for the log and the tests:
 * { asked: { id, kind, subject } } or { skipped: <reason> }.
 */
export async function weatherTick({ nowMs = Date.now(), deps = defaultDeps } = {}) {
  const w = config.weather;
  if (w.mode === 'off' || config.stage < 3) return { skipped: 'off' };
  await settle(nowMs, deps);
  if (killSwitchEngaged()) return { skipped: 'kill_switch' };
  if (isNapping()) return { skipped: 'nap' };
  const g = gates();
  const rows = recentRows(nowMs);
  const blocked = askGate(rows, nowMs, g);
  if (blocked) return { skipped: blocked };

  const [reading, almanac] = await Promise.all([
    fetchJson(`${w.apiBase}/atmosphere`, deps.fetcher).then(parseReading).catch((err) => {
      logger.warn('weather reading unavailable', { error: err.message });
      return null;
    }),
    fetchJson(`${w.apiBase}/weather-almanac?tz=UTC`, deps.fetcher).then((b) => parseAlmanac(b, nowMs)).catch((err) => {
      logger.warn('weather almanac unavailable', { error: err.message });
      return null;
    }),
  ]);
  if (!reading && !almanac) return { skipped: 'no_weather' };

  const moment = pickMoment(dueMoments({ reading, almanac, nowMs, gates: g }), rows, nowMs, g);
  if (!moment) return { skipped: 'nothing_due' };

  const facts = factsFor(moment, reading, almanac);
  const at = new Date(nowMs).toISOString();
  const id = Number(db.prepare(`INSERT INTO weather_post (kind, subject, facts, status, created_at, updated_at)
    VALUES (?, ?, ?, 'dispatched', ?, ?)`).run(moment.kind, moment.subject, JSON.stringify(facts), at, at).lastInsertRowid);
  try {
    await dispatchMoment({ momentId: `wx-${id}`, kind: moment.kind, facts, recent: recentPosts() }, deps.fetcher);
  } catch (err) {
    finish(id, 'failed', { detail: err.message }, 'dispatched');
    logger.error('weather moment not dispatched', { id, kind: moment.kind, error: err.message });
    return { skipped: 'dispatch_failed' };
  }
  logger.info('weather moment sent to Poe', { id, kind: moment.kind, subject: moment.subject });
  return { asked: { id, kind: moment.kind, subject: moment.subject } };
}

// --- Poe's answer -------------------------------------------------------------------

/**
 * Validate and store a weather draft from the callback URL (callback.js). Returns { status, body, id? }.
 * `page` is the page of the report Poe said the post is about; one this droplet doesn't
 * know (a page newer than it, say) leaves the card on the whole report.
 */
export function receiveWeatherDraft(body) {
  if (!isObject(body)) return { status: 400, body: { error: 'BadRequest' } };
  const { key, momentId, text, links, page } = body;
  const id = typeof momentId === 'string' ? /^wx-(\d{1,15})$/.exec(momentId)?.[1] : null;
  if (typeof key !== 'string' || !key.trim() || key.length > 500 || !id || typeof text !== 'string' ||
      text.length > 10000 || (links != null && (!Array.isArray(links) || links.some((l) => typeof l !== 'string'))) ||
      (page != null && (typeof page !== 'string' || page.length > 64))) {
    return { status: 400, body: { error: 'BadRequest' } };
  }
  if (page != null && !weatherPageOf(page)) logger.warn('weather draft named a page this droplet doesn\'t know', { momentId, page });
  let claimed;
  try {
    claimed = db.prepare(`UPDATE weather_post SET status = 'drafted', draft_key = ?, draft_text = ?, page = ?, updated_at = ?
      WHERE id = ? AND status = 'dispatched'`).run(key.trim(), text, weatherPageOf(page), nowIso(), Number(id)).changes > 0;
  } catch (err) {
    if (!/UNIQUE/i.test(err.message)) throw err;
    claimed = false;   // the same draft delivered twice
  }
  if (!claimed) return { status: 200, body: { ok: true, ignored: true } };
  return { status: 200, body: { ok: true }, id: Number(id) };
}

/**
 * Gate a stored draft and, when allowed, post it. Never throws; each outcome is
 * the row's status. Safe to call twice: only a `drafted` row is processed.
 */
export async function handleWeatherDraft(id, deps = defaultDeps) {
  const row = getRow(id);
  if (row?.status !== 'drafted') return;
  const draft = String(row.draft_text ?? '').trim();
  const page = weatherPageOf(row.page);
  const log = { id, kind: row.kind, subject: row.subject, ...(page ? { page } : {}) };

  if (isSkip(draft)) {
    if (!finish(id, 'skipped', { detail: draft.replace(/^skip\s*[:\-–—.!]?\s*/i, '').slice(0, 300) || null }, 'drafted')) return;
    logger.info('Poe skipped a weather moment', { ...log, why: draft });
    return;
  }

  const g = gates();
  const last = db.prepare(`SELECT post_text FROM weather_post WHERE status = 'posted' ORDER BY posted_at DESC LIMIT 1`).get();
  const verdict = evaluateWeatherDraft(draft, { gates: g, killSwitch: killSwitchEngaged, lastPostText: last?.post_text ?? null });
  if (!verdict.ok) {
    if (!finish(id, 'rejected', { gate: verdict.gate, detail: verdict.detail }, 'drafted')) return;
    logger.warn('weather draft rejected', { ...log, gate: verdict.gate, detail: verdict.detail, draft });
    return;
  }
  const text = faceRules(verdict.text, { maxGraphemes: g.faceMaxGraphemes });

  if (config.weather.mode !== 'post' || config.stage < 4) {
    if (!finish(id, 'held', { gate: 'draft_mode', post_text: text }, 'drafted')) return;
    logger.info('weather draft held (WEATHER_POSTS is not post, or stage < 4)', { ...log, draft: text });
    return;
  }
  if (isNapping()) {
    finish(id, 'rejected', { gate: 'nap', post_text: text }, 'drafted');
    return;
  }
  const capped = postGate(recentRows(Date.now()), Date.now(), g);
  if (capped) {
    if (!finish(id, 'rejected', { gate: capped, post_text: text }, 'drafted')) return;
    logger.info('weather draft over the caps', { ...log, gate: capped });
    return;
  }

  // The card before anything is claimed: without it the draft stays drafted, and the
  // next tick (settle) tries again, until CARD_WAIT_MS has passed since it came in.
  let thumb;
  try {
    const card = await deps.fetchCard(freshCardUrl(WEATHER_CARD, row.kind, Date.now(), page));
    thumb = await deps.uploadBlob(card.bytes, card.mimeType);
  } catch (err) {
    if (Date.now() - Date.parse(row.updated_at) < CARD_WAIT_MS) {
      logger.warn('weather card not ready; the post waits for it', { ...log, error: err.message });
      return;
    }
    if (finish(id, 'rejected', { gate: 'no_card', detail: err.message, post_text: text }, 'drafted')) {
      logger.warn('weather post dropped: no weather card', { ...log, error: err.message });
    }
    return;
  }

  // The key first, so a post whose fate a crash leaves unknown is found, not repeated.
  const rkey = nextTid();
  if (!db.prepare(`UPDATE weather_post SET status = 'posting', post_rkey = ?, post_text = ?, updated_at = ?
    WHERE id = ? AND status = 'drafted'`).run(rkey, text, nowIso(), id).changes) return;

  // The page only for the card's words; its image is never used (WEATHER_CARD).
  const pageUrl = weatherPageUrl(page);
  let html = null;
  try {
    const res = await deps.fetchPage(pageUrl);
    if (res.status === 200) html = res.html;
  } catch (err) {
    logger.warn('weather page unreachable for the card', { page: pageUrl, error: err.message });
  }
  const record = buildAnnouncement({
    text,
    pageUrl,
    title: (html && ogContent(html, 'og:title')) || CARD_TITLE,
    description: (html && ogContent(html, 'og:description')) || CARD_DESCRIPTION,
    thumb,
  });
  try {
    const res = await deps.createPost(record, rkey);
    finish(id, 'posted', { post_uri: res.uri, post_cid: res.cid, posted_at: nowIso() }, 'posting');
    logger.info('weather post posted', { ...log, uri: res.uri, url: postUrl(res.uri) });
  } catch (err) {
    finish(id, 'post_failed', { detail: err.message }, 'posting');
    logger.error('weather post failed', { ...log, rkey, error: err.message });
  }
}

// --- the watcher ------------------------------------------------------------------

export function startWeatherWatch() {
  const w = config.weather;
  if (w.mode === 'off') return null;
  if (config.stage < 3 || !config.agentUrl || !config.sharedSecret) {
    logger.warn('weather posts disabled: they need stage 3 or higher and the agent', { mode: w.mode, stage: config.stage });
    return null;
  }
  if (!config.callbackUrl) logger.warn('weather posts: DROPLET_CALLBACK_URL is unset, so no draft can come back');
  if (w.mode === 'post' && config.stage < 4) logger.warn('WEATHER_POSTS=post below stage 4: every draft is held');
  logger.info('weather watch starting', { mode: w.mode, pollMs: w.pollMs, api: w.apiBase });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await weatherTick();
      if (!result.asked) logger.debug('weather tick', result);
    } catch (err) {
      logger.error('weather tick failed', { error: err.message });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 30000);
  first.unref?.();
  const timer = setInterval(tick, w.pollMs);
  timer.unref?.();
  return timer;
}
