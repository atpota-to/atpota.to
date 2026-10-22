/**
 * "atmospheric conditions" on the home page: a weather report for the network, from
 * /api/atmosphere (server/atmosphere.ts samples the whole firehose for a few seconds).
 * The tile is a link to the full report at /weather (weather-page.ts), which reuses the
 * reading, its checks and its wording from here, and its header is the report's in small:
 * "392 rec/sec", the forecast, and the station's last 60 seconds as a sparkline
 * (weather-spark.ts).
 * It reads the weather as soon as the page loads, in the same request as the hero's scene,
 * then checks again while the tile is on screen and the tab is visible: every 15 seconds
 * when the reading is the weather station's live 60 seconds, once a minute when it's the
 * fallback sample. Numbers roll to each new reading (roll.ts), and the little sun's rays
 * turn faster when the network is busy. Under reduced motion the numbers just change and
 * the rays hold still.
 *
 * Under the Bluesky numbers sits the diversity index: how much of the atmosphere isn't
 * Bluesky, by the accounts writing elsewhere and how spread out they are over apps
 * (server/atmosphere.ts diversityOf), with a bar for the share of accounts, and the sky
 * behind it all gets cloudier as the index climbs (weather-sky.ts).
 *
 * States live on the tile as data-state="loading" | "ready" | "error". While it loads,
 * every part of the tile is already in its place (home.css shimmers where the numbers go),
 * so nothing moves when the reading lands.
 *
 * Every good reading is kept in this tab for STORE_MS (storedReading), so the next page
 * shows the weather straight away and rolls on to a fresh one, and announced as a
 * READING_EVENT, so the sky behind the header's wordmark (nav-weather.ts) keeps up with
 * the tile and the report without asking again.
 *
 * The hero tile's scene (scene.ts) reads the same weather on load; readAtmosphere() lets the
 * two share one request when they ask within SHARE_MS of each other. The scene keeps its
 * own weather on the hero as data-weather="calm|rain|…", so the tile is [data-weather-tile].
 */

import { rollText } from './roll';
import { cloudCount, renderClouds } from './weather-sky';
import { renderSpark } from './weather-spark';

export const ATMOSPHERE_ENDPOINT = '/api/atmosphere';
export const REFRESH_MS = 60_000;
/** How often the tile checks while readings come live from the weather station (a rolling 60 seconds). */
export const LIVE_REFRESH_MS = 15_000;
/** New records a second (every app) that makes the rays turn at their CSS speed. */
const RAYS_BASELINE = 450;

export type Condition = 'calm' | 'light' | 'breezy' | 'gusty' | 'stormy';

export const CONDITION_TEXT: Record<Condition, string> = {
  calm: 'calm. a quiet moment in the atmosphere',
  light: 'a light breeze. a quiet spell',
  breezy: 'breezy. a usual day in the atmosphere',
  gusty: 'gusty. lots going on out there',
  stormy: 'stormy. somebody said something',
};

export const ERROR_TEXT = "the sky is hard to read right now. try again in a bit.";

export type DiversityLevel = 'low' | 'moderate' | 'high' | 'very high' | 'extreme';

/** Where each level starts, like the UV index (server/atmosphere.ts names them). */
export const DIVERSITY_SCALE: ReadonlyArray<readonly [DiversityLevel, number]> = [
  ['low', 0],
  ['moderate', 3],
  ['high', 6],
  ['very high', 8],
  ['extreme', 11],
];

export const LEVEL_TEXT: Record<DiversityLevel, string> = {
  low: 'mostly bluesky out there',
  moderate: 'a good mix of apps in the air',
  high: 'lots of other apps about',
  'very high': 'the atmosphere is really mixing it up',
  extreme: 'bluesky is barely the weather today',
};

export interface Rate {
  perSecond: number;
  count: number;
}

export interface App extends Rate {
  domain: string;
  collections: string[];
}

