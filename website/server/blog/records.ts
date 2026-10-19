/**
 * site.standard.publication and site.standard.document records, read from the blog's repo
 * and checked field by field. Lexicons: https://standard.site/docs (publication, document)
 * and the leaflet.pub schemas for `content` ($type "pub.leaflet.content").
 *
 * Only documents whose `site` is the publication's at:// URI belong to the blog. A
 * document dated in the future is left out until its time comes, so a post can be
 * scheduled by writing it early.
 */

import { blobCid, blobUrl, listRecords, getRecord, type Fetch, type Identity, type RecordEntry } from './atproto.js';
import { parseAtUri } from './html.js';
import { normalizePublicationUrl } from './config.js';

export const PUBLICATION_NSID = 'site.standard.publication';
export const DOCUMENT_NSID = 'site.standard.document';
export const LEAFLET_CONTENT = 'pub.leaflet.content';

export interface Publication {
  uri: string;
  cid: string;
  rkey: string;
  name: string;
  description: string | null;
  url: string;
  iconUrl: string | null;
}

export interface BlogDocument {
  uri: string;
  cid: string;
  rkey: string;
  title: string;
  description: string | null;
  /** Leading slash, no trailing slash; null when the record has no usable path. */
  path: string | null;
  publishedAt: string;
  updatedAt: string | null;
  tags: string[];
  coverUrl: string | null;
  coverCid: string | null;
  textContent: string | null;
  /** The raw `content` union value (checked when rendered). */
  content: unknown;
  /** at:// URI of the Bluesky post that announces it, for "reply on bluesky". */
  bskyPostUri: string | null;
  contributors: string[];
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function date(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function rkeyOf(uri: string): string {
  return parseAtUri(uri)?.rkey ?? '';
}

const PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,500}$/;

/** "/my-post/" -> "/my-post"; null for anything that is not a plain URL path. */
export function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let p = value.trim();
  if (!p) return null;
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+$/, '');
  if (!PATH_RE.test(p) || p.includes('//') || /(^|\/)\.\.?(\/|$)/.test(p)) return null;
  return p;
}

export function toPublication(entry: RecordEntry, identity: Identity): Publication | null {
  const v = entry.value as Record<string, unknown>;
  const name = str(v.name, 500);
  const url = normalizePublicationUrl(typeof v.url === 'string' ? v.url : undefined);
  if (!name || !url) return null;
  return {
    uri: entry.uri,
    cid: entry.cid,
    rkey: rkeyOf(entry.uri),
    name,
    description: str(v.description, 3000),
    url,
    iconUrl: blobUrl(identity.pds, identity.did, v.icon),
  };
}

export function toDocument(entry: RecordEntry, identity: Identity): BlogDocument | null {
  const v = entry.value as Record<string, unknown>;
  const title = str(v.title, 500);
  const publishedAt = date(v.publishedAt);
  if (!title || !publishedAt) return null;
  const tags = Array.isArray(v.tags)
    ? v.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().replace(/^#/, '').slice(0, 128)).slice(0, 20)
    : [];
  const bskyRef = v.bskyPostRef as { uri?: unknown } | undefined;
  const bskyPostUri = typeof bskyRef?.uri === 'string' && /^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._:~-]+$/.test(bskyRef.uri) ? bskyRef.uri : null;
  const contributors = Array.isArray(v.contributors)
    ? v.contributors.map((c) => (c as { did?: unknown })?.did).filter((d): d is string => typeof d === 'string')
    : [];
  return {
    uri: entry.uri,
    cid: entry.cid,
    rkey: rkeyOf(entry.uri),
    title,
    description: str(v.description, 3000),
    path: normalizePath(v.path),
    publishedAt,
    updatedAt: date(v.updatedAt),
    tags,
    coverUrl: blobUrl(identity.pds, identity.did, v.coverImage),
    coverCid: blobCid(v.coverImage),
    textContent: typeof v.textContent === 'string' ? v.textContent : null,
    content: v.content,
    bskyPostUri,
    contributors,
  };
}

/**
 * The blog's publication: the pinned URI if one is configured, else the record in the
 * repo whose url matches (the oldest one if there are several). Null when none exists yet.
 */
export async function findPublication(
  doFetch: Fetch,
  identity: Identity,
  opts: { pinnedUri: string | null; url: string },
): Promise<Publication | null> {
  if (opts.pinnedUri) {
    const rkey = rkeyOf(opts.pinnedUri);
    try {
      return toPublication(await getRecord(doFetch, identity.pds, identity.did, PUBLICATION_NSID, rkey), identity);
    } catch (error) {
      if ((error as { code?: string }).code === 'not_found') return null;
      throw error;
    }
  }
  const entries = await listRecords(doFetch, identity.pds, identity.did, PUBLICATION_NSID, 2);
  const matches = entries
    .map((e) => toPublication(e, identity))
    .filter((p): p is Publication => p !== null && p.url === opts.url)
    .sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0));
  return matches[0] ?? null;
}

/** The publication's documents, newest first, without future-dated ones. */
export async function listDocuments(doFetch: Fetch, identity: Identity, publication: Publication, now: number): Promise<BlogDocument[]> {
  const entries = await listRecords(doFetch, identity.pds, identity.did, DOCUMENT_NSID);
  return entries
    .filter((e) => (e.value as { site?: unknown }).site === publication.uri)
    .map((e) => toDocument(e, identity))
    .filter((d): d is BlogDocument => d !== null && Date.parse(d.publishedAt) <= now)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** The address a document is served at, relative to the publication: its path, else "/<rkey>". */
export function documentPath(doc: BlogDocument): string {
  return doc.path ?? `/${doc.rkey}`;
}

/**
 * The document for a request path under the publication ("" for the index, "my-post" or
 * "3mabc..."). Matches the record's path first, then its record key.
 */
export function findDocument(docs: readonly BlogDocument[], rest: string): BlogDocument | null {
  const wanted = normalizePath(rest);
  if (!wanted) return null;
  return docs.find((d) => d.path === wanted) ?? docs.find((d) => `/${d.rkey}` === wanted) ?? null;
}
