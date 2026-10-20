/**
 * What readers did with a post, read from public atproto indexes. Nothing is stored on
 * atpota.to: every comment, recommend and subscription is a record in its author's own
 * repo, written by the browser after the reader signs in (src/blog/).
 *
 *   comments    pub.leaflet.comment, the record Leaflet writes, with `subject` = the
 *               post's site.standard.document URI, so comments made here show on Leaflet
 *               and the other way round. `reply.parent` threads them.
 *   recommends  site.standard.graph.recommend, `document` = the post's URI (counted).
 *
 * Where it comes from:
 *   Constellation  constellation.microcosm.blue   which records link to the post
 *   Slingshot      slingshot.microcosm.blue       the records themselves (a cache over every PDS)
 *   AppView        public.api.bsky.app            commenters' names, avatars and labels
 *
 * A comment is left off the page when:
 *   - its record no longer points at the post, or has no text
 *   - its author has no Bluesky profile view (deleted, deactivated or taken down)
 *   - its author carries one of HIDDEN_LABELS (Bluesky moderation, or their own
 *     "!no-unauthenticated", which asks logged-out pages not to show them)
 *   - the publication's owner blocks its author on Bluesky (app.bsky.graph.block records
 *     in the owner's repo), so moderating is "block them as the owner"
 *   - its URI or its author's DID is in BLOG_HIDDEN_COMMENTS (config.ts)
 * and so is every reply under a hidden comment. A reply whose parent is just gone
 * (deleted by its author) moves up to the top level.
 *
 * Everything runs under one deadline. If the comment index cannot be read, the page says
 * comments did not load instead of claiming there are none.
 */

import { APPVIEW, fetchJson, listRecords, TtlCache, type Fetch, type Identity } from './atproto.js';
import { isDid } from './config.js';
import { httpUrl } from './html.js';

export const CONSTELLATION = 'https://constellation.microcosm.blue';
export const SLINGSHOT = 'https://slingshot.microcosm.blue';
export const COMMENT_NSID = 'pub.leaflet.comment';
export const RECOMMEND_NSID = 'site.standard.graph.recommend';
export const BLOCK_NSID = 'app.bsky.graph.block';

/** At most this many comments are read for one post. */
export const MAX_COMMENTS = 150;
/** Longer comments are cut (Leaflet's lexicon sets no limit). */
export const MAX_COMMENT_TEXT = 10_000;
export const DISCUSSION_DEADLINE_MS = 6000;
export const DISCUSSION_TTL_MS = 60_000;
export const BLOCKS_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 4000;
const CONCURRENCY = 8;
/** Owner block lists are read up to this many pages of 100. */
const BLOCK_PAGES = 5;

export const HIDDEN_LABELS: ReadonlySet<string> = new Set(['!hide', '!takedown', '!suspend', 'spam', '!no-unauthenticated']);

export interface CommentAuthor {
  did: string;
  handle: string;
  name: string;
  avatar: string | null;
}

export interface BlogComment {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  text: string;
  facets: unknown[];
  createdAt: string;
  /** at:// URI of the comment this one answers, if any. */
  parent: string | null;
  author: CommentAuthor;
  replies: BlogComment[];
}

export interface Discussion {
  status: 'ok' | 'unavailable';
  /** Top-level comments, oldest first, each with its replies (oldest first). */
  comments: BlogComment[];
  /** Comments shown, replies included. */
  count: number;
  /** Accounts that recommend the post, or null when the count could not be read. */
  recommends: number | null;
}

export const NO_DISCUSSION: Discussion = { status: 'unavailable', comments: [], count: 0, recommends: null };

export interface DiscussionInput {
  /** The post's site.standard.document URI. */
  document: string;
  /** The publication's repo: its blocks hide commenters. */
  owner: Identity;
  hidden: ReadonlySet<string>;
  deadlineMs?: number;
}

const COMMENT_RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;

interface LinkRef {
  did: string;
  rkey: string;
}

