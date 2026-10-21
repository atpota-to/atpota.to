import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '../api/og-weather.js';
import { applyRewrites, readApiRewrites } from '../build/api-middleware.js';
import { fromStation, type Reading } from '../server/atmosphere.js';
import {
  CACHE_OK,
  CACHE_QUIET,
  cardArt,
  cardFor,
  createOgWeatherHandlers,
  FALLBACK_IMAGE,
  readCardData,
  renderPng,
  renderSvg,
} from '../server/og-weather.js';
import {
  bigNumber,
  CARDS,
  changeText,
  chartTop,
  cloudCount,
  CONDITION_TEXT,
  DEFAULT_CARD,
  DIVERSITY_SCALE,
  drawCard,
  drawQuiet,
  formatIndex,
  gaugeAt,
  isCard,
  LEVEL_TEXT,
  MAX_CLOUDS,
  stamp,
  usualChip,
  usualOf,
  USUAL_EDGES,
  type CardData,
} from '../server/og-weather-cards.js';
import type { Normal } from '../server/weather-almanac.js';
import * as almanacPage from '../src/scripts/weather-almanac.js';
import * as sky from '../src/scripts/weather-sky.js';
import * as weatherPage from '../src/scripts/weather.js';

// The weather report's Open Graph card (/og/weather.png): drawn from the weather right now,
// always a PNG, in the page's own words.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(`${root}${file}`, 'utf8');

const NOW = Date.parse('2026-10-21T12:11:25.000Z');
const HOUR = 3600_000;

const STATION = {
  measuredAt: '2026-10-21T12:11:25.000Z',
  seconds: 60,
  perSecond: { posts: 47.7, likes: 241, reposts: 41, follows: 21.6 },
  records: { perSecond: 362, bluesky: 359.3, elsewhere: 2.7 },
  diversity: { index: 1.87, share: 0.53, spread: 12.42, apps: 12, collections: 35 },
  apps: [
    { domain: 'grain.social', perSecond: 0.9, count: 56, collections: ['social.grain.photo'] },
    { domain: 'sprk.so', perSecond: 0.3, count: 16, collections: ['so.sprk.feed.post'] },
  ],
  bluesky: [{ nsid: 'app.bsky.feed.like', perSecond: 241, count: 14459 }],
  events: { creates: 362, updates: 2.3, deletes: 14, identity: 0.3, account: 0.4 },
  accounts: { active: 10648, bluesky: 10619, elsewhere: 56, index: 0.53, apps: [] },
};

function points(hours = 24) {
  return Array.from({ length: hours }, (_, i) => {
    const t = new Date(NOW - (hours - i) * HOUR).toISOString();
    const rate = 300 + 150 * Math.sin(i / 4);
    const seconds = 3600;
    return { t, seconds, creates: Math.round(rate * seconds), bluesky: 0, elsewhere: 0, posts: 0, likes: 0, reposts: 0, follows: 0, updates: 0, deletes: 0, identity: 0, account: 0 };
  });
}

const SUMS = { seconds: 3600, posts: 150_000, creates: 1_250_000, elsewhere: 7000 };
const NORMAL: Normal = { historyStart: '2026-10-06T14:00:00.000Z', now: SUMS, days: { ...SUMS, windows: 6 }, weeks: { ...SUMS, creates: 1_000_000, windows: 2 } };

function data(over: Partial<CardData> = {}): CardData {
  return {
    at: NOW,
    now: fromStation(STATION),
    day: {
      points: points(),
      apps: [
        { domain: 'rocksky.app', creates: 16836, prevCreates: 0, collections: [] },
        { domain: 'teal.fm', creates: 15527, prevCreates: 0, collections: [] },
        { domain: 'standard.site', creates: 13070, prevCreates: 0, collections: [] },
      ],
    },
    almanac: {
      normal: NORMAL,
      today: { start: '2026-10-21T00:00:00.000Z', seconds: 39480, posts: 1_336_626, creates: 11_428_979, elsewhere: 85_926, high: { minute: '2026-10-21T01:00:00.000Z', perSecond: 445.5 }, low: { minute: '2026-10-21T07:44:00.000Z', perSecond: 212.3 } },
      newApps: { historyStart: '2026-10-06T14:00:00.000Z', readyAt: '2026-10-13T14:00:00.000Z', warmingUp: false, heard: 228, apps: [] },
    },
    ...over,
  };
}

