// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MASCOT_URLS, bindMascot, setMascotRest } from '../src/scripts/mascot.js';
import {
  AWAY_ODDS,
  PLACES,
  SEASONS,
  TIMES,
  VISITOR_ODDS,
  WEATHER_WAIT_MS,
  initScene,
  parseScene,
  pickPlace,
  pickVisitor,
  restFace,
  seasonOf,
  timeOfDay,
  visitorsThatFit,
  weatherFor,
  type Scene,
} from '../src/scripts/scene.js';
import { applyTheme } from '../src/scripts/theme.js';
import { SHARE_MS, readAtmosphere, resetSharedReading } from '../src/scripts/weather.js';

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');
const at = (month: number, hour: number, minute = 0) => new Date(2026, month, 15, hour, minute);
const always = (n: number) => () => n;

beforeEach(() => {
  resetSharedReading();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  applyTheme('light');
});

describe('picking a scene', () => {
  it('follows the clock, and the dark theme is always night', () => {
    expect(timeOfDay(at(0, 4, 59))).toBe('night');
    expect(timeOfDay(at(0, 5))).toBe('dawn');
    expect(timeOfDay(at(0, 7, 59))).toBe('dawn');
    expect(timeOfDay(at(0, 8))).toBe('day');
    expect(timeOfDay(at(0, 16, 59))).toBe('day');
    expect(timeOfDay(at(0, 17))).toBe('golden');
    expect(timeOfDay(at(0, 19, 29))).toBe('golden');
    expect(timeOfDay(at(0, 19, 30))).toBe('night');
    expect(timeOfDay(at(0, 12), 'dark')).toBe('night');
  });

  it('follows the month for the season', () => {
    expect([0, 1, 11].map((m) => seasonOf(at(m, 12)))).toEqual(['winter', 'winter', 'winter']);
    expect([2, 3, 4].map((m) => seasonOf(at(m, 12)))).toEqual(['spring', 'spring', 'spring']);
    expect([5, 6, 7].map((m) => seasonOf(at(m, 12)))).toEqual(['summer', 'summer', 'summer']);
    expect([8, 9, 10].map((m) => seasonOf(at(m, 12)))).toEqual(['autumn', 'autumn', 'autumn']);
  });

  it('goes away now and then: a cloud by day, the moon at night', () => {
    expect(pickPlace('day', always(AWAY_ODDS))).toBe('hill');
    expect(pickPlace('day', always(0))).toBe('cloud');
    expect(pickPlace('golden', always(0))).toBe('cloud');
    expect(pickPlace('night', always(0))).toBe('moon');
  });

  it('reads the weather station: only gusty and stormy change the sky', () => {
    expect(weatherFor('calm', 'summer')).toBe('calm');
    expect(weatherFor('light', 'summer')).toBe('calm');
    expect(weatherFor('breezy', 'summer')).toBe('calm');
    expect(weatherFor('gusty', 'summer')).toBe('gusty');
    expect(weatherFor('stormy', 'summer')).toBe('rain');
    expect(weatherFor('stormy', 'winter')).toBe('snow');
    expect(weatherFor(null, 'autumn')).toBe('calm');
  });

  it('only sends visitors that fit, about one visit in six', () => {
    const day: Pick<Scene, 'time' | 'season' | 'weather' | 'place'> = { time: 'day', season: 'spring', weather: 'calm', place: 'hill' };
    expect(visitorsThatFit(day)).toEqual(['butterfly']);
    expect(visitorsThatFit({ ...day, season: 'autumn' })).toEqual([]);
    expect(visitorsThatFit({ ...day, weather: 'rain' })).toEqual(['worm']);
    expect(visitorsThatFit({ ...day, time: 'night' })).toEqual(['moth']);
    expect(visitorsThatFit({ ...day, time: 'night', weather: 'snow' })).toEqual([]);
    expect(visitorsThatFit({ ...day, place: 'cloud' })).toEqual([]);
    expect(pickVisitor(day, always(VISITOR_ODDS))).toBe('none');
    expect(pickVisitor(day, always(0))).toBe('butterfly');
    expect(pickVisitor({ ...day, season: 'winter' }, always(0))).toBe('none');
  });

  it('gives Poe a face that fits', () => {
    const scene: Scene = { time: 'day', season: 'plain', weather: 'calm', ground: 'meadow', visitor: 'none', place: 'hill' };
    expect(restFace(scene)).toBeUndefined();
    expect(restFace({ ...scene, time: 'night' })).toBe('sleepy');
    expect(restFace({ ...scene, time: 'night', visitor: 'moth' })).toBe('wow');
    expect(restFace({ ...scene, visitor: 'worm' })).toBe('happy');
    expect(restFace({ ...scene, place: 'moon' })).toBe('wow');
  });

  it('reads a ?scene preview, one word per layer', () => {
    expect(parseScene('?scene=night,winter,snow,deeper,moth,moon')).toEqual({ time: 'night', season: 'winter', weather: 'snow', ground: 'deeper', visitor: 'moth', place: 'moon' });
    expect(parseScene('?scene=Golden%20plain,hail')).toEqual({ time: 'golden', season: 'plain' });
    expect(parseScene('?scene=night,dawn')).toEqual({ time: 'dawn' });
    expect(parseScene('?other=1')).toEqual({});
  });
});

