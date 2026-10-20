/**
 * The weather report's almanac (weather/index.html), from /api/weather-almanac
 * (server/weather-almanac.ts) in the reader's own time zone:
 *
 *   today so far          the high and low (the busiest and quietest whole minute, by new
 *                         records a second, every app), the day's totals, and the last hour against usual:
 *                         "busier than usual for a tuesday afternoon" once the station has
 *                         heard a few of those, "for this time of day" after a day
 *   new in the atmosphere apps heard for the first time in the last 24 hours, after the
 *                         station's first week (until then it says it's warming up)
 *   when the sky is busiest
 *                         new records a second for every hour of the week, as a heat map;
 *                         it only names the busiest and quietest hours after a few weeks
 *
 * Checks again every minute while the tab is visible. App and collection names are other
 * people's text and only reach the DOM through textContent.
 */

export const ALMANAC_ENDPOINT = '/api/weather-almanac';
export const ALMANAC_REFRESH_MS = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Weeks of readings before the heat map names its busiest and quietest hours. */
export const HEAT_READY_WEEKS = 3;
/** A cell needs this many seconds heard to get a colour. */
export const HEAT_MIN_SECONDS = 600;

interface Sums {
  seconds: number;
  posts: number;
  creates: number;
  elsewhere: number;
}

export interface Almanac {
  tz: string;
  today?: Sums & { start: string; high: Extreme | null; low: Extreme | null };
  normal?: { historyStart: string | null; now: Sums; days: Sums & { windows: number }; weeks: Sums & { windows: number } };
  newApps?: { historyStart: string | null; readyAt: string | null; warmingUp: boolean; heard: number; apps: NewApp[] };
  heatmap?: { seconds: number; cells: HeatCell[] };
}

export interface Extreme {
  minute: string;
  perSecond: number;
}

export interface NewApp {
  domain: string;
  firstSeen: string;
  creates: number;
  collections: string[];
}

export interface HeatCell {
  dow: number;
  hour: number;
  seconds: number;
  posts: number;
  creates: number;
}

// ---------- reading the answer ----------

const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const date = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
const sums = (x: unknown): x is Sums => obj(x) && n(x.seconds) && n(x.posts) && n(x.creates) && n(x.elsewhere);
const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/i;
const name = (x: unknown): x is string => typeof x === 'string' && NAME_RE.test(x);
const extreme = (x: unknown): Extreme | null => (obj(x) && date(x.minute) && n(x.perSecond) ? { minute: x.minute, perSecond: x.perSecond } : null);

/** Keeps the parts that check out; a part that doesn't is left out, like a part the server couldn't get. */
export function readAlmanac(body: unknown): Almanac | null {
  if (!obj(body) || typeof body.tz !== 'string') return null;
  const out: Almanac = { tz: body.tz };
  const t = body.today;
  if (obj(t) && sums(t) && date(t.start)) {
    out.today = { seconds: t.seconds, posts: t.posts, creates: t.creates, elsewhere: t.elsewhere, start: t.start, high: extreme(t.high), low: extreme(t.low) };
  }
  const nm = body.normal;
  const windows = (x: unknown): x is Sums & { windows: number } => sums(x) && n((x as unknown as Record<string, unknown>).windows);
  if (obj(nm) && sums(nm.now) && windows(nm.days) && windows(nm.weeks)) {
    out.normal = { historyStart: date(nm.historyStart) ? nm.historyStart : null, now: nm.now, days: nm.days, weeks: nm.weeks };
  }
  const na = body.newApps;
  if (obj(na) && typeof na.warmingUp === 'boolean' && n(na.heard) && Array.isArray(na.apps)) {
    out.newApps = {
      historyStart: date(na.historyStart) ? na.historyStart : null,
      readyAt: date(na.readyAt) ? na.readyAt : null,
      warmingUp: na.warmingUp,
      heard: na.heard,
      apps: na.apps.filter(
        (a): a is NewApp => obj(a) && name(a.domain) && date(a.firstSeen) && n(a.creates) && Array.isArray(a.collections) && a.collections.every(name),
      ),
    };
  }
  const hm = body.heatmap;
  if (obj(hm) && n(hm.seconds) && Array.isArray(hm.cells)) {
    out.heatmap = {
      seconds: hm.seconds,
      cells: hm.cells.filter(
        (c): c is HeatCell => obj(c) && n(c.dow) && n(c.hour) && n(c.seconds) && n(c.posts) && n(c.creates) && c.dow >= 1 && c.dow <= 7 && c.hour <= 23,
      ),
    };
  }
  return out;
}

