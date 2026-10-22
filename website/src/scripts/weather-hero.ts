/**
 * The weather report's header (weather/index.html, .weather-hero) as a window on the sky:
 *
 *   the reader's clock  dawn, day, golden hour or night, by the reader's own clock, like Poe's
 *                       hill on the home page (sky-clock.ts). The dark theme is always night,
 *                       and by night the sun is the moon. data-time on the header.
 *   the weather         the station's reading as weather you can see (airFor): a wisp or two
 *                       of wind when it's breezy, streaks of it when it's gusty, and a grey sky
 *                       with rain when it's stormy (snow in winter). data-condition on the
 *                       header, and the bits in its air ([data-weather-air], renderAir).
 *   a rainbow           when a storm clears (clearedUp), and for anyone who gives the sun
 *                       enough spins (bindSun, sunReaction); by night it's a moonbow.
 *
 * The clouds that come with the diversity index are weather-sky.ts, and weather.css paints
 * all of it. Everything here is decoration (aria-hidden); the reading says it in words, and
 * Poe says what the sun's spins do. Under reduced motion the rain and wind rest where they
 * are, nothing spins or bounces, and a rainbow just appears and goes.
 */

import { say, type PoeLine, type PoeSpeech } from '../poe/say';
import type { MascotFace } from './mascot';
import { motionOK, ROLL_EASE, ROLL_MS } from './roll';
import { seasonOf, timeOfDay, type Season, type TimeOfDay } from './sky-clock';
import { getTheme } from './theme';
import type { Condition } from './weather';

export type Air = 'still' | 'breeze' | 'gusts' | 'rain' | 'snow';

/** What the sky does for a reading: rain in a storm (snow in winter), wind when it blows. */
export function airFor(condition: Condition, season: Season): Air {
  if (condition === 'stormy') return season === 'winter' ? 'snow' : 'rain';
  if (condition === 'gusty') return 'gusts';
  if (condition === 'breezy') return 'breeze';
  return 'still';
}

/** How a bit of weather goes and how fast, in seconds: [fewest, most]. */
const BITS: Record<Exclude<Air, 'still'>, Array<{ kind: 'rain' | 'snow' | 'gust' | 'wisp'; n: number; dur: [number, number] }>> = {
  breeze: [{ kind: 'wisp', n: 2, dur: [6, 9] }],
  gusts: [{ kind: 'gust', n: 7, dur: [1.6, 2.8] }],
  rain: [
    { kind: 'rain', n: 40, dur: [0.55, 0.9] },
    { kind: 'gust', n: 3, dur: [1.4, 2.2] },
  ],
  snow: [{ kind: 'snow', n: 36, dur: [7, 13] }],
};

/** A bit that's going fades for this long before it's taken away. */
const FADE_MS = 1200;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Brings the header's air to `air`: the bits for it, each with its own place and speed, the
 * ones there before fading out. The same air twice leaves it alone, so a reading every few
 * seconds doesn't restart the rain. A rainbow in the air stays where it is.
 */
export function renderAir(layer: HTMLElement, air: Air, random: () => number = Math.random): void {
  if (layer.dataset.air === air) return;
  layer.dataset.air = air;
  const doc = layer.ownerDocument;
  for (const old of layer.querySelectorAll<HTMLElement>('.weather-air__bit:not(.is-going)')) {
    if (!motionOK()) {
      old.remove();
      continue;
    }
    old.classList.add('is-going');
    doc.defaultView?.setTimeout(() => old.remove(), FADE_MS);
  }
  if (air === 'still') return;
  for (const { kind, n, dur } of BITS[air]) {
    for (let i = 0; i < n; i++) {
      const d = dur[0] + random() * (dur[1] - dur[0]);
      const bit = doc.createElement('span');
      bit.className = `weather-air__bit weather-air__bit--${kind}`;
      bit.style.setProperty('--x', pct(random()));
      bit.style.setProperty('--y', pct(0.08 + random() * 0.84));
      bit.style.setProperty('--dur', `${d.toFixed(2)}s`);
      bit.style.setProperty('--at', `${(-random() * d).toFixed(2)}s`);
      bit.style.setProperty('--size', (0.6 + random() * 0.7).toFixed(2));
      layer.append(bit);
    }
  }
}

