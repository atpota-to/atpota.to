// records.js
// What the index keeps: a garden record (or a pet count for Poe) as a garden_records row,
// and a Jetstream v2 event as what to do with it.
//
// The checks are cheap shape checks, enough that every row is safe to store and to join on
// (a sprout's patch, a tend's flower). The website still validates each record fully when
// it reads one. A record that fails them isn't kept: a create or an update that fails
// becomes a delete of that URI, so a record edited into junk leaves the index.
//
// Two things Postgres refuses would otherwise jam the stream: a NUL (\u0000) anywhere in a
// jsonb string, and a lone UTF-16 surrogate. A record carrying either is junk too.

export const PATCH = 'to.atpota.garden.patch';
export const SPROUT = 'to.atpota.garden.sprout';
export const TEND = 'to.atpota.garden.tend';
/** Poe's pet count, one record at PETS_RKEY in each petter's repo, for the garden's leaderboard. */
export const PETS = 'to.atpota.poe.pets';
export const PETS_RKEY = 'self';
export const COLLECTIONS = [PATCH, SPROUT, TEND, PETS];
/** What Jetstream v2 is asked for: the garden's wildcard, and the pets. */
export const STREAM_COLLECTIONS = ['to.atpota.garden.*', PETS];
export const COMMIT_TYPE = 'network.bsky.jetstream.subscribeEvents#commit';

export const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/;
export const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;
export const CID_RE = /^[a-zA-Z0-9]{8,200}$/;
export const MAX_RECORD_CHARS = 20_000;
export const MAX_WORD = 64;

const UNSTORABLE = /\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

export const uriOf = (did, collection, rkey) => `at://${did}/${collection}/${rkey}`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isWord = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_WORD;
const isStrongRef = (v) => isObject(v) && typeof v.uri === 'string' && v.uri.startsWith('at://') && v.uri.length <= 8192 && typeof v.cid === 'string' && v.cid.length > 0;

/** An ISO time Postgres will take (years 0001 to 9999), or null. */
export function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return /^(?!0000)\d{4}-/.test(iso) ? iso : null;
}

/** What a record points at: a sprout's patch, a tend's flower (null for a patch or pets); undefined when its shape is wrong. */
function refOf(collection, r) {
  if (typeof r.createdAt !== 'string') return undefined;
  if (collection === PATCH) return typeof r.name === 'string' && Number.isInteger(r.cols) && Number.isInteger(r.rows) ? null : undefined;
  if (collection === SPROUT) return isStrongRef(r.patch) && isWord(r.kind) && Number.isInteger(r.plot) ? r.patch.uri : undefined;
  if (collection === TEND) return isStrongRef(r.subject) && isWord(r.action) ? r.subject.uri : undefined;
  if (collection === PETS) return Number.isSafeInteger(r.count) && r.count >= 0 ? null : undefined;
  return undefined;
}

/** True when did, collection and rkey make a URI the index can hold. */
export function isAddress(did, collection, rkey) {
  return typeof did === 'string' && DID_RE.test(did) && COLLECTIONS.includes(collection) && typeof rkey === 'string' && RKEY_RE.test(rkey);
}

/**
 * A garden_records row, or null when the record isn't one the index keeps.
 * `firstSeenAt` is when Jetstream relayed its creation (null from a backfill or an update).
 */
export function toRow({ did, collection, rkey, cid, record, firstSeenAt = null }) {
  if (!isAddress(did, collection, rkey)) return null;
  // Only the one at "self" is anyone's pet count (the website's pet-sync.ts).
  if (collection === PETS && rkey !== PETS_RKEY) return null;
  if (typeof cid !== 'string' || !CID_RE.test(cid)) return null;
  if (!isObject(record) || record.$type !== collection) return null;
  let json;
  try {
    json = JSON.stringify(record);
  } catch {
    return null;
  }
  if (json.length > MAX_RECORD_CHARS || UNSTORABLE.test(json)) return null;
  const ref = refOf(collection, record);
  if (ref === undefined) return null;
  return {
    uri: uriOf(did, collection, rkey),
    did,
    collection,
    rkey,
    cid,
    record,
    ref_uri: ref,
    created_at: isoOrNull(record.createdAt),
    first_seen_at: isoOrNull(firstSeenAt),
  };
}

/**
 * A Jetstream v2 payload (the `payload` of a {"$type":"message"} envelope) as
 * { op: 'upsert', row } | { op: 'delete', uri }, or null when it isn't a commit the index keeps.
 */
export function eventOf(payload) {
  if (!isObject(payload)) return null;
  if (payload.$type !== undefined && payload.$type !== COMMIT_TYPE) return null;
  const { did, collection, rkey, operation } = payload;
  if (!isAddress(did, collection, rkey)) return null;
  const uri = uriOf(did, collection, rkey);
  if (operation === 'delete') return { op: 'delete', uri };
  if (operation !== 'create' && operation !== 'update') return null;
  const row = toRow({ did, collection, rkey, cid: payload.cid, record: payload.record, firstSeenAt: operation === 'create' ? payload.time : null });
  return row ? { op: 'upsert', row } : { op: 'delete', uri };
}
