/**
 * /api/blog: Poe's blog, server-rendered from standard.site records. vercel.json rewrites
 * the public addresses here (and build/api-middleware.ts applies the same rewrites in dev):
 *
 *   /blog                                          view=index       the list of posts
 *   /blog/feed.xml                                 view=feed        Atom feed
 *   /blog/<path>                                   view=post        one post, by its record's
 *                                                                   path or its record key
 *   /.well-known/site.standard.publication/blog    view=well-known  the publication's at:// URI
 *                                                                   (standard.site verification)
 *   /blog/preview/<token>                          view=preview     a draft of the dispatch,
 *                                                                   read from the droplet by
 *                                                                   its private token, never
 *                                                                   cached or indexed
 *   /receive_auth_callback                         view=email-return
 *                                                                   Leaflet's way back for an
 *                                                                   email subscriber: a redirect
 *                                                                   to their page (subscribe.ts)
 *
 * Pages are cached by Vercel's CDN for a few minutes and served stale while they refresh,
 * so a new post shows up within about five minutes without a deploy. Records, identities
 * and the shell are also cached briefly in the function instance. A post also carries its
 * comments and recommend count (discussion.ts), on the same cache; the reader's own new
 * comment shows at once because the browser adds it (src/blog/).
 */

import type { Env } from '../config.js';
import { AtprotoError, resolveDid, TtlCache, type Fetch, type Identity } from './atproto.js';
import { embedTargets, EMPTY_EMBEDS, headingShiftFor, leafletPages, pagesText } from './blocks.js';
import { ATPOTATO_DID, POE_DID, readBlogConfig, type BlogConfig } from './config.js';
import { loadDiscussion } from './discussion.js';
import { loadEmbeds } from './embeds.js';
import { atomFeed, FEED_ENTRIES } from './feed.js';
import {
  docHref,
  indexPage,
  notFoundPage,
  postBody,
  postPage,
  siteInfo,
  unavailablePage,
  type Page,
} from './pages.js';
import { documentPath, findDocument, findPublication, listDocuments, toDocument, type BlogDocument, type Publication } from './records.js';
import { bareDocument, fetchShell, fillShell, type Shell } from './shell.js';
import { EMAIL_RETURN_COOKIE_CLEARED, emailReturnLocation } from './subscribe.js';

/** Fresh for 5 minutes at the CDN, then served stale for up to a day while it refreshes. */
export const CACHE_OK = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';
export const CACHE_MISSING = 'public, max-age=0, s-maxage=60';
export const CACHE_WELL_KNOWN = 'public, max-age=3600, s-maxage=3600';
export const DATA_TTL_MS = 60_000;
export const SHELL_TTL_MS = 10 * 60_000;
/** A draft is private and changes with every edit: never stored anywhere on the way. */
export const CACHE_PREVIEW = 'private, no-store';
export const PREVIEW_TIMEOUT_MS = 8000;
const PREVIEW_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

interface DraftPreview {
  draft: { status: string; version: number; savedAt: string | null; published?: string };
  record: Record<string, unknown> | null;
}

/** If plc.directory is unreachable, the PDS for Poe's and atpota.to's repos is still known. */
const KNOWN_PDS: Readonly<Record<string, string>> = {
  [POE_DID]: 'https://pds.atpota.to',
  [ATPOTATO_DID]: 'https://pds.atpota.to',
};

export interface BlogDeps {
  env?: () => Env;
  fetch?: Fetch;
  now?: () => number;
  log?: (fields: { event: string; code?: string; status?: number; error?: string }) => void;
}

export interface BlogData {
  identity: Identity;
  publication: Publication | null;
  docs: BlogDocument[];
}

export interface BlogHandlers {
  GET(request: Request): Promise<Response>;
  HEAD(request: Request): Promise<Response>;
  methodNotAllowed(request: Request): Promise<Response>;
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

/** Keeps a page out of search engines, whatever its own tags say. */
function privately(response: Response): Response {
  response.headers.set('x-robots-tag', 'noindex, nofollow');
  return response;
}

function respond(method: string, body: string, status: number, type: string, cache: string, extra: Record<string, string> = {}): Response {
  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: { 'content-type': type, 'cache-control': cache, ...BASE_HEADERS, ...extra },
  });
}

/**
 * The publication and its posts, cached in the instance for DATA_TTL_MS. Shared by the
 * pages here and each post's Open Graph card (server/og-dispatch.ts).
 */
