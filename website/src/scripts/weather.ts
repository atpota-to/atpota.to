/**
 * "atmospheric conditions" on the home page: a weather report for the network, from
 * /api/atmosphere (server/atmosphere.ts samples the whole firehose for a few seconds).
 * The tile is a link to the full report at /weather (weather-page.ts), which reuses the
 * reading, its checks and its wording from here.
 * It loads when the tile comes near the screen and checks again while the tile is on
 * screen and the tab is visible: every 15 seconds when the reading is the weather
 * station's live 60 seconds, once a minute when it's the fallback sample. Numbers count up to each new reading, and the
 * little sun's rays turn faster when the network is busy. Under reduced motion the
 * numbers just change and the rays hold still.
 *
 * Under the Bluesky numbers sits the diversity index: the share of new records written
 * outside Bluesky, with a bar for the split, and the sky behind it all gets cloudier as
 * the index climbs (weather-sky.ts).
 *
 * States live on the tile as data-state="loading" | "ready" | "error".
 */

import { cloudCount, renderClouds } from './weather-sky';

export const ATMOSPHERE_ENDPOINT = '/api/atmosphere';
export const REFRESH_MS = 60_000;
/** How often the tile checks while readings come live from the weather station (a rolling 60 seconds). */
export const LIVE_REFRESH_MS = 15_000;
const COUNT_MS = 700;
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
  diversity?: { index: number; level: DiversityLevel; apps: number; collections: number };
  apps?: App[];
  bluesky?: Array<Rate & { nsid: string }>;
  events?: { creates: number; updates: number; deletes: number; identity: number; account: number };
  /** "station": a rolling 60 seconds from the weather station; "sample": a few seconds sampled by the function. */
  source?: 'station' | 'sample';
  /** The station's window, second by second, oldest first; null for a second it missed. */
  series?: Array<{ t: number; creates: number; bluesky: number; elsewhere: number; posts: number } | null>;
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
  const d = r.diversity as Record<string, unknown> | undefined;
  if (nums(d, ['index', 'apps', 'collections']) && typeof d?.level === 'string' && LEVELS.has(d.level)) out.diversity = r.diversity;
  if (nums(r.events, ['creates', 'updates', 'deletes', 'identity', 'account'])) out.events = r.events;
  if (Array.isArray(r.apps)) {
    out.apps = r.apps.filter((a) => nums(a, ['perSecond', 'count']) && name(a.domain) && Array.isArray(a.collections)).map((a) => ({ ...a, collections: a.collections.filter(name).slice(0, 3) }));
  }
  if (Array.isArray(r.bluesky)) out.bluesky = r.bluesky.filter((b) => nums(b, ['perSecond', 'count']) && name(b.nsid));
  if (r.source === 'station' || r.source === 'sample') out.source = r.source;
  if (Array.isArray(r.series)) out.series = r.series.slice(-120).map((p) => (nums(p, ['t', 'creates', 'bluesky', 'elsewhere', 'posts']) ? p : null));
  return out;
}

export async function fetchReading(fetchImpl: typeof fetch = fetch): Promise<Reading | null> {
  try {
    const res = await fetchImpl(ATMOSPHERE_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return isReading(body) ? clean(body) : null;
  } catch {
    return null;
  }
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

/** Sizes a two-part bar (bluesky, elsewhere). A sliver of "elsewhere" stays visible. */
export function renderRatio(bsky: HTMLElement | null, elsewhere: HTMLElement | null, records: NonNullable<Reading['records']>): void {
  const share = records.perSecond > 0 ? (records.elsewhere / records.perSecond) * 100 : 0;
  if (bsky) bsky.style.flexGrow = String(100 - share);
  if (elsewhere) {
    elsewhere.style.flexGrow = String(share);
    elsewhere.hidden = records.elsewhere <= 0;
  }
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Sets `el` to `to`, counting from its current number when motion is welcome. */
export function countTo(el: HTMLElement, to: number, format: (n: number) => string = (n) => String(Math.round(n))): void {
  const target = format(to);
  const from = Number(el.dataset.value ?? NaN);
  el.dataset.value = String(to);
  if (!Number.isFinite(from) || reducedMotion() || typeof requestAnimationFrame !== 'function') {
    el.textContent = target;
    return;
  }
  const started = performance.now();
  const step = (t: number) => {
    if (el.dataset.value !== String(to)) return; // a newer reading took over
    const k = Math.min(1, (t - started) / COUNT_MS);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = k < 1 ? format(from + (to - from) * eased) : target;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Turns the little sun's rays with how busy the network is. */
export function spinRays(root: ParentNode, recordsPerSecond: number): void {
  const rays = root.querySelector<SVGElement>('[data-weather-rays]');
  const spin = rays?.getAnimations?.()[0];
  if (spin) spin.playbackRate = Math.max(0.3, Math.min(3, recordsPerSecond / RAYS_BASELINE));
}

/**
 * The headline: every new record a second, in any app. A reading from before the
 * whole-firehose sampler has no records, so it falls back to Bluesky's posts.
 */
export function recordsPerSecond(r: Reading): number {
  return r.records?.perSecond ?? r.perSecond.posts;
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
  const sky = tile.querySelector<HTMLElement>('[data-weather-sky]');
  if (sky && reading.diversity) renderClouds(sky, cloudCount(reading.diversity.index));
  const mix = tile.querySelector<HTMLElement>('[data-weather-mix]');
  if (mix && reading.records && reading.diversity) {
    const index = tile.querySelector<HTMLElement>('[data-weather-index]');
    if (index) countTo(index, reading.diversity.index, formatIndex);
    const level = tile.querySelector<HTMLElement>('[data-weather-level]');
    if (level) level.textContent = reading.diversity.level;
    const text = tile.querySelector<HTMLElement>('[data-weather-mix-text]');
    if (text) text.textContent = ratioText(reading.records);
    renderRatio(tile.querySelector('[data-weather-bar-bsky]'), tile.querySelector('[data-weather-bar-else]'), reading.records);
    mix.hidden = false;
  }
  tile.dataset.state = 'ready';
}

export function renderWeatherError(tile: HTMLElement): void {
  // A reading already on screen stays; only a tile that never loaded says so.
  if (tile.dataset.state === 'ready') return;
  const cond = tile.querySelector<HTMLElement>('[data-weather-cond]');
  if (cond) cond.textContent = ERROR_TEXT;
  tile.dataset.state = 'error';
}

export function initWeather(root: ParentNode = document, fetchImpl: typeof fetch = fetch): void {
  const tile = root.querySelector<HTMLElement>('[data-weather]');
  if (!tile || tile.dataset.weatherBound === 'true') return;
  tile.dataset.weatherBound = 'true';
  let onScreen = false;
  let started = false;
  let every = REFRESH_MS;
  const load = async () => {
    const reading = await fetchReading(fetchImpl);
    if (reading) renderReading(tile, reading);
    else renderWeatherError(tile);
    every = reading?.source === 'station' ? LIVE_REFRESH_MS : REFRESH_MS;
  };
  const tick = () => {
    window.setTimeout(async () => {
      if (onScreen && document.visibilityState !== 'hidden') await load();
      tick();
    }, every);
  };
  const begin = () => {
    if (started) return;
    started = true;
    void load().then(tick);
  };
  if (!('IntersectionObserver' in window)) {
    onScreen = true;
    begin();
    return;
  }
  new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) begin();
    },
    { rootMargin: '200px 0px' },
  ).observe(tile);
}