const EMPTY: CardData = { at: NOW, now: null, day: null, almanac: null };

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Every string anywhere in an element tree. */
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object' && 'props' in node) return texts((node as { props: { children?: unknown } }).props.children);
  return [];
}

describe('og weather: the page\'s words', () => {
  it('copies the conditions, levels, scale and clouds from the page', () => {
    expect(CONDITION_TEXT).toEqual(weatherPage.CONDITION_TEXT);
    expect(LEVEL_TEXT).toEqual(weatherPage.LEVEL_TEXT);
    expect(DIVERSITY_SCALE).toEqual(weatherPage.DIVERSITY_SCALE);
    expect(MAX_CLOUDS).toBe(sky.MAX_CLOUDS);
    for (const index of [0, 0.3, 1.87, 3, 6.5, 11, 40]) {
      expect(cloudCount(index), String(index)).toBe(sky.cloudCount(index));
      expect(formatIndex(index), String(index)).toBe(weatherPage.formatIndex(index));
    }
  });

  it('says usual the way the almanac does', () => {
    expect(USUAL_EDGES).toEqual(almanacPage.USUAL_EDGES);
    for (const v of [0, 999, 1_400_000, 11_428_979, 2.3e9]) expect(bigNumber(v)).toBe(almanacPage.bigNumber(v));
    for (const r of [0.5, 0.97, 1, 1.2, 2.4]) {
      expect(changeText(r)).toBe(almanacPage.changeText(r));
      expect(gaugeAt(r)).toBe(almanacPage.gaugeAt(r));
    }
    for (const creates of [700_000, 950_000, 1_000_000, 1_100_000, 1_300_000]) {
      const normal = { ...NORMAL, now: { ...SUMS, creates } };
      const page = almanacPage.usualText(normal, NOW, 'UTC');
      const card = usualOf(normal)!;
      expect(card.ratio).toBe(page.ratio);
      expect(page.headline.startsWith(card.how), page.headline).toBe(true);
    }
  });

  it('waits for usual like the page does', () => {
    expect(usualOf(undefined)).toBeNull();
    expect(usualOf({ ...NORMAL, days: { ...SUMS, windows: 0 }, weeks: { ...SUMS, windows: 0 } })).toBeNull();
    expect(usualOf({ ...NORMAL, now: { ...SUMS, seconds: 600 } })).toBeNull();
    expect(usualOf({ ...NORMAL, weeks: { ...SUMS, windows: 0 } })!.when).toBe('for this time of day');
    expect(usualOf(NORMAL)!.when).toBe('for this time of the week');
  });

  it('puts the number first on the usual chip, unless there is nothing to say', () => {
    const at = (creates: number) => usualChip(usualOf({ ...NORMAL, now: { ...SUMS, creates } })!);
    expect(at(1_250_000)).toBe('+25% busier than usual');
    expect(at(2_000_000)).toBe('+100% busier than usual');
    expect(at(700_000)).toBe('−30% quieter than usual');
    expect(at(1_010_000)).toBe('about as busy as usual');
  });

  it('dates the card in utc', () => {
    expect(stamp(NOW)).toBe('wed 21 oct, 12:11 utc');
  });

  it('gives the trend chart a round top above the busiest hour', () => {
    expect(chartTop(465)).toBe(600);
    expect(chartTop(80)).toBe(100);
    expect(chartTop(1250)).toBe(1500);
  });
});

