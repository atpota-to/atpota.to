/**
 * /api/latest: the home page's "latest" tile, one feed for everything atpotato makes.
 *
 * It reads each account's own repo (plc.directory names the PDS, then one
 * com.atproto.repo.listRecords page of app.bsky.feed.post records) and the dispatch's
 * site.standard.document records, the same ones /blog shows. Replies are left out, and
 * so are reposts, which live in another collection. Each source is read on its own: one
 * that fails or times out drops out of the feed, and only when every source fails does
 * the endpoint answer 503 (the home page then falls back to atpota.to's newest post).
 *
 *   GET /api/latest  ->  { items: LatestItem[] }, newest first, at most MAX_ITEMS
 *
 * Fresh for 5 minutes at the CDN and served stale while it refreshes, like /blog, and
 * cached for a minute in the function instance.
 */

import type { Env } from './config.js';
import { listRecords, resolveDid, TtlCache, type Fetch, type Identity, type RecordEntry } from './blog/atproto.js';
import { ATPOTATO_DID, POE_DID, readBlogConfig } from './blog/config.js';
import { docHref } from './blog/pages.js';
import { findPublication, listDocuments } from './blog/records.js';

export const CACHE_OK = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';
export const DATA_TTL_MS = 60_000;
/** Items in the feed, and how many any one source may take, so a busy account can't fill it. */
export const MAX_ITEMS = 6;
export const MAX_PER_SOURCE = 2;
export const MAX_TEXT_CHARS = 220;

export type SourceId = 'atpotato' | 'poe' | 'anisota' | 'aturi' | 'dispatch';

interface Account {
  id: Exclude<SourceId, 'dispatch'>;
  did: string;
  handle: string;
  /** Used when plc.directory is unreachable. */
  pds?: string;
}

export const ACCOUNTS: readonly Account[] = [
  { id: 'atpotato', did: ATPOTATO_DID, handle: 'atpota.to', pds: 'https://pds.atpota.to' },
  { id: 'poe', did: POE_DID, handle: 'poe.atpota.to', pds: 'https://pds.atpota.to' },
  { id: 'anisota', did: 'did:plc:lcieujcfkv4jx7gehsvok3pr', handle: 'anisota.net' },
  { id: 'aturi', did: 'did:plc:6teuhlkizzebk6wdp42633el', handle: 'aturi.to' },
];

export interface LatestItem {
  source: SourceId;
  kind: 'post' | 'article';
  /** Post text or the article's description, trimmed. May be empty for a media-only post. */
  text: string;
  /** Article title; null for posts. */
  title: string | null;
  /** Short note about a post's attachment ("with an image"), or "". */
  embed: string;
  createdAt: string;
  /** https://bsky.app/... for a post, /blog/... for an article. */
  url: string;
}

export interface LatestDeps {
  env?: () => Env;
  fetch?: Fetch;
  now?: () => number;
  log?: (fields: { event: string; source?: string; error?: string }) => void;
}

const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;

/** Collapse whitespace and cut to `max` characters at a word boundary, with an ellipsis. */
export function clip(input: string, max = MAX_TEXT_CHARS): string {
  const text = input.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.search(/\s\S*$/);
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/u, '')}…`;
}

export function embedNote(embed: unknown): string {
  if (typeof embed !== 'object' || embed === null) return '';
  const e = embed as { $type?: unknown; images?: unknown; media?: unknown };
  const type = typeof e.$type === 'string' ? e.$type : '';
  if (type.startsWith('app.bsky.embed.recordWithMedia')) {
    const media = embedNote(e.media);
    return media ? `${media} and a quoted post` : 'with a quoted post';
  }
  if (type.startsWith('app.bsky.embed.images')) {
    const count = Array.isArray(e.images) ? e.images.length : 1;
    return count > 1 ? `with ${count} images` : 'with an image';
  }
  if (type.startsWith('app.bsky.embed.video')) return 'with a video';
  if (type.startsWith('app.bsky.embed.external')) return 'with a link';
  if (type.startsWith('app.bsky.embed.record')) return 'with a quoted post';
  return '';
}

/** An account's original posts (no replies), newest first, as feed items. */
export function postItems(account: Account, entries: readonly RecordEntry[], now: number): LatestItem[] {
  const out: LatestItem[] = [];
  const prefix = `at://${account.did}/app.bsky.feed.post/`;
  for (const entry of entries) {
    if (!entry.uri.startsWith(prefix)) continue;
    const rkey = entry.uri.slice(prefix.length);
    const v = entry.value as Record<string, unknown>;
    if (!RKEY_RE.test(rkey) || v.$type !== 'app.bsky.feed.post' || v.reply !== undefined) continue;
    const created = Date.parse(typeof v.createdAt === 'string' ? v.createdAt : '');
    if (!Number.isFinite(created) || created > now + 5 * 60_000) continue;
    const text = clip(typeof v.text === 'string' ? v.text : '');
    const embed = embedNote(v.embed);
    if (!text && !embed) continue;
    out.push({
      source: account.id,
      kind: 'post',
      text,
      title: null,
      embed,
      createdAt: new Date(created).toISOString(),
      url: `https://bsky.app/profile/${account.handle}/post/${encodeURIComponent(rkey)}`,
    });
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Up to MAX_PER_SOURCE items from each source, merged newest first, at most MAX_ITEMS. */
export function mergeItems(lists: readonly LatestItem[][]): LatestItem[] {
  return lists
    .flatMap((list) => list.slice(0, MAX_PER_SOURCE))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_ITEMS);
}

