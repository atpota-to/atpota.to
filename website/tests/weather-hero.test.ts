// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoeLine } from '../src/poe/say.js';
import { seasonOf, timeOfDay } from '../src/scripts/sky-clock.js';
import {
  airFor,
  airNow,
  bindSun,
  clearedUp,
  initHero,
  RAINBOW_MS,
  renderAir,
  setHeroTime,
  showRainbow,
  SPIN_RESET_MS,
  sunReaction,
} from '../src/scripts/weather-hero.js';
import { spinRays } from '../src/scripts/weather.js';

// The weather report's header: the reader's clock, the weather you can see, rainbows, and a sun to spin.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);
const CSS = readFileSync(resolve(process.cwd(), 'src/styles/weather.css'), 'utf8');

let hero: HTMLElement;
let air: HTMLElement;

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  document.body.innerHTML = MAIN;
  hero = document.querySelector<HTMLElement>('[data-weather-hero]')!;
  air = hero.querySelector<HTMLElement>('[data-weather-air]')!;
});

afterEach(() => {
  vi.useRealTimers();
});

/** A fixed random, stepping through [0, 1). */
const steps = () => {
  let i = 0;
  return () => ((i++ * 0.137) % 1);
};

describe("the reader's clock", () => {
  it('goes dawn, day, golden hour, night, and the dark theme is always night', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m);
    expect([at(4, 59), at(5), at(7, 59), at(8), at(16, 59), at(17), at(19, 29), at(19, 30), at(23)].map((d) => timeOfDay(d))).toEqual([
      'night',
      'dawn',
      'dawn',
      'day',
      'day',
      'golden',
      'golden',
      'night',
      'night',
    ]);
    expect(timeOfDay(at(12), 'dark')).toBe('night');
    expect(seasonOf(new Date(2026, 0, 5))).toBe('winter');
    expect(seasonOf(new Date(2026, 9, 21))).toBe('autumn');
  });

  it('sets the header to the time of day, and the sun button says the moon by night', () => {
    expect(setHeroTime(hero, new Date(2026, 9, 21, 18))).toBe('golden');
    expect(hero.dataset.time).toBe('golden');
    const sun = hero.querySelector('[data-sun-spin]')!;
    expect(sun.getAttribute('aria-label')).toBe('give the sun a spin');
    setHeroTime(hero, new Date(2026, 9, 21, 23));
    expect(sun.getAttribute('aria-label')).toBe('give the moon a spin');
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(setHeroTime(hero, new Date(2026, 9, 21, 12))).toBe('night');
  });

  it('follows the theme when it flips', () => {
    initHero(hero);
    document.documentElement.setAttribute('data-theme', 'dark');
    window.dispatchEvent(new Event('theme:change'));
    expect(hero.dataset.time).toBe('night');
  });

  it('every time of day has a sky in the light theme', () => {
    for (const time of ['dawn', 'golden', 'night']) expect(CSS, time).toContain(`.weather-hero[data-time="${time}"]`);
  });
});