export interface Reading {
  measuredAt?: string;
  seconds?: number;
  perSecond: { posts: number; likes: number; reposts: number; follows: number };
  condition: Condition;
  /** The rest arrived with the whole-firehose sampler; the tile does without them. */
  records?: { perSecond: number; bluesky: number; elsewhere: number };
  /** share: percent of active accounts that wrote outside Bluesky; spread: how many apps they're spread across, as an effective number. Readings from before the index went by accounts have neither. */
  diversity?: { index: number; level: DiversityLevel; share?: number; spread?: number; apps: number; collections: number };
  apps?: App[];
  bluesky?: Array<Rate & { nsid: string }>;
  events?: { creates: number; updates: number; deletes: number; identity: number; account: number };
  /** "station": a rolling 60 seconds from the weather station; "sample": a few seconds sampled by the function. */
  source?: 'station' | 'sample';
  /** The station's window, second by second, oldest first; null for a second it missed. */
  series?: Array<{ t: number; creates: number; bluesky: number; elsewhere: number; posts: number } | null>;
  /** How many different accounts wrote anything in the station's window (the station only). */
  accounts?: {
    active: number;
    bluesky: number;
    elsewhere: number;
    /** The share of them that wrote outside Bluesky, percent. */
    index: number;
    apps: Array<{ domain: string; accounts: number; collections: string[] }>;
  };
  /** The PDS hosts on the network, from the station's census of the relay's list (server/atmosphere.ts Hosts). */
  hosts?: Hosts;
}

