/**
 * The Atmosphere's weather, as the weather report at atpota.to/weather tells it: how
 * many new records a second the whole network writes, how much of the network isn't
 * Bluesky (the diversity index: the share of active accounts writing elsewhere, scaled by
 * how many apps they're spread across), which apps are busiest, and how it compares
 * with usual. Not the weather outside.
 *
 * The numbers come from the weather station (atmosphere/ in this repo), an always-on
 * firehose counter on the droplet, through atpota.to's own public endpoints, the ones
 * the page reads:
 *
 *   /api/atmosphere               the last 60 seconds
 *   /api/weather-history?range=   day | week | month, from the station's rows
 *   /api/weather-almanac?tz=      today's high and low, the last hour against usual,
 *                                 apps heard for the first time, the week as a heat map
 *   /api/weather-span?span=hour   the last hour against the hour before: feels like,
 *                                 gusts, humidity, visibility, active accounts
 *   /api/weather-forecast         the next 12 hours, the network's sunrise and sunset,
 *                                 and how good the forecast has been
 *
 * And where the atmosphere lives: the PDS hosts, from the station's census of the relay's
 * list every 10 minutes (`hosts` on /api/atmosphere), with their history and the PLC
 * directory's day by day (sign-ups, accounts moving house, air quality; `hosts` on
 * /api/weather-history).
 *
 * No credentials, and nothing here can write. The website checks every field first;
 * this checks again (app names are someone else's text) and does the arithmetic, so the
 * model gets rates, percentages and comparisons instead of hundreds of raw rows.
 *
 * Coverage is part of every answer. The station only reports what it heard, and a week
 * it heard half of is half a week, so `heardPercent` says how much, and a comparison is
 * left out when either side is too thin to say. Each part is read on its own; one that
 * fails is named in `unavailable` and the rest still comes back.
 *
 * tools/read_weather.ts hands these to the model.
 */

export const WEATHER_PAGE = "https://atpota.to/weather";
const API = "https://atpota.to/api";
const FETCH_MS = 6_000;
const MAX_BYTES = 1_000_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** How long the station listens before an outlook means anything: one of every hour of the week. */
const OUTLOOK_MIN_SECONDS = 6 * 86_400;
const TOP = 10;
/**
 * The station has listened live since this; before, its days came from Jetstream's
 * archive, which keeps few edits and so hears fewer accounts outside Bluesky. Their
 * diversity index isn't comparable with a live day's (website/server/weather-almanac.ts
 * LIVE_SINCE, the same date).
 */
const LIVE_SINCE = Date.parse("2026-10-20T16:50:00Z");

/**
 * The weather words, as the website and the station have them (website/server/atmosphere.ts
 * and atmosphere/src/atmosphere.js; change all three together). New records a second,
 * every app, at which each condition starts, and the diversity index at which each level
 * starts. tests/weather.test.mjs checks these against the website's.
 */
export const CONDITIONS = [["stormy", 600], ["gusty", 500], ["breezy", 400], ["light", 300]] as const;
export const DIVERSITY_LEVELS = [["extreme", 11], ["very high", 8], ["high", 6], ["moderate", 3]] as const;

export type Condition = "calm" | (typeof CONDITIONS)[number][0];
export type DiversityLevel = "low" | (typeof DIVERSITY_LEVELS)[number][0];
export type Report = "now" | "today" | "week" | "hosts" | "forecast";

export function conditionFor(perSecond: number): Condition {
  for (const [name, from] of CONDITIONS) if (perSecond >= from) return name;
  return "calm";
}

export function diversityLevel(index: number): DiversityLevel {
  for (const [name, from] of DIVERSITY_LEVELS) if (index >= from) return name;
  return "low";
}

// ---------- checking what came back ----------

const DOMAIN_RE = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}$/;
const NSID_RE = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62}){1,}\.[a-z][a-z0-9]{0,62}$/i;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** A count: sums of numeric arrive as numbers or strings. null if it isn't one. */
function count(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function counts<K extends string>(x: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(x)) return null;
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const n = count(x[k]);
    if (n === null) return null;
    out[k] = n;
  }
  return out;
}

function iso(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const domainOf = (x: unknown): string | null => (typeof x === "string" && DOMAIN_RE.test(x) ? x : null);

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A PDS's hostname, checked (someone else's text). */
const hostnameOf = (x: unknown): string | null => (typeof x === "string" && HOSTNAME_RE.test(x) ? x : null);

/** Up to three collection names that look like NSIDs. */
const collectionsOf = (x: unknown): string[] =>
  list(x).filter((c): c is string => typeof c === "string" && c.length <= 253 && NSID_RE.test(c)).slice(0, 3);

