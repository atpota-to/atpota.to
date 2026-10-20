// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newestDispatch, writeCache } from '../src/scripts/home.js';
import { MASCOT_URLS, bindMascot, setMascotRest } from '../src/scripts/mascot.js';
import { BIRD_COLOURS, drawStage, type Geometry } from '../src/scripts/scene-art.js';
import {
  AWAY_ODDS,
  BIRDS,
  DISPATCH_DAY_MS,
  EVENTS,
  PLACES,
  SEASONS,
  TAKES,
  TIMES,
  VISITOR_ODDS,
  WEATHER_WAIT_MS,
  clockScene,
  eventOn,
  initScene,
  isDispatchDay,
  mirrorPoe,
  parseScene,
  pickPlace,
  pickTake,
  pickVisitor,
  restFace,
  rightProp,
  seasonOf,
  timeOfDay,
  visitorsThatFit,
  weatherFor,
  type Scene,
} from '../src/scripts/scene.js';
import { applyTheme } from '../src/scripts/theme.js';
import { SHARE_MS, readAtmosphere, resetSharedReading } from '../src/scripts/weather.js';

const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month, day, hour, minute);
const always = (n: number) => () => n;
const BASE: Scene = { time: 'day', season: 'plain', weather: 'calm', ground: 'meadow', event: 'none', visitor: 'none', place: 'hill', visitorTake: '', eventTake: '', placeTake: '', bird: 'robin' };