export interface Hosts {
  measuredAt: string;
  listed: number;
  active: number;
  bluesky: number;
  independent: number;
  writing: { bluesky: number; independent: number; minutes: number } | null;
  accounts: { bluesky: number; independent: number };
  diversity: { index: number; share: number; spread: number };
  top: Array<{ hostname: string; accounts: number }>;
  /** Every listed host by the relay's state for it. */
  statuses?: { active: number; idle: number; offline: number; throttled: number; banned: number; other: number };
  /** Independent hosts by accounts: 0, 1, up to 10, 100, 1,000, 10,000, and more. */
  sizes?: number[];
  tlds?: Array<{ tld: string; hosts: number; accounts: number }>;
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const nums = (x: unknown, keys: string[]) => obj(x) && keys.every((k) => num(x[k]));
const LEVELS = new Set<string>(DIVERSITY_SCALE.map(([name]) => name));
/** Collection names and domains as the server lets them through; anything else is dropped. */
const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/i;
const name = (x: unknown): x is string => typeof x === 'string' && NAME_RE.test(x);

function isReading(v: unknown): v is Reading {
  return obj(v) && nums(v.perSecond, ['posts', 'likes', 'reposts', 'follows']) && typeof v.condition === 'string' && Object.hasOwn(CONDITION_TEXT, v.condition);
}

/** Keeps the parts of a reading that check out, so one odd field can't spoil the rest. */
function clean(r: Reading): Reading {
  const out: Reading = { perSecond: r.perSecond, condition: r.condition };
  if (typeof r.measuredAt === 'string' && Number.isFinite(Date.parse(r.measuredAt))) out.measuredAt = r.measuredAt;
  if (num(r.seconds)) out.seconds = r.seconds;
  if (nums(r.records, ['perSecond', 'bluesky', 'elsewhere'])) out.records = r.records;
  const d = r.diversity;
  if (d && nums(d, ['index', 'apps', 'collections']) && typeof d.level === 'string' && LEVELS.has(d.level)) {
    out.diversity = { index: d.index, level: d.level, apps: d.apps, collections: d.collections };
    if (nums(d, ['share', 'spread'])) Object.assign(out.diversity, { share: d.share, spread: d.spread });
  }
  if (nums(r.events, ['creates', 'updates', 'deletes', 'identity', 'account'])) out.events = r.events;
  if (Array.isArray(r.apps)) {
    out.apps = r.apps.filter((a) => nums(a, ['perSecond', 'count']) && name(a.domain) && Array.isArray(a.collections)).map((a) => ({ ...a, collections: a.collections.filter(name).slice(0, 3) }));
  }
  if (Array.isArray(r.bluesky)) out.bluesky = r.bluesky.filter((b) => nums(b, ['perSecond', 'count']) && name(b.nsid));
  if (r.source === 'station' || r.source === 'sample') out.source = r.source;
  if (Array.isArray(r.series)) out.series = r.series.slice(-120).map((p) => (nums(p, ['t', 'creates', 'bluesky', 'elsewhere', 'posts']) ? p : null));
  const a = r.accounts;
  if (nums(a, ['active', 'bluesky', 'elsewhere', 'index']) && Array.isArray(a?.apps)) {
    out.accounts = { ...a, apps: a.apps.filter((x) => nums(x, ['accounts']) && name(x.domain) && Array.isArray(x.collections)).map((x) => ({ ...x, collections: x.collections.filter(name).slice(0, 3) })) };
  }
  const h = r.hosts;
  if (h && nums(h, ['listed', 'active', 'bluesky', 'independent']) && typeof h.measuredAt === 'string' && Number.isFinite(Date.parse(h.measuredAt)) && nums(h.accounts, ['bluesky', 'independent']) && nums(h.diversity, ['index', 'share', 'spread']) && Array.isArray(h.top)) {
    const { statuses, sizes, tlds, ...rest } = h;
    out.hosts = {
      ...rest,
      writing: nums(h.writing, ['bluesky', 'independent', 'minutes']) ? h.writing : null,
      top: h.top.filter((x) => nums(x, ['accounts']) && name(x.hostname)).slice(0, 10),
    };
    if (nums(statuses, ['active', 'idle', 'offline', 'throttled', 'banned', 'other'])) out.hosts.statuses = statuses;
    if (Array.isArray(sizes) && sizes.length === 7 && sizes.every(num)) out.hosts.sizes = sizes;
    if (Array.isArray(tlds)) out.hosts.tlds = tlds.filter((t) => nums(t, ['hosts', 'accounts']) && typeof t.tld === 'string' && /^[a-z0-9-]{2,63}$/.test(t.tld)).slice(0, 8);
  }
  return out;
}

async function request(fetchImpl: typeof fetch): Promise<Reading | null> {
  try {
    const res = await fetchImpl(ATMOSPHERE_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!isReading(body)) return null;
    const reading = clean(body);
    remember(reading);
    return reading;
  } catch {
    return null;
  }
}

/** Two readers asking this close together get the same reading. */
export const SHARE_MS = 10_000;
let shared: { at: number; reading: Promise<Reading | null> } | null = null;

/** A fresh reading, always asked for; readAtmosphere() hands it to anyone who asks in the next SHARE_MS. */
export function fetchReading(fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<Reading | null> {
  const reading = request(fetchImpl);
  shared = { at: now, reading };
  return reading;
}

/** The reading anyone asked for in the last SHARE_MS (still on its way, perhaps), or a fresh one. */
export function readAtmosphere(fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<Reading | null> {
  if (shared && now - shared.at < SHARE_MS) return shared.reading;
  return fetchReading(fetchImpl, now);
}

const STORE_KEY = 'atpotato:weather';
/** A reading this recent is shown at once on the next page in this tab, while a fresh one comes. */
export const STORE_MS = 120_000;
/** Sent on window with each good reading (detail: the Reading), for the header's sky. */
export const READING_EVENT = 'weather:reading';

/** The last good reading in this tab, if it's under STORE_MS old. */
export function storedReading(now = Date.now()): Reading | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (!obj(data) || !num(data.at) || now - data.at > STORE_MS || now < data.at) return null;
    return isReading(data.reading) ? clean(data.reading) : null;
  } catch {
    return null;
  }
}

function remember(reading: Reading, now = Date.now()): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ at: now, reading }));
  } catch {
    /* storage full or blocked: the next page just waits for its own */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<Reading>(READING_EVENT, { detail: reading }));
}

/** Forgets the shared reading (tests). */
export function resetSharedReading(): void {
  shared = null;
}

/** Records a second as people read them: one decimal under 100, whole after that. */
export function formatRate(n: number): string {
  return n < 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : Math.round(n).toLocaleString('en-US');
}

/** Accounts as people read them: 21,345. */
export const formatCount = (n: number) => Math.round(n).toLocaleString('en-US');

/** Accounts on an axis: 21k, 1.2m. */
export function compactCount(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n).toLowerCase();
}

/** How much of a range the station covered, in words: "13 minutes", "2 days". */
export function coverageWords(seconds: number): string {
  const units: Array<[string, number]> = [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'}`;
  }
  return 'under a minute';
}

/** The index as people read it: two decimals under 1, one under 10, whole after that. */
export function formatIndex(index: number): string {
  return index < 1 ? index.toFixed(2) : index < 10 ? index.toFixed(1) : String(Math.round(index));
}