export function readerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function fetchAlmanac(tz: string, fetchImpl: typeof fetch = fetch): Promise<Almanac | null> {
  try {
    const res = await fetchImpl(`${ALMANAC_ENDPOINT}?tz=${encodeURIComponent(tz)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return readAlmanac(await res.json());
  } catch {
    return null;
  }
}

// ---------- words ----------

/** "3:14 pm" in the reader's zone. */
export function clock(iso: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).toLowerCase();
}

/** "1.6 million", "171,986". */
export function bigNumber(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} billion`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} million`;
  return Math.round(v).toLocaleString('en-US');
}

/** The part of the day an hour falls in, for "a tuesday afternoon". */
export function daypart(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function local(nowMs: number, tz: string | undefined, opts: Intl.DateTimeFormatOptions): string {
  return new Date(nowMs).toLocaleString('en-US', { ...opts, timeZone: tz }).toLowerCase();
}

/** How long, in rough words: "3 days", "1 hour", "40 minutes". */
export function roughly(ms: number): string {
  const units: Array<[string, number]> = [
    ['day', DAY],
    ['hour', HOUR],
    ['minute', 60_000],
  ];
  for (const [unit, size] of units) {
    const v = Math.floor(ms / size);
    if (v >= 1) return `${v} ${unit}${v === 1 ? '' : 's'}`;
  }
  return 'under a minute';
}

export interface Usual {
  headline: string;
  detail: string;
}

/**
 * The last hour against usual, in words. "weeks" (the same weekday) once the station has
 * heard one; "days" (the same hour on other days) before that; null with a reason when
 * there's nothing to compare with yet.
 */
export function usualText(normal: NonNullable<Almanac['normal']>, nowMs: number, tz?: string): Usual {
  const now = normal.now;
  const basis = normal.weeks.windows > 0 ? 'weeks' : normal.days.windows > 0 ? 'days' : null;
  const listening = normal.historyStart ? nowMs - Date.parse(normal.historyStart) : 0;
  if (!basis || now.seconds < 1800) {
    return {
      headline: 'the station is still learning what usual looks like',
      detail: `it's been listening for ${roughly(listening)}. after a day it can compare with this time yesterday, and after a week with a usual ${local(nowMs, tz, { weekday: 'long' })}.`,
    };
  }
  const base = normal[basis];
  const rate = now.creates / now.seconds;
  const usual = base.creates / base.seconds;
  const ratio = usual > 0 ? rate / usual : 1;
  const how =
    ratio >= 1.25 ? 'much busier than usual' : ratio >= 1.08 ? 'busier than usual' : ratio <= 0.8 ? 'much quieter than usual' : ratio <= 0.93 ? 'quieter than usual' : 'about as busy as usual';
  const weekday = local(nowMs, tz, { weekday: 'long' });
  const hour = Number(new Date(nowMs).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }));
  const when = basis === 'weeks' ? `for a ${weekday} ${daypart(hour % 24)}` : 'for this time of day';
  const over =
    basis === 'weeks' ? (base.windows === 1 ? `last ${weekday}` : `the last ${base.windows} ${weekday}s`) : base.windows === 1 ? 'yesterday' : `the last ${base.windows} days`;
  let detail = `${Math.round(rate)} new records a second over the last hour; usually about ${Math.round(usual)} at this hour (${over}).`;
  // Diversity against usual, when both sides have enough records from other apps to say.
  if (now.elsewhere >= 50 && base.elsewhere >= 50 && now.creates > 0 && base.creates > 0) {
    const mix = now.elsewhere / now.creates / (base.elsewhere / base.creates);
    if (mix >= 1.3) detail += ' a more mixed sky than usual, too.';
    else if (mix <= 0.77) detail += ' a little less mixed than usual.';
  }
  if (basis === 'days') detail += ` in a week it'll compare with ${weekday}s.`;
  return { headline: `${how} ${when}`, detail };
}

// ---------- today so far ----------

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
function setText(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) el.textContent = text;
}

export function renderToday(tile: HTMLElement, a: Almanac, nowMs = Date.now(), tz?: string): void {
  if (a.normal) {
    const usual = usualText(a.normal, nowMs, tz);
    setText(tile, '[data-a-usual]', usual.headline);
    setText(tile, '[data-a-usual-detail]', usual.detail);
  }
  const t = a.today;
  if (t) {
    setText(tile, '[data-a-high]', t.high ? `${Math.round(t.high.perSecond)}` : '–');
    setText(tile, '[data-a-high-at]', t.high ? `new records a second at ${clock(t.high.minute, tz)}` : 'no whole minute heard yet');
    setText(tile, '[data-a-low]', t.low ? `${Math.round(t.low.perSecond)}` : '–');
    setText(tile, '[data-a-low-at]', t.low ? `new records a second at ${clock(t.low.minute, tz)}` : '');
    setText(tile, '[data-a-total]', bigNumber(t.creates));
    const share = t.creates > 0 ? (t.elsewhere / t.creates) * 100 : 0;
    setText(tile, '[data-a-total-note]', t.creates > 0 ? `new records, ${share < 1 ? share.toFixed(2) : share.toFixed(1)}% from other apps` : 'new records');
    const heardAll = t.seconds >= (nowMs - Date.parse(t.start)) / 1000 - 300;
    setText(
      tile,
      '[data-a-today-note]',
      `the high and low are whole minutes, by new records a second. today started at midnight where you are${heardAll ? '' : `; the station has heard ${roughly(t.seconds * 1000)} of it`}.`,
    );
  }
  tile.dataset.state = 'ready';
}

