import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as api from '../api/weather-card.js';
import type { Reading } from '../server/atmosphere.js';
import {
  CACHE,
  CACHE_FALLBACK,
  card,
  cloudCount,
  CONDITION_TEXT,
  createCardHandlers,
  FACES,
  HEIGHT,
  loadAssets,
  MAX_CLOUDS,
  paintSun,
  takenAt,
  WIDTH,
  type Node,
} from '../server/weather-card.js';
import { cloudCount as heroClouds, MAX_CLOUDS as HERO_MAX_CLOUDS } from '../src/scripts/weather-sky.js';
import { CONDITION_TEXT as HERO_TEXT } from '../src/scripts/weather.js';

// /weather/card.png: the weather report's Open Graph card, drawn from the live reading.

const root = process.cwd();
const READING = {
  measuredAt: '2026-10-21T14:05:00.000Z',
  condition: 'stormy',
  records: { perSecond: 688.4, bluesky: 680, elsewhere: 8.4 },
  diversity: { index: 6.5, level: 'high', share: 1.2, spread: 18, apps: 30, collections: 90 },
} as Reading;

/** Every string in an element tree, in order. */
function words(node: Node | string | null | false | undefined): string[] {
  if (!node) return [];
  if (typeof node === 'string') return [node];
  const kids = node.props.children;
  return (Array.isArray(kids) ? kids : [kids]).flatMap((k) => words(k as Node));
}

/** Every img src in an element tree. */
function images(node: Node | string | null | false | undefined): string[] {
  if (!node || typeof node === 'string') return [];
  const kids = node.props.children;
  return [...(node.type === 'img' ? [String(node.props.src)] : []), ...(Array.isArray(kids) ? kids : [kids]).flatMap((k) => images(k as Node))];
}

/** A PNG's width and height, from its IHDR. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const get = (h: ReturnType<typeof createCardHandlers>, method = 'GET') => h.GET(new Request('https://atpota.to/api/weather-card', { method }));
const quiet = () => {};

describe('the weather card', () => {
  it('says what the hero says, and fills the sky the way the hero does', () => {
    expect(CONDITION_TEXT).toEqual(HERO_TEXT);
    expect(MAX_CLOUDS).toBe(HERO_MAX_CLOUDS);
    for (const index of [0, 0.05, 0.4, 1, 2.3, 4, 6.5, 8, 11, 40]) expect(cloudCount(index), String(index)).toBe(heroClouds(index));
  });

  it('paints the sun by day, with no CSS for the renderer to miss and no moon', () => {
    const sun = paintSun(readFileSync(resolve(root, 'src/assets/weather-sun.svg'), 'utf8'));
    expect(sun).not.toContain('class=');
    expect(sun).not.toContain('weather-sun__moon');
    expect(sun).not.toContain('<!--');
    expect(sun).toContain('fill="#FFD978"');
    expect(sun.startsWith('<svg')).toBe(true);
  });

  it("says when the reading was taken, in utc", () => {
    expect(takenAt('2026-10-21T14:05:00.000Z')).toBe('2:05 pm utc, oct 21');
    expect(takenAt('2026-10-21T00:30:00.000Z')).toBe('12:30 am utc, oct 21');
    expect(takenAt('nope')).toBe('');
  });

  it("draws the reading: its rate, condition and diversity, and Poe's face for the weather", async () => {
    const assets = await loadAssets(root);
    const tree = card(assets, READING);
    const text = words(tree).join(' ');
    expect(text).toContain('688');
    expect(text).toContain('rec/sec');
    expect(text).toContain('stormy. somebody said something.');
    expect(text).toContain('6.5, high');
    expect(text).toContain('lots of other apps about.');
    expect(text).toContain('the atmosphere at 2:05 pm utc, oct 21');
    expect(images(tree)).toContain(assets.poe.stormy);
    expect(FACES.stormy).toBe('wow');
    // without a reading: the report's title on a plain day
    const plain = words(card(assets, null)).join(' ');
    expect(plain).toContain('the atmosphere weather report');
    expect(plain).not.toContain('rec/sec');
  });

  it('every face it can make is a mascot that exists', async () => {
    const assets = await loadAssets(root);
    for (const [condition, face] of Object.entries(FACES)) {
      expect(assets.poe[condition as keyof typeof FACES], face).toMatch(/^data:image\/svg\+xml;base64,/);
    }
    expect(Buffer.from(assets.wordmark.split(',')[1]!, 'base64').toString()).not.toContain('currentColor');
  });

  it('answers a 1200x630 PNG drawn from the live reading, cached for a few minutes', async () => {
    const res = await get(createCardHandlers({ reading: async () => READING, root, log: quiet }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe(CACHE);
    expect(pngSize(Buffer.from(await res.arrayBuffer()))).toEqual({ width: WIDTH, height: HEIGHT });
  }, 30_000);

  it("draws the plain card, and keeps it for less time, when there's no reading or it's slow", async () => {
    const logged: string[] = [];
    const down = createCardHandlers({ reading: async () => Promise.reject(new Error('down')), root, log: (f) => logged.push(f.event) });
    const res = await get(down);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_FALLBACK);
    expect(pngSize(Buffer.from(await res.arrayBuffer()))).toEqual({ width: WIDTH, height: HEIGHT });
    expect(logged).toEqual(['reading_error']);

    const slow = createCardHandlers({ reading: () => new Promise(() => {}), root, timeoutMs: 20, log: quiet });
    const late = await get(slow);
    expect(late.headers.get('cache-control')).toBe(CACHE_FALLBACK);
    await late.arrayBuffer();
  }, 30_000);

  it("sends people to the site's own card if it can't draw one", async () => {
    const res = await get(createCardHandlers({ reading: async () => READING, root: '/nowhere', log: quiet }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/og/home.png');
  });

  it("HEAD answers without reading the sky; anything else isn't allowed", async () => {
    let reads = 0;
    const h = createCardHandlers({ reading: async () => (reads++, READING), root, log: quiet });
    const head = await get(h, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('image/png');
    expect(await head.text()).toBe('');
    expect(reads).toBe(0);
    const post = await api.POST(new Request('https://atpota.to/api/weather-card', { method: 'POST' }));
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('is what /weather shares, served at /weather/card.png with the files it reads', () => {
    const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>;
      functions: Record<string, { includeFiles?: string }>;
    };
    expect(vercel.rewrites).toContainEqual({ source: '/weather/card.png', destination: '/api/weather-card' });
    const include = vercel.functions['api/weather-card.ts']?.includeFiles ?? '';
    for (const path of ['server/fonts/**', 'src/assets/wordmark.svg', 'src/assets/weather-sun.svg', 'src/assets/mascot/**']) expect(include).toContain(path);
    const page = readFileSync(resolve(root, 'weather/index.html'), 'utf8');
    const meta = (attr: string, name: string) => page.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`))?.[1];
    expect(meta('property', 'og:image')).toBe('https://atpota.to/weather/card.png');
    expect(meta('name', 'twitter:image')).toBe('https://atpota.to/weather/card.png');
    expect([meta('property', 'og:image:width'), meta('property', 'og:image:height')]).toEqual([String(WIDTH), String(HEIGHT)]);
    expect(meta('property', 'og:image:alt')).toMatch(/weather report/);
    // the font's licence goes with it
    expect(readFileSync(resolve(root, 'server/fonts/OFL.txt'), 'utf8')).toContain('SIL Open Font License');
  });
});
