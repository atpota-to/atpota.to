/**
 * The sky on the home page's weather tile and the weather report's header gets cloudier
 * with the diversity index: a clear sky when nobody active is writing outside Bluesky, up
 * to MAX_CLOUDS when the atmosphere is really mixing it up. The index is usually a
 * couple at most, so the count follows its square root: a little diversity already shows.
 *
 * Clouds drift across like the ones on the home page's sunburst tile (home.css). Each
 * slot always has the same height, size and speed, so a new reading only adds or removes
 * clouds at the end instead of reshuffling the sky; a cloud fades in or out as it comes
 * and goes. Under reduced motion the clouds rest where they are and just appear.
 *
 * The layer is decoration ([aria-hidden]); the index itself is always in words nearby.
 */

export const MAX_CLOUDS = 8;
/** Where "extreme" starts on the diversity scale (weather.ts DIVERSITY_SCALE). */
const INDEX_TOP = 11;
const FADE_MS = 1200;

/** How many clouds a diversity index brings. */
export function cloudCount(index: number): number {
  if (!(index > 0)) return 0;
  return Math.max(1, Math.round(MAX_CLOUDS * Math.sqrt(Math.min(index, INDEX_TOP) / INDEX_TOP)));
}

/** Height (% of the sky), size, seconds to cross, a head start, and where it rests under reduced motion. */
const SLOTS: ReadonlyArray<{ y: number; size: number; dur: number; at: number; rest: number }> = [
  { y: 12, size: 1, dur: 80, at: -10, rest: 16 },
  { y: 58, size: 0.75, dur: 105, at: -70, rest: 70 },
  { y: 30, size: 0.6, dur: 130, at: -40, rest: 45 },
  { y: 76, size: 0.9, dur: 95, at: -25, rest: 86 },
  { y: 4, size: 0.5, dur: 140, at: -100, rest: 30 },
  { y: 44, size: 0.8, dur: 115, at: -55, rest: 58 },
  { y: 66, size: 0.65, dur: 90, at: -85, rest: 6 },
  { y: 22, size: 0.7, dur: 125, at: -5, rest: 94 },
];

function reducedMotion(win: Window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Brings the sky to `count` clouds, keeping the ones already there. */
export function renderClouds(layer: HTMLElement, count: number, win: Window = window): void {
  const want = Math.max(0, Math.min(MAX_CLOUDS, Math.round(count)));
  const doc = layer.ownerDocument;
  const here = [...layer.querySelectorAll<HTMLElement>('.weather-sky__drift:not(.is-going)')];
  for (let i = here.length; i < want; i++) {
    const s = SLOTS[i]!;
    const drift = doc.createElement('span');
    drift.className = 'weather-sky__drift is-new';
    drift.dataset.slot = String(i);
    drift.style.setProperty('--y', `${s.y}%`);
    drift.style.setProperty('--size', String(s.size));
    drift.style.setProperty('--dur', `${s.dur}s`);
    drift.style.setProperty('--at', `${s.at}s`);
    drift.style.setProperty('--rest', `${s.rest}%`);
    const cloud = doc.createElement('span');
    cloud.className = 'weather-sky__cloud';
    drift.append(cloud);
    layer.append(drift);
  }
  for (const gone of here.slice(want)) {
    if (reducedMotion(win)) {
      gone.remove();
      continue;
    }
    gone.classList.add('is-going');
    win.setTimeout(() => gone.remove(), FADE_MS);
  }
  layer.dataset.clouds = String(want);
}