/** "1 in 240 new records came from outside bluesky", or that none did. */
export function ratioText(records: NonNullable<Reading['records']>): string {
  if (records.elsewhere <= 0) return 'every new record just now was a bluesky one';
  const n = Math.max(1, Math.round(records.perSecond / records.elsewhere));
  return n <= 1 ? 'most new records came from outside bluesky' : `1 in ${n.toLocaleString('en-US')} new records came from outside bluesky`;
}

/** "1 in 190 accounts active just now wrote outside bluesky, spread across about 10 apps' worth", or that nobody did. */
export function diversityText(d: { share: number; spread: number }): string {
  if (d.share <= 0) return 'nobody active just now wrote outside bluesky';
  const n = Math.round(100 / d.share);
  const apps = Math.max(1, Math.round(d.spread));
  const who = n <= 1 ? 'most accounts' : `1 in ${n.toLocaleString('en-US')} accounts`;
  return `${who} active just now wrote outside bluesky, ${apps === 1 ? 'all in about one app' : `spread across about ${apps} apps' worth`}`;
}

/** Sizes a two-part bar (bluesky, elsewhere) for elsewhere's share, in percent. A sliver of "elsewhere" stays visible. */
export function renderShare(bsky: HTMLElement | null, elsewhere: HTMLElement | null, share: number): void {
  if (bsky) bsky.style.flexGrow = String(100 - share);
  if (elsewhere) {
    elsewhere.style.flexGrow = String(share);
    elsewhere.hidden = share <= 0;
  }
}

/** The bar for new records: bluesky's and everyone else's. */
export function renderRatio(bsky: HTMLElement | null, elsewhere: HTMLElement | null, records: NonNullable<Reading['records']>): void {
  renderShare(bsky, elsewhere, records.perSecond > 0 && records.elsewhere > 0 ? (records.elsewhere / records.perSecond) * 100 : 0);
}

/** The diversity index's own words and bar: by accounts, or by records for a reading from before it went by accounts. */
function renderMix(text: HTMLElement | null, bsky: HTMLElement | null, elsewhere: HTMLElement | null, r: Reading): void {
  const d = r.diversity;
  if (d?.share !== undefined && d.spread !== undefined) {
    if (text) rollText(text, diversityText({ share: d.share, spread: d.spread }));
    renderShare(bsky, elsewhere, d.share);
  } else if (r.records) {
    if (text) rollText(text, ratioText(r.records));
    renderRatio(bsky, elsewhere, r.records);
  }
}

/** Sets `el` to `to`, its digits rolling up or down from the number it shows now. */
export function countTo(el: HTMLElement, to: number, format: (n: number) => string = (n) => String(Math.round(n))): void {
  const from = Number(el.dataset.value ?? NaN);
  el.dataset.value = String(to);
  rollText(el, format(to), Number.isFinite(from) ? Math.sign(to - from) : undefined);
}

/**
 * Turns the little sun's rays with how busy the network is. The rate is kept on the rays
 * (data-rate), so a reader spinning the report's sun (weather-hero.ts, data-boost) speeds
 * them up on top of it.
 */
export function spinRays(root: ParentNode, recordsPerSecond: number): void {
  const rays = root.querySelector<SVGElement>('[data-weather-rays]');
  if (!rays) return;
  const rate = Math.max(0.3, Math.min(3, recordsPerSecond / RAYS_BASELINE));
  rays.dataset.rate = String(rate);
  const spin = rays.getAnimations?.()[0];
  if (spin) spin.playbackRate = rate * (Number(rays.dataset.boost) || 1);
}

/**
 * The headline: every new record a second, in any app. A reading from before the
 * whole-firehose sampler has no records, so it falls back to Bluesky's posts.
 */
export function recordsPerSecond(r: Reading): number {
  return r.records?.perSecond ?? r.perSecond.posts;
}

/** The home tile's line on where the atmosphere lives: "1,889 pds hosts, 1,799 independent · hosting diversity 7.5". */
export function hostsLine(h: Hosts): string {
  return `${h.active.toLocaleString('en-US')} pds hosts, ${h.independent.toLocaleString('en-US')} independent · hosting diversity ${formatIndex(h.diversity.index)}`;
}

