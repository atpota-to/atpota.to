/**
 * /og/dispatch/<key>.png (vercel.json rewrites it to /api/og-dispatch?key=<key>): one dispatch
 * issue's Open Graph card, so a link to a post shows that issue's title rather than the
 * blog's card. Each post page points here (server/blog/pages.ts) unless the post has a
 * cover image of its own.
 *
 *   GET /og/dispatch/<key>.png    <key> is the post's record key or path, as /blog/<key> takes
 *   ->  image/png, 1200x630, cached at the CDN for CACHE_OK
 *   ->  a redirect to the blog's card (/og/blog.png) for a post that isn't there, or when the
 *       records or the drawing fail
 *
 * The post is found the way its page finds it (createBlogData, findDocument), so only a real
 * post's title is ever drawn on an atpota.to card. Drawn with the weather card's satori and
 * resvg kit (server/og-weather.ts), in the same tiles as the blog's card (og/blog.png): the
 * text on paper, and Poe on the home page's meadow under green rays.
 */

import { createBlogData, type BlogDeps } from './blog/handler.js';
import { formatDate } from './blog/blocks.js';
import { readBlogConfig } from './blog/config.js';
import { DEFAULT_OG_IMAGE, siteInfo } from './blog/pages.js';
import { findDocument } from './blog/records.js';
import { asset, cardArt, measureHeight, renderPng } from './og-weather.js';
import { C, CARD_HEIGHT, CARD_WIDTH, chip, h, img, mixColor, page, PAGE_GAP, PAGE_PAD, tile, wordmark, type Art, type El, type Style } from './og-weather-cards.js';

export const CACHE_OK = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';
export const CACHE_MISSING = 'public, max-age=0, s-maxage=60';

/** What a card says about an issue. */
export interface Issue {
  title: string;
  description: string | null;
  publishedAt: string;
  /** 1 for the first issue. */
  number: number;
  /** The byline's handle, without the @ (always Poe's, as on the post's page). */
  handle: string;
  /** The publication's name. */
  name: string;
}

export interface OgDispatchDeps extends BlogDeps {
  /** Finds the issue for a key; default reads the publication's records. */
  load?: (key: string) => Promise<Issue | null>;
  /** Draws a card to PNG; default renderPng. */
  render?: (card: El) => Promise<Uint8Array>;
}

// ---------- drawing ----------

const ART_W = 470;
const ART_H = CARD_HEIGHT - 56;
const SAGE = '#C5E3B0';
const SAGE_DEEP = '#CFE7C1';
/** The rays' centre, as in og-cards.html (.og-rays: at 50% 76%). */
const RAYS_AT = { x: ART_W / 2, y: Math.round(ART_H * 0.76) };

/** The home hero's meadow, out of season (src/styles/home.css --ground, its shade and tufts). */
const MEADOW = { ground: '#B9DE93', shade: mixColor('#4C7A33', '#B9DE93', 0.26), tuft: mixColor('#2F5A22', '#B9DE93', 0.5) };
const MOUND_H = 160;
/** Where Poe's feet are, from the bottom of the tile. */
export const FEET = 112;

