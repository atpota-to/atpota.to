import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyRewrites, readApiRewrites } from '../build/api-middleware.js';
import { ATPOTATO_DID } from '../server/blog/config.js';
import type { Flower, Garden } from '../server/garden.js';
import { CACHE_OK as PAGE_CACHE_OK, CACHE_PLAIN, createGardenPageHandlers, gardenMeta, withMeta } from '../server/garden-page.js';
import {
  actorOf,
  addressOf,
  avatarThumb,
  cardText,
  CACHE_MISSING,
  CACHE_OK,
  createOgGardenHandlers,
  drawGarden,
  gardenWords,
  isAvatarUrl,
  patchSvg,
  placeFlowers,
  plantSvg,
  statsText,
  STATIC_CARD,
  windowOf,
} from '../server/og-garden.js';
import { cardArt, renderPng } from '../server/og-weather.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(`${root}${file}`, 'utf8');
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function flower(plot: number, kind: Flower['kind'], daysAgo: number): Flower {
  return {
    did: `did:plc:f${plot}`,
    rkey: '3mabcdefghijk',
    uri: `at://did:plc:f${plot}/to.atpota.garden.sprout/3mabcdefghijk`,
    cid: 'c',
    handle: `f${plot}.test`,
    kind,
    family: kind === 'seed' ? null : 'flower',
    weather: null,
    plot,
    plantedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    care: 0.5,
    helpers: 0,
    lastTended: null,
    thirsty: false,
  };
}