export function renderReading(tile: HTMLElement, reading: Reading): void {
  const set = (name: string, value: number) => {
    const el = tile.querySelector<HTMLElement>(`[data-weather-${name}]`);
    if (el) countTo(el, value);
  };
  set('records', recordsPerSecond(reading));
  set('posts', reading.perSecond.posts);
  set('likes', reading.perSecond.likes);
  set('reposts', reading.perSecond.reposts);
  set('follows', reading.perSecond.follows);
  const cond = tile.querySelector<HTMLElement>('[data-weather-cond]');
  if (cond) cond.textContent = CONDITION_TEXT[reading.condition];
  spinRays(tile, recordsPerSecond(reading));
  const spark = tile.querySelector<HTMLElement>('[data-weather-spark]');
  if (spark) renderSpark(spark, reading);
  const sky = tile.querySelector<HTMLElement>('[data-weather-sky]');
  if (sky && reading.diversity) renderClouds(sky, cloudCount(reading.diversity.index));
  // its room is kept while the tile loads; a reading from before the diversity index has none
  const mix = tile.querySelector<HTMLElement>('[data-weather-mix]');
  if (mix) mix.hidden = !(reading.records && reading.diversity);
  if (mix && reading.records && reading.diversity) {
    const index = tile.querySelector<HTMLElement>('[data-weather-index]');
    if (index) countTo(index, reading.diversity.index, formatIndex);
    const level = tile.querySelector<HTMLElement>('[data-weather-level]');
    if (level) level.textContent = reading.diversity.level;
    renderMix(tile.querySelector('[data-weather-mix-text]'), tile.querySelector('[data-weather-bar-bsky]'), tile.querySelector('[data-weather-bar-else]'), reading);
  }
  const hosts = tile.querySelector<HTMLElement>('[data-weather-hosts]');
  if (hosts) {
    hosts.hidden = !reading.hosts;
    if (reading.hosts) hosts.textContent = hostsLine(reading.hosts);
  }
  tile.removeAttribute('aria-busy');
  tile.dataset.state = 'ready';
}

export function renderWeatherError(tile: HTMLElement): void {
  // A reading already on screen stays; only a tile that never loaded says so.
  if (tile.dataset.state === 'ready') return;
  const cond = tile.querySelector<HTMLElement>('[data-weather-cond]');
  if (cond) cond.textContent = ERROR_TEXT;
  tile.removeAttribute('aria-busy');
  tile.dataset.state = 'error';
}

export function initWeather(root: ParentNode = document, fetchImpl: typeof fetch = fetch): void {
  const tile = root.querySelector<HTMLElement>('[data-weather-tile]');
  if (!tile || tile.dataset.weatherBound === 'true') return;
  tile.dataset.weatherBound = 'true';
  // aria-busy only from JS: without JS the tile isn't shown at all
  tile.setAttribute('aria-busy', 'true');
  const stored = storedReading();
  if (stored) renderReading(tile, stored);
  let onScreen = !('IntersectionObserver' in window);
  let every = REFRESH_MS;
  let checkedAt = -Infinity;
  let checking = false;
  let timer: number | undefined;
  const due = () => onScreen && document.visibilityState !== 'hidden';
  const check = async () => {
    if (checking) return;
    checking = true;
    window.clearTimeout(timer);
    checkedAt = Date.now();
    const reading = await readAtmosphere(fetchImpl);
    checking = false;
    if (reading) renderReading(tile, reading);
    else renderWeatherError(tile);
    every = reading?.source === 'station' ? LIVE_REFRESH_MS : REFRESH_MS;
    timer = window.setTimeout(() => {
      if (due()) void check();
    }, every);
  };
  // Back on screen, or back in the tab, with a reading that's had its time: check now.
  const resume = () => {
    if (due() && Date.now() - checkedAt >= every) void check();
  };
  // The first reading straight away, whether the tile is on screen or not: the hero's scene
  // asks at the same moment, so it's the same request (readAtmosphere).
  void check();
  document.addEventListener('visibilitychange', resume);
  if (onScreen) return;
  new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      resume();
    },
    { rootMargin: '200px 0px' },
  ).observe(tile);
}