/** The green rays, and the meadow Poe stands on: its darker band, grass tufts and a soft shadow. Shapes only. */
export function backdropSvg(): string {
  const r = 1000;
  const wedges: string[] = [];
  for (let a = 0; a < 360; a += 16) {
    const p = (deg: number) => {
      const t = ((deg - 90) * Math.PI) / 180;
      return `${(RAYS_AT.x + r * Math.cos(t)).toFixed(1)} ${(RAYS_AT.y + r * Math.sin(t)).toFixed(1)}`;
    };
    wedges.push(`M${RAYS_AT.x} ${RAYS_AT.y} L${p(a)} L${p(a + 8)} Z`);
  }
  // As og-cards.html's .og-mound: 10% wider than the tile each side, 160px tall, sunk 12px.
  const cx = ART_W / 2;
  const rx = ART_W * 0.6;
  const cy = ART_H + 12;
  const crest = (x: number) => cy - MOUND_H * Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2));
  const tuft = (x: number, y: number) =>
    `<path transform="translate(${(x - 13).toFixed(1)} ${(y - 24).toFixed(1)}) scale(1.1)" d="M12,23 q-2,-8 -8,-12 M12,23 q0,-11 1,-20 M12,23 q3,-7 9,-10" fill="none" stroke="${MEADOW.tuft}" stroke-width="3" stroke-linecap="round"/>`;
  const feetY = ART_H - FEET;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}">` +
    `<defs><clipPath id="mound"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${MOUND_H}"/></clipPath>` +
    `<radialGradient id="shadow"><stop offset="0" stop-color="#2A1E10" stop-opacity="0.2"/><stop offset="1" stop-color="#2A1E10" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${ART_W}" height="${ART_H}" fill="${SAGE_DEEP}"/>` +
    `<path fill="${SAGE}" d="${wedges.join(' ')}"/>` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${MOUND_H}" fill="${MEADOW.ground}"/>` +
    // home.css: radial-gradient(56.6% 94% at 50% 136%, shade 99%, transparent 100%)
    `<ellipse clip-path="url(#mound)" cx="${cx}" cy="${cy - MOUND_H + MOUND_H * 1.36}" rx="${(rx * 2 * 0.566).toFixed(1)}" ry="${(MOUND_H * 0.94).toFixed(1)}" fill="${MEADOW.shade}"/>` +
    [0.05, 0.27, 0.73, 0.95].map((p) => tuft(ART_W * p, crest(ART_W * p) + 20)).join('') +
    `<ellipse cx="${cx - 4}" cy="${feetY}" rx="110" ry="13" fill="url(#shadow)"/>` +
    '</svg>'
  );
}

// ---------- fitting the text ----------
//
// Titles and descriptions vary a lot in length, and how many lines they wrap to depends on
// the words, not only on how many characters there are. So rather than guess sizes from the
// length, the card lays its text tile out with satori first (measureHeight) and picks the
// biggest title, and the most lines of description, that fit inside the tile.

/** The text tile's width, and every tile's height: the card less its margins, the gap and the picture. */
const TEXT_W = CARD_WIDTH - 2 * PAGE_PAD - PAGE_GAP - ART_W;
const TILE_H = CARD_HEIGHT - 2 * PAGE_PAD;
const PAD_X = 54;
const PAD_Y = 50;
/** The width the title and description wrap at. */
const TEXT_INNER_W = TEXT_W - 2 * PAD_X;

/** Title sizes, biggest first. */
export const TITLE_SIZES = [76, 66, 56, 48, 42] as const;
/** A title wraps to at most this many lines; past it, the size goes down, and at the smallest it ends in an ellipsis. */
export const TITLE_LINES = 3;
/** The description gets the lines left under the title, at most DESCRIPTION_LINES; a title shrinks to leave it DESCRIPTION_MIN. */
export const DESCRIPTION_LINES = 4;
const DESCRIPTION_MIN = 2;
const DESCRIPTION_GAP = 20;
const DESCRIPTION_TEXT: Style = { fontFamily: 'signika', fontSize: 26, lineHeight: 1.35, color: C.soft, wordBreak: 'break-word' };
const DESCRIPTION_LINE_H = 26 * 1.35;

/**
 * How the card sets an issue's text. The title is
 *   'balance'  evened out across its lines, so no word sits alone on the last one
 *   'wrap'     wrapped plainly, breaking a word too long for a line (a balanced title can't
 *              break words: satori would narrow it until it split short ones too)
 *   'clamp'    too long even at the smallest size: cut off after TITLE_LINES with an ellipsis
 */
