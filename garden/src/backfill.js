// backfill.js
// A reconcile: every repo with garden records, listed from its own PDS and compared with
// the index. It fills the index the first time, and afterwards puts right whatever the
// stream missed: a gap while a cursor was dropped, a record deleted while the service was
// down, an account that moved PDS or left.
//
//  1. The repos: the relay's listReposByCollection for each collection (it takes no
//     wildcards), plus every repo the index already has records from (garden_repos), so a
//     repo that has since emptied is still visited.
//  2. Each repo, four at a time: its PDS from its DID document (plc.directory for did:plc,
//     /.well-known/did.json for did:web; cached for an hour), then listRecords for each
//     collection.
//  3. What the index holds for the repo (garden_repo_uris), read before the listing: every
//     record listed is upserted (first_seen_at null: garden_apply keeps a time Jetstream
//     gave it) and every record the index held that the repo no longer lists is deleted.
//     A record the stream touched since the repo's turn began is left to the stream.
//  4. garden_status.backfilled_at and state.json's backfilledAt, once the pass is over.
//
// A repo that's gone is complete and empty, so its records leave the index: an account
// plc.directory answers 404 or 410 for, or a PDS that says RepoNotFound, RepoDeactivated,
// RepoTakendown or RepoSuspended. Any other failure leaves that repo incomplete: what was
// listed is still upserted, nothing is deleted, and it's logged. A listing cut short by the
// page limit, or one whose URIs don't match the repo, is incomplete too.
//
// One pass at a time. It runs on start when the last one is older than RECONCILE_HOURS (or
// there's none), every RECONCILE_HOURS, and when the stream may have a gap (at most one
// more queued behind a running pass). A pass that couldn't list the repos at all is
// retried after RETRY_FAILED_MS. It never throws out of the loop.

import { applyChunked } from './indexer.js';
import { DID_RE, RECONCILED, toRow } from './records.js';

export const RELAY_PAGES = 20;
export const RELAY_LIMIT = 1000;
export const RECORD_PAGES = 50;
export const RECORD_LIMIT = 100;
export const CONCURRENCY = 4;
export const PDS_CACHE_MS = 60 * 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const CHECK_MS = 60_000;
export const RETRY_FAILED_MS = 30 * 60_000;
export const GONE_ERRORS = ['RepoNotFound', 'RepoDeactivated', 'RepoTakendown', 'RepoSuspended'];