function garden(over: Partial<Garden> = {}, patch: Partial<NonNullable<Garden['patch']>> = {}): Garden {
  return {
    owner: { did: 'did:plc:dame', handle: 'dame.is', displayName: 'dame', avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:dame/bafk@jpeg' },
    patch: {
      rkey: 'self', uri: 'at://did:plc:dame/to.atpota.garden.patch/self', cid: 'c', name: "dame's garden", note: null, season: null,
      cols: 12, rows: 8, opensAt: null, closesAt: null, createdAt: '2026-10-20T00:00:00.000Z', planting: 'one', open: true, ...patch,
    },
    patches: [],
    flowers: [],
    total: 0,
    seeds: true,
    ...over,
  };
}

const FULL = garden({ flowers: [flower(0, 'sunflower', 9), flower(13, 'storm-lily', 8), flower(26, 'seed', 3), flower(40, 'rose', 0.5), flower(95, 'lotus', 10)] });

describe('og garden: the patch', () => {
  it("draws each flower with the garden's own code, as svg markup", () => {
    const svg = String(plantSvg({ did: 'did:plc:x', rkey: '3mabcdefghijk', kind: 'sunflower', family: 'flower', care: 1, grew: null }, 'bloom'));
    expect(svg).toMatch(/^<svg viewBox="-20 -20 40 40"[^>]*>.*<\/svg>$/);
    expect(svg).toContain('<circle');
    expect(String(plantSvg({ did: 'did:plc:x', rkey: '3mabcdefghijk', kind: 'seed', family: null, care: 0, grew: null }, 'sprout'))).toContain('<ellipse');
  });

  it('shows a big patch where the most is growing, and a small one whole', () => {
    const { plots } = placeFlowers(FULL, NOW);
    expect(windowOf(12, 8, plots)).toEqual({ col: 0, row: 0, cols: 5, rows: 6 });
    const corner = placeFlowers(garden({ flowers: [flower(95, 'rose', 9), flower(94, 'rose', 9), flower(0, 'daisy', 1)] }), NOW).plots;
    expect(windowOf(12, 8, corner)).toEqual({ col: 7, row: 2, cols: 5, rows: 6 });
    expect(windowOf(4, 5, new Map())).toEqual({ col: 0, row: 0, cols: 4, rows: 5 });
  });

  it('marks an empty plot with its seed dot and a planted one with its flower', () => {
    const svg = patchSvg(4, 5, placeFlowers(garden({ flowers: [flower(0, 'rose', 9)] }, { cols: 4, rows: 5 }), NOW).plots);
    expect(svg.match(/<rect x=/g)).toHaveLength(20);
    expect(svg.match(/<svg viewBox="-20 -20 40 40"/g)).toHaveLength(1);
  });
});

describe('og garden: the words', () => {
  it("names a garden by its own name, or its owner's", () => {
    expect(gardenWords(FULL)).toMatchObject({ chip: null, title: "dame's garden", note: null });
    expect(gardenWords(garden({}, { name: '' })).title).toBe("dame's garden");
    expect(gardenWords(garden({}, { note: 'come plant!' }))).toMatchObject({ lede: 'come plant!', note: 'come plant!' });
    expect(gardenWords(garden({ patch: null })).lede).toBe("@dame.is hasn't set up a garden yet.");
    expect(gardenWords(garden({ owner: { did: ATPOTATO_DID, handle: 'atpota.to', displayName: 'atpotato', avatar: null } })).title).toBe('the community garden');
  });

  it("drops what the card's font can't draw", () => {
    expect(cardText('dame 🌻 (he/him)')).toBe('dame (he/him)');
    expect(cardText("🌷 tulip 🏳️‍🌈's garden 👋🏽")).toBe("tulip's garden");
    expect(cardText('🌻')).toBe('');
  });

  it("counts what's growing and what's in bloom", () => {
    expect(statsText(FULL, placeFlowers(FULL, NOW))).toBe('5 flowers · 3 in bloom');
    expect(statsText(garden(), placeFlowers(garden(), NOW))).toBe('no flowers yet. plant the first one!');
    const young = garden({ flowers: [flower(1, 'rose', 1)] });
    expect(statsText(young, placeFlowers(young, NOW))).toBe('1 flower, all still growing');
  });

  it('names an owner by handle, or by DID when the handle is broken', () => {
    expect(addressOf({ did: 'did:plc:x', handle: 'x.test' })).toBe('x.test');
    expect(addressOf({ did: 'did:plc:x', handle: 'handle.invalid' })).toBe('did:plc:x');
  });
});

describe('og garden: the card', () => {
  it('draws 1200x630, empty or full, with an avatar or without', async () => {
    const art = await cardArt();
    const long = 'Bartholomew Featherstonehaugh-Cholmondeley of the Long Name';
    const wordy = garden({ owner: { did: 'did:plc:x', handle: 'a.very.long.handle.bsky.social', displayName: long, avatar: null } }, { name: '', note: 'x '.repeat(70) });
    for (const g of [garden(), FULL, garden({ patch: null }), wordy]) {
      expect(pngSize(await renderPng(drawGarden(g, art, null, NOW)))).toEqual({ width: 1200, height: 630 });
    }
  });
});

describe('og garden: the function', () => {
  const quiet = () => undefined;
  const get = (actor: string) => new Request(`https://atpota.to/api/og-garden?actor=${encodeURIComponent(actor)}`);

  it('answers a png of the garden, cached fifteen minutes, with the avatar from the CDN', async () => {
    const avatars: string[] = [];
    const og = createOgGardenHandlers({ load: async () => FULL, avatar: async (u) => (avatars.push(u), null), render: async () => new Uint8Array([7]), now: () => NOW });
    const res = await og.GET(get('dame.is.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    expect(avatars).toEqual([FULL.owner.avatar]);
  });

  it("sends a crawler to the garden's static card for a garden that isn't shown, or isn't a garden's address", async () => {
    const og = createOgGardenHandlers({ load: async () => null, log: quiet });
    for (const actor of ['nobody.test', 'not a handle', '']) {
      const res = await og.GET(get(actor));
      expect(res.status, actor).toBe(302);
      expect(res.headers.get('location')).toBe(STATIC_CARD);
      expect(res.headers.get('cache-control')).toBe(CACHE_MISSING);
    }
  });

  it('falls back, uncached, when the garden or the drawing fails', async () => {
    const down = createOgGardenHandlers({ load: async () => Promise.reject(new Error('down')), log: quiet });
    const broken = createOgGardenHandlers({ load: async () => FULL, avatar: async () => null, render: async () => Promise.reject(new Error('no')), log: quiet });
    for (const res of [await down.GET(get('dame.is')), await broken.GET(get('dame.is'))]) {
      expect(res.status).toBe(302);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it("only fetches avatars from Bluesky's CDN, as small JPEGs", () => {
    expect(isAvatarUrl('https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafk')).toBe(true);
    for (const bad of ['http://cdn.bsky.app/x', 'https://evil.test/x', 'not a url']) expect(isAvatarUrl(bad), bad).toBe(false);
    expect(avatarThumb('https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafk')).toBe('https://cdn.bsky.app/img/avatar_thumbnail/plain/did:plc:x/bafk@jpeg');
    expect(avatarThumb('https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafk@webp')).toBe('https://cdn.bsky.app/img/avatar_thumbnail/plain/did:plc:x/bafk@jpeg');
  });

  it('reads the actor the way /garden/<actor> takes it', () => {
    const actor = (q: string) => actorOf(new URL(`https://atpota.to/api/og-garden?${q}`));
    expect(actor('actor=dame.is.png')).toBe('dame.is');
    expect(actor('actor=did%3Aplc%3Agq4fo3u6tqzzdkjlwzpb23tj.png')).toBe('did:plc:gq4fo3u6tqzzdkjlwzpb23tj');
    expect(actor('actor=%3Cscript%3E')).toBeNull();
  });
});

describe('the garden page function', () => {
  const PAGE = read('garden/index.html');
  const tag = (html: string, re: RegExp) => html.match(re)?.[1];

  it("gives someone's garden page its own title, description, address and card", async () => {
    const g = garden({}, { note: 'plant $& anything $1 here' });
    const res = await createGardenPageHandlers({ load: async () => g, page: async () => PAGE, now: () => NOW }).GET(new Request('https://atpota.to/api/garden-page?actor=dame.is'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(PAGE_CACHE_OK);
    const html = await res.text();
    expect(tag(html, /<title>([^<]*)<\/title>/)).toBe("dame's garden · atpotato");
    expect(tag(html, /<meta name="description" content="([^"]*)">/)).toBe('plant $&amp; anything $1 here');
    expect(tag(html, /<link rel="canonical" href="([^"]*)">/)).toBe('https://atpota.to/garden/dame.is');
    expect(tag(html, /<meta property="og:image" content="([^"]*)">/)).toBe('https://atpota.to/og/garden/dame.is.png');
    expect(tag(html, /<meta property="og:image:alt" content="([^"]*)">/)).toContain('waiting for its first flower');
    // the rest of the page is the built page's
    expect(html.replace(/<head>[\s\S]*<\/head>/, '')).toBe(PAGE.replace(/<head>[\s\S]*<\/head>/, ''));
  });

  it("goes out with the page's own tags when the garden isn't shown, isn't an address, or takes too long", async () => {
    for (const [actor, load] of [
      ['nobody.test', async () => null],
      ['%3Cscript%3E', async () => garden()],
      ['dame.is', () => new Promise<Garden>(() => undefined)],
    ] as const) {
      const h = createGardenPageHandlers({ load, page: async () => PAGE });
      const res = await h.GET(new Request(`https://atpota.to/api/garden-page?actor=${actor}`));
      expect(res.status, actor).toBe(200);
      expect(res.headers.get('cache-control')).toBe(CACHE_PLAIN);
      expect(await res.text()).toBe(PAGE);
    }
  }, 10_000);

  it("answers 503, uncached, when the built page can't be fetched, or something else comes back", async () => {
    const login = '<!DOCTYPE html><html><head><title>Login – Vercel</title></head><body></body></html>';
    for (const page of [async () => Promise.reject(new Error('down')), async () => login]) {
      const h = createGardenPageHandlers({ load: async () => garden(), page, log: () => undefined });
      const res = await h.GET(new Request('https://atpota.to/api/garden-page?actor=dame.is'));
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it("points the community garden's tags at /garden, its flowers address included", () => {
    const community = garden({ owner: { did: ATPOTATO_DID, handle: 'atpota.to', displayName: 'atpotato', avatar: null } });
    const m = gardenMeta(community, 'flowers', NOW);
    expect(m).toMatchObject({ title: 'the community garden · atpotato', url: 'https://atpota.to/garden', image: 'https://atpota.to/og/garden/atpota.to.png' });
    expect(gardenMeta(garden(), 'flowers', NOW)).toMatchObject({ title: "dame's flowers · atpotato", url: 'https://atpota.to/garden/dame.is/flowers' });
    expect(gardenMeta(community, 'tending', NOW)).toMatchObject({ url: 'https://atpota.to/garden' });
    expect(gardenMeta(garden(), 'tending', NOW)).toMatchObject({ title: "dame's tending · atpotato", url: 'https://atpota.to/garden/dame.is/tending' });
  });

  it('only swaps tags the page has', () => {
    expect(withMeta('<p>no head</p>', gardenMeta(garden(), 'garden', NOW))).toBe('<p>no head</p>');
  });
});

describe('og garden: wiring', () => {
  const vercel = JSON.parse(read('vercel.json')) as { functions: Record<string, { includeFiles?: string }> };

  it('serves the card and the garden pages from their functions, in dev too', () => {
    const rewrites = readApiRewrites(`${root}vercel.json`);
    expect(applyRewrites(rewrites, '/og/garden/dame.is.png', '')).toBe('/api/og-garden?actor=dame.is.png');
    expect(applyRewrites(rewrites, '/garden/dame.is', '')).toBe('/api/garden-page?actor=dame.is');
    expect(applyRewrites(rewrites, '/garden/dame.is/flowers', '')).toBe('/api/garden-page?actor=dame.is&level=flowers');
    expect(existsSync(`${root}public/og/garden.png`)).toBe(true);
  });

  it("ships the card function's files with it, and its own settings come before api/*.ts", () => {
    const keys = Object.keys(vercel.functions);
    expect(keys.indexOf('api/og-garden.ts')).toBeLessThan(keys.indexOf('api/*.ts'));
    const include = vercel.functions['api/og-garden.ts']!.includeFiles!;
    for (const file of ['server/og-fonts/signika-latin-700-normal.woff', 'src/assets/wordmark.svg', 'src/assets/mascot/potato-wink.svg', 'node_modules/@resvg/resvg-wasm/index_bg.wasm']) {
      const dir = file.slice(0, file.lastIndexOf('/'));
      expect(include.includes(file) || include.includes(`${dir}/**`) || include.includes(`${dir}/*.${file.split('.').pop()}`), file).toBe(true);
    }
  });
});
