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
import { clip, DEFAULT_OG_IMAGE, siteInfo } from './blog/pages.js';
import { findDocument } from './blog/records.js';
import { asset, cardArt, renderPng } from './og-weather.js';
import { C, CARD_HEIGHT, chip, h, img, mixColor, page, tile, wordmark, type Art, type El } from './og-weather-cards.js';

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

/** Bigger for a short title, smaller for a long one, so it fits in three lines or so. */
export function titleSize(title: string): number {
  const n = [...title].length;
  return n <= 28 ? 76 : n <= 48 ? 66 : n <= 72 ? 56 : 48;
}

/** A long title leaves room for a line or two of the description; a short one, three or four. */
export function descriptionMax(title: string): number {
  return titleSize(title) > 48 ? 150 : 90;
}

const SPROUT_H = 195 / 210;

export function drawIssue(issue: Issue, art: Art, sprout: string): El {
  const potatoW = 350;
  const byline = [`@${issue.handle}`, formatDate(issue.publishedAt) || null].filter(Boolean).join(' · ');
  const text = tile(
    { flex: 1, minWidth: 0, padding: '50px 54px', background: C.paper },
    h({ alignItems: 'center', gap: 16 }, wordmark(art, C.brown, 40), chip(`issue ${issue.number}`, { background: C.leafTint, color: C.leaf, height: 40, fontSize: 20, fontWeight: 700 })),
    h(
      { flexDirection: 'column', marginTop: 'auto', paddingTop: 24 },
      h({ marginBottom: 14, fontSize: 24, fontWeight: 600, color: C.muted }, issue.name),
      h({ fontSize: titleSize(issue.title), fontWeight: 700, lineHeight: 1, letterSpacing: '-0.025em', color: C.ink }, issue.title),
      issue.description ? h({ marginTop: 20, fontSize: 26, lineHeight: 1.35, color: C.soft }, clip(issue.description, descriptionMax(issue.title))) : null,
      h(
        { marginTop: 24, alignSelf: 'flex-start', alignItems: 'center', gap: 8, height: 46, padding: '0 20px', borderRadius: 999, background: C.bg, fontSize: 20, color: C.soft },
        h({}, 'by'),
        h({ fontWeight: 700, color: C.leaf }, byline),
      ),
    ),
  );
  const pic = tile(
    { width: ART_W, flexShrink: 0 },
    img(`data:image/svg+xml;base64,${Buffer.from(backdropSvg()).toString('base64')}`, ART_W, ART_H, { position: 'absolute', left: 0, top: 0 }),
    img(sprout, 70, Math.round(70 * SPROUT_H), { position: 'absolute', left: 28, bottom: 114 }),
    img(sprout, 44, Math.round(44 * SPROUT_H), { position: 'absolute', left: 92, bottom: 126 }),
    img(sprout, 58, Math.round(58 * SPROUT_H), { position: 'absolute', right: 22, bottom: 112 }),
    img(art.mascot('happy'), potatoW, Math.round((potatoW * 419) / 515), { position: 'absolute', left: ART_W / 2 - 180, bottom: FEET }),
  );
  return page(text, pic);
}

let sproutUri: Promise<string> | null = null;

function sproutArt(): Promise<string> {
  sproutUri ??= asset('src/assets/sprout.svg').then((svg) => `data:image/svg+xml;base64,${svg.toString('base64')}`);
  sproutUri.catch(() => (sproutUri = null));
  return sproutUri;
}

export async function cardFor(issue: Issue): Promise<El> {
  const [art, sprout] = await Promise.all([cardArt(), sproutArt()]);
  return drawIssue(issue, art, sprout);
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
