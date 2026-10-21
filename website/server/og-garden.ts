/**
 * /og/garden/<actor>.png (vercel.json rewrites it to /api/og-garden?actor=<actor>): a
 * garden's Open Graph card, drawn from the garden as it is now, so a link to someone's
 * garden shows their patch with whatever's growing in it. Their garden page points here
 * (server/garden-page.ts); /garden itself keeps the static card (og/garden.png).
 *
 *   GET /og/garden/<actor>.png    <actor> is a handle or a DID, as /garden/<actor> takes
 *   ->  image/png, 1200x630, cached at the CDN for CACHE_OK
 *   ->  a redirect to the garden's static card for a garden that isn't shown (unknown,
 *       hidden or blocked: /api/garden's 404), or when reading or drawing fails
 *
 * The garden is read through /api/garden's own handler (server/garden.ts), so the card shows
 * exactly what the page would, moderation included. The flowers are drawn by the garden's
 * own code (src/scripts/flowers.ts) into a small SVG document of our own, since there is no
 * DOM here, then laid out with the weather card's satori and resvg kit (server/og-weather.ts).
 */

import { flowerSeed, SEED } from '../shared/garden-rules.js';
import { drawFlower, drawSeed, seedVariant, variantFor, type Stage } from '../src/scripts/flowers.js';
import { ATPOTATO_DID } from './blog/config.js';
import { createGardenHandlers, isActor, type Garden, type GardenDeps } from './garden.js';
import { addressOf, gardenWords, placeFlowers, statsText, type Plant } from './garden-words.js';

export { addressOf, gardenWords, placeFlowers, statsText, type Placed, type Plant } from './garden-words.js';
import { cardArt, renderPng } from './og-weather.js';
import { C, CARD_HEIGHT, chip, h, img, page, tile, wordmark, type Art, type El, type Style } from './og-weather-cards.js';

export const CACHE_OK = 'public, max-age=0, s-maxage=900, stale-while-revalidate=86400';
export const CACHE_MISSING = 'public, max-age=0, s-maxage=60';
export const STATIC_CARD = 'https://atpota.to/og/garden.png';
/** How long the garden and the owner's avatar each have to answer. */
export const READ_MS = 4000;
export const AVATAR_MAX_BYTES = 1_000_000;

export interface OgGardenDeps extends GardenDeps {
  /** Reads the garden; default /api/garden's handler. Null for a garden that isn't shown. */
  load?: (actor: string) => Promise<Garden | null>;
  /** The owner's avatar as a data: URI, or null; default fetches it. */
  avatar?: (url: string) => Promise<string | null>;
  render?: (card: El) => Promise<Uint8Array>;
}

// ---------- an SVG document for the garden's flower drawings ----------

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Just enough of an element for flowers.ts: attributes, children, and its markup. */
class SvgNode {
  readonly attrs = new Map<string, string>();
  readonly kids: SvgNode[] = [];
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  append(...kids: SvgNode[]): void {
    this.kids.push(...kids);
  }
  toString(): string {
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
    return `<${this.tag}${attrs}>${this.kids.join('')}</${this.tag}>`;
  }
}

/** flowers.ts only ever calls createElementNS, setAttribute and append. */
const svgDoc = { createElementNS: (_ns: string, tag: string) => new SvgNode(tag) } as unknown as Document;

/** One flower as the garden draws it now (garden.ts drawPlanted), as an <svg> to nest. */
export function plantSvg(f: Plant, stage: Stage): SvgNode {
  const seed = flowerSeed(f.did, f.rkey);
  const node =
    f.kind === SEED
      ? drawSeed(svgDoc, stage, seedVariant(seed), f.family)
      : drawFlower(svgDoc, f.kind, stage, variantFor(f.kind, seed, f.care, f.grew));
  return node as unknown as SvgNode;
}

// ---------- the patch ----------

const ART_W = 470;
const ART_H = CARD_HEIGHT - 56;
const PAD = 22;
const PATH = '#E6D6B0';
const MOUND = '#A58650';
const SEED_DOT = '#8C7146';

/** The most plots a card shows across and down, so a flower is big enough to see. */
export const WINDOW = { cols: 5, rows: 6 } as const;

