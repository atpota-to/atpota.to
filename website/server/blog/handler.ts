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
 *
 * Pages are cached by Vercel's CDN for a few minutes and served stale while they refresh,
 * so a new post shows up within about five minutes without a deploy. Records, identities
 * and the shell are also cached briefly in the function instance.
 */

import type { Env } from '../config.js';
import { AtprotoError, resolveDid, TtlCache, type Fetch, type Identity } from './atproto.js';
import { embedTargets, EMPTY_EMBEDS, headingShiftFor, leafletPages, pagesText } from './blocks.js';
import { POE_DID, readBlogConfig, type BlogConfig } from './config.js';
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
import { documentPath, findDocument, findPublication, listDocuments, type BlogDocument, type Publication } from './records.js';
import { bareDocument, fetchShell, fillShell, type Shell } from './shell.js';

/** Fresh for 5 minutes at the CDN, then served stale for up to a day while it refreshes. */
export const CACHE_OK = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';
export const CACHE_MISSING = 'public, max-age=0, s-maxage=60';
export const CACHE_WELL_KNOWN = 'public, max-age=3600, s-maxage=3600';
export const DATA_TTL_MS = 60_000;
export const SHELL_TTL_MS = 10 * 60_000;

/** If plc.directory is unreachable, Poe's PDS is still known. */
const KNOWN_PDS: Readonly<Record<string, string>> = { [POE_DID]: 'https://pds.atpota.to' };

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

function respond(method: string, body: string, status: number, type: string, cache: string, extra: Record<string, string> = {}): Response {
  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: { 'content-type': type, 'cache-control': cache, ...BASE_HEADERS, ...extra },
  });
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

  const dataCache = new TtlCache<Promise<BlogData>>(DATA_TTL_MS, now);
  const shellCache = new TtlCache<Shell>(SHELL_TTL_MS, now);

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
    const site = siteInfo(data.publication, config.publicationUrl, data.identity.handle);

    if (view === 'well-known') {
      if (!data.publication) return respond(request.method, '', 404, 'text/plain; charset=utf-8', CACHE_MISSING);
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
    const embeds = await loadEmbeds(doFetch, embedTargets(pages));
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
      }),
    );
  }

  return {
    GET,
    HEAD: GET,
    async methodNotAllowed(request: Request) {
      return respond(request.method, 'method not allowed\n', 405, 'text/plain; charset=utf-8', 'no-store', { allow: 'GET, HEAD' });
    },
  };
}