describe('the weather you can see', () => {
  it('rains in a storm (snows in winter), blows when gusty or breezy, and is still otherwise', () => {
    expect(airFor('stormy', 'autumn')).toBe('rain');
    expect(airFor('stormy', 'winter')).toBe('snow');
    expect(airFor('gusty', 'summer')).toBe('gusts');
    expect(airFor('breezy', 'spring')).toBe('breeze');
    expect(airFor('light', 'plain')).toBe('still');
    expect(airFor('calm', 'winter')).toBe('still');
    expect(airNow('stormy', new Date(2026, 11, 24))).toBe('snow');
  });

  it("fills the air with bits, each with its own place and pace, and leaves the same air alone", () => {
    renderAir(air, 'rain', steps());
    const drops = air.querySelectorAll<HTMLElement>('.weather-air__bit--rain');
    expect(drops).toHaveLength(40);
    expect(air.querySelectorAll('.weather-air__bit--gust')).toHaveLength(3);
    expect(air.dataset.air).toBe('rain');
    const first = drops[0]!;
    expect(first.style.getPropertyValue('--dur')).toMatch(/^0\.\d\ds$/);
    expect(first.style.getPropertyValue('--x')).toMatch(/%$/);
    expect(new Set([...drops].map((d) => d.style.getPropertyValue('--x'))).size).toBeGreaterThan(5);
    renderAir(air, 'rain', steps());
    expect(air.querySelector('.weather-air__bit')).toBe(first);
  });

  it('swaps one weather for another, and clears it when it goes still', () => {
    renderAir(air, 'snow', steps());
    expect(air.querySelectorAll('.weather-air__bit--snow')).toHaveLength(36);
    renderAir(air, 'breeze', steps());
    // no motion here (jsdom has no matchMedia): the old bits go at once
    expect(air.querySelectorAll('.weather-air__bit--snow')).toHaveLength(0);
    expect(air.querySelectorAll('.weather-air__bit--wisp')).toHaveLength(2);
    renderAir(air, 'still', steps());
    expect(air.querySelectorAll('.weather-air__bit')).toHaveLength(0);
  });

  it('every bit of weather is drawn, and none of it shows in forced colours', () => {
    for (const kind of ['rain', 'snow', 'gust', 'wisp']) expect(CSS, kind).toContain(`.weather-air__bit--${kind}`);
    expect(CSS).toMatch(/@media \(forced-colors: active\)[\s\S]*\.weather-air/);
    expect(air.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('rainbows', () => {
  it('come out when a storm clears, not when it just eases', () => {
    expect(clearedUp('stormy', 'breezy')).toBe(true);
    expect(clearedUp('stormy', 'calm')).toBe(true);
    expect(clearedUp('stormy', 'gusty')).toBe(false);
    expect(clearedUp('gusty', 'calm')).toBe(false);
    expect(clearedUp(null, 'calm')).toBe(false);
  });

  it('stays out for a while, then goes, and another one keeps it out', () => {
    vi.useFakeTimers();
    renderAir(air, 'breeze', steps());
    showRainbow(hero);
    const bow = air.querySelector('.weather-air__rainbow')!;
    expect(hero.dataset.rainbow).toBe('out');
    // a reading's new air leaves the rainbow be
    renderAir(air, 'gusts', steps());
    expect(air.querySelector('.weather-air__rainbow')).toBe(bow);
    vi.advanceTimersByTime(RAINBOW_MS - 1000);
    showRainbow(hero, 5000);
    expect(air.querySelectorAll('.weather-air__rainbow')).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(hero.dataset.rainbow).toBe('out');
    vi.advanceTimersByTime(1000);
    expect(hero.dataset.rainbow).toBeUndefined();
    vi.advanceTimersByTime(10);
    expect(air.querySelector('.weather-air__rainbow')).toBeNull();
  });
});

describe('spinning the sun', () => {
  it('gets a word from Poe at 3 and 6, and a rainbow at 10 and every 10 after; by night it is the moon', () => {
    expect(sunReaction(1, false)).toEqual({});
    expect(sunReaction(3, false).say).toBe("careful, you'll whip up a storm");
    expect(sunReaction(3, true).say).toBe("shh, the moon's trying to sleep");
    expect(sunReaction(6, false).face).toBe('happy');
    expect(sunReaction(10, false)).toMatchObject({ rainbow: true, say: 'you spun up a rainbow (◕‿◕)' });
    expect(sunReaction(10, true)).toMatchObject({ rainbow: true });
    expect(sunReaction(10, true).say).toContain('moonbow');
    expect(sunReaction(11, false)).toEqual({});
    expect(sunReaction(20, false)).toMatchObject({ rainbow: true, say: 'another rainbow. legend.' });
  });

  it("Poe's lines are in its voice: lowercase, no dashes, a kaomoji only at the end", () => {
    for (const n of [3, 6, 10, 20]) {
      for (const night of [false, true]) {
        const said = sunReaction(n, night).say!;
        expect(said).toBe(said.toLowerCase());
        expect(said).not.toMatch(/[–—]/);
        expect(said.replace(/ \(◕‿◕\)$/, '')).not.toContain('◕');
      }
    }
  });

  it('counts presses in a go, and starts over after a pause', () => {
    vi.useFakeTimers();
    let t = 0;
    const said: PoeLine[] = [];
    bindSun(hero, { speak: (line) => (said.push(line), null), now: () => t });
    bindSun(hero, { speak: (line) => (said.push(line), null), now: () => t });
    const sun = hero.querySelector<HTMLButtonElement>('[data-sun-spin]')!;
    const press = (n: number) => {
      for (let i = 0; i < n; i++) {
        t += 200;
        sun.click();
      }
    };
    press(3);
    expect(said.map((l) => l.text)).toEqual(["careful, you'll whip up a storm"]);
    press(7);
    expect(said).toHaveLength(3);
    expect(said[2]!.text).toBe('you spun up a rainbow (◕‿◕)');
    expect(hero.dataset.rainbow).toBe('out');
    // a long pause: the next press is the first of a new go
    t += SPIN_RESET_MS + 1;
    vi.advanceTimersByTime(SPIN_RESET_MS + 1);
    press(2);
    expect(said).toHaveLength(3);
    press(1);
    expect(said).toHaveLength(4);
  });

  it('keeps the reading\'s speed on the rays for the spins to multiply', () => {
    // the sun's svg is inlined at build time (the @svg partial); here, just its rays
    hero.querySelector('[data-sun-spin]')!.innerHTML = '<svg><g data-weather-rays></g></svg>';
    const rays = hero.querySelector<SVGElement>('[data-weather-rays]')!;
    spinRays(hero, 900);
    expect(rays.dataset.rate).toBe('2');
    spinRays(hero, 10);
    expect(rays.dataset.rate).toBe('0.3');
  });
});