// ---------- new in the atmosphere ----------

export function renderNewApps(tile: HTMLElement, a: Almanac, nowMs = Date.now(), tz?: string): void {
  const na = a.newApps;
  if (!na) return;
  const list = $(tile, '[data-a-new-list]');
  if (na.warmingUp) {
    const left = na.readyAt ? Math.max(0, Date.parse(na.readyAt) - nowMs) : WEEK;
    setText(tile, '[data-a-new-lede]', `the station is still getting to know the sky. after a week of listening it can tell a new app from a quiet one: ${roughly(left)} to go. so far today it's heard ${na.heard} apps outside bluesky.`);
    setText(tile, '[data-a-new-count]', '');
    list?.replaceChildren();
  } else if (na.apps.length === 0) {
    setText(tile, '[data-a-new-lede]', `nothing new in the last 24 hours: all ${na.heard} apps it heard, it had heard before. the sky's settled.`);
    setText(tile, '[data-a-new-count]', '');
    list?.replaceChildren();
  } else {
    setText(tile, '[data-a-new-lede]', `${na.apps.length === 1 ? 'one app' : `${na.apps.length} apps`} blew in for the first time in the last 24 hours.`);
    setText(tile, '[data-a-new-count]', `${na.apps.length} new`);
    list?.replaceChildren(
      ...na.apps.map((app) => {
        const li = document.createElement('li');
        li.className = 'weather-new__app';
        const domain = document.createElement('strong');
        domain.className = 'weather-new__domain';
        domain.textContent = app.domain;
        const when = document.createElement('span');
        when.className = 'weather-new__when';
        when.textContent = `first heard at ${clock(app.firstSeen, tz)} · ${app.creates.toLocaleString('en-US')} record${app.creates === 1 ? '' : 's'}`;
        li.append(domain, when);
        if (app.collections.length) {
          const sub = document.createElement('span');
          sub.className = 'weather-new__collections';
          sub.textContent = app.collections.join(', ');
          li.append(sub);
        }
        return li;
      }),
    );
  }
  tile.dataset.state = 'ready';
}

// ---------- when the sky is busiest ----------

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

