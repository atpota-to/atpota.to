import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyRewrites, readApiRewrites } from '../build/api-middleware.js';
import { DEFAULT_OG_IMAGE } from '../server/blog/pages.js';
import { CACHE_MISSING, CACHE_OK, cardFor, createOgDispatchHandlers, descriptionMax, keyOf, titleSize, type Issue } from '../server/og-dispatch.js';
import { renderPng } from '../server/og-weather.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(`${root}${file}`, 'utf8');

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Every string anywhere in an element tree. */
function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node && typeof node === 'object') return strings((node as { props?: { children?: unknown } }).props?.children);
  return [];
}

const ISSUE: Issue = {
  title: 'attie sites, spaces near beta, and a brand new cow',
  description: 'the atmosphere argued about attie, pds moover shipped oauth, and bridgy fed quietly filled spark.',
  publishedAt: '2026-10-19T12:00:00.000Z',
  number: 3,
  handle: 'poe.atpota.to',
  name: "poe's atmosphere dispatch",
};

const get = (key: string, method = 'GET') => new Request(`https://atpota.to/api/og-dispatch?key=${encodeURIComponent(key)}`, { method });

describe('og dispatch: the card', () => {
  it("says the issue's title, description, number, byline and date", async () => {
    const text = strings(await cardFor(ISSUE)).join('\n');
    for (const want of [ISSUE.title, ISSUE.description!, 'issue 3', "poe's atmosphere dispatch", '@poe.atpota.to · oct 19, 2026']) expect(text).toContain(want);
  });

  it('draws a 1200x630 png, a long title and description included', async () => {
    expect(pngSize(await renderPng(await cardFor(ISSUE)))).toEqual({ width: 1200, height: 630 });
    const long = { ...ISSUE, title: 'x '.repeat(60).trim(), description: 'y '.repeat(200).trim() };
    expect(pngSize(await renderPng(await cardFor(long)))).toEqual({ width: 1200, height: 630 });
  });

  it('shrinks a longer title, and gives its description less room', () => {
    const sizes = [10, 40, 60, 90].map((n) => titleSize('a'.repeat(n)));
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(descriptionMax('a'.repeat(90))).toBeLessThan(descriptionMax('a'.repeat(10)));
  });
});

describe('og dispatch: the function', () => {
  it('answers a png of the issue its key finds, cached an hour', async () => {
    const asked: string[] = [];
    const og = createOgDispatchHandlers({ load: async (key) => (asked.push(key), ISSUE), render: async () => new Uint8Array([1, 2, 3]) });
    const res = await og.GET(get('3myasnk4bzk22.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(asked).toEqual(['3myasnk4bzk22']);
  });

  it("sends a crawler to the blog's card for a post that isn't there", async () => {
    const og = createOgDispatchHandlers({ load: async () => null, render: async () => new Uint8Array() });
    for (const res of [await og.GET(get('nope.png')), await og.GET(get(''))]) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DEFAULT_OG_IMAGE);
      expect(res.headers.get('cache-control')).toBe(CACHE_MISSING);
    }
  });

  it("falls back to the blog's card, uncached, when the records or the drawing fail", async () => {
    const quiet = () => undefined;
    const down = createOgDispatchHandlers({ load: async () => Promise.reject(new Error('pds down')), log: quiet });
    const broken = createOgDispatchHandlers({ load: async () => ISSUE, render: async () => Promise.reject(new Error('no fonts')), log: quiet });
    for (const res of [await down.GET(get('3abc')), await broken.GET(get('3abc'))]) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DEFAULT_OG_IMAGE);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('answers a HEAD without drawing', async () => {
    let drawn = 0;
    const og = createOgDispatchHandlers({ load: async () => ISSUE, render: async () => (drawn++, new Uint8Array([1])) });
    const res = await og.HEAD(get('3abc', 'HEAD'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(drawn).toBe(0);
  });

  it('reads the key the way /blog/<key> takes it', () => {
    const key = (q: string) => keyOf(new URL(`https://atpota.to/api/og-dispatch?${q}`));
    expect(key('key=3abc.png')).toBe('3abc');
    expect(key('key=%2Fweekly-1%2F.png')).toBe('weekly-1');
    expect(key('')).toBe('');
  });
});

describe('og dispatch: wiring', () => {
  const vercel = JSON.parse(read('vercel.json')) as {
    functions: Record<string, { includeFiles?: string }>;
    rewrites: Array<{ source: string; destination: string }>;
  };

  it('serves /og/dispatch/<key>.png from the function, in dev too', () => {
    expect(applyRewrites(readApiRewrites(`${root}vercel.json`), '/og/dispatch/3abc.png', '')).toBe('/api/og-dispatch?key=3abc.png');
    expect(existsSync(`${root}api/og-dispatch.ts`)).toBe(true);
  });

  it("ships the function's files with it, and its own settings come before api/*.ts", () => {
    const keys = Object.keys(vercel.functions);
    expect(keys.indexOf('api/og-dispatch.ts')).toBeLessThan(keys.indexOf('api/*.ts'));
    const include = vercel.functions['api/og-dispatch.ts']!.includeFiles!;
    for (const file of ['server/og-fonts/signika-latin-700-normal.woff', 'src/assets/wordmark.svg', 'src/assets/sprout.svg', 'src/assets/mascot/potato-happy.svg', 'node_modules/@resvg/resvg-wasm/index_bg.wasm']) {
      expect(existsSync(`${root}${file}`), file).toBe(true);
      const dir = file.slice(0, file.lastIndexOf('/'));
      expect(include.includes(file) || include.includes(`${dir}/**`) || include.includes(`${dir}/*.${file.split('.').pop()}`), file).toBe(true);
    }
  });
});