/** A DID document's PDS, when it is the `service` entry #atproto_pds and an https URL on a public host. */
export function pdsOf(doc) {
  const services = doc?.service;
  if (!Array.isArray(services)) return null;
  for (const s of services) {
    if (typeof s?.id !== 'string' || !s.id.endsWith('#atproto_pds') || typeof s.serviceEndpoint !== 'string') continue;
    if (s.type !== undefined && s.type !== 'AtprotoPersonalDataServer') continue;
    try {
      const url = new URL(s.serviceEndpoint);
      if (url.protocol === 'https:' && !url.username && !url.password && isPublicHost(url.hostname)) return url.origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Not an IP literal, localhost or a local-only name: a DID document names the host this
 * calls, and must not be able to point it at the droplet's own services.
 */
export function isPublicHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || h.startsWith('[') || /^[\d.]+$/.test(h)) return false;
  return !/(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa)$/.test(h);
}

/** Where a DID's document lives. Throws for a DID it can't resolve. */
export function didDocumentUrl(did, plcUrl) {
  if (did.startsWith('did:plc:')) return `${plcUrl}/${did}`;
  if (did.startsWith('did:web:')) {
    const rest = did.slice('did:web:'.length);
    if (rest.includes(':')) throw new Error('did:web with a path is not an atproto DID');
    const host = rest.replace(/%3A/gi, ':');
    const [name, port] = host.split(':');
    if (!/^[a-zA-Z0-9.-]+$/.test(name) || !isPublicHost(name) || (port !== undefined && !/^\d{1,5}$/.test(port))) throw new Error('bad did:web host');
    return `https://${host}/.well-known/did.json`;
  }
  throw new Error('unsupported DID method');
}

/** Runs `fn` over `items`, `n` at a time. */
export async function mapPool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

const GONE = Symbol('gone');

export function createBackfill({
  rpc,
  /** Upserts garden_status (id 1) with these columns. */
  writeStatus,
  store,
  log,
  relayUrl,
  plcUrl,
  reconcileMs = 6 * 3600_000,
  /** Whether the stream touched a URI at or after a time (indexer.touchedSince). */
  touchedSince = () => false,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  setRepeat = setInterval,
  clearRepeat = clearInterval,
}) {
  const pdsCache = new Map();
  let running = null;
  let queued = null;
  let failedAt = null;
  let timer = null;
  let last = null;

  async function get(url) {
    try {
      return await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`${new URL(url).host}: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message ?? err}`);
    }
  }

  async function json(res, what) {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async function relayRepos(collection) {
    const dids = [];
    let cursor = null;
    for (let page = 0; page < RELAY_PAGES; page++) {
      const params = new URLSearchParams({ collection, limit: String(RELAY_LIMIT) });
      if (cursor) params.set('cursor', cursor);
      const body = await json(await get(`${relayUrl}/xrpc/com.atproto.sync.listReposByCollection?${params}`), `listReposByCollection ${collection}`);
      if (!Array.isArray(body?.repos)) throw new Error(`listReposByCollection ${collection}: no repos`);
      for (const r of body.repos) if (typeof r?.did === 'string' && DID_RE.test(r.did)) dids.push(r.did);
      if (typeof body.cursor !== 'string' || !body.cursor || !body.repos.length) return dids;
      cursor = body.cursor;
    }
    log.warn('relay listing cut short', { collection, pages: RELAY_PAGES, repos: dids.length });
    return dids;
  }

  async function resolvePds(did) {
    const hit = pdsCache.get(did);
    if (hit && now() - hit.at < PDS_CACHE_MS) return hit.pds;
    const res = await get(didDocumentUrl(did, plcUrl));
    let pds;
    if (did.startsWith('did:plc:') && (res.status === 404 || res.status === 410)) {
      pds = GONE;
    } else {
      const doc = await json(res, 'did document');
      if (typeof doc?.id === 'string' && doc.id !== did) throw new Error('did document is for another DID');
      pds = pdsOf(doc);
      if (!pds) throw new Error('no PDS in the did document');
    }
    pdsCache.set(did, { pds, at: now() });
    return pds;
  }

  /** The rows a repo lists in one collection, or GONE. Throws when the listing is incomplete. */
  async function listCollection(pds, did, collection) {
    const rows = new Map();
    let cursor = null;
    for (let page = 0; page < RECORD_PAGES; page++) {
      const params = new URLSearchParams({ repo: did, collection, limit: String(RECORD_LIMIT) });
      if (cursor) params.set('cursor', cursor);
      const res = await get(`${pds}/xrpc/com.atproto.repo.listRecords?${params}`);
      if (res.status === 400) {
        const body = await res.json().catch(() => null);
        if (GONE_ERRORS.includes(body?.error)) return GONE;
        throw new Error(`listRecords ${collection}: HTTP 400 ${String(body?.error ?? '')}`);
      }
      const body = await json(res, `listRecords ${collection}`);
      if (!Array.isArray(body?.records)) throw new Error(`listRecords ${collection}: no records`);
      for (const entry of body.records) {
        const m = typeof entry?.uri === 'string' ? /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(entry.uri) : null;
        if (!m || m[1] !== did || m[2] !== collection) throw new Error(`listRecords ${collection}: a record from elsewhere (${String(entry?.uri).slice(0, 200)})`);
        // A record the index wouldn't keep counts as listed-and-invalid: it isn't
        // upserted, and leaves the index if it was there.
        rows.set(entry.uri, toRow({ did, collection, rkey: m[3], cid: entry.cid, record: entry.value, firstSeenAt: null }));
      }
      if (typeof body.cursor !== 'string' || !body.cursor || !body.records.length) return rows;
      cursor = body.cursor;
    }
    throw new Error(`listRecords ${collection}: more than ${RECORD_PAGES * RECORD_LIMIT} records`);
  }

  /** One repo: { complete, upserts, deletes }. */
  async function reconcileRepo(did) {
    const began = now();
    const held = await rpc('garden_repo_uris', { p_did: did });
    if (!Array.isArray(held)) throw new Error('garden_repo_uris: not a list');
    const listed = new Map();
    let complete = true;
    let why = null;
    let pds = null;
    try {
      pds = await resolvePds(did);
    } catch (err) {
      complete = false;
      why = err;
    }
    if (pds !== null && pds !== GONE) {
      for (const collection of RECONCILED) {
        try {
          const rows = await listCollection(pds, did, collection);
          if (rows !== GONE) for (const [uri, row] of rows) listed.set(uri, row);
        } catch (err) {
          complete = false;
          why = err;
        }
      }
    }
    const entries = [];
    for (const [uri, row] of listed) {
      if (row && !touchedSince(uri, began)) entries.push([uri, { op: 'upsert', row }]);
    }
    if (complete) {
      for (const h of held) {
        const uri = h?.uri;
        // only what was listed can be missing from the listing: chat pets are the stream's
        if (!RECONCILED.includes(h?.collection)) continue;
        if (typeof uri === 'string' && !listed.get(uri) && !touchedSince(uri, began)) entries.push([uri, { op: 'delete', uri }]);
      }
    } else {
      log.warn('repo not reconciled: listing incomplete, nothing deleted', { did, pds: typeof pds === 'string' ? pds : null, err: why });
    }
    await applyChunked(rpc, entries);
    const deletes = entries.filter(([, e]) => e.op === 'delete').length;
    if (deletes) log.info('reconcile deleted records the repo no longer has', { did, deletes, gone: pds === GONE });
    return { complete, upserts: entries.length - deletes, deletes };
  }

  async function pass(reason) {
    const started = now();
    log.info('reconcile starting', { reason });
    const dids = new Set();
    let listedRepos = true;
    for (const collection of RECONCILED) {
      try {
        for (const did of await relayRepos(collection)) dids.add(did);
      } catch (err) {
        listedRepos = false;
        log.error('relay listing failed; reconciling the repos the index knows', { collection, err });
      }
    }
    let known;
    try {
      known = await rpc('garden_repos', {});
      if (!Array.isArray(known)) throw new Error('garden_repos: not a list');
    } catch (err) {
      failedAt = now();
      log.error('reconcile failed: could not read the index', { err });
      return null;
    }
    for (const did of known) if (typeof did === 'string' && DID_RE.test(did)) dids.add(did);

    const result = { repos: dids.size, listed: listedRepos, complete: 0, incomplete: 0, upserts: 0, deletes: 0 };
    await mapPool([...dids], CONCURRENCY, async (did) => {
      try {
        const r = await reconcileRepo(did);
        result[r.complete ? 'complete' : 'incomplete']++;
        result.upserts += r.upserts;
        result.deletes += r.deletes;
      } catch (err) {
        result.incomplete++;
        log.warn('repo not reconciled', { did, err });
      }
    });
    result.seconds = Math.round((now() - started) / 100) / 10;
    if (!listedRepos) {
      failedAt = now();
      log.error('reconcile incomplete: the relay could not list the repos', result);
      return result;
    }
    const at = new Date(now()).toISOString();
    try {
      await writeStatus({ backfilled_at: at });
    } catch (err) {
      log.error('could not write backfilled_at', { err });
    }
    store.setBackfilledAt(at);
    failedAt = null;
    log.info('reconciled', result);
    return result;
  }

  function run(reason = 'asked') {
    if (running) return running;
    running = pass(reason)
      .catch((err) => {
        failedAt = now();
        log.error('reconcile failed', { err });
        return null;
      })
      .then((result) => {
        last = result;
        running = null;
        if (queued !== null) {
          const next = queued;
          queued = null;
          void run(next);
        }
        return result;
      });
    return running;
  }

  function due() {
    if (failedAt !== null && now() - failedAt < RETRY_FAILED_MS) return false;
    const at = store.backfilledAt === null ? NaN : Date.parse(store.backfilledAt);
    return !Number.isFinite(at) || now() - at >= reconcileMs;
  }

  function check() {
    if (!running && due()) void run(store.backfilledAt === null ? 'never reconciled' : 'scheduled');
  }

  return {
    run,
    /** The stream may have a gap: a pass now, or one more after the running one. */
    request(reason) {
      if (running) {
        if (queued === null) log.info('reconcile queued', { reason });
        queued = reason;
        return;
      }
      void run(reason);
    },
    start() {
      check();
      timer = setRepeat(check, CHECK_MS);
    },
    stop() {
      if (timer) clearRepeat(timer);
      timer = null;
      queued = null;
    },
    check,
    get running() {
      return running !== null;
    },
    get last() {
      return last;
    },
  };
}