/** A storm clearing: stormy, then calmer than gusty. That's when the rainbow comes out. */
export function clearedUp(before: Condition | null | undefined, now: Condition): boolean {
  return before === 'stormy' && (now === 'calm' || now === 'light' || now === 'breezy');
}

/** How long a rainbow stays out. */
export const RAINBOW_MS = 60_000;
/** A storm's rainbow comes at most this often, however the sky flickers about the line. */
export const RAINBOW_COOLDOWN_MS = 10 * 60_000;

const rainbows = new WeakMap<HTMLElement, { timer?: number }>();

/**
 * A rainbow over the header for `ms` (a moonbow by night: weather.css only needs data-time).
 * Showing one while one's out keeps it out a little longer.
 */
export function showRainbow(hero: HTMLElement, ms: number = RAINBOW_MS): void {
  const air = hero.querySelector<HTMLElement>('[data-weather-air]');
  const win = hero.ownerDocument.defaultView;
  if (!air || !win) return;
  let bow = air.querySelector<HTMLElement>('.weather-air__rainbow');
  if (!bow) {
    bow = hero.ownerDocument.createElement('span');
    bow.className = 'weather-air__rainbow';
    air.prepend(bow);
  }
  const state = rainbows.get(hero) ?? {};
  rainbows.set(hero, state);
  win.clearTimeout(state.timer);
  bow.classList.remove('is-going');
  hero.dataset.rainbow = 'out';
  state.timer = win.setTimeout(() => {
    bow.classList.add('is-going');
    delete hero.dataset.rainbow;
    state.timer = win.setTimeout(() => bow.remove(), motionOK() ? 2000 : 0);
  }, ms);
}

/** The header's time of day, and what the sun button is called by it. */
export function setHeroTime(hero: HTMLElement, date: Date = new Date()): TimeOfDay {
  const time = timeOfDay(date, getTheme());
  hero.dataset.time = time;
  const sun = hero.querySelector<HTMLElement>('[data-sun-spin]');
  sun?.setAttribute('aria-label', time === 'night' ? 'give the moon a spin' : 'give the sun a spin');
  return time;
}

// ---------- spinning the sun ----------

/** Spins this far apart count as one go; after a longer pause the sun settles back. */
export const SPIN_RESET_MS = 5000;
/** How much faster each spin in a go turns the rays, and the most they turn. */
const SPIN_BOOST = 0.6;
const MAX_BOOST = 8;

export interface SunReaction {
  say?: string;
  face?: MascotFace;
  rainbow?: boolean;
}

/** What Poe says, and whether a rainbow comes out, on the nth spin in a go (1-based). By night it's the moon. */
export function sunReaction(n: number, night: boolean): SunReaction {
  if (n === 3) return night ? { say: "shh, the moon's trying to sleep", face: 'sleepy' } : { say: "careful, you'll whip up a storm", face: 'wow' };
  if (n === 6) return night ? { say: "ok, the moon's up now", face: 'wink' } : { say: "wheee, it's getting dizzy up there", face: 'happy' };
  if (n === 10) return night ? { say: "a moonbow! they're real, look it up (◕‿◕)", face: 'kawaii', rainbow: true } : { say: 'you spun up a rainbow (◕‿◕)', face: 'kawaii', rainbow: true };
  if (n > 10 && n % 10 === 0) return night ? { say: 'another moonbow, just for you', face: 'happy', rainbow: true } : { say: 'another rainbow. legend.', face: 'happy', rainbow: true };
  return {};
}

/** The rays turn this much faster than the reading has them (weather.ts spinRays keeps the reading's part). */
export function boostRays(hero: HTMLElement, boost: number): void {
  const rays = hero.querySelector<SVGElement>('[data-weather-rays]');
  if (!rays) return;
  rays.dataset.boost = String(boost);
  const spin = rays.getAnimations?.()[0];
  if (spin) spin.playbackRate = Number(rays.dataset.rate || 1) * boost;
}

