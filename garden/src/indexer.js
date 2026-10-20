// indexer.js
// The batcher between Jetstream and Supabase. Events wait in a Map by URI, so a URI's last
// event wins and a batch never both upserts and deletes one (garden_apply deletes first,
// then upserts). Alongside them, the newest Jetstream seq per host and the newest event
// time.
//
// A flush sends what's pending to garden_apply, 500 URIs a call. Only once every call has
// succeeded does it save the cursors (state.js) and move stream_at on: a restart resumes
// from the last seq whose events are all in Supabase, and Jetstream re-delivers the rest.
// Everything is idempotent, so re-delivery and re-sending are harmless. On a failure
// everything stays pending and the flush is retried with backoff (1 s doubling to 30 s).
//
// It flushes a second after anything arrives, at once when 200 URIs are waiting, and one
// flush runs at a time.
//
// One row Postgres refuses would hold up everything behind it forever, so after
// MAX_REJECTED_TRIES rejections in a row (400, 409, 413, 422: bad data, not Supabase being
// down or the key being wrong) the batch goes one URI at a time, and whatever Supabase still
// refuses is dropped, loudly. A reconcile puts back anything dropped by mistake.
//
// It also remembers, for an hour, which URIs the stream touched and when, so a reconcile
// can leave alone what the stream changed while it was listing (backfill.js).

export const CHUNK = 500;
export const FLUSH_AT = 200;
export const FLUSH_MS = 1000;
export const RETRY_MS = [1000, 2000, 4000, 8000, 16000, 30000];
export const MAX_REJECTED_TRIES = 3;
export const REJECTED_STATUS = [400, 409, 413, 422];
export const TOUCHED_MS = 60 * 60_000;

const uriOfEvent = (event) => (event.op === 'delete' ? event.uri : event.row.uri);

/** garden_apply's arguments for some [uri, event] entries. */
export function applyArgs(entries) {
  const p_upserts = [];
  const p_deletes = [];
  for (const [, event] of entries) {
    if (event.op === 'delete') p_deletes.push(event.uri);
    else p_upserts.push(event.row);
  }
  return { p_upserts, p_deletes };
}

/** Sends entries to garden_apply, CHUNK at a time. */
export async function applyChunked(rpc, entries) {
  for (let i = 0; i < entries.length; i += CHUNK) await rpc('garden_apply', applyArgs(entries.slice(i, i + CHUNK)));
}

export function createIndexer({ rpc, store, log, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const pending = new Map();
  const seqs = new Map();
  const touched = new Map();
  let newestTime = null;
  let streamAt = null;
  let lastFlushAt = null;
  let inFlight = null;
  let timer = null;
  let failures = 0;
  let rejections = 0;
  let retryAt = 0;
  const counts = { events: 0, applied: 0, flushes: 0, failures: 0, dropped: 0 };

  function cancel() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function kick() {
    if (timer || inFlight || (!pending.size && !seqs.size)) return;
    timer = setTimer(
      () => {
        timer = null;
        void flush();
      },
      Math.max(FLUSH_MS, retryAt - now()),
    );
  }

  function add(event, { seq, host, time } = {}) {
    if (event) {
      const uri = uriOfEvent(event);
      pending.delete(uri);
      pending.set(uri, event);
      touched.set(uri, now());
      counts.events++;
    }
    if (host && Number.isSafeInteger(seq) && seq > (seqs.get(host) ?? 0)) seqs.set(host, seq);
    const t = typeof time === 'string' ? Date.parse(time) : NaN;
    if (Number.isFinite(t) && (newestTime === null || t > newestTime)) newestTime = t;
    if (pending.size >= FLUSH_AT && !inFlight && now() >= retryAt) void flush();
    else kick();
  }

  /** One URI at a time; drops what Supabase refuses. False if Supabase failed some other way. */
  async function isolate(batch) {
    for (const entry of batch) {
      try {
        await applyChunked(rpc, [entry]);
      } catch (err) {
        if (!REJECTED_STATUS.includes(err?.status)) throw err;
        counts.dropped++;
        log.error('event dropped: rejected by supabase', { uri: entry[0], op: entry[1].op, err });
      }
    }
  }

  async function run() {
    const batch = [...pending];
    const seqAt = new Map(seqs);
    const timeAt = newestTime;
    const started = now();
    try {
      try {
        await applyChunked(rpc, batch);
      } catch (err) {
        rejections = REJECTED_STATUS.includes(err?.status) ? rejections + 1 : 0;
        if (rejections < MAX_REJECTED_TRIES) throw err;
        log.warn('apply rejected again; applying one at a time', { err, events: batch.length });
        await isolate(batch);
      }
    } catch (err) {
      failures++;
      counts.failures++;
      const wait = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)];
      retryAt = now() + wait;
      log.warn('apply failed', { err, pending: pending.size, retryInMs: wait });
      return false;
    }
    failures = 0;
    rejections = 0;
    retryAt = 0;
    for (const [uri, event] of batch) if (pending.get(uri) === event) pending.delete(uri);
    for (const [host, seq] of seqAt) if (seqs.get(host) === seq) seqs.delete(host);
    store.setCursors(seqAt);
    if (timeAt !== null && (streamAt === null || timeAt > Date.parse(streamAt))) streamAt = new Date(timeAt).toISOString();
    lastFlushAt = now();
    counts.flushes++;
    counts.applied += batch.length;
    const cutoff = now() - TOUCHED_MS;
    for (const [uri, at] of touched) if (at < cutoff) touched.delete(uri);
    if (batch.length) {
      const { p_upserts, p_deletes } = applyArgs(batch);
      log.info('applied', { upserts: p_upserts.length, deletes: p_deletes.length, ms: now() - started, cursors: Object.fromEntries(seqAt), streamAt });
    }
    return true;
  }

  /** Sends everything pending; one flush at a time. Resolves true when all of it went. */
  async function flush() {
    while (inFlight) await inFlight;
    if (!pending.size && !seqs.size) return true;
    cancel();
    inFlight = run().finally(() => {
      inFlight = null;
      kick();
    });
    return inFlight;
  }

  return {
    add,
    flush,
    /** After a stale cursor is dropped: never save this host's unsaved seq again. */
    forget(host) {
      seqs.delete(host);
    },
    /** Whether the stream touched this URI at or after `sinceMs`. */
    touchedSince(uri, sinceMs) {
      return (touched.get(uri) ?? -Infinity) >= sinceMs;
    },
    stop() {
      cancel();
    },
    get pending() {
      return pending.size;
    },
    get streamAt() {
      return streamAt;
    },
    get lastFlushAt() {
      return lastFlushAt === null ? null : new Date(lastFlushAt).toISOString();
    },
    get counts() {
      return counts;
    },
  };
}