describe('the first-paint script in index.html', () => {
  const source = /<div class="tile home-sun"[^>]*>\s*<script>([\s\S]*?)<\/script>/.exec(INDEX)?.[1] ?? '';
  const run = (search = '') => {
    window.history.replaceState(null, '', `/${search}`);
    const tile = document.createElement('div');
    new Function('tile', source.replace('document.currentScript.parentNode', 'tile'))(tile);
    return tile;
  };

  it('is there, at the top of the scene tile', () => {
    expect(source).toContain("tile.setAttribute('data-time'");
    expect(INDEX).toMatch(/<div class="tile home-sun"[^>]*data-scene[^>]*data-ground="meadow"/);
  });

  it('picks the same time of day and season as scene.ts', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    for (let month = 0; month < 12; month++) {
      for (let half = 0; half < 48; half++) {
        const now = at(month, Math.floor(half / 2), (half % 2) * 30);
        vi.setSystemTime(now);
        const tile = run();
        expect([tile.dataset.time, tile.dataset.season, tile.dataset.place]).toEqual([timeOfDay(now), seasonOf(now), 'hill']);
      }
    }
    applyTheme('dark');
    vi.setSystemTime(at(6, 12));
    expect(run().dataset.time).toBe('night');
  });

  it('rolls the same away days, and takes a preview', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(6, 12));
    vi.spyOn(Math, 'random').mockReturnValue(AWAY_ODDS / 2);
    expect(run().dataset.place).toBe(pickPlace('day', always(AWAY_ODDS / 2)));
    vi.setSystemTime(at(6, 23));
    expect(run().dataset.place).toBe('moon');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const tile = run('?scene=dawn,winter,moon,snow');
    expect([tile.dataset.time, tile.dataset.season, tile.dataset.place]).toEqual(['dawn', 'winter', 'moon']);
    for (const [layer, values] of [['time', TIMES], ['season', SEASONS], ['place', PLACES]] as const) {
      for (const value of values) expect(run(`?scene=${value}`).dataset[layer]).toBe(value);
    }
  });
});