export interface SunOptions {
  speak?: (line: PoeLine) => PoeSpeech | null;
  now?: () => number;
}

/**
 * The sun (the moon by night) is a button: each press bounces it and turns its rays
 * faster, a few in a row get a word from Poe, and ten bring out a rainbow (sunReaction).
 * After SPIN_RESET_MS without a press it settles back to the reading's own speed.
 */
export function bindSun(hero: HTMLElement, opts: SunOptions = {}): void {
  const button = hero.querySelector<HTMLButtonElement>('[data-sun-spin]');
  const win = hero.ownerDocument.defaultView;
  if (!button || !win || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';
  const speak = opts.speak ?? say;
  const now = opts.now ?? (() => Date.now());
  let n = 0;
  let last = -Infinity;
  let settle: number | undefined;
  button.addEventListener('click', () => {
    const t = now();
    n = t - last > SPIN_RESET_MS ? 1 : n + 1;
    last = t;
    if (motionOK()) {
      boostRays(hero, Math.min(MAX_BOOST, 1 + n * SPIN_BOOST));
      button.firstElementChild?.animate?.([{ scale: 1 }, { scale: 0.86 }, { scale: 1.08 }, { scale: 1 }], { duration: 420, easing: 'ease-out' });
    }
    const night = hero.dataset.time === 'night';
    const reaction = sunReaction(n, night);
    if (reaction.rainbow) showRainbow(hero, 12_000);
    if (reaction.say) speak({ text: reaction.say, face: reaction.face, ms: 4000 });
    win.clearTimeout(settle);
    settle = win.setTimeout(() => {
      n = 0;
      boostRays(hero, 1);
    }, SPIN_RESET_MS);
  });
}

/**
 * The header's clock: set now, again every minute (golden hour comes on its own), and when
 * the theme flips. The sun gets its button.
 */
export function initHero(hero: HTMLElement, opts: SunOptions = {}): void {
  setHeroTime(hero);
  const win = hero.ownerDocument.defaultView;
  win?.setInterval(() => setHeroTime(hero), 60_000);
  win?.addEventListener('theme:change', () => setHeroTime(hero));
  bindSun(hero, opts);
  const reading = hero.querySelector<HTMLElement>('.weather-hero__reading');
  if (reading) smoothHeight(hero, reading);
}

/**
 * Eases the header to its new height whenever the reading under the sun grows or shrinks
 * (the first numbers landing, a chip coming or going, the line hiding), instead of the
 * tiles below jumping. A ResizeObserver hears it after layout and before paint, so the
 * first frame still shows the old height. A change of width (the window resizing) just
 * lets the header be. data-easing on the header clips it while it eases.
 */
export function smoothHeight(hero: HTMLElement, reading: HTMLElement): void {
  if (typeof ResizeObserver !== 'function') return;
  let height = hero.offsetHeight;
  let width = hero.offsetWidth;
  let easing: Animation | null = null;
  new ResizeObserver(() => {
    // where it is now, mid-ease or not, then where it's going
    const from = hero.getBoundingClientRect().height;
    easing?.cancel();
    delete hero.dataset.easing;
    const to = hero.offsetHeight;
    const resized = hero.offsetWidth !== width;
    width = hero.offsetWidth;
    const before = easing ? from : height;
    height = to;
    easing = null;
    if (resized || Math.abs(before - to) < 1 || !motionOK() || typeof hero.animate !== 'function') return;
    hero.dataset.easing = '';
    const ease = hero.animate([{ height: `${before}px` }, { height: `${to}px` }], { duration: ROLL_MS, easing: ROLL_EASE });
    easing = ease;
    ease.finished.then(
      () => {
        if (easing !== ease) return;
        easing = null;
        delete hero.dataset.easing;
      },
      () => {},
    );
  }).observe(reading);
}

/** The air for a reading, in the reader's season now. */
export function airNow(condition: Condition, date: Date = new Date()): Air {
  return airFor(condition, seasonOf(date));
}
