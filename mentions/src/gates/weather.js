// gates/weather.js
// Every decision about Poe's weather posts (weather-posts.js), in code: which
// moments in the weather station's readings are worth asking Poe about, how often
// it may be asked and may post, and whether its draft is safe to post. Poe
// decides whether a moment is worth a post and what to say; these decide whether
// it gets the chance, and whether what it said goes out.
//
// No inbound post is involved, but the readings carry other people's text: an
// app's name is whatever namespace somebody wrote records under. Those reach Poe
// only as validated domains, and the draft goes through the same outbound gates
// as a reply, with a stricter link rule: the weather page, or nothing.

import { evaluateOutbound } from './outbound.js';

/** The one link a weather post may carry. Its card links it whatever the text says. */
export const WEATHER_PAGE = 'https://atpota.to/weather';

/** Every kind of moment, most newsworthy first: when two are due at once, the first is asked about. */
export const MOMENT_KINDS = ['storm', 'unusual', 'new_app', 'mixed', 'daily'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/**
 * Statuses that mean Poe was asked (or is being asked) about a moment. Only
 * `failed`, the agent never taking it, leaves the moment open to ask again; a
 * post that failed (`post_failed`) may have gone out, so it is never redone.
 */
const ASKED = new Set(['dispatched', 'drafted', 'skipped', 'held', 'rejected', 'posting', 'posted', 'post_failed', 'expired']);

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcHour = (ms) => new Date(ms).toISOString().slice(0, 13);
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The moments due in this reading, most newsworthy first, before any cap or
 * cooldown. `reading` is the last 60 seconds (/api/atmosphere), `almanac` today
 * against usual (/api/weather-almanac), both already checked field by field;
 * either may be null. Each moment is { kind, subject, trigger }: `subject` says
 * what it is about (a UTC date, an hour, an app) so the same thing is asked
 * about once.
 */
export function dueMoments({ reading, almanac, nowMs, gates: g }) {
  const kinds = new Set(Array.isArray(g.weatherKinds) ? g.weatherKinds : []);
  const out = [];
  // The live readings count only when they come from the station: a website
  // sample is a few seconds of the firehose, too short to call a storm on.
  const live = reading?.source === 'station' ? reading : null;

  if (kinds.has('storm') && live?.condition === 'stormy') {
    out.push({ kind: 'storm', subject: utcHour(nowMs), trigger: { perSecond: live.perSecond, condition: live.condition } });
  }

  const hour = almanac?.lastHour;
  if (kinds.has('unusual') && hour && hour.usualPerSecond > 0) {
    const ratio = hour.perSecond / hour.usualPerSecond;
    const direction = ratio >= g.weatherUnusualBusier ? 'busier' : ratio <= g.weatherUnusualQuieter ? 'quieter' : null;
    if (direction) {
      out.push({
        kind: 'unusual',
        subject: `${utcHour(nowMs)}:${direction}`,
        trigger: { direction, percent: Math.round((ratio - 1) * 100), ...hour },
      });
    }
  }

  const fresh = (almanac?.newApps ?? [])
    .filter((a) => a.records >= g.weatherNewAppMinRecords && nowMs - Date.parse(a.firstSeen) <= DAY)
    .sort((a, b) => b.records - a.records);
  if (kinds.has('new_app')) {
    for (const app of fresh) out.push({ kind: 'new_app', subject: app.domain, trigger: { app } });
  }

  if (kinds.has('mixed') && live?.diversity && live.diversity.index >= g.weatherMixedMinIndex) {
    out.push({ kind: 'mixed', subject: utcHour(nowMs), trigger: { diversity: live.diversity } });
  }

  if (kinds.has('daily') && Number.isInteger(g.weatherDailyHourUtc) &&
      new Date(nowMs).getUTCHours() >= g.weatherDailyHourUtc && (live || almanac?.today)) {
    out.push({ kind: 'daily', subject: utcDate(nowMs), trigger: {} });
  }
  return out;
}

/** The cooldown for a kind, in hours: one more of it is not news until this has passed. */
function cooldownHours(kind, g) {
  return {
    storm: g.weatherStormCooldownHours,
    unusual: g.weatherUnusualCooldownHours,
    mixed: g.weatherMixedCooldownHours,
    new_app: g.weatherNewAppCooldownHours,
    daily: 0,
  }[kind] ?? 0;
}

const within = (at, ms, nowMs) => !!at && nowMs - Date.parse(at) < ms;

/**
 * Whether one more weather post may go out now, and if not, why. Checked before
 * Poe is asked and again right before posting. `rows` is the weather_post
 * history (at least the last day's), each { kind, subject, status, created_at,
 * updated_at, posted_at }. A draft held in draft mode counts as the post it would
 * have been, so draft mode shows the cadence posting would have.
 */
export function postGate(rows, nowMs, g) {
  const went = rows.flatMap((r) => (r.status === 'posted' ? [r.posted_at] : r.status === 'held' ? [r.updated_at] : []));
  if (went.filter((t) => within(t, DAY, nowMs)).length >= g.weatherPostsPerDay) return 'posts_per_day';
  if (went.some((t) => within(t, g.weatherMinGapMin * 60_000, nowMs))) return 'min_gap';
  return null;
}

/** Whether Poe may be asked about anything right now, and if not, why. */
export function askGate(rows, nowMs, g) {
  if (rows.some((r) => r.status === 'dispatched' || r.status === 'drafted' || r.status === 'posting')) {
    return 'in_flight';
  }
  const capped = postGate(rows, nowMs, g);
  if (capped) return capped;
  if (rows.filter((r) => ASKED.has(r.status) && within(r.created_at, DAY, nowMs)).length >= g.weatherAsksPerDay) {
    return 'asks_per_day';
  }
  // The agent didn't take the last one: give it a while before trying again.
  const last = rows.reduce((a, r) => (!a || r.created_at > a.created_at ? r : a), null);
  if (last?.status === 'failed' && within(last.created_at, 15 * 60_000, nowMs)) return 'agent_backoff';
  return null;
}

/** The first due moment Poe hasn't been asked about and whose kind isn't cooling down, or null. */
export function pickMoment(due, rows, nowMs, g) {
  for (const m of due) {
    const asked = rows.filter((r) => r.kind === m.kind && ASKED.has(r.status));
    if (asked.some((r) => r.subject === m.subject)) continue;
    const hours = cooldownHours(m.kind, g);
    if (hours > 0 && asked.some((r) => nowMs - Date.parse(r.created_at) < hours * HOUR)) continue;
    return m;
  }
  return null;
}

/**
 * Poe declining the moment: "skip", or "skip: why", and nothing else. Narrow on
 * purpose, so a post that happens to start with the word is still a post.
 */
export function isSkip(text) {
  const t = String(text ?? '').trim();
  return /^skip[.!]?$/i.test(t) || (t.length <= 300 && /^skip\s*[:\-–—]/i.test(t));
}

/**
 * Whether a draft is safe to post: the reply gates (markdown, non-answers, length,
 * @handles, links) for a single post, with no @handle allowed at all and no link
 * but the weather page, plus not repeating the last weather post.
 */
export function evaluateWeatherDraft(draft, { gates: g, killSwitch, lastPostText = null }) {
  return evaluateOutbound(draft, {
    gates: { ...g, maxPosts: 1, maxLinks: 1 },
    replyingToDid: null,
    replyingToHandle: null,
    botHandle: null,
    lastReplyText: lastPostText,
    allowedLinks: new Set([WEATHER_PAGE]),
    killSwitch,
  });
}

/** Records a second over a span, one decimal. */
export const perSecond = (n, seconds) => (seconds > 0 ? round1(n / seconds) : 0);