beforeEach(() => {
  resetSharedReading();
  window.history.replaceState(null, '', '/');
  try {
    sessionStorage.clear();
  } catch {
    // no storage
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  applyTheme('light');
});

describe('picking a scene', () => {
  it('follows the clock, and the dark theme is always night', () => {
    expect(timeOfDay(at(0, 15, 4, 59))).toBe('night');
    expect(timeOfDay(at(0, 15, 5))).toBe('dawn');
    expect(timeOfDay(at(0, 15, 7, 59))).toBe('dawn');
    expect(timeOfDay(at(0, 15, 8))).toBe('day');
    expect(timeOfDay(at(0, 15, 16, 59))).toBe('day');
    expect(timeOfDay(at(0, 15, 17))).toBe('golden');
    expect(timeOfDay(at(0, 15, 19, 29))).toBe('golden');
    expect(timeOfDay(at(0, 15, 19, 30))).toBe('night');
    expect(timeOfDay(at(0, 15, 12), 'dark')).toBe('night');
  });

  it('follows the month for the season', () => {
    expect([0, 1, 11].map((m) => seasonOf(at(m, 15, 12)))).toEqual(['winter', 'winter', 'winter']);
    expect([2, 3, 4].map((m) => seasonOf(at(m, 15, 12)))).toEqual(['spring', 'spring', 'spring']);
    expect([5, 6, 7].map((m) => seasonOf(at(m, 15, 12)))).toEqual(['summer', 'summer', 'summer']);
    expect([8, 9, 10].map((m) => seasonOf(at(m, 15, 12)))).toEqual(['autumn', 'autumn', 'autumn']);
  });

  it("keeps halloween and new year's eve on the calendar, as night scenes", () => {
    expect(eventOn(at(9, 23, 22), 'night')).toBe('none');
    expect(eventOn(at(9, 24, 22), 'night')).toBe('halloween');
    expect(eventOn(at(9, 27, 12), 'day')).toBe('none');
    expect(eventOn(at(9, 31, 12), 'day')).toBe('halloween');
    expect(eventOn(at(11, 31, 12), 'day')).toBe('none');
    expect(eventOn(at(11, 31, 21), 'night')).toBe('newyear');
    expect(eventOn(at(0, 1, 2), 'night')).toBe('newyear');
    expect(eventOn(at(0, 1, 6), 'dawn')).toBe('none');
    expect(clockScene(at(9, 31, 12), 'light')).toEqual({ time: 'night', event: 'halloween' });
    expect(clockScene(at(9, 26, 12), 'dark')).toEqual({ time: 'night', event: 'halloween' });
    expect(clockScene(at(9, 26, 12), 'light')).toEqual({ time: 'day', event: 'none' });
    expect(clockScene(at(9, 31, 12), 'light', { time: 'day' })).toEqual({ time: 'day', event: 'halloween' });
  });

  it('goes away now and then: the moon at night, a cloud by day, sometimes the beach in summer', () => {
    expect(pickPlace('day', 'summer', 'none', always(AWAY_ODDS))).toBe('hill');
    expect(pickPlace('night', 'summer', 'none', always(0))).toBe('moon');
    expect(pickPlace('day', 'autumn', 'none', always(0))).toBe('cloud');
    expect(pickPlace('day', 'summer', 'none', always(0))).toBe('beach');
    const rolls = [0, 0.9];
    expect(pickPlace('day', 'summer', 'none', () => rolls.shift()!)).toBe('cloud');
    expect(pickPlace('day', 'summer', 'dispatch', always(0))).toBe('hill');
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

  it('makes dispatch day the day after an issue goes out', () => {
    const now = at(9, 20, 12).getTime();
    expect(isDispatchDay(now - 60_000, now)).toBe(true);
    expect(isDispatchDay(now - DISPATCH_DAY_MS + 1, now)).toBe(true);
    expect(isDispatchDay(now - DISPATCH_DAY_MS, now)).toBe(false);
    expect(isDispatchDay(now + 60_000, now)).toBe(false);
    expect(isDispatchDay(null, now)).toBe(false);
  });

  it('only sends visitors that fit, about one visit in six', () => {
    const day: Pick<Scene, 'time' | 'season' | 'weather' | 'place' | 'event'> = { time: 'day', season: 'spring', weather: 'calm', place: 'hill', event: 'none' };
    expect(visitorsThatFit(day)).toEqual(['butterfly', 'snail', 'bird']);
    expect(visitorsThatFit({ ...day, season: 'winter' })).toEqual(['bird']);
    expect(visitorsThatFit({ ...day, weather: 'rain' })).toEqual(['worm', 'snail']);
    expect(visitorsThatFit({ ...day, time: 'night' })).toEqual(['moth', 'snail']);
    expect(visitorsThatFit({ ...day, time: 'night', season: 'winter', weather: 'snow' })).toEqual([]);
    expect(visitorsThatFit({ ...day, time: 'night', season: 'autumn', event: 'halloween' })).toEqual(['moth', 'snail']);
    expect(visitorsThatFit({ ...day, place: 'beach' })).toEqual([]);
    expect(pickVisitor(day, always(VISITOR_ODDS))).toBe('none');
    expect(pickVisitor(day, always(0))).toBe('butterfly');
    expect(pickVisitor({ ...day, season: 'winter', weather: 'snow' }, always(0))).toBe('bird');
    expect(pickVisitor({ ...day, time: 'night', season: 'winter', weather: 'snow' }, always(0))).toBe('none');
  });

  it('picks takes, never two in the same spot', () => {
    for (const kind of Object.keys(TAKES) as Array<keyof typeof TAKES>) {
      for (const r of [0, 0.5, 0.99]) expect(TAKES[kind]).toContain(pickTake(kind, BASE, always(r)));
    }
    // the mailbox and the lanterns stand right of Poe, so snails and birds go elsewhere
    for (const r of [0, 0.5, 0.99]) {
      expect(pickTake('snail', { event: 'dispatch', eventTake: 'a' }, always(r))).not.toBe('c');
      expect(pickTake('bird', { event: 'halloween', eventTake: 'c' }, always(r))).not.toBe('c');
      expect(pickTake('bird', { event: 'dispatch', eventTake: 'c' }, always(r))).not.toBe('a');
    }
    expect(pickTake('snail', { event: 'dispatch', eventTake: 'c' }, always(0.99))).toBe('c');
    expect(rightProp({ ...BASE, visitor: 'snail', visitorTake: 'c' })).toBe(true);
    expect(rightProp({ ...BASE, visitor: 'snail', visitorTake: 'a' })).toBe(false);
    expect(rightProp({ ...BASE, event: 'dispatch', eventTake: 'b' })).toBe(true);
  });

  it('gives Poe a face that fits', () => {
    expect(restFace(BASE)).toBeUndefined();
    expect(restFace({ ...BASE, time: 'night' })).toBe('sleepy');
    expect(restFace({ ...BASE, time: 'night', visitor: 'moth' })).toBe('wow');
    expect(restFace({ ...BASE, visitor: 'worm' })).toBe('happy');
    expect(restFace({ ...BASE, visitor: 'bird', visitorTake: 'b' })).toBe('wow');
    expect(restFace({ ...BASE, visitor: 'bird', visitorTake: 'c' })).toBeUndefined();
    expect(restFace({ ...BASE, time: 'night', event: 'halloween', eventTake: 'a' })).toBe('wow');
    expect(restFace({ ...BASE, time: 'night', event: 'newyear', eventTake: 'b' })).toBe('happy');
    expect(restFace({ ...BASE, event: 'dispatch', eventTake: 'a' })).toBe('wink');
    expect(restFace({ ...BASE, place: 'moon' })).toBe('wow');
    expect(restFace({ ...BASE, place: 'beach' })).toBe('happy');
  });

  it('reads a ?scene preview, one word per layer, with takes and kinds of bird', () => {
    expect(parseScene('?scene=night,winter,snow,deeper,moth,moon')).toEqual({ time: 'night', season: 'winter', weather: 'snow', ground: 'deeper', visitor: 'moth', place: 'moon' });
    expect(parseScene('?scene=Golden%20plain,hail')).toEqual({ time: 'golden', season: 'plain' });
    expect(parseScene('?scene=night,dawn')).toEqual({ time: 'dawn' });
    expect(parseScene('?scene=snail-c,dispatch-b,beach-a')).toEqual({ visitor: 'snail', visitorTake: 'c', event: 'dispatch', eventTake: 'b', place: 'beach', placeTake: 'a' });
    expect(parseScene('?scene=bird-b,bluetit,halloween-z')).toEqual({ visitor: 'bird', visitorTake: 'b', bird: 'bluetit', event: 'halloween' });
    expect(parseScene('?scene=none')).toEqual({ visitor: 'none' });
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

  it('picks the same time of day, season and special day as scene.ts', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const days: Array<[number, number]> = [[0, 1], [0, 15], [2, 10], [5, 21], [8, 30], [9, 23], [9, 24], [9, 28], [9, 31], [11, 30], [11, 31]];
    for (const theme of ['light', 'dark'] as const) {
      applyTheme(theme);
      for (const [month, day] of days) {
        for (let half = 0; half < 48; half++) {
          const now = at(month, day, Math.floor(half / 2), (half % 2) * 30);
          vi.setSystemTime(now);
          const tile = run();
          const want = clockScene(now, theme);
          expect([tile.dataset.time, tile.dataset.season, tile.dataset.event, tile.dataset.place]).toEqual([want.time, seasonOf(now), want.event, 'hill']);
        }
      }
    }
  });

  it('rolls the same away days, and takes a preview', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(AWAY_ODDS / 2);
    for (const [now, season] of [[at(6, 15, 12), 'summer'], [at(6, 15, 23), 'summer'], [at(3, 15, 12), 'spring'], [at(9, 31, 12), 'autumn']] as const) {
      vi.setSystemTime(now);
      const { time, event } = clockScene(now, 'light');
      expect(run().dataset.place).toBe(pickPlace(time, season, event, always(AWAY_ODDS / 2)));
    }
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.setSystemTime(at(6, 15, 12));
    const tile = run('?scene=dawn,winter,moon,snow,halloween-c');
    expect([tile.dataset.time, tile.dataset.season, tile.dataset.event, tile.dataset.place]).toEqual(['dawn', 'winter', 'halloween', 'moon']);
    for (const [layer, values] of [['time', TIMES], ['season', SEASONS], ['place', PLACES]] as const) {
      for (const value of values) expect(run(`?scene=${value}`).dataset[layer]).toBe(value);
    }
    for (const value of EVENTS.filter((e) => e !== 'none')) expect(run(`?scene=${value}`).dataset.event).toBe(value);
  });
});

describe('drawing the scene', () => {
  const GEO: Geometry = { w: 592, h: 540, poe: { left: 112, top: 147, width: 360, height: 293 }, mound: { left: -47, top: 400, width: 686, height: 150 } };
  const draw = (scene: Partial<Scene>, reducedMotion = false) => drawStage({ ...BASE, ...scene }, GEO, { random: always(0.4), reducedMotion });

  it('draws each take where it belongs', () => {
    expect(draw({ visitor: 'snail', visitorTake: 'a' }).back).toContain('animateMotion');
    expect(draw({ visitor: 'snail', visitorTake: 'b' }).front).toContain('stroke-dasharray');
    expect(draw({ visitor: 'snail', visitorTake: 'c' }).front).toContain('home-art-heart');
    for (const take of ['a', 'b']) expect(draw({ visitor: 'bird', visitorTake: take, bird: 'bluetit' }).wornFront).toContain(BIRD_COLOURS.bluetit.breast);
    expect(draw({ visitor: 'bird', visitorTake: 'c' }).front).toContain('home-art-hopabout');
    expect(draw({ event: 'dispatch', eventTake: 'a' }).back).toContain('home-art-flag');
    expect(draw({ event: 'dispatch', eventTake: 'b' }).front).toContain('animateMotion');
    expect(draw({ event: 'dispatch', eventTake: 'c' }).wornBack).toContain('<rect');
    expect(draw({ event: 'newyear', eventTake: 'a' }).back.match(/home-art-burst/g)).toHaveLength(5);
    expect(draw({ event: 'newyear', eventTake: 'b' }).wornFront).toContain('home-art-sparkle');
    expect(draw({ event: 'halloween', eventTake: 'a' }).back.match(/url\(#home-art-glow\)/g)).toHaveLength(1);
    expect(draw({ event: 'halloween', eventTake: 'c' }).front).toContain('home-art-ghost');
    expect(draw({ place: 'beach', placeTake: 'a' }).back).toContain('#F2CF84');
    const b = draw({ place: 'beach', placeTake: 'b' });
    expect(b.wornFront).toContain('#2C4A5C');
    expect(b.back).not.toContain('#F2CF84');
    expect(draw({ place: 'moon' }).wornFront).toContain('<ellipse');
    expect(draw({})).toEqual({ back: '', front: '', wornBack: '', wornFront: '' });
  });

  it('sits things on the real hill, and keeps still under reduced motion', () => {
    const still = draw({ visitor: 'snail', visitorTake: 'a' }, true);
    expect(still.back).not.toContain('animateMotion');
    const y = Number(/translate\([\d.]+ ([\d.]+)\)/.exec(still.back)?.[1]);
    // the crest of a 686 x 150 half ellipse, 78% across a 592 wide tile
    const x = 592 * 0.78;
    const crest = 400 + 150 * (1 - Math.sqrt(1 - ((x - 296) / 343) ** 2));
    expect(Math.abs(y - crest)).toBeLessThan(3);
    expect(draw({ event: 'dispatch', eventTake: 'b' }, true).front).not.toContain('animateMotion');
  });
});

describe('the scene on the tile', () => {
  const TILE = `
    <div class="home-sun" data-mascot-trigger data-scene data-ground="meadow">
      <div class="home-sun__mound"></div>
      <div data-scene-life></div>
      <svg data-scene-stage="back"></svg>
      <svg data-scene-worn="back" viewBox="0 0 515 419"></svg>
      <img data-mascot="kawaii" data-mascot-dark="sleepy" data-pet src="${MASCOT_URLS.kawaii}" alt="poe">
      <svg data-scene-worn="front" viewBox="0 0 515 419"></svg>
      <svg data-scene-stage="front"></svg>
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
  const hill = (tile: HTMLElement) => Object.assign(tile.dataset, { place: 'hill', event: 'none' });

  it('rains when the network is stormy, and a worm comes up for it', async () => {
    const { tile, img } = setUp();
    hill(tile);
    const fetchImpl = reading('stormy');
    initScene(document, { fetchImpl, random: always(0.001), now: () => at(6, 15, 12), search: '' });
    expect(tile.dataset.weather).toBe('calm');
    expect(tile.dataset.visitor).toBe('none');
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([tile.dataset.time, tile.dataset.season, tile.dataset.weather, tile.dataset.visitor]).toEqual(['day', 'summer', 'rain', 'worm']);
    expect(tile.querySelectorAll('.home-sun__bit--rain').length).toBeGreaterThan(20);
    expect(tile.querySelector('.home-sun__visitor--worm .home-sun__hole')).not.toBeNull();
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.happy);
  });

  it('rolls the place itself when the inline script did not, and sends no visitors away from the hill', async () => {
    const { tile } = setUp();
    initScene(document, { fetchImpl: reading('stormy'), random: always(0.001), now: () => at(9, 15, 12), search: '' });
    await flush();
    expect([tile.dataset.place, tile.dataset.visitor]).toEqual(['cloud', 'none']);
  });

  it('turns the day after a dispatch into dispatch day, with a take that leaves room for visitors', async () => {
    const { tile } = setUp();
    hill(tile);
    const now = at(4, 12, 12);
    initScene(document, { fetchImpl: reading('calm'), dispatchedAt: async () => now.getTime() - 3_600_000, random: always(0.001), now: () => now, search: '' });
    await flush();
    expect([tile.dataset.event, tile.dataset.eventTake]).toEqual(['dispatch', 'a']);
    expect(tile.dataset.visitor).toBe('butterfly');
    expect(tile.querySelector('[data-scene-stage="back"]')!.innerHTML).toContain('home-art-flag');
    expect(tile.hasAttribute('data-right-prop')).toBe(true);
  });

  it('takes a preview over the network and the rolls, and draws the takes it names', async () => {
    const { tile } = setUp();
    const fetchImpl = reading('calm');
    initScene(document, { fetchImpl, random: always(0.9), now: () => at(6, 15, 12), search: '?scene=winter,snow,deeper,hill,bird-b,goldfinch' });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect([tile.dataset.season, tile.dataset.weather, tile.dataset.ground, tile.dataset.place, tile.dataset.visitor, tile.dataset.visitorTake, tile.dataset.bird]).toEqual(['winter', 'snow', 'deeper', 'hill', 'bird', 'b', 'goldfinch']);
    expect(tile.querySelectorAll('.home-sun__bit--snow').length).toBeGreaterThan(20);
    expect(tile.querySelector('[data-scene-worn="front"]')!.innerHTML).toContain(BIRD_COLOURS.goldfinch.breast);
  });

  it('keeps what the inline script picked, and settles on calm if nothing answers', () => {
    vi.useFakeTimers();
    const { tile } = setUp();
    Object.assign(tile.dataset, { time: 'golden', season: 'autumn', place: 'hill', event: 'none' });
    initScene(document, { fetchImpl: (() => new Promise(() => undefined)) as typeof fetch, dispatchedAt: () => new Promise(() => undefined), random: always(0.9), now: () => at(0, 15, 3), search: '' });
    expect([tile.dataset.time, tile.dataset.season]).toEqual(['golden', 'autumn']);
    expect(tile.querySelectorAll('.home-sun__bit--leaf').length).toBeGreaterThan(0);
    vi.advanceTimersByTime(WEATHER_WAIT_MS);
    expect([tile.dataset.weather, tile.dataset.event]).toEqual(['calm', 'none']);
  });

  it('turns to night with the dark theme, and back to the clock after', async () => {
    const { tile, img } = setUp();
    hill(tile);
    initScene(document, { fetchImpl: reading('calm'), random: always(0.9), now: () => at(9, 15, 10), search: '' });
    await flush();
    expect(tile.dataset.time).toBe('day');
    applyTheme('dark');
    expect(tile.dataset.time).toBe('night');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.sleepy);
    applyTheme('light');
    expect(tile.dataset.time).toBe('day');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
  });

  it('brings halloween with the dark theme in halloween week, and takes it away after', async () => {
    const { tile } = setUp();
    hill(tile);
    initScene(document, { fetchImpl: reading('calm'), random: always(0.9), now: () => at(9, 26, 10), search: '' });
    await flush();
    applyTheme('dark');
    expect([tile.dataset.time, tile.dataset.event]).toEqual(['night', 'halloween']);
    expect(TAKES.halloween).toContain(tile.dataset.eventTake);
    applyTheme('light');
    expect([tile.dataset.time, tile.dataset.event]).toEqual(['day', 'none']);
  });
});

describe('things Poe holds', () => {
  it("copy Poe's petting and leaning", async () => {
    document.body.innerHTML = '<img class="home-sun__mascot" alt="poe"><svg class="home-sun__worn" data-scene-worn="front"></svg>';
    const img = document.querySelector('img')!;
    const worn = document.querySelector('[data-scene-worn]')!;
    mirrorPoe(img, [worn]);
    img.classList.add('is-squished');
    img.style.setProperty('--lean-x', '0.5');
    await Promise.resolve();
    expect(worn.getAttribute('class')).toBe('home-sun__worn is-squished');
    expect(worn.getAttribute('style')).toContain('--lean-x: 0.5');
    img.classList.remove('is-squished');
    await Promise.resolve();
    expect(worn.getAttribute('class')).toBe('home-sun__worn');
  });
});

describe('the mascot rest face', () => {
  it("rests on the scene's face, but lets a held reaction finish first", () => {
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

describe('the dispatch and the weather, read once', () => {
  const FEED = {
    items: [
      { source: 'atpotato', kind: 'post', text: 'hi', title: null, embed: '', createdAt: '2026-10-20T10:00:00.000Z', url: 'https://bsky.app/profile/atpota.to/post/3abc' },
      { source: 'dispatch', kind: 'article', text: 'this week', title: 'issue 12', embed: '', createdAt: '2026-10-19T09:00:00.000Z', url: '/blog/issue-12' },
    ],
  };

  it('finds the newest dispatch in the latest feed, and keeps the feed for the latest tile', async () => {
    const fetchImpl = vi.fn(async () => Response.json(FEED)) as unknown as typeof fetch;
    expect(await newestDispatch(fetchImpl)).toBe(Date.parse('2026-10-19T09:00:00.000Z'));
    expect(await newestDispatch(fetchImpl)).toBe(Date.parse('2026-10-19T09:00:00.000Z'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('says so when the feed has no issue', async () => {
    writeCache([FEED.items[0] as never]);
    expect(await newestDispatch((async () => Response.json({})) as typeof fetch)).toBeNull();
  });

  it('asks the weather once for two readers close together', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ perSecond: { posts: 1, likes: 1, reposts: 1, follows: 1 }, condition: 'gusty' })) as unknown as typeof fetch;
    const first = await readAtmosphere(fetchImpl, 1000);
    const second = await readAtmosphere(fetchImpl, 1000 + SHARE_MS - 1);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await readAtmosphere(fetchImpl, 1000 + SHARE_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

it('knows every kind of bird it can draw', () => {
  expect(BIRDS).toEqual(Object.keys(BIRD_COLOURS));
  expect(BIRDS.length).toBeGreaterThanOrEqual(4);
});
