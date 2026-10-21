/**
 * /og/weather.png (vercel.json rewrites it to /api/og-weather): the weather report's Open
 * Graph card, drawn from the weather right now, so a link to /weather, and each of Poe's
 * weather posts, shows the sky as it was when it was shared.
 *
 *   GET /og/weather.png                the default card (DEFAULT_CARD)
 *   GET /og/weather.png?card=<name>    forecast | trend | mix | today (server/og-weather-cards.ts);
 *                                      anything else is the default card, never an error
 *   ->  image/png, 1200x630, cached at the CDN for CACHE_OK
 *
 * The numbers are read here, from the same places the page reads them, through the same
 * checks: the weather station's last 60 seconds (fromStation, as /api/atmosphere has it, but
 * never its Jetstream sample: a card shouldn't spend five seconds listening), and
 * /api/weather-history?range=day and /api/weather-almanac?tz=UTC through their own handlers.
 * Each has READ_MS. What doesn't come in time is left out; a card that needs it gives way to
 * the quiet card (no numbers), which is cached for a minute only. The answer is always a
 * PNG: if even the quiet card can't be drawn, it's a redirect to the home page's card.
 *
 * Drawn with satori (layout and text to SVG) and resvg (SVG to PNG), in Signika (OFL,
 * server/og-fonts/), because Eigerdals comes from an Adobe Fonts kit and can't be bundled.
 * vercel.json includeFiles ships the fonts, the mascots, the wordmark and resvg's wasm with
 * the function, since they're read from disk rather than imported.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';
import { fromStation, STATION_URL, type Reading } from './atmosphere.js';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DEFAULT_CARD,
  drawCard,
  drawQuiet,
  isCard,
  type AlmanacData,
  type Art,
  type CardData,
  type CardName,
  type DayHistory,
  type El,
  type MascotFace,
} from './og-weather-cards.js';
import { createAlmanacHandlers } from './weather-almanac.js';
import { createHistoryHandlers } from './weather-history.js';

export const CACHE_OK = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600';
/** The quiet card: try again soon. */
export const CACHE_QUIET = 'public, max-age=0, s-maxage=60, stale-while-revalidate=120';
/** How long each source has to answer. */
export const READ_MS = 4000;
/** Where to send a crawler if nothing can be drawn at all. */
export const FALLBACK_IMAGE = 'https://atpota.to/og/home.png';

type Env = Record<string, string | undefined>;

const defaultLog = (fields: { event: string; [k: string]: unknown }) => console.warn(JSON.stringify({ src: 'og-weather', ...fields }));

export interface OgWeatherDeps {
  fetch?: typeof fetch;
  now?: () => number;
  env?: () => Env;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
  /** Reads the weather; default readCardData with these deps. */
  read?: () => Promise<CardData>;
  /** Draws a card to PNG; default renderPng. */
  render?: (card: El) => Promise<Uint8Array>;
  readMs?: number;
}

// ---------- reading the weather ----------

/** `run`, or null if it fails or takes longer than `ms`. */
async function within<T>(ms: number, run: () => Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)))]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A handler's JSON answer, or null for anything but a 200. */
async function body(res: Response): Promise<unknown> {
  return res.ok ? res.json() : null;
}

export async function readCardData(deps: OgWeatherDeps = {}): Promise<CardData> {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const env = deps.env ?? (() => process.env);
  const at = (deps.now ?? Date.now)();
  const ms = deps.readMs ?? READ_MS;
  const handlerDeps = { fetch: fetchImpl, env, now: () => at, log: deps.log ?? defaultLog };

  const now = within<Reading>(ms, async () => {
    const vars = env();
    const secret = vars.ATMOSPHERE_STATION_SECRET?.trim();
    if (!secret) return null;
    const res = await fetchImpl(vars.ATMOSPHERE_STATION_URL?.trim() || STATION_URL, {
      headers: { accept: 'application/json', 'x-atpotato-weather-secret': secret },
      signal: AbortSignal.timeout(ms),
    });
    return res.ok ? fromStation(await res.json()) : null;
  });
  const day = within<DayHistory>(ms, async () => {
    const b = await body(await createHistoryHandlers(handlerDeps).GET(new Request('https://atpota.to/api/weather-history?range=day')));
    return b && typeof b === 'object' && Array.isArray((b as DayHistory).points) ? (b as DayHistory) : null;
  });
  const almanac = within<AlmanacData>(ms, async () => {
    const b = await body(await createAlmanacHandlers(handlerDeps).GET(new Request('https://atpota.to/api/weather-almanac?tz=UTC')));
    return b && typeof b === 'object' ? (b as AlmanacData) : null;
  });
  return { at, now: await now, day: await day, almanac: await almanac };
}

// ---------- drawing ----------

