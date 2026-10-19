/**
 * The records a signed-in reader writes to their own repo, in the shapes Leaflet and
 * other standard.site apps read:
 *
 *   site.standard.graph.subscription  { publication: <at:// publication>, createdAt }
 *   site.standard.graph.recommend     { document: <at:// document>, createdAt }
 *   pub.leaflet.comment               { subject: <at:// document>, plaintext, facets: [],
 *                                       createdAt, reply?: { parent: <at:// comment> } }
 *
 * Reads of the reader's own records go to their PDS without credentials (repos are
 * public); writes go through the OAuth session. Every response is checked before use.
 */

import type { Session } from './auth';

export const SUBSCRIPTION = 'site.standard.graph.subscription';
export const RECOMMEND = 'site.standard.graph.recommend';
export const COMMENT = 'pub.leaflet.comment';
/** Comments are cut to this many characters here (the lexicon sets no limit). */
export const MAX_COMMENT_LENGTH = 3000;
/** Own records are scanned up to this many pages of 100. */
export const MAX_PAGES = 10;

const AT_URI_RE = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9.-]+)\/([A-Za-z0-9._:~-]{1,512})$/;

export class RepoError extends Error {
  override name = 'RepoError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RecordRef {
  uri: string;
  cid: string;
}

export function parseRecordUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const m = AT_URI_RE.exec(uri);
  return m ? { did: m[1]!, collection: m[2]!, rkey: m[3]! } : null;
}

export function subscriptionRecord(publication: string, now: Date): Record<string, unknown> {
  return { $type: SUBSCRIPTION, publication, createdAt: now.toISOString() };
}

export function recommendRecord(document: string, now: Date): Record<string, unknown> {
  return { $type: RECOMMEND, document, createdAt: now.toISOString() };
}

/** Line endings normalised, outer blank space trimmed, cut to MAX_COMMENT_LENGTH. */
export function cleanCommentText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_COMMENT_LENGTH);
}

export function commentRecord(subject: string, text: string, parent: string | null, now: Date): Record<string, unknown> {
  return {
    $type: COMMENT,
    subject,
    plaintext: cleanCommentText(text),
    facets: [],
    createdAt: now.toISOString(),
    ...(parent ? { reply: { parent } } : {}),
  };
}

async function xrpcError(res: Response): Promise<RepoError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : `status ${res.status}`;
  return new RepoError(res.status, code);
}

/**
 * URIs of the reader's records in `collection` whose `field` equals `value`. Newest
 * records come first in listRecords, so a fresh one is found on the first page.
 */
export async function findOwn(
  session: Session,
  collection: string,
  field: string,
  value: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ repo: session.did, collection, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetchImpl(`${session.pds}/xrpc/com.atproto.repo.listRecords?${params}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw await xrpcError(res);
    const body = (await res.json()) as { records?: unknown; cursor?: unknown };
    if (!Array.isArray(body?.records)) throw new RepoError(res.status, 'records missing');
    for (const r of body.records) {
      const rec = r as { uri?: unknown; value?: Record<string, unknown> };
      if (typeof rec?.uri === 'string' && rec.value?.[field] === value && parseRecordUri(rec.uri)?.did === session.did) found.push(rec.uri);
    }
    cursor = typeof body.cursor === 'string' && body.cursor !== '' && body.records.length > 0 ? body.cursor : null;
    if (!cursor) break;
  }
  return found;
}

export async function createRecord(session: Session, collection: string, record: Record<string, unknown>): Promise<RecordRef> {
  const res = await session.fetch('/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: session.did, collection, record }),
  });
  if (!res.ok) throw await xrpcError(res);
  const body = (await res.json()) as { uri?: unknown; cid?: unknown };
  if (typeof body?.uri !== 'string' || typeof body.cid !== 'string' || parseRecordUri(body.uri)?.did !== session.did) {
    throw new RepoError(res.status, 'bad createRecord response');
  }
  return { uri: body.uri, cid: body.cid };
}

/** Deletes one of the reader's own records; anything else is refused before any request. */
export async function deleteRecord(session: Session, uri: string): Promise<void> {
  const at = parseRecordUri(uri);
  if (!at || at.did !== session.did) throw new RepoError(0, 'not your record');
  const res = await session.fetch('/xrpc/com.atproto.repo.deleteRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: session.did, collection: at.collection, rkey: at.rkey }),
  });
  if (!res.ok) throw await xrpcError(res);
  await res.body?.cancel().catch(() => undefined);
}