describe('the scene on the tile', () => {
  const TILE = `
    <div class="home-sun" data-mascot-trigger data-scene data-ground="meadow">
      <div data-scene-life></div>
      <img data-mascot="kawaii" data-mascot-dark="sleepy" data-pet src="${MASCOT_URLS.kawaii}" alt="poe">
      <div data-scene-visitor></div>
    </div>`;
  const reading = (condition: string) =>
    vi.fn(async () => Response.json({ perSecond: { posts: 1, likes: 1, reposts: 1, follows: 1 }, condition })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const setUp = () => {
    document.body.innerHTML = TILE;
    const tile = document.querySelector<HTMLElement>('[data-scene]')!;
    const img = tile.querySelector<HTMLImageElement>('img')!;
    bindMascot(img);
    return { tile, img };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('rains when the network is stormy, and a worm comes up for it', async () => {
    const { tile } = setUp();
    tile.dataset.place = 'hill';
    const fetchImpl = reading('stormy');
    initScene(document, { fetchImpl, random: always(0.001), now: () => at(6, 12), search: '' });
    expect(tile.dataset.weather).toBe('calm');
    expect(tile.dataset.visitor).toBe('none');
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([tile.dataset.time, tile.dataset.season, tile.dataset.weather, tile.dataset.visitor]).toEqual(['day', 'summer', 'rain', 'worm']);
  });

  it('rolls the place itself when the inline script did not, and sends no visitors away from the hill', async () => {
    const { tile } = setUp();
    initScene(document, { fetchImpl: reading('stormy'), random: always(0.001), now: () => at(6, 12), search: '' });
    await flush();
    expect([tile.dataset.place, tile.dataset.visitor]).toEqual(['cloud', 'none']);
  });

  it('draws the weather and the visitor, and gives Poe the face for it', async () => {
    const { tile, img } = setUp();
    tile.dataset.place = 'hill';
    initScene(document, { fetchImpl: reading('stormy'), random: always(0.001), now: () => at(6, 12), search: '' });
    await flush();
    expect(tile.querySelectorAll('.home-sun__bit--rain').length).toBeGreaterThan(20);
    expect(tile.querySelector('.home-sun__visitor--worm .home-sun__hole')).not.toBeNull();
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.happy);
  });

  it('takes a preview over the network and the rolls', async () => {
    const { tile } = setUp();
    const fetchImpl = reading('calm');
    initScene(document, { fetchImpl, random: always(0.9), now: () => at(6, 12), search: '?scene=winter,snow,deeper,hill' });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect([tile.dataset.season, tile.dataset.weather, tile.dataset.ground, tile.dataset.place, tile.dataset.visitor]).toEqual(['winter', 'snow', 'deeper', 'hill', 'none']);
    expect(tile.querySelectorAll('.home-sun__bit--snow').length).toBeGreaterThan(20);
    expect(tile.querySelectorAll('.home-sun__bit--leaf, .home-sun__bit--rain').length).toBe(0);
  });

  it('keeps what the inline script picked, and settles on calm if the weather never comes', () => {
    vi.useFakeTimers();
    const { tile } = setUp();
    Object.assign(tile.dataset, { time: 'golden', season: 'autumn', place: 'hill' });
    initScene(document, { fetchImpl: (() => new Promise(() => undefined)) as typeof fetch, random: always(0.9), now: () => at(0, 3), search: '' });
    expect([tile.dataset.time, tile.dataset.season]).toEqual(['golden', 'autumn']);
    expect(tile.querySelectorAll('.home-sun__bit--leaf').length).toBeGreaterThan(0);
    vi.advanceTimersByTime(WEATHER_WAIT_MS);
    expect(tile.dataset.weather).toBe('calm');
  });

  it('turns to night with the dark theme, and back to the clock after', async () => {
    const { tile, img } = setUp();
    tile.dataset.place = 'hill';
    initScene(document, { fetchImpl: reading('calm'), random: always(0.9), now: () => at(9, 10), search: '' });
    await flush();
    expect(tile.dataset.time).toBe('day');
    applyTheme('dark');
    expect(tile.dataset.time).toBe('night');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.sleepy);
    applyTheme('light');
    expect(tile.dataset.time).toBe('day');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
  });
});

describe('the mascot rest face', () => {
  it('rests on the scene\'s face, but lets a held reaction finish first', () => {
    document.body.innerHTML = `<img data-mascot="kawaii" src="${MASCOT_URLS.kawaii}" alt="poe">`;
    const img = document.querySelector('img')!;
    bindMascot(img);
    setMascotRest(img, 'wow');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.wow);
    img.dataset.mascotHold = '';
    img.src = MASCOT_URLS.wink;
    setMascotRest(img, undefined);
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.wink);
    delete img.dataset.mascotHold;
    setMascotRest(img, undefined);
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
  });
});

describe('sharing the weather reading', () => {
  it('asks once for two readers close together', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ perSecond: { posts: 1, likes: 1, reposts: 1, follows: 1 }, condition: 'gusty' })) as unknown as typeof fetch;
    const first = await readAtmosphere(fetchImpl, 1000);
    const second = await readAtmosphere(fetchImpl, 1000 + SHARE_MS - 1);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await readAtmosphere(fetchImpl, 1000 + SHARE_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