/** A file that ships with the function (vercel.json includeFiles), by its path in website/. */
export async function asset(path: string): Promise<Buffer> {
  try {
    return await readFile(fileURLToPath(new URL(`../${path}`, import.meta.url)));
  } catch {
    return readFile(resolve(process.cwd(), path));
  }
}

const FONTS = [
  ['signika-latin-400-normal.woff', 400],
  ['signika-latin-600-normal.woff', 600],
  ['signika-latin-700-normal.woff', 700],
] as const;
const FACES: readonly MascotFace[] = ['happy', 'sleepy', 'wow', 'scawy', 'kawaii', 'wink'];

interface Kit {
  fonts: Array<{ name: string; data: Buffer; weight: 400 | 600 | 700; style: 'normal' }>;
  art: Art;
}

let kit: Promise<Kit> | null = null;

const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** Fonts, pictures and resvg's wasm, loaded once per instance. */
function loadKit(): Promise<Kit> {
  kit ??= (async () => {
    const wasm = await readFile(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')).catch(() =>
      asset('node_modules/@resvg/resvg-wasm/index_bg.wasm'),
    );
    await initWasm(wasm);
    const fonts = await Promise.all(FONTS.map(async ([file, weight]) => ({ name: 'signika', data: await asset(`server/og-fonts/${file}`), weight, style: 'normal' as const })));
    const wordmark = (await asset('src/assets/wordmark.svg')).toString('utf8');
    const mascots = new Map(await Promise.all(FACES.map(async (f) => [f, dataUri((await asset(`src/assets/mascot/potato-${f}.svg`)).toString('utf8'))] as const)));
    const art: Art = {
      wordmark: (color) => dataUri(wordmark.replaceAll('currentColor', color)),
      mascot: (face) => mascots.get(face)!,
    };
    return { fonts, art };
  })();
  kit.catch(() => (kit = null));
  return kit;
}

export async function cardArt(): Promise<Art> {
  return (await loadKit()).art;
}

/** A card's element tree to an SVG, its text drawn as paths. */
export async function renderSvg(card: El): Promise<string> {
  const { fonts } = await loadKit();
  // satori's types want a ReactNode; a plain { type, props } tree is what it reads.
  return satori(card as never, { width: CARD_WIDTH, height: CARD_HEIGHT, fonts });
}

/** A card's element tree to a PNG. */
export async function renderPng(card: El): Promise<Uint8Array> {
  const svg = await renderSvg(card);
  return new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } }).render().asPng();
}

/** The card asked for, or the quiet card when its numbers aren't in. */
export async function cardFor(name: CardName, data: CardData): Promise<{ card: El; quiet: boolean }> {
  const art = await cardArt();
  const card = drawCard(name, data, art);
  return card ? { card, quiet: false } : { card: drawQuiet(data, art), quiet: true };
}

// ---------- the function ----------

export function createOgWeatherHandlers(deps: OgWeatherDeps = {}) {
  const log = deps.log ?? defaultLog;
  const read = deps.read ?? (() => readCardData({ ...deps, log }));
  const render = deps.render ?? renderPng;

  const png = (request: Request, bytes: Uint8Array | null, cache: string) =>
    new Response(request.method === 'HEAD' ? null : (bytes as BodyInit | null), {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': cache, 'x-content-type-options': 'nosniff' },
    });

  async function GET(request: Request): Promise<Response> {
    const asked = new URL(request.url).searchParams.get('card');
    const name = isCard(asked) ? asked : DEFAULT_CARD;
    // A HEAD only wants to know there's an image here; drawing one is the expensive part.
    // Never cached, so an empty answer can't stand in for a card.
    if (request.method === 'HEAD') return png(request, null, 'no-store');
    let data: CardData;
    try {
      data = await read();
    } catch (error) {
      log({ event: 'og_read_error', error: (error as Error)?.message ?? 'Error' });
      data = { at: (deps.now ?? Date.now)(), now: null, day: null, almanac: null };
    }
    try {
      const { card, quiet } = await cardFor(name, data);
      try {
        return png(request, await render(card), quiet ? CACHE_QUIET : CACHE_OK);
      } catch (error) {
        if (quiet) throw error;
        log({ event: 'og_draw_error', card: name, error: (error as Error)?.message ?? 'Error' });
        return png(request, await render(drawQuiet(data, await cardArt())), CACHE_QUIET);
      }
    } catch (error) {
      log({ event: 'og_quiet_error', error: (error as Error)?.message ?? 'Error' });
      return new Response(null, { status: 302, headers: { location: FALLBACK_IMAGE, 'cache-control': 'no-store' } });
    }
  }

  return {
    GET,
    HEAD: GET,
    async methodNotAllowed(request: Request) {
      return new Response(request.method === 'HEAD' ? null : 'method not allowed\n', {
        status: 405,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD', 'x-content-type-options': 'nosniff' },
      });
    },
  };
}