describe('og weather: the cards', () => {
  it('knows its cards, and the default is one of them', () => {
    expect(CARDS).toEqual(['forecast', 'trend', 'mix', 'today']);
    expect(isCard(DEFAULT_CARD)).toBe(true);
    expect(isCard('nope')).toBe(false);
    expect(isCard(null)).toBe(false);
    expect(isCard('toString')).toBe(false);
  });

  it.each(CARDS)('%s draws a 1200x630 png from the weather', async (name) => {
    const { card, quiet } = await cardFor(name, data());
    expect(quiet).toBe(false);
    const png = await renderPng(card);
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
    expect(png.length).toBeLessThan(900_000);
  });

  it('shows the numbers it was given', async () => {
    const art = await cardArt();
    // the measured comparison, not the condition's stock "a quiet spell" beside a busier-than-usual hour
    const forecast = texts(drawCard('forecast', data(), art));
    expect(forecast).toEqual(expect.arrayContaining(['362', 'a light breeze.', 'diversity index 1.9 · low', 'mostly bluesky out there', '+25% busier than usual for this time of the week']));
    expect(forecast.join(' ')).not.toContain('a quiet spell');
    // without a usual yet, the condition's own words
    expect(texts(drawCard('forecast', data({ almanac: null }), art))).toEqual(expect.arrayContaining(['a quiet spell, right now']));
    expect(texts(drawCard('mix', data(), art))).toEqual(expect.arrayContaining(['1.9', 'rocksky.app', '16,836', 'low']));
    expect(texts(drawCard('today', data(), art))).toEqual(expect.arrayContaining([
      'the last hour', 'much busier than usual', '+25%', 'today in numbers', '212', '446', 'new records', '11.4 million', 'from other apps',
    ]));
    expect(texts(drawCard('trend', data(), art))).toEqual(expect.arrayContaining(['busiest hour 450', '362']));
  });

  it('counts new apps no further than the almanac lists them', async () => {
    const art = await cardArt();
    const listing = (n: number) => data({ almanac: { ...data().almanac!, newApps: { ...data().almanac!.newApps!, apps: Array.from({ length: n }, (_, i) => ({
      domain: `app${i}.example`, firstSeen: '2026-10-21T11:50:00.000Z', creates: 10, collections: [],
    })) } } });
    expect(texts(drawCard('today', listing(3), art))).toEqual(expect.arrayContaining(['new apps, last 24 hours', '3']));
    // the almanac stops at 20, so 20 means "at least 20"
    expect(texts(drawCard('today', listing(20), art))).toEqual(expect.arrayContaining(['20+']));
  });

  it('gives way to the quiet card when its numbers are missing', async () => {
    for (const name of CARDS) expect((await cardFor(name, EMPTY)).quiet, name).toBe(true);
    const quiet = await renderPng((await cardFor('forecast', EMPTY)).card);
    expect(pngSize(quiet)).toEqual({ width: 1200, height: 630 });
    expect(texts(drawQuiet(EMPTY, await cardArt())).join(' ')).not.toMatch(/\d/);
  });

  it('draws what it can from what came', async () => {
    const art = await cardArt();
    // no station: the forecast reads the newest hour, and says so
    const noStation = data({ now: null });
    expect(texts(drawCard('forecast', noStation, art))).toEqual(expect.arrayContaining(['over the last hour, +25% busier than usual for this time of the week']));
    expect(texts(drawCard('forecast', data({ now: null, almanac: null }), art))).toEqual(expect.arrayContaining([expect.stringContaining(', over the last hour')]));
    // an hour too old to be "now" is no forecast
    expect(drawCard('forecast', data({ now: null, at: NOW + 3 * HOUR }), art)).toBeNull();
    // too few hours for a chart
    expect(drawCard('trend', data({ day: { points: points(4) } }), art)).toBeNull();
    // no usual yet: today's range still stands
    expect(texts(drawCard('today', data({ almanac: { ...data().almanac, normal: undefined } }), art))).toEqual(
      expect.arrayContaining(['still learning what usual looks like', '212']),
    );
    // nothing for the right-hand panel: the last hour has the card to itself
    expect(texts(drawCard('today', data({ almanac: { ...data().almanac, today: undefined, newApps: undefined } }), art))).not.toContain('today in numbers');
    // the apps of the last minute when the day's aren't in
    expect(texts(drawCard('mix', data({ day: null }), art))).toEqual(expect.arrayContaining(['grain.social', 'new records, the last minute']));
  });

  it("draws other people's names as shapes, never markup, and long ones don't break it", async () => {
    const hostile = '</svg><script>alert(1)</script>&amp;"';
    const long = `${'a'.repeat(63)}.${'b'.repeat(63)}`;
    const d = data();
    d.day!.apps = [{ domain: hostile, creates: 99, prevCreates: 0, collections: [] }, { domain: long, creates: 98, prevCreates: 0, collections: [] }, ...d.day!.apps!];
    const card = drawCard('mix', d, await cardArt())!;
    const svg = await renderSvg(card);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('alert(1)');
    expect(pngSize(await renderPng(card))).toEqual({ width: 1200, height: 630 });
  });

  it('a stormy, very mixed sky still fits', async () => {
    const stormy = data({ now: fromStation({ ...STATION, records: { perSecond: 12345.6, bluesky: 12000, elsewhere: 345.6 }, diversity: { ...STATION.diversity, share: 30, spread: 80 } }) as Reading });
    for (const name of CARDS) expect(pngSize(await renderPng((await cardFor(name, stormy)).card)), name).toEqual({ width: 1200, height: 630 });
  });
});

