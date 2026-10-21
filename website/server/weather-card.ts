/**
 * /weather/card.png (rewritten to /api/weather-card): the weather report's Open Graph card,
 * drawn from the live reading when someone shares the page, so a link posted in a storm
 * shows the storm. The other cards are screenshots made at build time (scripts/og-cards.html);
 * this one can't be, so it's drawn here with @vercel/og (satori and resvg) in the same
 * shape: the words on paper on the left, the sky on the right with Poe on a mound under it.
 *
 *   GET / HEAD  ->  image/png, 1200x630
 *
 * The sky follows the reading: clouds by the diversity index (the hero's rule, cloudCount),
 * wind when it's gusty, rain and a grey sky when it's stormy, and Poe's face by the
 * condition. Without a reading (the station and Jetstream both quiet, or too slow) it
 * draws the report's title on a plain day instead, and the CDN keeps that for less time.
 *
 * The site's typeface (Eigerdals) comes from an Adobe Fonts kit that only serves web pages,
 * so the card is set in Nunito (server/fonts, SIL Open Font License, OFL.txt). The fonts
 * and the art are read from the project's files: vercel.json includes them in this function.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from '@vercel/og';
import { createAtmosphereHandlers, type Condition, type DiversityLevel, type Reading } from './atmosphere.js';
import { methodNotAllowed } from './supabase-public.js';

export const WIDTH = 1200;
export const HEIGHT = 630;
export const CACHE = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';
/** Without a reading, try again sooner. */
export const CACHE_FALLBACK = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
/** A crawler waits a few seconds for a card; past this it gets the plain one. */
export const READING_TIMEOUT_MS = 8000;

/** The hero's words for each condition (CONDITION_TEXT in src/scripts/weather.ts). */
export const CONDITION_TEXT: Record<Condition, string> = {
  calm: 'calm. a quiet moment in the atmosphere',
  light: 'a light breeze. a quiet spell',
  breezy: 'breezy. a usual day in the atmosphere',
  gusty: 'gusty. lots going on out there',
  stormy: 'stormy. somebody said something',
};

/** Poe's face for each condition (src/assets/mascot). */
export const FACES: Record<Condition, string> = {
  calm: 'sleepy',
  light: 'normal',
  breezy: 'happy',
  gusty: 'wink',
  stormy: 'wow',
};

/** Clouds in the sky for a diversity index (cloudCount in src/scripts/weather-sky.ts). */
export const MAX_CLOUDS = 8;
const INDEX_TOP = 11;
export function cloudCount(index: number): number {
  if (!(index > 0)) return 0;
  return Math.max(1, Math.round(MAX_CLOUDS * Math.sqrt(Math.min(index, INDEX_TOP) / INDEX_TOP)));
}

// tokens.css, light theme
const C = {
  bg: '#F4EEDF',
  paper: '#FFFDF7',
  ink: '#3D2F1B',
  soft: '#5E4D33',
  brown: '#725B36',
  skin: '#A58650',
  leaf: '#006837',
  leafStrong: '#00532C',
  leafTint: '#E2F0D6',
  sky: '#B3DDF0',
};

// ---------- elements: satori takes React-shaped objects, so no React is needed ----------

type Style = Record<string, string | number>;
export interface Node {
  type: string;
  props: { style?: Style; children?: Child | Child[]; [k: string]: unknown };
}
type Child = Node | string | null | false;

function h(type: string, props: Node['props'], ...children: Child[]): Node {
  const kids = children.filter((c): c is Node | string => c !== null && c !== false);
  return { type, props: kids.length ? { ...props, children: kids.length === 1 ? kids[0] : kids } : props };
}

const div = (style: Style, ...children: Child[]) => h('div', { style: { display: 'flex', ...style } }, ...children);
const img = (src: string, style: Style) => h('img', { src, style, width: style.width, height: style.height });

const svgData = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

// ---------- the art ----------

export interface Assets {
  fonts: Array<{ name: string; data: ArrayBuffer; weight: 400 | 800; style: 'normal' }>;
  wordmark: string;
  sun: string;
  poe: Record<Condition, string>;
}