/** "3 pm", "12 am". */
export function hourWords(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'am' : 'pm'}`;
}

export interface HeatSummary {
  /** Posts a second per cell, by dow (1–7) and hour; null where it hasn't heard enough. */
  rate: (dow: number, hour: number) => number | null;
  heard: number;
  min: number;
  max: number;
  busiest: { dow: number; hour: number; rate: number } | null;
  quietest: { dow: number; hour: number; rate: number } | null;
  weeks: number;
}

export function summarizeHeat(h: NonNullable<Almanac['heatmap']>): HeatSummary {
  const rates = new Map<string, number>();
  for (const c of h.cells) if (c.seconds >= HEAT_MIN_SECONDS) rates.set(`${c.dow}:${c.hour}`, c.creates / c.seconds);
  let busiest: HeatSummary['busiest'] = null;
  let quietest: HeatSummary['quietest'] = null;
  for (const [key, rate] of rates) {
    const [dow, hour] = key.split(':').map(Number) as [number, number];
    if (!busiest || rate > busiest.rate) busiest = { dow, hour, rate };
    if (!quietest || rate < quietest.rate) quietest = { dow, hour, rate };
  }
  return {
    rate: (dow, hour) => rates.get(`${dow}:${hour}`) ?? null,
    heard: rates.size,
    min: quietest?.rate ?? 0,
    max: busiest?.rate ?? 0,
    busiest,
    quietest,
    weeks: h.seconds / (WEEK / 1000),
  };
}

/** One of five steps, by where `rate` sits between the quietest and busiest hours. */
export function heatStep(rate: number, min: number, max: number): number {
  if (max <= min) return 3;
  return Math.min(5, 1 + Math.floor(((rate - min) / (max - min)) * 5));
}

export function renderHeatmap(tile: HTMLElement, a: Almanac, nowMs = Date.now(), tz?: string): void {
  const h = a.heatmap;
  const table = $(tile, '[data-a-heat-grid]');
  if (!h || !table) return;
  const s = summarizeHeat(h);
  const nowDow = (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(local(nowMs, tz, { weekday: 'short' })) + 1) || 0;
  const nowHour = Number(new Date(nowMs).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz })) % 24;

  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('td');
  hr.append(corner);
  for (let hour = 0; hour < 24; hour++) {
    const th = document.createElement('th');
    th.scope = 'col';
    const short = hour === 0 ? '12a' : hour === 12 ? '12p' : hour % 6 === 0 ? `${hour % 12}${hour < 12 ? 'a' : 'p'}` : '';
    const label = document.createElement('span');
    label.textContent = hourWords(hour);
    label.className = 'visually-hidden';
    th.append(label);
    if (short) {
      const mark = document.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = short;
      th.append(mark);
    }
    hr.append(th);
  }
  head.append(hr);
  const body = document.createElement('tbody');
  WEEKDAYS.forEach((day, i) => {
    const dow = i + 1;
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = day.slice(0, 3);
    tr.append(th);
    for (let hour = 0; hour < 24; hour++) {
      const td = document.createElement('td');
      const rate = s.rate(dow, hour);
      const words = rate === null ? 'not heard yet' : `${Math.round(rate)} new records a second`;
      td.className = `weather-heat__cell${rate === null ? ' weather-heat__cell--empty' : ` weather-heat__cell--${heatStep(rate, s.min, s.max)}`}${dow === nowDow && hour === nowHour ? ' weather-heat__cell--now' : ''}`;
      td.title = `${day}s at ${hourWords(hour)}: ${words}`;
      const v = document.createElement('span');
      v.className = 'visually-hidden';
      v.textContent = rate === null ? 'not heard yet' : String(Math.round(rate));
      td.append(v);
      tr.append(td);
    }
    body.append(tr);
  });
  const caption = table.querySelector('caption');
  table.replaceChildren(...(caption ? [caption] : []), head, body);

  setText(tile, '[data-a-heat-min]', s.heard ? String(Math.round(s.min)) : '–');
  setText(tile, '[data-a-heat-max]', s.heard ? `${Math.round(s.max)} new records a second` : '–');
  if (s.weeks >= HEAT_READY_WEEKS && s.busiest && s.quietest) {
    setText(
      tile,
      '[data-a-heat-lede]',
      `busiest on ${WEEKDAYS[s.busiest.dow - 1]}s around ${hourWords(s.busiest.hour)}, quietest on ${WEEKDAYS[s.quietest.dow - 1]}s around ${hourWords(s.quietest.hour)}.`,
    );
  } else {
    const daysIn = Math.floor((h.seconds * 1000) / DAY);
    setText(
      tile,
      '[data-a-heat-lede]',
      `filling in: ${s.heard} of the week's 168 hours heard so far. the pattern settles after about ${HEAT_READY_WEEKS} weeks of listening${daysIn >= 1 ? ` (${daysIn} day${daysIn === 1 ? '' : 's'} in)` : ''}.`,
    );
  }
  setText(tile, '[data-a-heat-aside]', s.weeks >= 1 ? `${Math.floor(s.weeks)} week${Math.floor(s.weeks) === 1 ? '' : 's'} of readings` : `${roughly(h.seconds * 1000)} of readings`);
  tile.dataset.state = 'ready';
}

/**
 * The three tiles, a first load, and a check every minute while the tab is visible.
 * `onLoad` hears every almanac that arrives (the weather alerts watch it for new apps).
 */
export function initAlmanac(root: ParentNode = document, fetchImpl: typeof fetch = fetch, onLoad?: (a: Almanac) => void): void {
  const today = $(root, '[data-a-today]');
  const fresh = $(root, '[data-a-new]');
  const heat = $(root, '[data-a-heat]');
  if (!today && !fresh && !heat) return;
  const tz = readerTimeZone();
  const load = async () => {
    const a = await fetchAlmanac(tz, fetchImpl);
    const now = Date.now();
    if (!a) {
      for (const tile of [today, fresh, heat]) if (tile && tile.dataset.state !== 'ready') tile.dataset.state = 'error';
      return;
    }
    if (today && (a.today || a.normal)) renderToday(today, a, now, tz);
    if (fresh) renderNewApps(fresh, a, now, tz);
    if (heat) renderHeatmap(heat, a, now, tz);
    onLoad?.(a);
  };
  void load();
  const tick = () =>
    window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load();
      tick();
    }, ALMANAC_REFRESH_MS);
  tick();
}
