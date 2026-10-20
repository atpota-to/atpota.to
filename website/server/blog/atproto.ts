/**
 * The little bit of atproto the blog needs: resolve a DID to its PDS, read records with
 * com.atproto.repo.listRecords / getRecord, build blob URLs, and ask the public Bluesky
 * AppView for posts. Every request has a timeout; every response is treated as untrusted
 * JSON and checked by the caller.
 */

import { isDid } from './config.js';

export const PLC_DIRECTORY = 'https://plc.directory';
export const APPVIEW = 'https://public.api.bsky.app';
export const FETCH_TIMEOUT_MS = 8000;
/** listRecords pages to walk at most (100 records each). */
export const MAX_PAGES = 10;

export type Fetch = typeof fetch;

export interface RecordEntry<T = unknown> {
  uri: string;
  cid: string;
  value: T;
}

export class AtprotoError extends Error {
  constructor(
    readonly code: 'not_found' | 'upstream' | 'bad_response',
    message: string,
  ) {
    super(message);
    this.name = 'AtprotoError';
  }
}

/** Small in-memory cache with a time-to-live, per function instance. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly max = 200,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  set(key: string, value: V): V {
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }
}

export async function fetchJson(doFetch: Fetch, url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  let res: Response;
  try {
    res = await doFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new AtprotoError('upstream', `fetch failed: ${(error as Error)?.name ?? 'Error'}`);
  }
  if (res.status === 400 || res.status === 404) {
    // XRPC answers a missing record with 400 RecordNotFound; read it to tell the two apart.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 404 || body?.error === 'RecordNotFound' || body?.error === 'NotFound') {
      throw new AtprotoError('not_found', 'not found');
    }
    throw new AtprotoError('upstream', `status ${res.status}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new AtprotoError('upstream', `status ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new AtprotoError('bad_response', 'invalid json');
  }
}

/**
 * A public host name: not an IP literal, localhost or a local-only suffix. DID documents
 * name the PDS to call, and embeds can name anyone's DID, so a document must not be able
 * to point the function at its own network.
 */
export function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || h.startsWith('[') || /^[\d.]+$/.test(h)) return false;
  return !/(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa)$/.test(h);
}

function serviceEndpoint(doc: unknown): string | null {
  const services = (doc as { service?: unknown })?.service;
  if (!Array.isArray(services)) return null;
  for (const s of services) {
    const entry = s as { id?: unknown; type?: unknown; serviceEndpoint?: unknown };
    if ((entry.id === '#atproto_pds' || (typeof entry.id === 'string' && entry.id.endsWith('#atproto_pds'))) && typeof entry.serviceEndpoint === 'string') {
      try {
        const url = new URL(entry.serviceEndpoint);
        if (url.protocol === 'https:' && !url.username && !url.password && isPublicHost(url.hostname)) return url.origin;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function handleFrom(doc: unknown): string | null {
  const aka = (doc as { alsoKnownAs?: unknown })?.alsoKnownAs;
  if (!Array.isArray(aka)) return null;
  for (const entry of aka) {
    if (typeof entry === 'string' && /^at:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(entry)) return entry.slice(5).toLowerCase();
  }
  return null;
}

export interface Identity {
  did: string;
  pds: string;
  handle: string | null;
}

/** Where a DID's document lives: plc.directory for did:plc, /.well-known/did.json for did:web. */
export function didDocumentUrl(did: string): string {
  if (!isDid(did)) throw new AtprotoError('bad_response', 'not a did');
  if (did.startsWith('did:plc:')) return `${PLC_DIRECTORY}/${did}`;
  const host = decodeURIComponent(did.slice('did:web:'.length)).split(':')[0]!;
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !isPublicHost(host)) throw new AtprotoError('bad_response', 'bad did:web');
  return `https://${host}/.well-known/did.json`;
}

/** did:plc via plc.directory, did:web via /.well-known/did.json. */
export async function resolveDid(doFetch: Fetch, did: string): Promise<Identity> {
  const doc = await fetchJson(doFetch, didDocumentUrl(did));
  const pds = serviceEndpoint(doc);
  if (!pds) throw new AtprotoError('bad_response', 'no pds in did document');
  return { did, pds, handle: handleFrom(doc) };
}

const NSID_RE = /^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+){2,}$/;
const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;

function isEntry(value: unknown): value is RecordEntry {
  const r = value as RecordEntry;
  return typeof r?.uri === 'string' && typeof r.cid === 'string' && typeof r.value === 'object' && r.value !== null;
}

/** Every record in a collection, newest first, up to MAX_PAGES pages. */
export async function listRecords(doFetch: Fetch, pds: string, did: string, collection: string, maxPages = MAX_PAGES): Promise<RecordEntry[]> {
  if (!NSID_RE.test(collection)) throw new AtprotoError('bad_response', 'bad collection');
  const out: RecordEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ repo: did, collection, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const body = (await fetchJson(doFetch, `${pds}/xrpc/com.atproto.repo.listRecords?${params}`)) as {
      records?: unknown;
      cursor?: unknown;
    };
    if (!Array.isArray(body?.records)) throw new AtprotoError('bad_response', 'records missing');
    for (const record of body.records) if (isEntry(record)) out.push(record);
    if (typeof body.cursor !== 'string' || body.cursor === '' || body.records.length === 0) break;
    cursor = body.cursor;
  }
  return out;
}

export async function getRecord(doFetch: Fetch, pds: string, did: string, collection: string, rkey: string): Promise<RecordEntry> {
  if (!NSID_RE.test(collection) || !RKEY_RE.test(rkey)) throw new AtprotoError('bad_response', 'bad record address');
  const params = new URLSearchParams({ repo: did, collection, rkey });
  const body = await fetchJson(doFetch, `${pds}/xrpc/com.atproto.repo.getRecord?${params}`);
  if (!isEntry(body)) throw new AtprotoError('bad_response', 'record missing');
  return body;
}

const CID_RE = /^[a-zA-Z0-9]{8,200}$/;

/** The CID of a blob ref ({ $type: "blob", ref: { $link } } or the legacy { cid }), or null. */
export function blobCid(blob: unknown): string | null {
  const b = blob as { ref?: { $link?: unknown }; cid?: unknown } | null;
  const cid = typeof b?.ref?.$link === 'string' ? b.ref.$link : typeof b?.cid === 'string' ? b.cid : null;
  return cid && CID_RE.test(cid) ? cid : null;
}

export function blobMime(blob: unknown): string | null {
  const mime = (blob as { mimeType?: unknown } | null)?.mimeType;
  return typeof mime === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(mime) ? mime.toLowerCase() : null;
}

export function blobUrl(pds: string, did: string, blob: unknown): string | null {
  const cid = blobCid(blob);
  if (!cid) return null;
  return `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${cid}`;
}

/** Bluesky post views from the public AppView, keyed by at:// URI (25 per request). */
export async function getPosts(doFetch: Fetch, uris: readonly string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (let i = 0; i < uris.length; i += 25) {
    const params = new URLSearchParams();
    for (const uri of uris.slice(i, i + 25)) params.append('uris', uri);
    const body = (await fetchJson(doFetch, `${APPVIEW}/xrpc/app.bsky.feed.getPosts?${params}`)) as { posts?: unknown };
    if (!Array.isArray(body?.posts)) continue;
    for (const post of body.posts) {
      const uri = (post as { uri?: unknown })?.uri;
      if (typeof uri === 'string') out.set(uri, post);
    }
  }
  return out;
}

export async function getProfile(doFetch: Fetch, actor: string): Promise<unknown> {
  return fetchJson(doFetch, `${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`);
}