/** Records in `collection` whose `path` field links to `target`, newest index entries first. */
export async function backlinks(doFetch: Fetch, target: string, collection: string, path: string, max: number): Promise<LinkRef[]> {
  const out: LinkRef[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5 && out.length < max; page++) {
    const params = new URLSearchParams({ target, collection, path, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const body = (await fetchJson(doFetch, `${CONSTELLATION}/links?${params}`, REQUEST_TIMEOUT_MS)) as {
      linking_records?: unknown;
      cursor?: unknown;
    };
    if (!Array.isArray(body?.linking_records)) throw new Error('backlinks missing');
    for (const link of body.linking_records) {
      const l = link as { did?: unknown; collection?: unknown; rkey?: unknown };
      if (typeof l?.did === 'string' && isDid(l.did) && l.collection === collection && typeof l.rkey === 'string' && COMMENT_RKEY_RE.test(l.rkey)) {
        out.push({ did: l.did, rkey: l.rkey });
      }
    }
    cursor = typeof body.cursor === 'string' && body.cursor !== '' ? body.cursor : null;
    if (!cursor) break;
  }
  return out.slice(0, max);
}

/** Distinct accounts whose `collection` records link to `target` through `path`. */
export async function backlinkAccounts(doFetch: Fetch, target: string, collection: string, path: string): Promise<number> {
  const params = new URLSearchParams({ target, collection, path });
  const body = (await fetchJson(doFetch, `${CONSTELLATION}/links/count/distinct-dids?${params}`, REQUEST_TIMEOUT_MS)) as { total?: unknown };
  if (typeof body?.total !== 'number' || !Number.isFinite(body.total) || body.total < 0) throw new Error('count missing');
  return Math.floor(body.total);
}

interface RawComment {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  text: string;
  facets: unknown[];
  createdAt: string;
  parent: string | null;
}

const COMMENT_AT_URI_RE = /^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]+\/pub\.leaflet\.comment\/[A-Za-z0-9._:~-]{1,512}$/;

/** A pub.leaflet.comment record on `document`, checked field by field; null otherwise. */
export function toComment(entry: unknown, ref: LinkRef, document: string): RawComment | null {
  const e = entry as { uri?: unknown; cid?: unknown; value?: Record<string, unknown> };
  const v = e?.value;
  if (!v || typeof v !== 'object' || typeof e.cid !== 'string') return null;
  if (v.subject !== document) return null;
  if (typeof v.plaintext !== 'string' || v.plaintext.trim() === '') return null;
  const created = typeof v.createdAt === 'string' ? Date.parse(v.createdAt) : NaN;
  if (!Number.isFinite(created)) return null;
  const parentUri = (v.reply as { parent?: unknown } | undefined)?.parent;
  return {
    uri: `at://${ref.did}/${COMMENT_NSID}/${ref.rkey}`,
    cid: e.cid,
    did: ref.did,
    rkey: ref.rkey,
    text: v.plaintext.slice(0, MAX_COMMENT_TEXT),
    // Facets past the cut point simply never match (richtext.ts snaps ranges to the text).
    facets: Array.isArray(v.facets) ? v.facets : [],
    createdAt: new Date(created).toISOString(),
    parent: typeof parentUri === 'string' && COMMENT_AT_URI_RE.test(parentUri) ? parentUri : null,
  };
}

async function readComment(doFetch: Fetch, ref: LinkRef, document: string): Promise<RawComment | null> {
  const params = new URLSearchParams({ repo: ref.did, collection: COMMENT_NSID, rkey: ref.rkey });
  try {
    return toComment(await fetchJson(doFetch, `${SLINGSHOT}/xrpc/com.atproto.repo.getRecord?${params}`, REQUEST_TIMEOUT_MS), ref, document);
  } catch {
    return null;
  }
}

/** Runs `fn` over `items`, `limit` at a time, keeping the order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Profile views for these DIDs from the public AppView, as comment authors. An account
 * missing from the answer, or labelled with one of HIDDEN_LABELS, is not in the map.
 */
export async function commentAuthors(doFetch: Fetch, dids: readonly string[]): Promise<Map<string, CommentAuthor>> {
  const out = new Map<string, CommentAuthor>();
  for (let i = 0; i < dids.length; i += 25) {
    const params = new URLSearchParams();
    for (const did of dids.slice(i, i + 25)) params.append('actors', did);
    const body = (await fetchJson(doFetch, `${APPVIEW}/xrpc/app.bsky.actor.getProfiles?${params}`, REQUEST_TIMEOUT_MS)) as { profiles?: unknown };
    if (!Array.isArray(body?.profiles)) throw new Error('profiles missing');
    for (const p of body.profiles) {
      const view = p as { did?: unknown; handle?: unknown; displayName?: unknown; avatar?: unknown; labels?: unknown };
      if (typeof view?.did !== 'string' || !dids.includes(view.did)) continue;
      const labels = Array.isArray(view.labels) ? view.labels : [];
      if (labels.some((l) => HIDDEN_LABELS.has((l as { val?: unknown })?.val as string) && (l as { neg?: unknown }).neg !== true)) continue;
      const handle = typeof view.handle === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(view.handle) && view.handle !== 'handle.invalid' ? view.handle.toLowerCase() : null;
      const name = typeof view.displayName === 'string' ? view.displayName.trim().slice(0, 64) : '';
      const avatar = httpUrl(view.avatar);
      out.set(view.did, {
        did: view.did,
        handle: handle ?? view.did,
        name: name || (handle ? `@${handle}` : 'someone'),
        avatar: avatar?.startsWith('https://') ? avatar : null,
      });
    }
  }
  return out;
}

const blockCache = new TtlCache<Promise<Set<string>>>(BLOCKS_TTL_MS);
const discussionCache = new TtlCache<Promise<Discussion>>(DISCUSSION_TTL_MS);

/** For tests: start from empty caches. */
export function resetDiscussionCaches(): void {
  blockCache.clear();
  discussionCache.clear();
}

/** DIDs the owner blocks on Bluesky. A failed read counts as no blocks (and is retried). */
export function ownerBlocks(doFetch: Fetch, owner: Identity): Promise<Set<string>> {
  const known = blockCache.get(owner.did);
  if (known) return known;
  const pending = listRecords(doFetch, owner.pds, owner.did, BLOCK_NSID, BLOCK_PAGES).then((records) => {
    const out = new Set<string>();
    for (const r of records) {
      const subject = (r.value as { subject?: unknown }).subject;
      if (typeof subject === 'string' && isDid(subject)) out.add(subject);
    }
    return out;
  });
  blockCache.set(owner.did, pending);
  pending.catch(() => blockCache.delete(owner.did));
  return pending.catch(() => new Set<string>());
}

/**
 * Builds the threads. Comments are placed oldest first and a reply only attaches to a
 * parent placed before it, so a malformed record can never make a cycle.
 */
export function threads(comments: readonly (RawComment & { author: CommentAuthor })[], hiddenUris: ReadonlySet<string>): BlogComment[] {
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.uri.localeCompare(b.uri));
  const placed = new Map<string, BlogComment>();
  const dropped = new Set(hiddenUris);
  const top: BlogComment[] = [];
  for (const c of sorted) {
    if (placed.has(c.uri)) continue;
    if (c.parent && dropped.has(c.parent)) {
      dropped.add(c.uri);
      continue;
    }
    const node: BlogComment = { ...c, replies: [] };
    const parent = c.parent ? placed.get(c.parent) : undefined;
    if (parent) parent.replies.push(node);
    else top.push(node);
    placed.set(c.uri, node);
  }
  return top;
}