/** An IANA time zone this runtime knows, or null. */
export function timeZoneOf(raw: string | undefined): string | null {
  const tz = raw?.trim() || "UTC";
  if (tz.length > 64 || !TZ_RE.test(tz)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// ---------- arithmetic ----------

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Records a second, one decimal. */
const rate = (n: number, seconds: number) => (seconds > 0 ? round1(n / seconds) : 0);

/** The percent of new records written outside Bluesky, two decimals (it is often under one). */
const indexOf = (elsewhere: number, creates: number) => (creates > 0 ? round2((100 * elsewhere) / creates) : 0);

/** How much of a span the station heard, in percent; a sliver keeps a decimal, so it never reads as nothing. */
function heardPercent(seconds: number, spanMs: number): number {
  const pct = spanMs > 0 ? Math.min(100, (seconds * 100_000) / spanMs) : 0;
  return pct < 1 ? round1(pct) : Math.round(pct);
}

const changePercent = (now: number, before: number) => Math.round((now / before - 1) * 100);

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const UTC_WEEKDAYS = ["sunday", ...WEEKDAYS.slice(0, 6)];

function local(ms: number, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(ms).toLowerCase();
}

/** "thursday, oct 15, 15:00" in `tz`. */
const hourAt = (t: string, tz: string) =>
  local(Date.parse(t), tz, { weekday: "long", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** How an app did against an earlier window, by rate, in words. null when the earlier window is too thin to say. */
function appChange(creates: number, prevCreates: number, seconds: number, prevSeconds: number, earlier: string): string | null {
  if (seconds <= 0 || prevSeconds < seconds * 0.5) return null;
  if (prevCreates === 0) return `new: none at all ${earlier}`;
  return percentWords(changePercent(creates / seconds, prevCreates / prevSeconds), earlier);
}

/** Accounts don't scale with time, so only when both windows were heard about as well. */
function accountChange(active: number, prevActive: number, seconds: number, prevSeconds: number, earlier: string): string | null {
  if (seconds <= 0 || prevSeconds < seconds * 0.9 || prevSeconds > seconds * 1.1) return null;
  if (prevActive === 0) return `new: nobody at all ${earlier}`;
  return percentWords(changePercent(active, prevActive), earlier);
}

function percentWords(pct: number, earlier: string): string {
  if (pct >= 15) return `up ${Math.min(pct, 999)}% on ${earlier}`;
  if (pct <= -15) return `down ${-pct}% on ${earlier}`;
  return `about the same as ${earlier}`;
}

/** A diversity index against an earlier one, as the weather page words it. */
function mixWords(index: number, before: number, earlier: string): string | null {
  if (before <= 0) return null;
  const mix = index / before;
  if (mix >= 1.3) return `a more mixed sky than ${earlier}`;
  if (mix <= 0.77) return `a little less mixed than ${earlier}`;
  return `about as mixed as ${earlier}`;
}

const mean = (xs: number[]) => round2(xs.reduce((sum, x) => sum + x, 0) / xs.length);

// ---------- fetching ----------

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, path: string): Promise<unknown> {
  const res = await fetchImpl(`${API}/${path}`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`status ${res.status}`);
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("response too large");
  return JSON.parse(text);
}

// ---------- now: the last 60 seconds ----------

export function nowReport(body: unknown, span?: unknown) {
  if (!isRecord(body)) return null;
  const measuredAt = iso(body.measuredAt);
  const seconds = count(body.seconds);
  const records = counts(body.records, ["perSecond", "bluesky", "elsewhere"] as const);
  const perSecond = counts(body.perSecond, ["posts", "likes", "reposts", "follows"] as const);
  const diversity = counts(body.diversity, ["index", "apps", "collections"] as const);
  if (!measuredAt || !seconds || !records || !perSecond || !diversity) return null;
  const parts = counts(body.diversity, ["share", "spread"] as const);
  const events = counts(body.events, ["updates", "deletes", "identity", "account"] as const);
  const apps = list(body.apps).flatMap((a) => {
    const domain = isRecord(a) ? domainOf(a.domain) : null;
    const c = counts(a, ["perSecond", "count"] as const);
    return domain && c && isRecord(a) ? [{ domain, perSecond: c.perSecond, records: c.count, collections: collectionsOf(a.collections) }] : [];
  }).slice(0, TOP);
  const a = counts(body.accounts, ["active", "bluesky", "elsewhere", "index"] as const);
  const accounts = a && isRecord(body.accounts)
    ? {
      active: a.active,
      bluesky: a.bluesky,
      elsewhere: a.elsewhere,
      indexPercent: Math.min(a.index, 100),
      apps: list(body.accounts.apps).flatMap((x) => {
        const domain = isRecord(x) ? domainOf(x.domain) : null;
        const n = isRecord(x) ? count(x.accounts) : null;
        return domain && n !== null ? [{ domain, accounts: n }] : [];
      }).slice(0, TOP),
    }
    : undefined;
  return {
    report: "now" as const,
    page: WEATHER_PAGE,
    measuredAt,
    seconds,
    // "sample": the station was out of reach, so the website listened to a few seconds of the firehose itself
    source: body.source === "station" ? "station" : "sample",
    condition: conditionFor(records.perSecond),
    records: { perSecond: records.perSecond, blueskyPerSecond: records.bluesky, elsewherePerSecond: records.elsewhere },
    bluesky: { postsPerSecond: perSecond.posts, likesPerSecond: perSecond.likes, repostsPerSecond: perSecond.reposts, followsPerSecond: perSecond.follows },
    ...(events ? { events: { updatesPerSecond: events.updates, deletesPerSecond: events.deletes, identityPerSecond: events.identity, accountPerSecond: events.account } } : {}),
    diversity: {
      index: diversity.index,
      level: diversityLevel(diversity.index),
      // what the index is made of: the percent of active accounts that wrote elsewhere, and how many apps' worth they're spread across
      ...(parts ? { accountSharePercent: Math.min(parts.share, 100), spreadAcrossApps: round1(parts.spread) } : {}),
      apps: diversity.apps,
      collections: diversity.collections,
    },
    apps,
    ...(accounts ? { accounts } : {}),
    ...hostsBrief(body.hosts),
    ...(() => {
      const lastHour = span === undefined ? null : lastHourOf(span);
      return lastHour ? { lastHour } : {};
    })(),
  };
}

/** The live census, short, for the reports that aren't about hosts (report "hosts" has the rest). */
function hostsBrief(x: unknown) {
  const h = hostsNowOf(x);
  if (!h) return {};
  return {
    hosts: {
      activeHosts: h.activeHosts,
      independentHosts: h.independentHosts,
      hostingDiversity: h.hostingDiversity,
      ...(h.wroteLately ? { wroteLately: h.wroteLately } : {}),
      more: 'report "hosts" has the whole census, sign-ups, accounts moving house and air quality',
    },
  };
}

// ---------- the station's rows (/api/weather-history) ----------

const POINT_KEYS = ["creates", "bluesky", "elsewhere", "posts", "likes", "reposts", "follows", "updates", "deletes", "identity", "account"] as const;
export type Point = { t: string; seconds: number; steady?: number } & Record<(typeof POINT_KEYS)[number], number>;
/** Active accounts, and the diversity index they make when the website sent it. */
type AccountTotals = { active: number; bluesky: number; elsewhere: number; index?: number };

/** `c` with the index on `x`, when there is one. */
function withIndex<T extends object>(x: unknown, c: T): T & { index?: number } {
  const index = isRecord(x) ? count(x.index) : null;
  return index === null ? c : { ...c, index };
}

function toPoint(x: unknown): Point | null {
  if (!isRecord(x)) return null;
  const t = iso(x.t);
  const seconds = count(x.seconds);
  const c = counts(x, POINT_KEYS);
  const steady = count(x.steady);
  return t && seconds && c ? { t, seconds, ...c, ...(steady === null ? {} : { steady }) } : null;
}

/** An hour that ran far past its steady count: one app's bulk import, mostly (website/server/weather-history.ts). */
type Burst = { t: string; records: number; app?: { domain: string; minute: string; records: number; collections: string[] } };

function toBurst(x: unknown): Burst | null {
  const t = isRecord(x) ? iso(x.t) : null;
  const records = isRecord(x) ? count(x.records) : null;
  if (!isRecord(x) || !t || records === null) return null;
  const a = isRecord(x.app) ? x.app : null;
  const domain = a ? domainOf(a.domain) : null;
  const minute = a ? iso(a.minute) : null;
  const appRecords = a ? count(a.records) : null;
  return domain && minute && appRecords !== null
    ? { t, records, app: { domain, minute, records: appRecords, collections: collectionsOf(a!.collections) } }
    : { t, records };
}

export function parseHistory(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.points)) return null;
  const points = body.points.map(toPoint).filter((p): p is Point => p !== null);
  const compare = counts(body.compare, ["seconds", "prevSeconds"] as const);
  const apps = Array.isArray(body.apps)
    ? body.apps.flatMap((a) => {
      const domain = isRecord(a) ? domainOf(a.domain) : null;
      const c = counts(a, ["creates", "prevCreates"] as const);
      return domain && c && isRecord(a) ? [{ domain, ...c, collections: collectionsOf(a.collections) }] : [];
    }).slice(0, TOP)
    : null;
  const appsOverTime = isRecord(body.appsOverTime)
    ? list(body.appsOverTime.points).flatMap((p) => {
      const t = isRecord(p) ? iso(p.t) : null;
      const n = isRecord(p) ? count(p.apps) : null;
      return t && n !== null ? [{ t, apps: n }] : [];
    })
    : null;
  let accounts: {
    seconds: number; prevSeconds: number; total: AccountTotals;
    /** Everyone in the earlier window, when the station kept their sketches, with the seconds those cover. */
    prev?: { seconds: number } & AccountTotals;
    points: ({ t: string; seconds: number } & AccountTotals)[];
    apps: { domain: string; active: number; prevActive: number; collections: string[] }[];
  } | null = null;
  const acc = isRecord(body.accounts) ? body.accounts : null;
  const accCover = counts(acc, ["seconds", "prevSeconds"] as const);
  const accTotal = counts(acc?.total, ["active", "bluesky", "elsewhere"] as const);
  const accPrev = counts(acc?.prev, ["seconds", "active", "bluesky", "elsewhere"] as const);
  if (acc && accCover && accTotal) {
    accounts = {
      ...accCover,
      total: withIndex(acc?.total, accTotal),
      ...(accPrev ? { prev: withIndex(acc.prev, accPrev) } : {}),
      points: list(acc.points).flatMap((p) => {
        const t = isRecord(p) ? iso(p.t) : null;
        const c = counts(p, ["seconds", "active", "bluesky", "elsewhere"] as const);
        return t && c ? [withIndex(p, { t, ...c })] : [];
      }),
      apps: list(acc.apps).flatMap((a) => {
        const domain = isRecord(a) ? domainOf(a.domain) : null;
        const c = counts(a, ["active", "prevActive"] as const);
        return domain && c && isRecord(a) ? [{ domain, ...c, collections: collectionsOf(a.collections) }] : [];
      }).slice(0, TOP),
    };
  }
  const bursts = list(body.bursts).map(toBurst).filter((b): b is Burst => b !== null).slice(0, TOP);
  return { points, compare, apps, appsOverTime, accounts, bursts };
}

type History = NonNullable<ReturnType<typeof parseHistory>>;

export function sumPoints(points: Point[]): Point {
  const total = { t: points[0]?.t ?? "", seconds: 0 } as Point;
  for (const k of POINT_KEYS) total[k] = 0;
  for (const p of points) {
    total.seconds += p.seconds;
    for (const k of POINT_KEYS) total[k] += p[k];
  }
  // only when every point has one, or it would come up short
  if (points.length && points.every((p) => p.steady !== undefined)) total.steady = points.reduce((n, p) => n + p.steady!, 0);
  return total;
}

/**
 * The records that make the weather: new records with any burst left out, when the station
 * sent that (`steady`: no minute counts for more than 3 times its hour's median minute),
 * else all of them. One app's bulk import is in the record counts, not in the sky.
 */
const busy = (p: { creates: number; steady?: number }) => p.steady ?? p.creates;

/** A stretch of the station's rows, in weather words. */
function weatherOf(p: { seconds: number; creates: number; steady?: number }) {
  const perSecond = rate(busy(p), p.seconds);
  return { perSecond, condition: conditionFor(perSecond) };
}

/** The diversity index over a range, with its level, from the range's accounts (none without them). */
function diversityOf(a: { index?: number } | undefined) {
  return a?.index === undefined ? {} : { diversityIndex: a.index, diversityLevel: diversityLevel(a.index) };
}

/**
 * The diversity index against the earlier window's, as the weather page words it: only when
 * the station heard both about as well, like the apps' accounts.
 */
function mixOf(h: History, earlier: string) {
  const a = h.accounts;
  const was = a?.prev;
  if (!a || a.total.index === undefined || was?.index === undefined || a.seconds <= 0) return {};
  if (was.seconds < a.seconds * 0.9 || was.seconds > a.seconds * 1.1) return {};
  const mix = mixWords(a.total.index, was.index, earlier);
  return mix ? { diversityIndexBefore: was.index, mix } : {};
}

/** The busiest apps outside Bluesky over a range, each against the window before it. */
function appsOf(h: History, total: Point, earlier: string) {
  return (h.apps ?? []).map((a) => {
    const change = h.compare ? appChange(a.creates, a.prevCreates, h.compare.seconds, h.compare.prevSeconds, earlier) : null;
    return {
      domain: a.domain,
      records: a.creates,
      // its share of everything written outside Bluesky
      sharePercent: total.elsewhere > 0 ? round1((100 * a.creates) / total.elsewhere) : 0,
      ...(change ? { change } : {}),
      collections: a.collections,
    };
  });
}

function accountsOf(h: History, spanMs: number, earlier: string) {
  const a = h.accounts;
  if (!a || a.seconds <= 0) return null;
  return {
    active: a.total.active,
    bluesky: a.total.bluesky,
    elsewhere: a.total.elsewhere,
    heardPercent: heardPercent(a.seconds, spanMs),
    apps: a.apps.map((x) => {
      const change = accountChange(x.active, x.prevActive, a.seconds, a.prevSeconds, earlier);
      return { domain: x.domain, accounts: x.active, ...(change ? { change } : {}), collections: x.collections };
    }),
  };
}

/** The busiest and quietest hours the station heard at least half of. */
function extremes(points: Point[], tz: string) {
  const heard = points.filter((p) => p.seconds >= 1800);
  if (!heard.length) return {};
  const byRate = [...heard].sort((a, b) => busy(b) / b.seconds - busy(a) / a.seconds);
  const describe = (p: Point) => ({ hour: hourAt(p.t, tz), ...weatherOf(p) });
  return { busiestHour: describe(byRate[0]!), quietestHour: describe(byRate[byRate.length - 1]!) };
}

// ---------- the almanac (/api/weather-almanac) ----------

const SUMS = ["seconds", "posts", "creates", "elsewhere"] as const;

export function parseAlmanac(body: unknown) {
  if (!isRecord(body)) return null;
  const today = (() => {
    const t = body.today;
    const sums = counts(t, SUMS);
    const start = isRecord(t) ? iso(t.start) : null;
    if (!isRecord(t) || !sums || !start) return null;
    const extreme = (x: unknown) => {
      const minute = isRecord(x) ? iso(x.minute) : null;
      const c = counts(x, ["perSecond"] as const);
      return minute && c ? { minute, perSecond: c.perSecond } : null;
    };
    return { start, ...sums, high: extreme(t.high), low: extreme(t.low) };
  })();
  const normal = (() => {
    const n = body.normal;
    if (!isRecord(n)) return null;
    const now = counts(n.now, SUMS);
    const days = counts(n.days, [...SUMS, "windows"] as const);
    const weeks = counts(n.weeks, [...SUMS, "windows"] as const);
    if (!now || !days || !weeks) return null;
    // the diversity index of the last whole hour, and on average of the same hour on the days and weeks before
    const d = isRecord(n.diversity) ? n.diversity : null;
    const dNow = counts(d?.now, ["index", "elsewhere"] as const);
    const dDays = counts(d?.days, ["windows", "index"] as const);
    const dWeeks = counts(d?.weeks, ["windows", "index"] as const);
    const hour = d ? iso(d.hour) : null;
    const diversity = hour && dNow && dDays && dWeeks ? { hour, now: dNow, days: dDays, weeks: dWeeks } : null;
    return { historyStart: iso(n.historyStart), now, days, weeks, diversity };
  })();
  const newApps = (() => {
    const n = body.newApps;
    if (!isRecord(n) || typeof n.warmingUp !== "boolean") return null;
    return {
      warmingUp: n.warmingUp,
      readyAt: iso(n.readyAt),
      heard: count(n.heard),
      apps: list(n.apps).flatMap((a) => {
        const domain = isRecord(a) ? domainOf(a.domain) : null;
        const firstSeen = isRecord(a) ? iso(a.firstSeen) : null;
        const c = counts(a, ["creates"] as const);
        return domain && firstSeen && c && isRecord(a) ? [{ domain, firstSeen, records: c.creates, collections: collectionsOf(a.collections) }] : [];
      }).slice(0, TOP),
    };
  })();
  const heatmap = (() => {
    const h = body.heatmap;
    const total = counts(h, ["seconds"] as const);
    if (!isRecord(h) || !total) return null;
    const cells = list(h.cells).flatMap((c) => {
      const v = counts(c, ["dow", "hour", "seconds", "posts", "creates"] as const);
      const steady = isRecord(c) ? count(c.steady) : null;
      return v && Number.isInteger(v.dow) && v.dow >= 1 && v.dow <= 7 && Number.isInteger(v.hour) && v.hour <= 23
        ? [steady === null ? v : { ...v, steady }]
        : [];
    });
    return { seconds: total.seconds, cells };
  })();
  return { today, normal, newApps, heatmap };
}

type Almanac = NonNullable<ReturnType<typeof parseAlmanac>>;

/** The last hour against usual, as the weather page has it (website/src/scripts/weather-almanac.ts). */
function usualOf(normal: NonNullable<Almanac["normal"]>, now: number, tz: string) {
  const basis = normal.weeks.windows > 0 ? "weeks" : normal.days.windows > 0 ? "days" : null;
  if (!basis || normal.now.seconds < 1800) {
    return { ready: false as const, listeningSince: normal.historyStart, reason: "the station is still learning what usual looks like: after a day it compares with this time yesterday, and after a week with the same weekday" };
  }
  const base = normal[basis];
  const lastHour = rate(normal.now.creates, normal.now.seconds);
  const usual = rate(base.creates, base.seconds);
  const ratio = usual > 0 ? lastHour / usual : 1;
  const how = ratio >= 1.25 ? "much busier than usual" : ratio >= 1.08 ? "busier than usual" : ratio <= 0.8 ? "much quieter than usual" : ratio <= 0.93 ? "quieter than usual" : "about as busy as usual";
  const weekday = local(now, tz, { weekday: "long" });
  const comparedWith = basis === "weeks"
    ? base.windows === 1 ? `this hour last ${weekday}` : `this hour on the last ${base.windows} ${weekday}s`
    : base.windows === 1 ? "this hour yesterday" : `this hour on the last ${base.windows} days`;
  // the diversity index goes by the hour (the last whole one), against the same hours as the records
  const d = normal.diversity;
  const was = d?.[basis];
  const diversity = d && was && was.windows > 0 && d.now.elsewhere >= 50
    ? { hour: hourAt(d.hour, tz), index: d.now.index, usualIndex: was.index, mix: mixWords(d.now.index, was.index, "usual") }
    : null;
  return { ready: true as const, words: how, lastHourPerSecond: lastHour, usualPerSecond: usual, comparedWith, ...(diversity ? { diversity } : {}) };
}

function newAppsOf(n: NonNullable<Almanac["newApps"]>) {
  return n.warmingUp
    ? { warmingUp: true, readyAt: n.readyAt, note: "until the station has listened for a week, every app is new to it, so it names none" }
    : { warmingUp: false, appsHeardOutsideBluesky: n.heard, apps: n.apps };
}

/**
 * What the station's usual week looks like, from its heat map (every hour of the week
 * in `tz` over the last 8 weeks), as the makings of a forecast: the usual weekday,
 * the busiest and quietest hours of the week, how many hours of each condition a usual
 * week has, and the apps that are on the rise. Patterns, not predictions: the model
 * writes the forecast and says so.
 */
function outlookOf(heat: NonNullable<Almanac["heatmap"]>, historyStart: string | null, risers: { domain: string; change?: string }[], tz: string) {
  const byDay = WEEKDAYS.map((weekday, i) => {
    const cells = heat.cells.filter((c) => c.dow === i + 1);
    const seconds = cells.reduce((n, c) => n + c.seconds, 0);
    return { weekday, seconds, records: cells.reduce((n, c) => n + busy(c), 0), posts: cells.reduce((n, c) => n + c.posts, 0) };
  });
  if (heat.seconds < OUTLOOK_MIN_SECONDS || byDay.some((d) => d.seconds < 12 * 3600)) {
    const readyAt = historyStart ? new Date(Date.parse(historyStart) + WEEK).toISOString() : null;
    return {
      ready: false as const,
      heardDays: round1(heat.seconds / 86_400),
      ...(readyAt ? { readyAt } : {}),
      reason: "an outlook needs the station to have heard every day of the week at least once",
    };
  }
  const hours = heat.cells.filter((c) => c.seconds >= 1800).map((c) => {
    const perSecond = rate(busy(c), c.seconds);
    return { weekday: WEEKDAYS[c.dow - 1]!, hour: `${String(c.hour).padStart(2, "0")}:00`, perSecond, condition: conditionFor(perSecond) };
  }).sort((a, b) => b.perSecond - a.perSecond);
  const conditions: Record<Condition, number> = { stormy: 0, gusty: 0, breezy: 0, light: 0, calm: 0 };
  for (const h of hours) conditions[h.condition]++;
  const usualPerSecond = rate(heat.cells.reduce((n, c) => n + busy(c), 0), heat.seconds);
  return {
    ready: true as const,
    timeZone: tz,
    heardDays: round1(heat.seconds / 86_400),
    usualPerSecond,
    weekdays: byDay.map((d) => ({ weekday: d.weekday, perSecond: rate(d.records, d.seconds), postsPerSecond: rate(d.posts, d.seconds) })),
    busiestHours: hours.slice(0, 3),
    quietestHours: hours.slice(-3).reverse(),
    // how many of a usual week's hours fall in each condition
    hoursByCondition: conditions,
    appsToWatch: risers
      .filter((a) => a.change && /^(new|up)/.test(a.change))
      .slice(0, 3)
      .map((a) => ({ domain: a.domain, change: a.change! })),
  };
}

// ---------- where the atmosphere lives: PDS hosts and identities ----------

/**
 * The independent hosts by size, as the station buckets them (atmosphere/src/hosts.js
 * SIZE_BOUNDS: 0, 1, up to 10, 100, 1,000, 10,000, more) and the weather page names them.
 */
const HOST_SIZES = ["empty", "justOnePerson", "household2to10", "village11to100", "town101to1000", "city1001to10000", "metropolis10000plus"] as const;
/** The air quality: the share of a day's sign-ups that went to hosts no relay carries (website weather-hosts.ts SMOG_LEVELS). */
const SMOG_LEVELS = [["thick smog", 90], ["smoggy", 50], ["hazy", 10]] as const;

export function smogOf(created: { bluesky: number; independent: number; unlisted: number }) {
  const all = created.bluesky + created.independent + created.unlisted;
  const percent = all > 0 ? round1((100 * created.unlisted) / all) : 0;
  return { level: SMOG_LEVELS.find(([, from]) => percent >= from)?.[0] ?? "clear", unlistedSignupsPercent: percent };
}

/** Which way accounts are moving between Bluesky's hosts and independent ones. */
export function windOf(out: number, back: number): string {
  if (out === 0 && back === 0) return "still: nobody moved between bluesky and an independent host";
  if (out === back) return "calm: as many moved back to bluesky as out of it";
  return out > back ? "blowing out of bluesky" : "blowing back to bluesky";
}

/** The live census on /api/atmosphere (`hosts`), in the page's words, or null. */
export function hostsNowOf(x: unknown) {
  if (!isRecord(x)) return null;
  const c = counts(x, ["listed", "active", "bluesky", "independent"] as const);
  const measuredAt = iso(x.measuredAt);
  const accounts = counts(x.accounts, ["bluesky", "independent"] as const);
  const d = counts(x.diversity, ["index", "share", "spread"] as const);
  if (!c || !measuredAt || !accounts || !d) return null;
  const writing = counts(x.writing, ["bluesky", "independent", "minutes"] as const);
  const statuses = counts(x.statuses, ["active", "idle", "offline", "throttled", "banned", "other"] as const);
  const sizes = Array.isArray(x.sizes) && x.sizes.length === HOST_SIZES.length ? x.sizes.map(count) : null;
  const sizeAccounts = Array.isArray(x.sizeAccounts) && x.sizeAccounts.length === HOST_SIZES.length ? x.sizeAccounts.map(count) : null;
  const biggest = list(x.top).flatMap((h) => {
    const hostname = isRecord(h) ? hostnameOf(h.hostname) : null;
    const n = isRecord(h) ? count(h.accounts) : null;
    return hostname && n !== null ? [{ hostname, accounts: n }] : [];
  }).slice(0, TOP);
  const topTen = biggest.slice(0, 10).reduce((n, h) => n + h.accounts, 0);
  return {
    countedAt: measuredAt,
    activeHosts: c.active,
    blueskyHosts: c.bluesky,
    independentHosts: c.independent,
    // every host the relay has heard of, in any state
    hostsTheRelayKnows: c.listed,
    // active hosts that sent the relay anything lately
    ...(writing ? { wroteLately: { hosts: writing.bluesky + writing.independent, independent: writing.independent, overMinutes: writing.minutes } } : {}),
    accounts: { onBlueskyHosts: accounts.bluesky, onIndependentHosts: accounts.independent },
    // like the diversity index, but by where accounts live: the percent on independent hosts, times the square root of how many hosts' worth they're spread across
    hostingDiversity: { index: d.index, accountsOnIndependentHostsPercent: d.share, spreadAcrossHosts: round1(d.spread) },
    biggestIndependentHosts: biggest,
    // how concentrated the independent side is: the share of its accounts on its ten biggest hosts
    ...(biggest.length && accounts.independent > 0 ? { biggestTenHoldPercentOfIndependentAccounts: round1((topTen / accounts.independent) * 100) } : {}),
    ...(statuses ? { relayRollCall: statuses } : {}),
    ...(sizes && sizes.every((n) => n !== null) ? { independentHostsBySize: Object.fromEntries(HOST_SIZES.map((k, i) => [k, sizes[i]])) } : {}),
    // the accounts living on hosts of each size (the page's sizes tile weighs by these)
    ...(sizeAccounts && sizeAccounts.every((n) => n !== null) ? { independentAccountsByHostSize: Object.fromEntries(HOST_SIZES.map((k, i) => [k, sizeAccounts[i]])) } : {}),
    ...(Array.isArray(x.tlds)
      ? { topLevelDomains: list(x.tlds).flatMap((t) => {
        const c2 = counts(t, ["hosts", "accounts"] as const);
        return isRecord(t) && typeof t.tld === "string" && /^[a-z0-9-]{2,63}$/.test(t.tld) && c2 ? [{ tld: `.${t.tld}`, hosts: c2.hosts, accounts: c2.accounts }] : [];
      }).slice(0, 8) }
      : {}),
  };
}

/** A day of the PLC directory's log (atmosphere_plc_day), in the page's words. */
function identityDayOf(x: unknown) {
  if (!isRecord(x) || typeof x.day !== "string" || !DAY_RE.test(x.day)) return null;
  const c = counts(x, ["createdBluesky", "createdIndependent", "createdUnlisted", "createdCustomHandle", "movedOut", "movedIn", "movedBetween", "deleted"] as const);
  if (!c) return null;
  return {
    date: x.day,
    signups: { onBlueskyHosts: c.createdBluesky, onIndependentHosts: c.createdIndependent, withOwnDomainHandle: c.createdCustomHandle },
    // of new accounts on hosts the relay carries, the percent that started outside bluesky
    ...(c.createdBluesky + c.createdIndependent > 0 ? { newAccountsStartingOutsideBlueskyPercent: round1((c.createdIndependent / (c.createdBluesky + c.createdIndependent)) * 100) } : {}),
    movingHouse: {
      outOfBluesky: c.movedOut,
      backToBluesky: c.movedIn,
      betweenIndependentHosts: c.movedBetween,
      wind: windOf(c.movedOut, c.movedIn),
      // the independent hosts movers went to, busiest first
      movedTo: list(x.destinations).flatMap((h) => {
        const hostname = isRecord(h) ? hostnameOf(h.hostname) : null;
        const n = isRecord(h) ? count(h.accounts) : null;
        return hostname && n !== null ? [{ hostname, accounts: n }] : [];
      }).slice(0, TOP),
    },
    // sign-ups on hosts no relay carries: test servers, typos, bulk sign-ups nobody relays. not the network's weather
    airQuality: { ...smogOf({ bluesky: c.createdBluesky, independent: c.createdIndependent, unlisted: c.createdUnlisted }), unlistedSignups: c.createdUnlisted },
    deletedAccounts: c.deleted,
  };
}

/** The hosts over a range on /api/weather-history (`hosts`), or null. */
export function hostHistoryOf(x: unknown) {
  if (!isRecord(x) || !Array.isArray(x.points)) return null;
  const points = list(x.points).flatMap((p) => {
    const t = isRecord(p) ? iso(p.t) : null;
    const c = counts(p, ["active", "independent", "share", "spread"] as const);
    const index = isRecord(p) ? count(p.index) : null;
    return t && c ? [{ t, ...c, index: index ?? round2(c.share * Math.sqrt(c.spread)) }] : [];
  });
  const days = list(x.daily).flatMap((d) => {
    if (!isRecord(d) || typeof d.day !== "string" || !DAY_RE.test(d.day)) return [];
    const change = typeof d.change === "number" && Number.isFinite(d.change) ? d.change : null;
    return [{
      date: d.day,
      activeHosts: count(d.active),
      changeFromDayBefore: change,
      independentHostsJoined: count(d.joined),
      independentHostsLeft: count(d.left),
      // from before the station kept hosts, estimated from the plc directory's log
      ...(d.estimated === true ? { estimated: true } : {}),
    }];
  });
  const identities = list(x.identities).map(identityDayOf).filter((d): d is NonNullable<ReturnType<typeof identityDayOf>> => d !== null);
  const byDate = new Map(identities.map((d) => [d.date, d]));
  const first = points[0];
  const last = points[points.length - 1];
  return {
    ...(typeof x.since === "string" && DAY_RE.test(x.since) ? { keptSince: x.since } : {}),
    ...(first && last && first !== last
      ? { overTheRange: { activeHosts: { from: first.active, to: last.active }, independentHosts: { from: first.independent, to: last.independent }, hostingDiversity: { from: first.index, to: last.index }, accountsOnIndependentHostsPercent: { from: first.share, to: last.share } } }
      : {}),
    newIndependentHosts: {
      count: count(x.newHosts) ?? 0,
      biggest: list(x.new).flatMap((h) => {
        const hostname = isRecord(h) ? hostnameOf(h.hostname) : null;
        const n = isRecord(h) ? count(h.accounts) : null;
        return hostname && n !== null && isRecord(h) && typeof h.first === "string" && DAY_RE.test(h.first) ? [{ hostname, accounts: n, firstSeen: h.first }] : [];
      }).slice(0, TOP),
    },
    growingFastest: list(x.growing).flatMap((h) => {
      const hostname = isRecord(h) ? hostnameOf(h.hostname) : null;
      const c = counts(h, ["accounts", "prevAccounts"] as const);
      return hostname && c ? [{ hostname, accounts: c.accounts, gained: c.accounts - c.prevAccounts }] : [];
    }).slice(0, TOP),
    // day by day (utc), each with the plc directory's sign-ups and moves when the station has them
    days: days.map((d) => ({ ...d, ...(byDate.get(d.date) ? { identities: byDate.get(d.date) } : {}) })),
    identities,
  };
}

/** Where the days' movers went, adding up each day's busiest destinations. */
function movedTo(days: NonNullable<ReturnType<typeof identityDayOf>>[]) {
  const by = new Map<string, number>();
  for (const d of days) for (const h of d.movingHouse.movedTo) by.set(h.hostname, (by.get(h.hostname) ?? 0) + h.accounts);
  return [...by].map(([hostname, accounts]) => ({ hostname, accounts })).sort((a, b) => b.accounts - a.accounts || (a.hostname < b.hostname ? -1 : 1)).slice(0, TOP);
}

/** Sign-ups, moves and deletions summed over identity days. */
function identityTotals(days: NonNullable<ReturnType<typeof identityDayOf>>[]) {
  const sum = (f: (d: (typeof days)[number]) => number) => days.reduce((n, d) => n + f(d), 0);
  const out = sum((d) => d.movingHouse.outOfBluesky);
  const back = sum((d) => d.movingHouse.backToBluesky);
  const created = { bluesky: sum((d) => d.signups.onBlueskyHosts), independent: sum((d) => d.signups.onIndependentHosts), unlisted: sum((d) => d.airQuality.unlistedSignups) };
  return {
    days: days.length,
    signups: { onBlueskyHosts: created.bluesky, onIndependentHosts: created.independent, withOwnDomainHandle: sum((d) => d.signups.withOwnDomainHandle) },
    ...(created.bluesky + created.independent > 0 ? { newAccountsStartingOutsideBlueskyPercent: round1((created.independent / (created.bluesky + created.independent)) * 100) } : {}),
    movingHouse: { outOfBluesky: out, backToBluesky: back, betweenIndependentHosts: sum((d) => d.movingHouse.betweenIndependentHosts), wind: windOf(out, back), movedTo: movedTo(days) },
    airQuality: smogOf(created),
    deletedAccounts: sum((d) => d.deletedAccounts),
  };
}

// ---------- the last hour, and the forecast ----------

const SPAN_KEYS = ["seconds", "creates", "posts", "updates", "deletes", "apps", "active"] as const;

/**
 * The weather page's "last hour" tile (/api/weather-span?span=hour), against the hour
 * before: feels like (new posts a second), gusts (the busiest minute, new records a
 * second), humidity (edits and deletions as a share of everything written), visibility
 * (apps outside Bluesky heard), and active accounts.
 */
export function lastHourOf(body: unknown) {
  if (!isRecord(body)) return null;
  const figures = (x: unknown) => {
    const c = counts(x, SPAN_KEYS);
    if (!c || c.seconds <= 0) return null;
    const gust = isRecord(x) ? count(x.gust) : null;
    const writes = c.creates + c.updates + c.deletes;
    return {
      feelsLikePostsPerSecond: rate(c.posts, c.seconds),
      ...(gust !== null ? { gustsPerSecond: round1(gust) } : {}),
      humidityPercent: writes > 0 ? round1((100 * (c.updates + c.deletes)) / writes) : 0,
      visibilityApps: c.apps,
      activeAccounts: c.active,
      perSecond: rate(c.creates, c.seconds),
    };
  };
  const now = figures(body.now);
  if (!now) return null;
  const before = figures(body.before);
  return { ...now, ...(before ? { hourBefore: before } : {}) };
}

/** The forecast (/api/weather-forecast), with times in `tz`, or null. */
export function forecastOf(body: unknown, tz: string) {
  if (!isRecord(body)) return null;
  if (body.learning === true) return { ready: false as const, reason: "the forecast is still learning: it needs a few days of the station's hours first" };
  const hours = list(body.hours).flatMap((h) => {
    const t = isRecord(h) ? iso(h.t) : null;
    const c = counts(h, ["perSecond", "low", "high"] as const);
    const chance = isRecord(h) ? counts(h.chance, ["gusts", "storm"] as const) : null;
    return t && c ? [{
      hour: hourAt(t, tz),
      perSecond: round1(c.perSecond),
      condition: conditionFor(c.perSecond),
      // where 8 runs in 10 land
      likelyRange: [round1(c.low), round1(c.high)],
      ...(chance ? { chanceOfGustsPercent: Math.round(chance.gusts * 100), chanceOfStormPercent: Math.round(chance.storm * 100) } : {}),
    }] : [];
  });
  if (!hours.length) return null;
  const sun = list(body.sun).flatMap((s) => {
    const at = isRecord(s) ? iso(s.at) : null;
    return at && isRecord(s) && (s.kind === "wakes" || s.kind === "settles") ? [{ [s.kind === "wakes" ? "networkSunrise" : "networkSunset"]: hourAt(at, tz) }] : [];
  });
  const skill = counts(body.skill, ["hours", "error", "usualError"] as const);
  return {
    ready: true as const,
    timeZone: tz,
    hours,
    ...(sun.length ? { sun } : {}),
    // how far off its next-hour forecasts have been, against just going by usual
    ...(skill ? { skill: { hoursChecked: skill.hours, typicalMissPercent: round1(skill.error * 100), usualAloneMissPercent: round1(skill.usualError * 100) } } : {}),
  };
}

// ---------- the reports ----------

export type Parts = { day?: unknown; week?: unknown; month?: unknown; almanac?: unknown; live?: unknown; span?: unknown; forecast?: unknown };

/** Today so far in `tz`: the high and low, the last hour against usual, new apps, the last 24 hours' busiest apps. */
export function todayReport(parts: Parts, now: number, tz: string) {
  const almanac = parseAlmanac(parts.almanac);
  const day = parseHistory(parts.day);
  if (!almanac?.today && !day) return null;
  const unavailable: string[] = [];
  const out: Record<string, unknown> = { report: "today", page: WEATHER_PAGE, timeZone: tz };
  const t = almanac?.today;
  if (t) {
    const w = weatherOf(t);
    out.today = {
      since: t.start,
      heardPercent: heardPercent(t.seconds, now - Date.parse(t.start)),
      perSecond: w.perSecond,
      condition: w.condition,
      postsPerSecond: rate(t.posts, t.seconds),
      records: t.creates,
      // the share of today's new records written outside Bluesky: not the diversity index, which goes by accounts (see last24Hours)
      recordsElsewherePercent: indexOf(t.elsewhere, t.creates),
      // the busiest and quietest whole minute, new records a second
      ...(t.high ? { high: { minute: hourAt(t.high.minute, tz), perSecond: t.high.perSecond, condition: conditionFor(t.high.perSecond) } } : {}),
      ...(t.low ? { low: { minute: hourAt(t.low.minute, tz), perSecond: t.low.perSecond, condition: conditionFor(t.low.perSecond) } } : {}),
    };
  } else unavailable.push("today so far");
  if (almanac?.normal) out.lastHour = usualOf(almanac.normal, now, tz);
  else unavailable.push("the last hour against usual");
  if (almanac?.newApps) out.newApps = newAppsOf(almanac.newApps);
  else unavailable.push("new apps");
  if (day) {
    const total = sumPoints(day.points);
    const accounts = accountsOf(day, DAY, "the 24 hours before");
    out.last24Hours = {
      heardPercent: heardPercent(total.seconds, DAY),
      ...weatherOf(total),
      ...diversityOf(day.accounts?.total),
      ...mixOf(day, "the 24 hours before"),
      apps: appsOf(day, total, "the 24 hours before"),
      ...(accounts ? { accounts } : {}),
    };
  } else unavailable.push("the last 24 hours");
  const lastHour = parts.span === undefined ? null : lastHourOf(parts.span);
  if (lastHour) out.lastHourReadouts = lastHour;
  else unavailable.push("the last hour's readouts");
  // today's sign-ups, accounts moving house and air quality, from the plc directory (utc day, so far)
  const hosts = isRecord(parts.day) ? hostHistoryOf(parts.day.hosts) : null;
  const todayId = hosts?.identities.find((d) => d.date === new Date(now).toISOString().slice(0, 10));
  if (todayId) out.identitiesTodayUtc = todayId;
  else unavailable.push("today's sign-ups and moves");
  const forecast = parts.forecast === undefined ? null : forecastOf(parts.forecast, tz);
  if (forecast?.ready) out.forecast = { nextHours: forecast.hours.slice(0, 6), ...(forecast.sun ? { sun: forecast.sun.slice(0, 2) } : {}), more: 'report "forecast" has all 12 hours and how good it has been' };
  else if (forecast) out.forecast = forecast;
  else unavailable.push("the forecast");
  if (unavailable.length) out.unavailable = unavailable;
  return out;
}

/**
 * The past 7 days, for the dispatch: the week's weather, the week before, its busiest
 * and quietest hour, each day, the busiest apps against the week before, the month,
 * and an outlook. The week itself is the last 7×24 hours; the days, the week before and
 * the month are whole UTC days, the way the station keeps them. Its weather words go by
 * the records with bursts left out (busy), and the bursts come on their own (bursts): one
 * app's bulk import is something that happened, not the sky, and not a usual week.
 */
export function weekReport(parts: Parts, now: number, tz: string) {
  const week = parseHistory(parts.week);
  if (!week || !week.points.length) return null;
  const month = parseHistory(parts.month);
  const almanac = parseAlmanac(parts.almanac);
  const unavailable: string[] = [];
  const total = sumPoints(week.points);
  const w = weatherOf(total);
  const heard = heardPercent(total.seconds, WEEK);
  const out: Record<string, unknown> = {
    report: "week",
    page: WEATHER_PAGE,
    timeZone: tz,
    from: new Date(now - WEEK).toISOString(),
    to: new Date(now).toISOString(),
    heardPercent: heard,
    ...(heard < 90 ? { note: `the station heard ${heard}% of these 7 days, so every number here covers only what it heard` } : {}),
    perSecond: w.perSecond,
    condition: w.condition,
    records: { total: total.creates, bluesky: total.bluesky, elsewhere: total.elsewhere },
    bluesky: {
      postsPerSecond: rate(total.posts, total.seconds),
      likesPerSecond: rate(total.likes, total.seconds),
      repostsPerSecond: rate(total.reposts, total.seconds),
      followsPerSecond: rate(total.follows, total.seconds),
      posts: total.posts,
      likes: total.likes,
      reposts: total.reposts,
      follows: total.follows,
    },
    edits: { updates: total.updates, deletes: total.deletes },
    ...extremes(week.points, tz),
  };
  const index = week.accounts?.total.index;
  if (index !== undefined) out.diversity = { index, level: diversityLevel(index) };
  else unavailable.push("the diversity index");
  const accounts = accountsOf(week, WEEK, "the week before");
  if (accounts) out.accounts = accounts;
  else unavailable.push("active accounts");
  const apps = appsOf(week, total, "the week before");
  if (week.apps) out.apps = apps;
  else unavailable.push("the busiest apps");
  // hours that one app's bulk import, mostly, blew far past the weather: news, not weather
  if (week.bursts.length) {
    out.bursts = week.bursts.map((b) => ({
      hour: hourAt(b.t, tz),
      records: b.records,
      ...(b.app
        ? { app: b.app.domain, minute: hourAt(b.app.minute, tz), recordsThatMinute: b.app.records, perSecond: Math.round(b.app.records / 60), collections: b.app.collections }
        : {}),
    }));
  }

  if (month && month.points.length) {
    const todayStart = Math.floor(now / DAY) * DAY;
    const thisFrom = todayStart - 6 * DAY;
    const beforeFrom = todayStart - 13 * DAY;
    const inside = (from: number, to: number) => month.points.filter((p) => Date.parse(p.t) >= from && Date.parse(p.t) < to);
    const accountsOn = new Map((month.accounts?.points ?? []).map((p) => [p.t, p]));
    out.days = inside(thisFrom, now).map((p) => {
      const d = weatherOf(p);
      const start = Date.parse(p.t);
      const a = accountsOn.get(p.t);
      return {
        date: p.t.slice(0, 10),
        weekday: UTC_WEEKDAYS[new Date(start).getUTCDay()],
        perSecond: d.perSecond,
        condition: d.condition,
        postsPerSecond: rate(p.posts, p.seconds),
        ...(a?.index !== undefined ? { diversityIndex: a.index } : {}),
        ...(a ? { activeAccounts: a.active } : {}),
        heardPercent: heardPercent(p.seconds, Math.min(DAY, now - start)),
      };
    });
    const thisWeek = sumPoints(inside(thisFrom, now));
    const before = sumPoints(inside(beforeFrom, thisFrom));
    const thisHeard = heardPercent(thisWeek.seconds, now - thisFrom);
    const beforeHeard = heardPercent(before.seconds, WEEK);
    if (thisHeard >= 50 && beforeHeard >= 50) {
      const b = weatherOf(before);
      // the mix by each week's days heard live and at least half, their diversity indexes
      // averaged: a week's accounts would spread over more apps than any day's, and only days come back
      const daily = (from: number, to: number) => inside(from, to).flatMap((p) => {
        const index = accountsOn.get(p.t)?.index;
        return Date.parse(p.t) >= LIVE_SINCE && p.seconds >= 43_200 && index !== undefined ? [index] : [];
      });
      const [thisDays, beforeDays] = [daily(thisFrom, now), daily(beforeFrom, thisFrom)];
      const mix = thisDays.length >= 4 && beforeDays.length >= 4 ? mixWords(mean(thisDays), mean(beforeDays), "the week before") : null;
      out.weekBefore = {
        from: new Date(beforeFrom).toISOString(),
        to: new Date(thisFrom).toISOString(),
        heardPercent: beforeHeard,
        perSecond: b.perSecond,
        // this week's records a second against the week before's, both by whole UTC days
        changePercent: changePercent(busy(thisWeek) / thisWeek.seconds, busy(before) / before.seconds),
        ...(mix ? { mix } : {}),
      };
    } else {
      out.weekBefore = { available: false, reason: `the station heard ${beforeHeard}% of the week before, too little to compare with` };
    }
    const monthFrom = todayStart - 29 * DAY;
    const days30 = inside(monthFrom, now);
    const m = sumPoints(days30);
    const wholeDays = days30.filter((p) => p.seconds >= 0.9 * 86_400).sort((a, b) => busy(b) / b.seconds - busy(a) / a.seconds);
    const day = (p: Point) => ({ date: p.t.slice(0, 10), weekday: UTC_WEEKDAYS[new Date(Date.parse(p.t)).getUTCDay()], perSecond: rate(busy(p), p.seconds) });
    out.month = {
      from: new Date(monthFrom).toISOString(),
      heardPercent: heardPercent(m.seconds, now - monthFrom),
      ...weatherOf(m),
      // over the station's last 30 days
      ...diversityOf(month.accounts?.total),
      ...mixOf(month, "the 30 days before"),
      ...(wholeDays.length >= 2 ? { busiestDay: day(wholeDays[0]!), quietestDay: day(wholeDays[wholeDays.length - 1]!) } : {}),
    };
    const perDay = (month.appsOverTime ?? []).filter((p) => Date.parse(p.t) >= thisFrom);
    if (perDay.length) {
      const most = perDay.reduce((a, b) => (b.apps > a.apps ? b : a));
      // apps outside Bluesky the station heard each UTC day
      out.appsPerDay = { average: Math.round(perDay.reduce((n, p) => n + p.apps, 0) / perDay.length), most: { date: most.t.slice(0, 10), apps: most.apps } };
    }
  } else unavailable.push("each day", "the week before", "the month");

  if (almanac?.newApps) out.newAppsLast24Hours = newAppsOf(almanac.newApps);
  else unavailable.push("new apps");
  if (almanac?.heatmap) {
    const historyStart = almanac.normal?.historyStart ?? null;
    out.outlook = outlookOf(almanac.heatmap, historyStart, apps, tz);
  } else unavailable.push("the outlook");
  const hosts = isRecord(parts.week) ? hostHistoryOf(parts.week.hosts) : null;
  if (hosts && (hosts.days.length || hosts.identities.length)) {
    out.whereTheAtmosphereLives = {
      ...(hosts.overTheRange ? { overTheWeek: hosts.overTheRange } : {}),
      newIndependentHosts: hosts.newIndependentHosts,
      growingFastest: hosts.growingFastest.slice(0, 5),
      ...(hosts.identities.length ? { thisWeek: identityTotals(hosts.identities.slice(-7)) } : {}),
      days: hosts.days.slice(-7),
    };
  } else unavailable.push("the pds hosts");
  if (unavailable.length) out.unavailable = unavailable;
  return out;
}

/**
 * Where the atmosphere lives: the PDS hosts now (the station's census of the relay's list),
 * and over the last 7 days (or 30, `month`): new and growing independent hosts, each day's
 * hosts, sign-ups, accounts moving house, air quality and deletions.
 */
export function hostsReport(parts: Parts, range: "week" | "month" = "week") {
  const live = isRecord(parts.live) ? hostsNowOf(parts.live.hosts) : null;
  const history = isRecord(parts[range]) ? hostHistoryOf((parts[range] as Record<string, unknown>).hosts) : null;
  if (!live && !history) return null;
  const unavailable: string[] = [];
  const out: Record<string, unknown> = { report: "hosts", page: `${WEATHER_PAGE}#weather-hosts-title`, range };
  if (live) out.now = live;
  else unavailable.push("the live census");
  if (history) {
    const today = history.identities[history.identities.length - 1];
    if (today) out.latestIdentityDay = today;
    if (history.identities.length) out.identityTotals = identityTotals(history.identities);
    out.history = { ...history, identities: undefined };
  } else unavailable.push("the hosts' history");
  if (unavailable.length) out.unavailable = unavailable;
  return out;
}

/** One report, read fresh. Throws only when its main part can't be read. */
export async function readWeather(report: Report, tz: string, fetchImpl: Fetch = fetch, now = Date.now()) {
  const read = (path: string) => getJson(fetchImpl, path).catch(() => undefined);
  if (report === "now") {
    const [body, span] = await Promise.all([getJson(fetchImpl, "atmosphere"), read("weather-span?span=hour")]);
    const out = nowReport(body, span);
    if (!out) throw new Error("the reading did not check out");
    return out;
  }
  if (report === "forecast") {
    const out = forecastOf(await getJson(fetchImpl, "weather-forecast"), tz);
    if (!out) throw new Error("the forecast did not check out");
    return { report: "forecast", page: WEATHER_PAGE, ...out };
  }
  if (report === "hosts") {
    const [live, week] = await Promise.all([read("atmosphere"), read("weather-history?range=week")]);
    const out = hostsReport({ live, week });
    if (!out) throw new Error("the hosts could not be read");
    return out;
  }
  const almanac = read(`weather-almanac?tz=${encodeURIComponent(tz)}`);
  if (report === "today") {
    const [day, span, forecast] = await Promise.all([read("weather-history?range=day"), read("weather-span?span=hour"), read("weather-forecast")]);
    const out = todayReport({ almanac: await almanac, day, span, forecast }, now, tz);
    if (!out) throw new Error("today could not be read");
    return out;
  }
  const [week, month] = await Promise.all([read("weather-history?range=week"), read("weather-history?range=month")]);
  const out = weekReport({ week, month, almanac: await almanac }, now, tz);
  if (!out) throw new Error("the week could not be read");
  return out;
}
