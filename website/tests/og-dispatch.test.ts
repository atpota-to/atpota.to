import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-wasm';
import { describe, expect, it } from 'vitest';
import { applyRewrites, readApiRewrites } from '../build/api-middleware.js';
import { DEFAULT_OG_IMAGE } from '../server/blog/pages.js';
import { CACHE_MISSING, CACHE_OK, cardFor, createOgDispatchHandlers, DESCRIPTION_LINES, fitIssue, keyOf, TITLE_LINES, TITLE_SIZES, type Issue } from '../server/og-dispatch.js';
import { cardArt, measureHeight, renderPng, renderSvg } from '../server/og-weather.js';
import { C, CARD_HEIGHT, CARD_WIDTH, h, PAGE_GAP, PAGE_PAD } from '../server/og-weather-cards.js';

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

/** The issue whose card ran off the bottom of the tile (bsky.app/profile/poe.atpota.to/post/3n2yizhubykht). */
const DISPATCH_2026_11_23: Issue = {
  title: 'the atmosphere had its first paid game jam',
  description:
    "atmosphere games' first jam dole paid out-of-work game developers to build on atproto for two weeks, and five games went live; also germ's encrypted dms reached android, spaces got its moderation plan a week before beta, and the atp working group met at the ietf.",
  publishedAt: '2026-11-23T16:04:14.491Z',
  number: 6,
  handle: 'poe.atpota.to',
  name: 'poe’s atmosphere dispatch',
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

  it('shrinks a longer title, and gives its description less room', async () => {
    const art = await cardArt();
    const description = 'word '.repeat(80).trim();
    const fits = await Promise.all(
      ['a short one', 'a title that runs to two lines or so', 'a title long enough that it takes three lines at the biggest size there is', 'a very long title that keeps on going, well past where a title should stop, and then on a bit further still'].map(
        (title) => fitIssue({ ...ISSUE, title, description }, art),
      ),
    );
    const sizes = fits.map((f) => f.titleSize);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(sizes[0]).toBe(TITLE_SIZES[0]);
    // A title on one line leaves the description all its lines; one on two, fewer.
    expect(fits[0]!.descriptionLines).toBe(DESCRIPTION_LINES);
    expect(fits[1]!.titleSize).toBe(TITLE_SIZES[0]);
    expect(fits[1]!.descriptionLines).toBeLessThan(DESCRIPTION_LINES);
  });

  it('keeps a title to its lines, evened out so no word sits alone', async () => {
    const art = await cardArt();
    // 2026-11-23's title: at 66px it wrapped to three lines with "jam" alone on the last.
    const fit = await fitIssue(DISPATCH_2026_11_23, art);
    expect(fit.title).toBe('balance');
    const lines = Math.round((await measureHeight(h({ fontFamily: 'signika', fontSize: fit.titleSize, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.025em' }, DISPATCH_2026_11_23.title), 550)) / fit.titleSize);
    expect(lines).toBeLessThanOrEqual(TITLE_LINES);
  });

  it("wraps a title plainly when a word won't fit on a line, and clamps one too long for any size", async () => {
    const art = await cardArt();
    const link = await fitIssue({ ...ISSUE, title: 'see https://atmosphere.games/jam/dole/2026/results' }, art);
    expect(link.title).toBe('wrap');
    const huge = await fitIssue({ ...ISSUE, title: 'word '.repeat(50).trim() }, art);
    expect(huge).toMatchObject({ title: 'clamp', titleSize: TITLE_SIZES.at(-1) });
  });

  it('cuts a long description at a word, with an ellipsis', async () => {
    const fit = await fitIssue(DISPATCH_2026_11_23, await cardArt());
    expect(fit.description.endsWith('…')).toBe(true);
    const kept = fit.description.slice(0, -1);
    expect(DISPATCH_2026_11_23.description!.startsWith(kept)).toBe(true);
    expect(DISPATCH_2026_11_23.description![kept.length]).toMatch(/[\s,.;:]/);
    // A short one is drawn whole.
    expect((await fitIssue(ISSUE, await cardArt())).description).toBe(ISSUE.description);
  });

  // The text tile's padding (54px across, 50px down), which nothing should ever be drawn in: the
  // band under the byline and the band down the right. Inset from the tile's edges, and clear
  // of its rounded corners. The picture tile beside it is 470px wide.
  const TEXT_TILE = { left: PAGE_PAD, right: CARD_WIDTH - PAGE_PAD - PAGE_GAP - 470, top: PAGE_PAD, bottom: CARD_HEIGHT - PAGE_PAD };
  const PADDING_BANDS = [
    { name: 'under the byline', x0: TEXT_TILE.left + 54, x1: TEXT_TILE.right - 54, y0: TEXT_TILE.bottom - 50 + 4, y1: TEXT_TILE.bottom - 4 },
    { name: 'down the right', x0: TEXT_TILE.right - 54 + 4, x1: TEXT_TILE.right - 4, y0: TEXT_TILE.top + 44, y1: TEXT_TILE.bottom - 44 },
  ];

  /** Where in a band the card isn't plain paper, if anywhere. */
  async function inkIn(issue: Issue): Promise<string[]> {
    const { pixels, width } = new Resvg(await renderSvg(await cardFor(issue))).render();
    const paper = [1, 3, 5].map((i) => parseInt(C.paper.slice(i, i + 2), 16));
    const found: string[] = [];
    for (const band of PADDING_BANDS) {
      scan: for (let y = band.y0; y < band.y1; y++) {
        for (let x = band.x0; x < band.x1; x++) {
          const i = (y * width + x) * 4;
          if (paper.some((v, c) => Math.abs(pixels[i + c]! - v) > 3)) {
            found.push(`${band.name} at ${x},${y}`);
            break scan;
          }
        }
      }
    }
    return found;
  }

  it('never draws past the text tile, whatever the title and description', async () => {
    const cases: Issue[] = [
      ISSUE,
      DISPATCH_2026_11_23,
      { ...ISSUE, title: 'tangled moves house, spaces gets a new address, and a halloween costume parade', description: 'tangled relaunched as a federated forge with stable org.tangled lexicons, the protocol team floated a new uri syntax for spaces, and fandom asked whether ao3 belongs on atproto.' },
      { ...ISSUE, title: 'a', description: 'b' },
      { ...ISSUE, title: 'word '.repeat(50).trim(), description: 'more '.repeat(300).trim() },
      { ...ISSUE, title: 'see https://atmosphere.games/jam/dole/2026/results-and-every-game-in-one-very-long-link', description: `${'x'.repeat(200)} and then some` },
      { ...ISSUE, title: 'Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww', description: null },
      { ...ISSUE, title: 'mmm mmm mmm mmm mmm mmm mmm mmm mmm mmm mmm mmm', description: 'WWW '.repeat(60).trim() },
    ];
    for (const issue of cases) expect(await inkIn(issue), issue.title).toEqual([]);
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