export function countComments(comments: readonly BlogComment[]): number {
  let n = 0;
  for (const c of comments) n += 1 + countComments(c.replies);
  return n;
}

async function load(doFetch: Fetch, input: DiscussionInput): Promise<Discussion> {
  const recommends = backlinkAccounts(doFetch, input.document, RECOMMEND_NSID, '.document').catch(() => null);
  const blocks = ownerBlocks(doFetch, input.owner);
  const refs = await backlinks(doFetch, input.document, COMMENT_NSID, '.subject', MAX_COMMENTS);
  const raw = (await mapPool(refs, CONCURRENCY, (ref) => readComment(doFetch, ref, input.document))).filter((c): c is RawComment => c !== null);
  const dids = [...new Set(raw.map((c) => c.did))];
  const [authors, blocked] = await Promise.all([dids.length ? commentAuthors(doFetch, dids) : new Map<string, CommentAuthor>(), blocks]);

  const shown: (RawComment & { author: CommentAuthor })[] = [];
  const hiddenUris = new Set<string>();
  for (const c of raw) {
    const author = authors.get(c.did);
    if (!author || blocked.has(c.did) || input.hidden.has(c.did) || input.hidden.has(c.uri)) {
      hiddenUris.add(c.uri);
      continue;
    }
    shown.push({ ...c, author });
  }
  const comments = threads(shown, hiddenUris);
  return { status: 'ok', comments, count: countComments(comments), recommends: await recommends };
}

/**
 * The post's comments and recommend count, cached briefly per post. Resolves (never
 * rejects) with status "unavailable" when the comment index or the AppView cannot be read
 * in time; that answer is not cached.
 */
export function loadDiscussion(doFetch: Fetch, input: DiscussionInput): Promise<Discussion> {
  const key = `${input.document}|${[...input.hidden].sort().join(',')}`;
  const known = discussionCache.get(key);
  if (known) return known;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Discussion>((resolve) => {
    timer = setTimeout(() => resolve(NO_DISCUSSION), input.deadlineMs ?? DISCUSSION_DEADLINE_MS);
  });
  const pending = Promise.race([load(doFetch, input).catch(() => NO_DISCUSSION), deadline]).finally(() => clearTimeout(timer));
  discussionCache.set(key, pending);
  void pending.then((d) => {
    if (d.status !== 'ok') discussionCache.delete(key);
  });
  return pending;
}
