/**
 * Looks up what a post's embed blocks point at, before rendering: Bluesky posts (public
 * AppView, batched) and standard.site documents or publications (their author's PDS).
 * Everything runs in parallel under one deadline; whatever is not back by then, or fails,
 * renders as a plain link card instead (see blocks.ts).
 */

import { blobUrl, getPosts, getRecord, resolveDid, TtlCache, type Fetch, type Identity } from './atproto.js';
import type { BskyPost, Embeds, LinkCard } from './blocks.js';
import { httpUrl, parseAtUri } from './html.js';
import { normalizePath } from './records.js';

export const EMBED_DEADLINE_MS = 5000;

const identities = new TtlCache<Promise<Identity>>(60 * 60 * 1000);
const cards = new TtlCache<LinkCard | null>(10 * 60 * 1000);
const posts = new TtlCache<BskyPost | null>(5 * 60 * 1000);

function str(value: unknown, max = 300): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

export function toBskyPost(view: unknown): BskyPost | null {
  const v = view as {
    uri?: unknown;
    author?: { did?: unknown; handle?: unknown; displayName?: unknown; avatar?: unknown };
    record?: { text?: unknown; facets?: unknown; createdAt?: unknown };
    embed?: Record<string, unknown>;
  };
  const uri = typeof v?.uri === 'string' ? parseAtUri(v.uri) : null;
  const handle = str(v?.author?.handle, 253);
  if (!uri?.rkey || !handle || typeof v.record?.text !== 'string') return null;
  const actor = /^[a-zA-Z0-9.-]+$/.test(handle) && handle !== 'handle.invalid' ? handle : uri.repo;
  let embed = v.embed;
  // recordWithMedia: show the media half; the quoted record is left out.
  if (embed?.$type === 'app.bsky.embed.recordWithMedia#view') embed = embed.media as Record<string, unknown> | undefined;
  const images: BskyPost['images'] = [];
  let external: BskyPost['external'] = null;
  if (embed?.$type === 'app.bsky.embed.images#view' && Array.isArray(embed.images)) {
    for (const img of embed.images.slice(0, 4)) {
      const thumb = httpUrl((img as { thumb?: unknown })?.thumb);
      if (thumb?.startsWith('https://')) images.push({ thumb, alt: str((img as { alt?: unknown }).alt, 2000) ?? '' });
    }
  } else if (embed?.$type === 'app.bsky.embed.external#view') {
    const ext = embed.external as { uri?: unknown; title?: unknown } | undefined;
    const href = httpUrl(ext?.uri);
    if (href) external = { href, title: str(ext?.title) ?? '' };
  }
  const avatar = httpUrl(v.author?.avatar);
  const createdAt = typeof v.record.createdAt === 'string' && Number.isFinite(Date.parse(v.record.createdAt)) ? v.record.createdAt : null;
  return {
    uri: v.uri as string,
    url: `https://bsky.app/profile/${actor}/post/${uri.rkey}`,
    authorName: str(v.author?.displayName, 64) ?? handle,
    handle,
    avatar: avatar?.startsWith('https://') ? avatar : null,
    text: v.record.text.slice(0, 3000),
    facets: v.record.facets,
    createdAt,
    images,
    external,
  };
}

function identityFor(doFetch: Fetch, did: string): Promise<Identity> {
  const known = identities.get(did);
  if (known) return known;
  const pending = resolveDid(doFetch, did);
  identities.set(did, pending);
  // Forget a failed lookup so the next request tries again (callers still see the error).
  pending.catch(() => identities.delete(did));
  return pending;
}

/** For tests: start from empty caches. */
export function resetEmbedCaches(): void {
  identities.clear();
  cards.clear();
  posts.clear();
}

async function publicationCard(doFetch: Fetch, uri: string): Promise<{ card: LinkCard; url: string } | null> {
  const at = parseAtUri(uri);
  if (!at?.rkey || at.collection !== 'site.standard.publication') return null;
  const id = await identityFor(doFetch, at.repo);
  const record = (await getRecord(doFetch, id.pds, id.did, at.collection, at.rkey)).value as Record<string, unknown>;
  const url = httpUrl(record.url);
  const name = str(record.name, 200);
  if (!url || !name) return null;
  return {
    url: url.replace(/\/+$/, ''),
    card: { href: url, title: name, description: str(record.description), kicker: 'publication', imageUrl: blobUrl(id.pds, id.did, record.icon) },
  };
}

async function documentCard(doFetch: Fetch, uri: string): Promise<LinkCard | null> {
  const at = parseAtUri(uri);
  if (!at?.rkey || at.collection !== 'site.standard.document') return null;
  const id = await identityFor(doFetch, at.repo);
  const record = (await getRecord(doFetch, id.pds, id.did, at.collection, at.rkey)).value as Record<string, unknown>;
  const title = str(record.title, 300);
  if (!title) return null;
  const path = normalizePath(record.path) ?? '';
  let base: string | null = null;
  let kicker: string | null = null;
  if (typeof record.site === 'string' && record.site.startsWith('at://')) {
    const pub = await publicationCard(doFetch, record.site).catch(() => null);
    base = pub?.url ?? null;
    kicker = pub?.card.title ?? null;
  } else {
    base = httpUrl(record.site)?.replace(/\/+$/, '') ?? null;
  }
  if (!base) return null;
  return { href: `${base}${path}`, title, description: str(record.description), kicker, imageUrl: blobUrl(id.pds, id.did, record.coverImage) };
}

async function cardFor(doFetch: Fetch, uri: string): Promise<LinkCard | null> {
  const known = cards.get(uri);
  if (known !== undefined) return known;
  const collection = parseAtUri(uri)?.collection;
  let card: LinkCard | null = null;
  try {
    card = collection === 'site.standard.publication' ? ((await publicationCard(doFetch, uri))?.card ?? null) : await documentCard(doFetch, uri);
  } catch {
    card = null;
  }
  return cards.set(uri, card);
}

/** Looks up the embeds, waiting at most `deadlineMs`; unresolved ones are simply absent. */
export async function loadEmbeds(
  doFetch: Fetch,
  targets: { posts: string[]; records: string[] },
  deadlineMs = EMBED_DEADLINE_MS,
): Promise<Embeds> {
  const out: Embeds = { posts: new Map(), cards: new Map() };
  const tasks: Promise<unknown>[] = [];

  const missingPosts = targets.posts.filter((uri) => {
    const known = posts.get(uri);
    if (known) out.posts.set(uri, known);
    return known === undefined;
  });
  if (missingPosts.length) {
    tasks.push(
      getPosts(doFetch, missingPosts)
        .then((views) => {
          for (const uri of missingPosts) {
            const post = toBskyPost(views.get(uri));
            posts.set(uri, post);
            if (post) out.posts.set(uri, post);
          }
        })
        .catch(() => undefined),
    );
  }
  for (const uri of targets.records) {
    tasks.push(cardFor(doFetch, uri).then((card) => card && out.cards.set(uri, card)));
  }
  if (tasks.length === 0) return out;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled(tasks), new Promise((r) => (timer = setTimeout(r, deadlineMs)))]);
  clearTimeout(timer);
  return out;
}