export function createBlogData(deps: Pick<BlogDeps, 'fetch' | 'now'> = {}): (config: BlogConfig) => Promise<BlogData> {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const dataCache = new TtlCache<Promise<BlogData>>(DATA_TTL_MS, now);

  async function identityFor(did: string): Promise<Identity> {
    try {
      return await resolveDid(doFetch, did);
    } catch (error) {
      const known = KNOWN_PDS[did];
      if (known) return { did, pds: known, handle: null };
      throw error;
    }
  }

  function loadData(config: BlogConfig): Promise<BlogData> {
    const key = `${config.did}|${config.publicationUri ?? ''}|${config.publicationUrl}`;
    const cached = dataCache.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const identity = await identityFor(config.did);
      const publication = await findPublication(doFetch, identity, { pinnedUri: config.publicationUri, url: config.publicationUrl });
      const docs = publication ? await listDocuments(doFetch, identity, publication, now()) : [];
      return { identity, publication, docs };
    })();
    dataCache.set(key, pending);
    pending.catch(() => dataCache.delete(key));
    return pending;
  }

  return loadData;
}

export function createBlogHandlers(deps: BlogDeps = {}): BlogHandlers {
  const env = deps.env ?? (() => process.env);
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const log =
    deps.log ??
    ((fields) => {
      const line = JSON.stringify({ src: 'blog', ...fields });
      if (fields.event.endsWith('_error')) console.warn(line);
      else console.info(line);
    });

  const loadData = createBlogData({ fetch: doFetch, now });
  const shellCache = new TtlCache<Shell>(SHELL_TTL_MS, now);

  async function shellFor(request: Request, e: Env): Promise<Shell> {
    const origin = new URL(request.url).origin;
    // Off Vercel (vite dev) the shell is re-read every time, so edits to it show up.
    const cacheable = Boolean(e.VERCEL);
    const cached = cacheable ? shellCache.get(origin) : undefined;
    if (cached) return cached;
    const shell = await fetchShell(doFetch, {
      origin,
      cookie: request.headers.get('cookie'),
      bypassSecret: e.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null,
    });
    return cacheable ? shellCache.set(origin, shell) : shell;
  }

  async function page(request: Request, e: Env, status: number, cache: string, build: (shell: Shell) => Page): Promise<Response> {
    let shell: Shell;
    try {
      shell = await shellFor(request, e);
    } catch (error) {
      log({ event: 'shell_error', error: (error as Error)?.name ?? 'Error' });
      return respond(request.method, bareDocument(build({ html: '', assets: new Map() })), status >= 500 ? status : 503, 'text/html; charset=utf-8', 'no-store');
    }
    return respond(request.method, fillShell(shell, build(shell)), status, 'text/html; charset=utf-8', cache);
  }

  async function unavailable(request: Request, e: Env, error: unknown): Promise<Response> {
    log({ event: 'records_error', code: error instanceof AtprotoError ? error.code : 'unknown', error: (error as Error)?.name ?? 'Error' });
    return page(request, e, 503, 'no-store', (shell) => unavailablePage(shell.assets));
  }

  async function GET(request: Request): Promise<Response> {
    const e = env();
    const config = readBlogConfig(e);
    const url = new URL(request.url);
    const view = url.searchParams.get('view') ?? 'index';

    // Needs no records: Leaflet's token is for Leaflet, the page to go back to is in a cookie.
    if (view === 'email-return') {
      return new Response(null, {
        status: 303,
        headers: { location: emailReturnLocation(request.headers.get('cookie')), 'cache-control': 'no-store', 'set-cookie': EMAIL_RETURN_COOKIE_CLEARED, ...BASE_HEADERS },
      });
    }

    let data: BlogData;
    try {
      data = await loadData(config);
    } catch (error) {
      if (view === 'well-known' || view === 'feed') {
        log({ event: 'records_error', code: error instanceof AtprotoError ? error.code : 'unknown' });
        return respond(request.method, 'unavailable\n', 503, 'text/plain; charset=utf-8', 'no-store');
      }
      return unavailable(request, e, error);
    }
    // A publication hosted elsewhere (the dispatch lives at poe.leaflet.pub) keeps its own
    // url as the canonical address, and only a publication at this address is claimed here.
    const site = siteInfo(data.publication, data.publication?.url ?? config.publicationUrl, data.identity.handle, config.emailEnabled);

    if (view === 'well-known') {
      if (!data.publication || data.publication.url !== config.publicationUrl) {
        return respond(request.method, '', 404, 'text/plain; charset=utf-8', CACHE_MISSING);
      }
      return respond(request.method, data.publication.uri, 200, 'text/plain; charset=utf-8', CACHE_WELL_KNOWN, {
        'access-control-allow-origin': '*',
      });
    }

    if (view === 'feed') {
      const entries = data.docs.slice(0, FEED_ENTRIES).map((doc) => {
        const pages = leafletPages(doc.content);
        return {
          doc,
          html: postBody({
            site,
            doc,
            pages,
            text: '',
            embeds: EMPTY_EMBEDS,
            did: data.identity.did,
            pds: data.identity.pds,
            others: [],
            headingShift: headingShiftFor(pages),
          }),
        };
      });
      return respond(request.method, atomFeed(site, entries, new Date(now()).toISOString()), 200, 'application/atom+xml; charset=utf-8', CACHE_OK);
    }

    if (view === 'index') {
      return page(request, e, 200, CACHE_OK, (shell) => indexPage(site, data.docs, shell.assets));
    }

    if (view === 'preview') return preview(request, e, data, site, url.searchParams.get('token') ?? '', config.previewOrigin);

    if (view !== 'post') {
      return page(request, e, 404, CACHE_MISSING, (shell) => notFoundPage(site, shell.assets));
    }

    const rest = url.searchParams.get('path') ?? '';
    const doc = findDocument(data.docs, rest);
    if (!doc) return page(request, e, 404, CACHE_MISSING, (shell) => notFoundPage(site, shell.assets));

    // Reached by record key while the record names another path: send readers to the one address.
    if (`/${rest.replace(/^\/+|\/+$/g, '')}` !== documentPath(doc)) {
      return new Response(null, { status: 308, headers: { location: docHref(doc), 'cache-control': CACHE_OK, ...BASE_HEADERS } });
    }

    const index = data.docs.indexOf(doc);
    const pages = leafletPages(doc.content);
    const [embeds, discussion] = await Promise.all([
      loadEmbeds(doFetch, embedTargets(pages)),
      config.commentsEnabled ? loadDiscussion(doFetch, { document: doc.uri, owner: data.identity, hidden: config.hiddenComments }) : null,
    ]);
    if (discussion?.status === 'unavailable') log({ event: 'discussion_error' });
    return page(request, e, 200, CACHE_OK, (shell) =>
      postPage({
        site,
        doc,
        pages,
        text: pagesText(pages),
        embeds,
        did: data.identity.did,
        pds: data.identity.pds,
        newer: data.docs[index - 1] ?? null,
        older: data.docs[index + 1] ?? null,
        others: data.docs.filter((d) => d !== doc),
        headingShift: headingShiftFor(pages),
        assets: shell.assets,
        coverCid: doc.coverCid,
        discussion,
      }),
    );
  }

  /**
   * A draft of the dispatch, from the droplet (mentions/src/dispatch-drafts.js), rendered as
   * the issue will look. The token is the only key, so an unknown one is a plain not found,
   * and a draft that has since gone out sends the reader to the issue.
   */
  async function preview(request: Request, e: Env, data: BlogData, site: ReturnType<typeof siteInfo>, token: string, origin: string): Promise<Response> {
    const missing = () => page(request, e, 404, CACHE_PREVIEW, (shell) => notFoundPage(site, shell.assets)).then(privately);
    if (!PREVIEW_TOKEN_RE.test(token)) return missing();
    let found: DraftPreview;
    try {
      const res = await doFetch(`${origin}/dispatch/preview/${encodeURIComponent(token)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      });
      if (res.status === 404) return missing();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      found = (await res.json()) as DraftPreview;
    } catch (error) {
      log({ event: 'preview_error', error: (error as Error)?.message ?? 'Error' });
      return page(request, e, 503, CACHE_PREVIEW, (shell) => unavailablePage(shell.assets)).then(privately);
    }
    if (found.draft?.published && /^https:\/\/(?:atpota\.to\/blog|poe\.leaflet\.pub)\/[A-Za-z0-9._~-]+$/.test(found.draft.published)) {
      return new Response(null, { status: 302, headers: { location: found.draft.published, 'cache-control': CACHE_PREVIEW, ...BASE_HEADERS } });
    }
    const record = found.record;
    const doc = record
      ? toDocument({ uri: `at://${data.identity.did}/site.standard.document/preview`, cid: 'preview',
        value: { ...record, publishedAt: found.draft.savedAt ?? new Date(now()).toISOString() } }, data.identity)
      : null;
    if (!doc) return missing();
    const pages = leafletPages(doc.content);
    const embeds = await loadEmbeds(doFetch, embedTargets(pages));
    return page(request, e, 200, CACHE_PREVIEW, (shell) =>
      postPage({
        site,
        doc,
        pages,
        text: pagesText(pages),
        embeds,
        did: data.identity.did,
        pds: data.identity.pds,
        newer: null,
        older: null,
        others: data.docs,
        headingShift: headingShiftFor(pages),
        assets: shell.assets,
        preview: { version: found.draft.version, savedAt: found.draft.savedAt, status: found.draft.status },
      }),
    ).then(privately);
  }

  return {
    GET,
    HEAD: GET,
    async methodNotAllowed(request: Request) {
      return respond(request.method, 'method not allowed\n', 405, 'text/plain; charset=utf-8', 'no-store', { allow: 'GET, HEAD' });
    },
  };
}