/** The sun's parts and their colours by day (components.css), as attributes: the renderer reads no CSS. */
const SUN_PAINT: ReadonlyArray<readonly [string, string]> = [
  ['class="weather-sun__rays" data-weather-rays', 'fill="none" stroke="#F2AE3A" stroke-width="7" stroke-linecap="round"'],
  ['class="weather-sun__short"', 'stroke-width="6"'],
  ['class="weather-sun__disc"', 'fill="#FFD978" stroke="#F2AE3A" stroke-width="5" stroke-linejoin="round"'],
  ['class="weather-sun__shine"', 'fill="none" stroke="#FFFDF7" stroke-opacity="0.85" stroke-width="4" stroke-linecap="round"'],
  ['class="weather-sun__glint"', 'fill="#FFFDF7" fill-opacity="0.85"'],
];

/** The weather sun (src/assets/weather-sun.svg) by day, painted; the moon left out. */
export function paintSun(svg: string): string {
  let out = svg
    .replace(/<\?xml[^>]*>\s*/, '')
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .replace(/<g class="weather-sun__night">[\s\S]*?<\/g>\s*/, '')
    .replace('<g class="weather-sun__day">', '<g>');
  for (const [from, to] of SUN_PAINT) out = out.replaceAll(from, to);
  return out;
}

export async function loadAssets(root: string): Promise<Assets> {
  const file = (path: string) => readFile(join(root, path));
  const text = async (path: string) => (await file(path)).toString('utf8');
  const font = async (weight: 400 | 800) => {
    const buf = await file(`server/fonts/nunito-${weight}.woff`);
    return { name: 'Nunito', data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, weight, style: 'normal' as const };
  };
  const conditions = Object.keys(FACES) as Condition[];
  const [regular, heavy, wordmark, sun, ...faces] = await Promise.all([
    font(400),
    font(800),
    text('src/assets/wordmark.svg'),
    text('src/assets/weather-sun.svg'),
    ...conditions.map((c) => text(`src/assets/mascot/potato-${FACES[c]}.svg`)),
  ]);
  return {
    fonts: [regular, heavy],
    wordmark: svgData(wordmark.replace(/currentColor/g, C.brown)),
    sun: svgData(paintSun(sun)),
    poe: Object.fromEntries(conditions.map((c, i) => [c, svgData(faces[i])])) as Record<Condition, string>,
  };
}

/** Where each cloud sits in the sky tile: left and top in px, and its width. */
const CLOUDS: ReadonlyArray<{ x: number; y: number; w: number }> = [
  { x: 30, y: 64, w: 140 },
  { x: 150, y: 178, w: 90 },
  { x: 336, y: 250, w: 100 },
  { x: 120, y: 18, w: 72 },
  { x: -24, y: 212, w: 100 },
  { x: 206, y: 100, w: 64 },
  { x: 384, y: 316, w: 80 },
  { x: 250, y: 16, w: 60 },
]

function cloud(x: number, y: number, w: number, color: string): Node {
  const hh = Math.round(w * 0.3);
  return div(
    { position: 'absolute', left: x, top: y, width: w, height: hh * 2 },
    div({ position: 'absolute', left: Math.round(w * 0.16), top: 0, width: Math.round(w * 0.42), height: Math.round(w * 0.42), borderRadius: 999, background: color }),
    div({ position: 'absolute', left: Math.round(w * 0.42), top: Math.round(hh * 0.35), width: Math.round(w * 0.34), height: Math.round(w * 0.34), borderRadius: 999, background: color }),
    div({ position: 'absolute', left: 0, top: Math.round(w * 0.28), width: w, height: hh, borderRadius: 999, background: color }),
  );
}

/** Rain: short slanted streaks in rows, the same every time so the card doesn't flicker on refetch. */
function rain(): Node[] {
  const drops: Node[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 7; col++) {
      const x = col * 72 + (row % 2) * 36 + ((row * 5 + col * 3) % 4) * 6 - 20;
      const y = 150 + row * 46 + ((col * 7) % 5) * 4;
      drops.push(div({ position: 'absolute', left: x, top: y, width: 4, height: 26, borderRadius: 4, background: 'rgba(62, 92, 122, 0.5)', transform: 'rotate(16deg)' }));
    }
  }
  return drops;
}