export interface LatestHandlers {
  GET(request: Request): Promise<Response>;
  HEAD(request: Request): Promise<Response>;
  methodNotAllowed(request: Request): Promise<Response>;
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

export function createLatestHandlers(deps: LatestDeps = {}): LatestHandlers {
  const env = deps.env ?? (() => process.env);
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const log =
    deps.log ??
    ((fields) => {
      const line = JSON.stringify({ src: 'latest', ...fields });
      if (fields.event.endsWith('_error')) console.warn(line);
      else console.info(line);
    });

  const cache = new TtlCache<Promise<LatestItem[]>>(DATA_TTL_MS, now);

  async function identityFor(did: string, knownPds?: string): Promise<Identity> {
    try {
      return await resolveDid(doFetch, did);
    } catch (error) {
      if (knownPds) return { did, pds: knownPds, handle: null };
      throw error;
    }
  }

  async function accountItems(account: Account): Promise<LatestItem[]> {
    const identity = await identityFor(account.did, account.pds);
    return postItems(account, await listRecords(doFetch, identity.pds, identity.did, 'app.bsky.feed.post', 1), now());
  }

  async function dispatchItems(): Promise<LatestItem[]> {
    const config = readBlogConfig(env());
    const identity = await identityFor(config.did, config.did === POE_DID || config.did === ATPOTATO_DID ? 'https://pds.atpota.to' : undefined);
    const publication = await findPublication(doFetch, identity, { pinnedUri: config.publicationUri, url: config.publicationUrl });
    if (!publication) return [];
    const docs = await listDocuments(doFetch, identity, publication, now());
    return docs.map((doc) => ({
      source: 'dispatch' as const,
      kind: 'article' as const,
      text: clip(doc.description ?? ''),
      title: clip(doc.title, 140),
      embed: '',
      createdAt: doc.publishedAt,
      url: docHref(doc),
    }));
  }

  function load(): Promise<LatestItem[]> {
    const cached = cache.get('feed');
    if (cached) return cached;
    const sources: Array<[string, () => Promise<LatestItem[]>]> = [
      ...ACCOUNTS.map((a): [string, () => Promise<LatestItem[]>] => [a.id, () => accountItems(a)]),
      ['dispatch', dispatchItems],
    ];
    const pending = (async () => {
      const results = await Promise.allSettled(sources.map(([, run]) => run()));
      const lists: LatestItem[][] = [];
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') lists.push(result.value);
        else log({ event: 'source_error', source: sources[i]![0], error: (result.reason as Error)?.name ?? 'Error' });
      });
      if (lists.length === 0) throw new Error('every source failed');
      return mergeItems(lists);
    })();
    cache.set('feed', pending);
    pending.catch(() => cache.delete('feed'));
    return pending;
  }

  async function GET(request: Request): Promise<Response> {
    let items: LatestItem[];
    try {
      items = await load();
    } catch {
      log({ event: 'feed_error' });
      return new Response(request.method === 'HEAD' ? null : '{"error":"unavailable"}', {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...BASE_HEADERS },
      });
    }
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ items }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': CACHE_OK, ...BASE_HEADERS },
    });
  }

  return {
    GET,
    HEAD: GET,
    async methodNotAllowed(request: Request) {
      return new Response(request.method === 'HEAD' ? null : 'method not allowed\n', {
        status: 405,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD', ...BASE_HEADERS },
      });
    },
  };
}