describe('og weather: reading the weather', () => {
  /** The station and a scripted Supabase. */
  function network(opts: { station?: unknown; supabase?: Record<string, unknown>; hang?: boolean } = {}) {
    const asked: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      if (opts.hang) return new Promise<Response>(() => {});
      if (url.startsWith('https://hook.atpota.to/')) return opts.station ? Response.json(opts.station) : new Response('down', { status: 503 });
      const name = /\/rpc\/([a-z_]+)$/.exec(url)?.[1] ?? /\/rest\/v1\/([a-z_]+)\?/.exec(url)?.[1] ?? '';
      const answer = opts.supabase?.[name];
      return answer !== undefined ? Response.json(answer) : new Response('nope', { status: 500 });
    }) as typeof globalThis.fetch;
    return { fetch, asked };
  }

  const quiet = () => undefined;

  it('reads the station only with its secret, and never samples Jetstream', async () => {
    const net = network({ station: STATION });
    const without = await readCardData({ fetch: net.fetch, env: () => ({}), now: () => NOW, log: quiet });
    expect(without.now).toBeNull();
    expect(net.asked.some((u) => u.startsWith('https://hook.atpota.to/'))).toBe(false);
    const withSecret = await readCardData({ fetch: net.fetch, env: () => ({ ATMOSPHERE_STATION_SECRET: 's' }), now: () => NOW, log: quiet });
    expect(withSecret.now?.records.perSecond).toBe(362);
    expect(withSecret.at).toBe(NOW);
  });

  it('reads the day and the almanac through their own handlers', async () => {
    const hour = { hour: '2026-10-21T11:00:00+00:00', seconds_covered: 3600, creates: 1_300_000, bluesky: 1_290_000, elsewhere: 10_000, posts: 1, likes: 1, reposts: 1, follows: 1, updates: 1, deletes: 1, identity: 1, account: 1 };
    const net = network({ supabase: { atmosphere_hour: [hour, { ...hour, hour: 'garbage' }], atmosphere_normal: { historyStart: null, now: SUMS, days: { ...SUMS, windows: 1 }, weeks: { ...SUMS, windows: 0 } } } });
    const d = await readCardData({ fetch: net.fetch, env: () => ({}), now: () => NOW, log: quiet });
    expect(d.day?.points).toHaveLength(1);
    expect(d.almanac?.normal?.days.windows).toBe(1);
    expect(d.almanac?.today).toBeUndefined();
    expect(net.asked.some((u) => u.includes('/rpc/atmosphere_today') )).toBe(true);
  });

  it('gives up on what takes too long', async () => {
    const started = Date.now();
    const d = await readCardData({ fetch: network({ hang: true }).fetch, env: () => ({ ATMOSPHERE_STATION_SECRET: 's' }), now: () => NOW, log: quiet, readMs: 50 });
    expect(d).toEqual(EMPTY);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('og weather: the function', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const get = (h: ReturnType<typeof createOgWeatherHandlers>, q = '', method = 'GET') => h.GET(new Request(`https://atpota.to/api/og-weather${q}`, { method }));

  it('answers a png of the card asked for, cached five minutes', async () => {
    const drawn: string[] = [];
    const h = createOgWeatherHandlers({ read: async () => data(), render: async (card) => (drawn.push(texts(card).join(' ')), PNG), log: () => undefined });
    const res = await get(h, '?card=mix');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(drawn[0]).toContain('who else is in the sky');
  });

  it('draws the default card for no card or one it does not know', async () => {
    const drawn: string[] = [];
    const h = createOgWeatherHandlers({ read: async () => data(), render: async (card) => (drawn.push(texts(card).join(' ')), PNG), log: () => undefined });
    await get(h);
    await get(h, '?card=__proto__');
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toBe(drawn[1]);
    expect(drawn[0]).toContain('the atmosphere weather report');
  });

  it('answers the quiet card, cached a minute, when the weather cannot be read', async () => {
    const h = createOgWeatherHandlers({ read: async () => { throw new Error('down'); }, render: async () => PNG, log: () => undefined });
    const res = await get(h, '?card=trend');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_QUIET);
  });

  it('falls back to the quiet card when a card fails to draw, and to the site card when that fails too', async () => {
    let calls = 0;
    const once = createOgWeatherHandlers({ read: async () => data(), render: async () => { if (calls++ === 0) throw new Error('boom'); return PNG; }, log: () => undefined });
    const res = await get(once);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_QUIET);
    const never = createOgWeatherHandlers({ read: async () => data(), render: async () => { throw new Error('boom'); }, log: () => undefined });
    const broken = await get(never);
    expect(broken.status).toBe(302);
    expect(broken.headers.get('location')).toBe(FALLBACK_IMAGE);
  });

  it('answers HEAD without drawing, and 405 to everything else', async () => {
    let drew = false;
    const h = createOgWeatherHandlers({ read: async () => data(), render: async () => ((drew = true), PNG), log: () => undefined });
    const head = await h.HEAD(new Request('https://atpota.to/api/og-weather', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('image/png');
    expect(head.headers.get('cache-control')).toBe('no-store');
    expect(await head.text()).toBe('');
    expect(drew).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const res = await api[method](new Request('https://atpota.to/api/og-weather', { method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
  });
});

describe('og weather: wiring', () => {
  const vercel = JSON.parse(read('vercel.json')) as {
    functions: Record<string, { includeFiles?: string }>;
    rewrites: Array<{ source: string; destination: string }>;
  };

  it('serves /og/weather.png from the function, in dev too, with nothing static in its way', () => {
    expect(vercel.rewrites).toContainEqual({ source: '/og/weather.png', destination: '/api/og-weather' });
    expect(applyRewrites(readApiRewrites(`${root}vercel.json`), '/og/weather.png', '?card=trend')).toBe('/api/og-weather?card=trend');
    expect(existsSync(`${root}public/og/weather.png`)).toBe(false);
    expect(read('scripts/og-cards.ts')).not.toMatch(/name: 'weather'/);
  });

  it("ships the function's files with it, and its own settings come before api/*.ts", () => {
    const keys = Object.keys(vercel.functions);
    expect(keys.indexOf('api/og-weather.ts')).toBeLessThan(keys.indexOf('api/*.ts'));
    const include = vercel.functions['api/og-weather.ts']!.includeFiles!;
    for (const file of [
      'server/og-fonts/signika-latin-700-normal.woff',
      'src/assets/wordmark.svg',
      'src/assets/mascot/potato-sleepy.svg',
      'node_modules/@resvg/resvg-wasm/index_bg.wasm',
    ]) {
      expect(existsSync(`${root}${file}`), file).toBe(true);
      const dir = file.slice(0, file.lastIndexOf('/'));
      expect(include.includes(file) || include.includes(`${dir}/**`) || include.includes(`${dir}/*.${file.split('.').pop()}`), file).toBe(true);
    }
    expect(existsSync(`${root}server/og-fonts/OFL.txt`)).toBe(true);
  });

  it('is the og:image of /weather', () => {
    const html = read('weather/index.html');
    const og = (name: string) => html.match(new RegExp(`<meta property="og:${name}" content="([^"]*)">`))?.[1];
    expect(og('image')).toBe('https://atpota.to/og/weather.png');
    expect([og('image:width'), og('image:height'), og('image:type')]).toEqual(['1200', '630', 'image/png']);
    expect(og('image:alt')).toBeTruthy();
  });
});