export interface Fit {
  titleSize: number;
  title: 'balance' | 'wrap' | 'clamp';
  /** The description as drawn, cut at a word to fit descriptionLines; '' draws none. */
  description: string;
  descriptionLines: number;
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Text in a block, cut to `lines` lines with an ellipsis: satori only clamps a block, and a block takes a bare string. */
function clamped(text: string, lines: number, style: Style): El {
  return { type: 'div', props: { style: { display: 'block', overflow: 'hidden', lineClamp: lines, ...style }, children: text } };
}

function titleStyle(size: number): Style {
  return { fontFamily: 'signika', fontSize: size, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.025em', color: C.ink };
}

function titleEl(title: string, size: number, how: Fit['title']): El {
  // satori balances by narrowing the text until it would take another line, so a balanced
  // title can't also be clamped (it would narrow to nothing) or break words (it would split short ones).
  if (how === 'balance') return h({ ...titleStyle(size), textWrap: 'balance' }, title);
  if (how === 'wrap') return h({ ...titleStyle(size), wordBreak: 'break-word' }, title);
  return clamped(title, TITLE_LINES, { ...titleStyle(size), wordBreak: 'break-word' });
}

/**
 * The biggest title that wraps to TITLE_LINES or fewer and leaves the description room, and as
 * much of the description as then fits, measured with the card's own layout and fonts.
 */
export async function fitIssue(issue: Issue, art: Art): Promise<Fit> {
  const title = flat(issue.title);
  const description = issue.description ? flat(issue.description) : '';
  const smallest = TITLE_SIZES[TITLE_SIZES.length - 1]!;
  const linesOf = async (el: El, lineHeight: number) => Math.round((await measureHeight(el, TEXT_INNER_W)) / lineHeight);
  const tileHeight = (fit: Fit) => measureHeight(textTile(issue, art, fit, { width: TEXT_W }), TEXT_W);

  let fit: Fit = { titleSize: smallest, title: 'clamp', description: '', descriptionLines: 0 };
  for (const titleSize of TITLE_SIZES) {
    const last = titleSize === smallest;
    const fits = (await linesOf(titleEl(title, titleSize, 'wrap'), titleSize)) <= TITLE_LINES;
    if (!fits && !last) continue;
    // A balanced title is as tall as a wrapped one, so 'wrap' stands in for it here.
    fit = { titleSize, title: fits ? 'wrap' : 'clamp', description: '', descriptionLines: 0 };
    const room = Math.floor((TILE_H - (await tileHeight(fit)) - DESCRIPTION_GAP) / DESCRIPTION_LINE_H);
    fit.descriptionLines = description ? Math.max(0, Math.min(DESCRIPTION_LINES, room)) : 0;
    if (!description || fit.descriptionLines >= DESCRIPTION_MIN || last) break;
  }

  // Balance the title if every word fits on a line by itself: one word to a line, and none wraps.
  if (fit.title === 'wrap') {
    const words = title.split(' ');
    const alone = h({ ...titleStyle(fit.titleSize), whiteSpace: 'pre-line', wordBreak: 'break-word' }, words.join('\n'));
    if ((await linesOf(alone, fit.titleSize)) === words.length) fit.title = 'balance';
  }

  // Cut the description at the last word that fits, then check the whole tile once more (the
  // layout rounds) and give up a line at a time until it fits.
  for (; fit.descriptionLines > 0; fit.descriptionLines--) {
    fit.description = await cutToLines(description, fit.descriptionLines, (text) => linesOf(h(DESCRIPTION_TEXT, text), DESCRIPTION_LINE_H));
    if ((await tileHeight(fit)) <= TILE_H) return fit;
  }
  return { ...fit, description: '' };
}

/** `text` whole if it takes `lines` lines or fewer, or as many of its words as fit with an ellipsis after them. */
async function cutToLines(text: string, lines: number, linesOf: (text: string) => Promise<number>): Promise<string> {
  if ((await linesOf(text)) <= lines) return text;
  const words = text.split(' ');
  const cut = (n: number) => `${words.slice(0, n).join(' ').replace(/[\s,.;:]+$/, '')}…`;
  // The most words that fit: `fit` words do, `over` words don't.
  let fit = 0;
  let over = words.length;
  while (over - fit > 1) {
    const mid = (fit + over) >> 1;
    if ((await linesOf(cut(mid))) <= lines) fit = mid;
    else over = mid;
  }
  // Not even one word fits (one very long one): satori's clamp cuts it short instead.
  return fit > 0 ? cut(fit) : text;
}

// ---------- the card ----------

const SPROUT_H = 195 / 210;

/** The words half of the card. `size` is how wide it is: flex in the card, a fixed width when measured. */
function textTile(issue: Issue, art: Art, fit: Fit, size: Style): El {
  const byline = [`@${issue.handle}`, formatDate(issue.publishedAt) || null].filter(Boolean).join(' · ');
  return tile(
    { ...size, padding: `${PAD_Y}px ${PAD_X}px`, background: C.paper, fontFamily: 'signika' },
    h({ alignItems: 'center', gap: 16 }, wordmark(art, C.brown, 40), chip(`issue ${issue.number}`, { background: C.leafTint, color: C.leaf, height: 40, fontSize: 20, fontWeight: 700 })),
    h(
      { flexDirection: 'column', marginTop: 'auto', paddingTop: 24 },
      h({ marginBottom: 14, fontSize: 24, fontWeight: 600, color: C.muted }, issue.name),
      titleEl(flat(issue.title), fit.titleSize, fit.title),
      fit.description && fit.descriptionLines > 0 ? clamped(fit.description, fit.descriptionLines, { ...DESCRIPTION_TEXT, marginTop: DESCRIPTION_GAP }) : null,
      h(
        { marginTop: 24, alignSelf: 'flex-start', alignItems: 'center', gap: 8, height: 46, padding: '0 20px', borderRadius: 999, background: C.bg, fontSize: 20, color: C.soft },
        h({}, 'by'),
        h({ fontWeight: 700, color: C.leaf }, byline),
      ),
    ),
  );
}

export function drawIssue(issue: Issue, art: Art, sprout: string, fit: Fit): El {
  const potatoW = 350;
  const pic = tile(
    { width: ART_W, flexShrink: 0 },
    img(`data:image/svg+xml;base64,${Buffer.from(backdropSvg()).toString('base64')}`, ART_W, ART_H, { position: 'absolute', left: 0, top: 0 }),
    img(sprout, 70, Math.round(70 * SPROUT_H), { position: 'absolute', left: 28, bottom: 114 }),
    img(sprout, 44, Math.round(44 * SPROUT_H), { position: 'absolute', left: 92, bottom: 126 }),
    img(sprout, 58, Math.round(58 * SPROUT_H), { position: 'absolute', right: 22, bottom: 112 }),
    img(art.mascot('happy'), potatoW, Math.round((potatoW * 419) / 515), { position: 'absolute', left: ART_W / 2 - 180, bottom: FEET }),
  );
  return page(textTile(issue, art, fit, { flex: 1, minWidth: 0 }), pic);
}

let sproutUri: Promise<string> | null = null;

function sproutArt(): Promise<string> {
  sproutUri ??= asset('src/assets/sprout.svg').then((svg) => `data:image/svg+xml;base64,${svg.toString('base64')}`);
  sproutUri.catch(() => (sproutUri = null));
  return sproutUri;
}

export async function cardFor(issue: Issue): Promise<El> {
  const [art, sprout] = await Promise.all([cardArt(), sproutArt()]);
  return drawIssue(issue, art, sprout, await fitIssue(issue, art));
}

// ---------- the function ----------

const defaultLog = (fields: { event: string; [k: string]: unknown }) => console.warn(JSON.stringify({ src: 'og-dispatch', ...fields }));

/** "3myasnk4bzk22.png" or "/some/path.png" to what /blog/<key> takes. */
export function keyOf(url: URL): string {
  return (url.searchParams.get('key') ?? '').replace(/\.png$/i, '').replace(/^\/+|\/+$/g, '');
}

export function createOgDispatchHandlers(deps: OgDispatchDeps = {}) {
  const env = deps.env ?? (() => process.env);
  const log = deps.log ?? defaultLog;
  const render = deps.render ?? renderPng;
  const loadData = createBlogData(deps);

  const load =
    deps.load ??
    (async (key: string): Promise<Issue | null> => {
      const config = readBlogConfig(env());
      const data = await loadData(config);
      const doc = findDocument(data.docs, key);
      if (!doc) return null;
      const site = siteInfo(data.publication, data.publication?.url ?? config.publicationUrl, data.identity.handle);
      return {
        title: doc.title,
        description: doc.description,
        publishedAt: doc.publishedAt,
        number: data.docs.length - data.docs.indexOf(doc),
        handle: site.handle,
        name: site.name,
      };
    });

  const fallback = (cache: string) => new Response(null, { status: 302, headers: { location: DEFAULT_OG_IMAGE, 'cache-control': cache } });

  async function GET(request: Request): Promise<Response> {
    const key = keyOf(new URL(request.url));
    if (!key) return fallback(CACHE_MISSING);
    let issue: Issue | null;
    try {
      issue = await load(key);
    } catch (error) {
      log({ event: 'og_records_error', error: (error as Error)?.message ?? 'Error' });
      return fallback('no-store');
    }
    if (!issue) return fallback(CACHE_MISSING);
    const headers = { 'content-type': 'image/png', 'cache-control': CACHE_OK, 'x-content-type-options': 'nosniff' };
    // A HEAD only wants to know there's an image here; drawing one is the expensive part.
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'cache-control': 'no-store' } });
    try {
      return new Response((await render(await cardFor(issue))) as BodyInit, { status: 200, headers });
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
