/**
 * "atmospheric conditions" on the home page: a weather report for the network, from
 * /api/atmosphere (server/atmosphere.ts samples Bluesky's firehose for a few seconds).
 * It loads when the tile comes near the screen and checks again once a minute while the
 * tile is on screen and the tab is visible. Numbers count up to each new reading, and the
 * little sun's rays turn faster when the network is busy. Under reduced motion the
 * numbers just change and the rays hold still.
 *
 * States live on the tile as data-state="loading" | "ready" | "error".
 */

export const ATMOSPHERE_ENDPOINT = '/api/atmosphere';
export const REFRESH_MS = 60_000;
const COUNT_MS = 700;
/** Posts a second that makes the rays turn at their CSS speed. */
const RAYS_BASELINE = 25;

export type Condition = 'calm' | 'light' | 'breezy' | 'gusty' | 'stormy';

export const CONDITION_TEXT: Record<Condition, string> = {
  calm: 'calm. a quiet moment in the atmosphere',
  light: 'a light breeze',
  breezy: 'breezy',
  gusty: 'gusty. lots of posting going on',
  stormy: 'stormy. somebody said something',
};

export const ERROR_TEXT = "the sky is hard to read right now. try again in a bit.";

export interface Reading {
  perSecond: { posts: number; likes: number; reposts: number; follows: number };
  condition: Condition;
}

function isReading(v: unknown): v is Reading {
  const r = v as Reading;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return (
    typeof r === 'object' &&
    r !== null &&
    n(r.perSecond?.posts) &&
    n(r.perSecond.likes) &&
    n(r.perSecond.reposts) &&
    n(r.perSecond.follows) &&
    Object.prototype.hasOwnProperty.call(CONDITION_TEXT, r.condition)
  );
}

export async function fetchReading(fetchImpl: typeof fetch = fetch): Promise<Reading | null> {
  try {
    const res = await fetchImpl(ATMOSPHERE_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return isReading(body) ? body : null;
  } catch {
    return null;
  }
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Sets `el` to `to`, counting from its current number when motion is welcome. */
function countTo(el: HTMLElement, to: number): void {
  const target = Math.round(to);
  const from = Number(el.dataset.value ?? NaN);
  el.dataset.value = String(target);
  if (!Number.isFinite(from) || reducedMotion() || typeof requestAnimationFrame !== 'function') {
    el.textContent = String(target);
    return;
  }
  const started = performance.now();
  const step = (t: number) => {
    if (el.dataset.value !== String(target)) return; // a newer reading took over
    const k = Math.min(1, (t - started) / COUNT_MS);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = String(Math.round(from + (target - from) * eased));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function renderReading(tile: HTMLElement, reading: Reading): void {
  const set = (name: string, value: number) => {
    const el = tile.querySelector<HTMLElement>(`[data-weather-${name}]`);
    if (el) countTo(el, value);
  };
  set('posts', reading.perSecond.posts);
  set('likes', reading.perSecond.likes);
  set('reposts', reading.perSecond.reposts);
  set('follows', reading.perSecond.follows);
  const cond = tile.querySelector<HTMLElement>('[data-weather-cond]');
  if (cond) cond.textContent = CONDITION_TEXT[reading.condition];
  const rays = tile.querySelector<SVGElement>('.home-weather__rays');
  const spin = rays?.getAnimations?.()[0];
  if (spin) spin.playbackRate = Math.max(0.3, Math.min(3, reading.perSecond.posts / RAYS_BASELINE));
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
  const load = async () => {
    const reading = await fetchReading(fetchImpl);
    if (reading) renderReading(tile, reading);
    else renderWeatherError(tile);
  };
  const begin = () => {
    if (started) return;
    started = true;
    void load();
    window.setInterval(() => {
      if (onScreen && document.visibilityState !== 'hidden') void load();
    }, REFRESH_MS);
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
