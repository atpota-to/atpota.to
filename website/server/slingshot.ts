/**
 * Slingshot (slingshot.microcosm.blue), microcosm's edge cache of atproto records and
 * identities. Two things the garden asks it for:
 *
 *   com.bad-example.identity.resolveMiniDoc   a handle or DID -> { did, handle, pds }, the
 *                                             handle checked both ways, in one cached call
 *   com.atproto.repo.getRecord                any record by its address (someone's garden,
 *                                             a flower, a tend)
 *
 * It can't list a repo's records, so listing (someone's flowers, tends and blocks, and
 * atpotato's seasonal patches) still goes to their PDS.
 */

import { AtprotoError, fetchJson, isPublicHost, type Fetch, type Identity, type RecordEntry } from './blog/atproto.js';
import { isDid } from './blog/config.js';
import { SLINGSHOT } from './blog/discussion.js';

export { SLINGSHOT };

const TIMEOUT_MS = 4000;
const HANDLE_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function pdsOrigin(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password && isPublicHost(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Who a handle or DID is: their DID, verified handle (null when it doesn't check out) and
 * PDS. Null when Slingshot can't resolve them (it answers 400); throws when it's down.
 */
export async function resolveMiniDoc(doFetch: Fetch, identifier: string): Promise<Identity | null> {
  let res: Response;
  try {
    res = await doFetch(`${SLINGSHOT}/xrpc/com.bad-example.identity.resolveMiniDoc?${new URLSearchParams({ identifier })}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AtprotoError('upstream', `slingshot failed: ${(error as Error)?.name ?? 'Error'}`);
  }
  if (res.status === 400 || res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new AtprotoError('upstream', `slingshot status ${res.status}`);
  }
  const v = (await res.json().catch(() => null)) as { did?: unknown; handle?: unknown; pds?: unknown } | null;
  if (typeof v?.did !== 'string' || !isDid(v.did)) throw new AtprotoError('bad_response', 'no did');
  const pds = pdsOrigin(v.pds);
  if (!pds) throw new AtprotoError('bad_response', 'no pds');
  const handle = typeof v.handle === 'string' && HANDLE_RE.test(v.handle) && v.handle !== 'handle.invalid' ? v.handle.toLowerCase() : null;
  // Asked by handle, the handle must be the one that came back (verified); by DID, the DID.
  if (isDid(identifier) ? v.did !== identifier : handle !== identifier.toLowerCase()) return null;
  return { did: v.did, pds, handle };
}

/** One record by its address; null when there isn't one. */
export async function getRecord(doFetch: Fetch, did: string, collection: string, rkey: string): Promise<RecordEntry | null> {
  const params = new URLSearchParams({ repo: did, collection, rkey });
  try {
    const body = (await fetchJson(doFetch, `${SLINGSHOT}/xrpc/com.atproto.repo.getRecord?${params}`, TIMEOUT_MS)) as Partial<RecordEntry> | null;
    if (typeof body?.uri !== 'string' || typeof body.cid !== 'string' || typeof body.value !== 'object' || body.value === null) {
      throw new AtprotoError('bad_response', 'not a record');
    }
    return { uri: body.uri, cid: body.cid, value: body.value };
  } catch (error) {
    if (error instanceof AtprotoError && error.code === 'not_found') return null;
    throw error;
  }
}

/** One record straight from its PDS (for a version Slingshot hasn't caught up to yet). */
export async function getRecordFromPds(doFetch: Fetch, pds: string, did: string, collection: string, rkey: string): Promise<RecordEntry | null> {
  const params = new URLSearchParams({ repo: did, collection, rkey });
  try {
    const body = (await fetchJson(doFetch, `${pds}/xrpc/com.atproto.repo.getRecord?${params}`, TIMEOUT_MS)) as Partial<RecordEntry> | null;
    if (typeof body?.uri !== 'string' || typeof body.cid !== 'string' || typeof body.value !== 'object' || body.value === null) {
      throw new AtprotoError('bad_response', 'not a record');
    }
    return { uri: body.uri, cid: body.cid, value: body.value };
  } catch (error) {
    if (error instanceof AtprotoError && error.code === 'not_found') return null;
    throw error;
  }
}