function wind(): Node[] {
  return [
    { x: 20, y: 180, w: 140 },
    { x: 230, y: 240, w: 200 },
    { x: 60, y: 300, w: 110 },
    { x: 280, y: 330, w: 150 },
  ].map(({ x, y, w }) => div({ position: 'absolute', left: x, top: y, width: w, height: 6, borderRadius: 6, background: 'rgba(255, 255, 255, 0.75)' }));
}

function sky(assets: Assets, condition: Condition, clouds: number): Node {
  const stormy = condition === 'stormy';
  const cloudColor = stormy ? 'rgba(226, 232, 236, 0.92)' : 'rgba(255, 255, 255, 0.78)';
  return div(
    {
      position: 'relative',
      width: 470,
      height: HEIGHT - 56,
      borderRadius: 40,
      overflow: 'hidden',
      background: stormy ? 'linear-gradient(180deg, #8EA2B0 0%, #B7C5CE 100%)' : `linear-gradient(180deg, ${C.sky} 0%, #D6EEF7 100%)`,
    },
    img(assets.sun, { position: 'absolute', right: 34, top: 34, width: 176, height: 176, opacity: stormy ? 0.55 : 1 }),
    ...(stormy ? rain() : []),
    ...CLOUDS.slice(0, clouds).map((c) => cloud(c.x, c.y, c.w, cloudColor)),
    // a storm cloud over the sun
    stormy && cloud(226, 78, 220, '#DCE3E8'),
    ...(condition === 'gusty' ? wind() : []),
    div({ position: 'absolute', left: -50, right: -50, bottom: -14, height: 156, borderRadius: '50% 50% 0 0 / 100% 100% 0 0', background: C.skin }),
    img(assets.poe[condition], { position: 'absolute', left: 14, bottom: 100, width: 340, height: 277 }),
  );
}

// ---------- the words ----------

/** "2:05 pm utc, oct 21": when the reading was taken. */
export function takenAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).toLowerCase();
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toLowerCase();
  return `${time} utc, ${day}`;
}

const LEVEL_TEXT: Record<DiversityLevel, string> = {
  low: 'mostly bluesky out there',
  moderate: 'a good mix of apps in the air',
  high: 'lots of other apps about',
  'very high': 'the atmosphere is really mixing it up',
  extreme: 'bluesky is barely the weather today',
};

function wordmark(assets: Assets): Node {
  return div(
    { alignItems: 'center', gap: 16 },
    img(assets.wordmark, { width: 160, height: 40 }),
    div({ alignItems: 'center', gap: 10, padding: '9px 18px 9px 14px', borderRadius: 999, background: C.leafTint, color: C.leafStrong, fontSize: 19, fontWeight: 800 }, div({ width: 12, height: 12, borderRadius: 999, background: C.leaf }), 'weather report'),
  );
}

const paper = (...children: Child[]) =>
  div({ flex: 1, minWidth: 0, flexDirection: 'column', justifyContent: 'space-between', padding: '50px 54px', borderRadius: 40, background: C.paper }, ...children);

function words(assets: Assets, r: Reading): Node {
  const rate = String(Math.round(r.records.perSecond));
  const at = takenAt(r.measuredAt);
  return paper(
    wordmark(assets),
    div(
      { flexDirection: 'column' },
      div({ fontSize: 27, color: C.soft }, at ? `the atmosphere at ${at}` : 'the atmosphere right now'),
      div(
        { alignItems: 'baseline', gap: 16, marginTop: 4 },
        div({ fontSize: 168, fontWeight: 800, color: C.ink, lineHeight: 1, letterSpacing: '-0.04em' }, rate),
        div({ fontSize: 40, fontWeight: 800, color: C.soft }, 'rec/sec'),
      ),
      div({ marginTop: 10, fontSize: 34, fontWeight: 800, color: C.ink, lineHeight: 1.2 }, `${CONDITION_TEXT[r.condition]}.`),
      div(
        { alignItems: 'center', marginTop: 26, alignSelf: 'flex-start', height: 46, padding: '0 20px', borderRadius: 999, background: C.bg, color: C.soft, fontSize: 20 },
        'diversity index',
        div({ marginLeft: 8, color: C.leaf, fontWeight: 800 }, `${r.diversity.index.toFixed(1)}, ${r.diversity.level}`),
      ),
      div({ marginTop: 14, fontSize: 21, color: C.soft }, `${LEVEL_TEXT[r.diversity.level] ?? 'read live from the firehose'}.`),
    ),
  );
}

