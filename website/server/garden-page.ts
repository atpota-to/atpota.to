/**
 * /garden/<actor>, /garden/<actor>/flowers and /garden/<actor>/tending (vercel.json rewrites
 * them to /api/garden-page?actor=<actor>[&level=flowers|tending]): the garden page (garden/index.html) as
 * built, with its title, description and Open Graph tags made this garden's, so a link to
 * someone's garden unfurls as theirs, with its card (/og/garden/<actor>.png,
 * server/og-garden.ts). The page itself is unchanged: it reads the garden in the browser,
 * from its address, as before.
 *
 * The garden is read through /api/garden's own handler (server/garden.ts), so only a garden
 * the page would show gets its own tags. When it can't be read in time, isn't shown, or the
 * address isn't a handle or a DID, the page goes out with the built page's own tags.
 */

import type { Fetch } from './blog/atproto.js';
import { fetchPage } from './blog/shell.js';
import { ATPOTATO_DID } from './blog/config.js';
import { createGardenHandlers, isActor, type Garden, type GardenDeps } from './garden.js';
import { addressOf, gardenWords, placeFlowers } from './garden-words.js';

/** With cleanUrls, garden/index.html is served at /garden (/garden/index.html only redirects there). */
export const PAGE_PATHS = ['/garden'] as const;
/** Only on the garden page: a protected preview answers its login page with a 200, and that mustn't go out as a garden. */
export const PAGE_MARKER = 'data-garden-page';
export const SITE_ORIGIN = 'https://atpota.to';
export const CACHE_OK = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';
export const CACHE_PLAIN = 'public, max-age=0, s-maxage=60';
/** How long the garden has to answer before the page goes out with its own tags. */
export const READ_MS = 2500;

type Env = Record<string, string | undefined>;

export interface GardenPageDeps extends GardenDeps {
  /** Reads the garden; default /api/garden's handler. Null for a garden that isn't shown. */
  load?: (actor: string) => Promise<Garden | null>;
  /** The built page; default fetched from this deployment. */
  page?: (request: Request) => Promise<string>;
  vars?: () => Env;
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface GardenMeta {
  title: string;
  description: string;
  url: string;
  image: string;
  alt: string;
}

export type GardenLevel = 'garden' | 'flowers' | 'tending';

/** The tags for a garden, in the page's words (src/scripts/garden-page.ts COPY). */
export function gardenMeta(g: Garden, level: GardenLevel, now: number): GardenMeta {
  const words = gardenWords(g);
  const who = g.owner.displayName || `@${g.owner.handle}`;
  const community = g.owner.did === ATPOTATO_DID;
  // The community garden is /garden, and its "flowers" and "tending" are just the garden (garden-page.ts).
  const path = community ? '/garden' : `/garden/${encodeURIComponent(addressOf(g.owner))}${level === 'garden' ? '' : `/${level}`}`;
  const n = g.flowers.length;
  const { blooming } = placeFlowers(g, now);
  const patch = !g.patch
    ? 'an empty patch, not planted yet'
    : n === 0
      ? 'its patch from above, waiting for its first flower'
      : `its patch from above, with ${n} ${n === 1 ? 'flower' : 'flowers'}${blooming ? `, ${blooming} in bloom` : ' coming up'}`;
  return {
    title: community ? 'the community garden · atpotato' : `${who}'s ${level} · atpotato`,
    description: words.lede,
    url: `${SITE_ORIGIN}${path}`,
    image: `${SITE_ORIGIN}/og/garden/${encodeURIComponent(addressOf(g.owner))}.png`,
    alt: `${words.title} on atpotato: ${patch}, and poe the potato winking from the corner.`,
  };
}

/** Each tag's value swapped for the garden's; a tag the page doesn't have stays missing. */
export function withMeta(html: string, m: GardenMeta): string {
  const swaps: Array<[RegExp, string]> = [
    [/<title>[^<]*<\/title>/, `<title>${escapeAttr(m.title)}</title>`],
    [/<meta name="title" content="[^"]*">/, `<meta name="title" content="${escapeAttr(m.title)}">`],
    [/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeAttr(m.description)}">`],
    [/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeAttr(m.url)}">`],
    [/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapeAttr(m.url)}">`],
    [/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapeAttr(m.title)}">`],
    [/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeAttr(m.description)}">`],
    [/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${escapeAttr(m.image)}">`],
    [/<meta property="og:image:alt" content="[^"]*">/, `<meta property="og:image:alt" content="${escapeAttr(m.alt)}">`],
  ];
  // A function as the replacement, so a "$" in someone's garden name is only ever text.
  return swaps.reduce((out, [re, tag]) => out.replace(re, () => tag), html);
}

const defaultLog = (fields: { event: string; [k: string]: unknown }) => console.warn(JSON.stringify({ src: 'garden-page', ...fields }));

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

export function createGardenPageHandlers(deps: GardenPageDeps = {}) {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? Date.now;
  const vars = deps.vars ?? (() => process.env);
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const garden = createGardenHandlers(deps);

  const load =
    deps.load ??
    (async (actor: string): Promise<Garden | null> => {
      const res = await garden.GET(new Request(`${SITE_ORIGIN}/api/garden?owner=${encodeURIComponent(actor)}`));
      return res.ok ? ((await res.json()) as Garden) : null;
    });

  const page =
    deps.page ??
    ((request: Request) =>
      fetchPage(doFetch, { origin: new URL(request.url).origin, cookie: request.headers.get('cookie'), bypassSecret: vars().VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null }, PAGE_PATHS));

  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const actor = (url.searchParams.get('actor') ?? '').trim();
    const asked = url.searchParams.get('level');
    const level: GardenLevel = asked === 'flowers' || asked === 'tending' ? asked : 'garden';
    const [html, g] = await Promise.all([
      page(request)
        .then((text) => {
          if (!text.includes(PAGE_MARKER)) throw new Error('that is not the garden page');
          return text;
        })
        .catch((error: unknown) => {
        log({ event: 'garden_page_error', error: (error as Error)?.message ?? 'Error' });
        return null;
      }),
      actor && isActor(actor) ? within(READ_MS, () => load(actor)) : Promise.resolve(null),
    ]);
    if (html === null) {
      return new Response(request.method === 'HEAD' ? null : 'the garden page is unavailable just now. try again in a moment?\n', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    const body = g ? withMeta(html, gardenMeta(g, level, now())) : html;
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': g ? CACHE_OK : CACHE_PLAIN, 'x-content-type-options': 'nosniff' },
    });
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