export interface PatchWindow {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/**
 * The part of a big patch the card shows: WINDOW's worth of plots where the most is
 * growing (a bloom counts double), the top left one on a tie. A small patch is all of it.
 */
export function windowOf(cols: number, rows: number, plots: ReadonlyMap<number, { stage: Stage }>): PatchWindow {
  const w = Math.min(cols, WINDOW.cols);
  const hgt = Math.min(rows, WINDOW.rows);
  let best = { col: 0, row: 0, score: -1 };
  for (let row = 0; row + hgt <= rows; row++) {
    for (let col = 0; col + w <= cols; col++) {
      let score = 0;
      for (const [plot, { stage }] of plots) {
        const x = plot % cols;
        const y = Math.floor(plot / cols);
        if (x >= col && x < col + w && y >= row && y < row + hgt) score += stage === 'bloom' ? 2 : 1;
      }
      if (score > best.score) best = { col, row, score };
    }
  }
  return { col: best.col, row: best.row, cols: w, rows: hgt };
}

/**
 * A patch from above, plot by plot, with each flower in its plot at its stage: the
 * garden's grid (src/styles/patch.css), its window (windowOf) filling the tile and the
 * plots around it running off the edges.
 */
export function patchSvg(cols: number, rows: number, plots: ReadonlyMap<number, { plant: Plant; stage: Stage }>): string {
  const gapRatio = 0.1;
  const win = windowOf(cols, rows, plots);
  const unit = Math.min((ART_W - 2 * PAD) / (win.cols + gapRatio * (win.cols - 1)), (ART_H - 2 * PAD) / (win.rows + gapRatio * (win.rows - 1)));
  const gap = unit * gapRatio;
  const left = (ART_W - (win.cols * unit + (win.cols - 1) * gap)) / 2 - win.col * (unit + gap);
  const top = (ART_H - (win.rows * unit + (win.rows - 1) * gap)) / 2 - win.row * (unit + gap);
  const f = (n: number) => n.toFixed(1);
  const cells: string[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const x = left + (i % cols) * (unit + gap);
    const y = top + Math.floor(i / cols) * (unit + gap);
    if (x > ART_W || y > ART_H || x + unit < 0 || y + unit < 0) continue;
    cells.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(unit)}" height="${f(unit)}" rx="${f(unit * 0.2)}" fill="${MOUND}"/>`);
    const here = plots.get(i);
    if (here) {
      const svg = plantSvg(here.plant, here.stage);
      const inset = unit * 0.04;
      for (const [k, v] of Object.entries({ x: f(x + inset), y: f(y + inset), width: f(unit - 2 * inset), height: f(unit - 2 * inset), overflow: 'visible' })) svg.setAttribute(k, v);
      svg.attrs.delete('class');
      cells.push(String(svg));
    } else {
      cells.push(`<circle cx="${f(x + unit / 2)}" cy="${f(y + unit / 2)}" r="${f(Math.max(2, unit * 0.035))}" fill="${SEED_DOT}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}"><rect width="${ART_W}" height="${ART_H}" fill="${PATH}"/>${cells.join('')}</svg>`;
}

// ---------- the card ----------

/** Bigger for a short name, smaller for a long one; never more than two lines (drawGarden). */
export function titleSize(title: string): number {
  const n = [...title].length;
  return n <= 16 ? 76 : n <= 28 ? 64 : n <= 40 ? 52 : 44;
}

/**
 * A name or a note as the card's font can draw it: no emoji (signika has none, so they come
 * out as empty boxes) and no runs of spaces left behind where they were.
 */
export function cardText(s: string): string {
  return s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u200D\uFE0E\uFE0F\u20E3]/gu, '').replace(/\s+/g, ' ').replace(/\s+([',.!?)])/g, '$1').replace(/\(\s*\)/g, '').trim();
}

/** A line of text cut short with an ellipsis, or `lines` lines of it: satori only clamps a block, and a block takes a bare string. */
function clipped(text: string, lines: number, style: Style): El {
  const clip: Style = lines === 1 ? { whiteSpace: 'nowrap', textOverflow: 'ellipsis' } : { lineClamp: lines };
  return { type: 'div', props: { style: { display: 'block', overflow: 'hidden', ...clip, ...style }, children: text } };
}

export function drawGarden(g: Garden, art: Art, avatar: string | null, now: number): El {
  const words = gardenWords(g);
  const placed = placeFlowers(g, now);
  const cols = g.patch?.cols ?? 4;
  const rows = g.patch?.rows ?? 5;
  const potatoW = 250;
  const title = cardText(words.title) || cardText(`@${g.owner.handle}'s garden`);
  const note = words.note ? cardText(words.note) : '';
  const community = g.owner.did === ATPOTATO_DID;
  const text = tile(
    { flex: 1, minWidth: 0, padding: '50px 54px', background: C.paper },
    h(
      { alignItems: 'center', gap: 16 },
      wordmark(art, C.brown, 40),
      words.chip ? chip(words.chip, { background: C.leafTint, color: C.leaf, height: 40, fontSize: 20, fontWeight: 700 }) : null,
    ),
    h(
      { flexDirection: 'column', marginTop: 'auto', paddingTop: 24, maxWidth: 440, position: 'relative' },
      community
        ? null
        : h(
            { alignItems: 'center', gap: 14, marginBottom: 20 },
            avatar ? img(avatar, 60, 60, { borderRadius: 999, border: `3px solid ${C.skin}`, flexShrink: 0 }) : null,
            clipped(`@${addressOf(g.owner)}`, 1, { minWidth: 0, fontSize: 24, fontWeight: 600, color: C.soft }),
          ),
      clipped(title, 2, { fontSize: titleSize(title), fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.025em', color: C.ink }),
      note ? clipped(note, 2, { marginTop: 16, fontSize: 24, lineHeight: 1.35, color: C.soft }) : null,
      h(
        { marginTop: 24, alignSelf: 'flex-start', alignItems: 'center', height: 44, padding: '0 20px', borderRadius: 999, background: C.bg, fontSize: 20, fontWeight: 700, color: C.leaf },
        statsText(g, placed),
      ),
    ),
    img(art.mascot('wink'), potatoW, Math.round((potatoW * 419) / 515), { position: 'absolute', right: -30, bottom: -76 }),
  );
  const pic = tile(
    { width: ART_W, flexShrink: 0 },
    img(`data:image/svg+xml;base64,${Buffer.from(patchSvg(cols, rows, placed.plots)).toString('base64')}`, ART_W, ART_H, { position: 'absolute', left: 0, top: 0 }),
  );
  return page(text, pic);
}

// ---------- reading ----------

const defaultLog = (fields: { event: string; [k: string]: unknown }) => console.warn(JSON.stringify({ src: 'og-garden', ...fields }));

/** Only Bluesky's image CDN, as the AppView hands it out. */
export function isAvatarUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'cdn.bsky.app';
  } catch {
    return false;
  }
}

/** The CDN's small JPEG of an avatar: the card can't draw the WebP it serves by default. */
export function avatarThumb(url: string): string {
  return url.replace('/img/avatar/', '/img/avatar_thumbnail/').replace(/@(jpeg|png|webp)$/, '') + '@jpeg';
}

async function fetchAvatar(doFetch: typeof fetch, url: string): Promise<string | null> {
  if (!isAvatarUrl(url)) return null;
  try {
    const res = await doFetch(avatarThumb(url), { signal: AbortSignal.timeout(READ_MS) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!res.ok || !/^image\/(jpeg|png)$/.test(type)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length <= AVATAR_MAX_BYTES ? `data:${type};base64,${bytes.toString('base64')}` : null;
  } catch {
    return null;
  }
}

/** "dame.is.png" to "dame.is"; null when it isn't a handle or a DID. */
export function actorOf(url: URL): string | null {
  const actor = decodeURIComponent(url.searchParams.get('actor') ?? '').replace(/\.png$/i, '').trim();
  return actor && isActor(actor) ? actor : null;
}

// ---------- the function ----------

export function createOgGardenHandlers(deps: OgGardenDeps = {}) {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? Date.now;
  const render = deps.render ?? renderPng;
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const garden = createGardenHandlers(deps);

  const load =
    deps.load ??
    (async (actor: string): Promise<Garden | null> => {
      const res = await garden.GET(new Request(`https://atpota.to/api/garden?owner=${encodeURIComponent(actor)}`, { signal: AbortSignal.timeout(READ_MS) }));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`garden answered ${res.status}`);
      return (await res.json()) as Garden;
    });
  const avatar = deps.avatar ?? ((url: string) => fetchAvatar(doFetch as typeof fetch, url));

  const fallback = (cache: string) => new Response(null, { status: 302, headers: { location: STATIC_CARD, 'cache-control': cache } });

  async function GET(request: Request): Promise<Response> {
    const actor = actorOf(new URL(request.url));
    if (!actor) return fallback(CACHE_MISSING);
    let g: Garden | null;
    try {
      g = await load(actor);
    } catch (error) {
      log({ event: 'og_garden_error', error: (error as Error)?.message ?? 'Error' });
      return fallback('no-store');
    }
    if (!g) return fallback(CACHE_MISSING);
    const headers = { 'content-type': 'image/png', 'cache-control': CACHE_OK, 'x-content-type-options': 'nosniff' };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'cache-control': 'no-store' } });
    try {
      const face = g.owner.did !== ATPOTATO_DID && g.owner.avatar ? await avatar(g.owner.avatar) : null;
      return new Response((await render(drawGarden(g, await cardArt(), face, now()))) as BodyInit, { status: 200, headers });
    } catch (error) {
      log({ event: 'og_draw_error', error: (error as Error)?.message ?? 'Error' });
      return fallback('no-store');
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