function plainWords(assets: Assets): Node {
  return paper(
    wordmark(assets),
    div(
      { flexDirection: 'column' },
      div({ fontSize: 68, fontWeight: 800, color: C.ink, lineHeight: 1, letterSpacing: '-0.03em' }, 'the atmosphere weather report'),
      div({ marginTop: 22, fontSize: 27, lineHeight: 1.36, color: C.soft }, 'how busy bluesky is right now, how much of the sky belongs to other apps, and who they are. read live from the firehose.'),
    ),
  );
}

/** The whole card: the reading's, or the plain one without a reading. */
export function card(assets: Assets, r: Reading | null): Node {
  return div(
    { width: WIDTH, height: HEIGHT, padding: 28, gap: 16, background: C.bg, fontFamily: 'Nunito' },
    r ? words(assets, r) : plainWords(assets),
    r ? sky(assets, r.condition, cloudCount(r.diversity.index)) : sky(assets, 'breezy', 3),
  );
}

// ---------- the handler ----------

export type Render = (element: Node, options: { width: number; height: number; fonts: Assets['fonts']; headers: Record<string, string> }) => Promise<Response> | Response;

export interface CardDeps {
  /** The live reading; default the atmosphere handler's (server/atmosphere.ts). */
  reading?: () => Promise<Reading>;
  /** Draws the PNG; default @vercel/og's ImageResponse. */
  render?: Render;
  /** Where the fonts and art are read from; default the project root (process.cwd()). */
  root?: string;
  timeoutMs?: number;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

function liveReading(): () => Promise<Reading> {
  const atmosphere = createAtmosphereHandlers();
  return async () => {
    const res = await atmosphere.GET(new Request('https://atpota.to/api/atmosphere'));
    if (!res.ok) throw new Error(`atmosphere answered ${res.status}`);
    return (await res.json()) as Reading;
  };
}

const ogRender: Render = (element, options) => new ImageResponse(element, options);

export function createCardHandlers(deps: CardDeps = {}) {
  const reading = deps.reading ?? liveReading();
  const render = deps.render ?? ogRender;
  const log = deps.log ?? ((fields) => console.warn(JSON.stringify({ src: 'weather-card', ...fields })));
  const timeoutMs = deps.timeoutMs ?? READING_TIMEOUT_MS;
  let assets: Promise<Assets> | null = null;

  async function read(): Promise<Reading | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('reading took too long')), timeoutMs);
    });
    try {
      return await Promise.race([reading(), late]);
    } catch (error) {
      log({ event: 'reading_error', error: (error as Error)?.message ?? 'Error' });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function GET(request: Request): Promise<Response> {
    const headers = { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'cache-control': CACHE } });
    const r = await read();
    const cache = r ? CACHE : CACHE_FALLBACK;
    assets ??= loadAssets(deps.root ?? process.cwd());
    assets.catch(() => (assets = null));
    try {
      const art = await assets;
      return await render(card(art, r), { width: WIDTH, height: HEIGHT, fonts: art.fonts, headers: { ...headers, 'cache-control': cache } });
    } catch (error) {
      log({ event: 'card_error', error: (error as Error)?.message ?? 'Error' });
      return new Response(null, { status: 302, headers: { location: '/og/home.png', 'cache-control': 'no-store' } });
    }
  }

  return { GET, HEAD: GET, methodNotAllowed: async (request: Request) => methodNotAllowed(request) };
}
