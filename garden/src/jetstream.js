// jetstream.js
// One Jetstream v2 connection at a time, filtered to the garden, Poe's pet counts and stream chat (chat pets):
//
//   wss://<host>/xrpc/network.bsky.jetstream.subscribeEvents
//     ?collections=to.atpota.garden.*&collections=to.atpota.poe.pets&collections=place.stream.chat.message&kinds=commit[&cursor=<seq>]
//
// v2, like the mentions service, not the v1 the weather station reads. The differences
// that matter (see mentions/src/jetstream.js for how each one bit):
//
//   Wire format. {"$type":"message","payload":{...}}, the commit's fields flat on the
//   payload: did, collection, rkey, operation, record, cid, seq, time. No record or cid on
//   a delete.
//
//   Cursor space. A cursor is a `seq`, per host: each Jetstream numbers its own events,
//   so cursors are kept per host (state.js) and a host without one starts at the live
//   tail. Replay is inclusive, so the last event comes again; everything downstream is
//   idempotent.
//
//   Stale cursors. v2 refuses a cursor it no longer holds with an HTTP 400, and Node's
//   WebSocket hides the status, so FAILURES_BEFORE_DROPPING_CURSOR failed opens in a row
//   while holding a cursor drop it and start from the live tail.
//
// Whenever a connection opens without a cursor, it may have missed something (a dropped
// cursor, a move to another host, a first start), so it asks for a reconcile
// (backfill.js), which compares every garden repo with the index.
//
// The garden is quiet: hours without a message are normal, so there is no silence
// watchdog. Instead the connection is recycled every RECYCLE_MINUTES (flush, close,
// reconnect from the saved cursor), which also gets rid of a socket that died without
// closing.
//
// Failover: an attempt that never opens moves on to the next host, unless it holds a
// cursor for this one (then it stays, until the cursor is dropped). A connection that
// opened and then dropped retries the same host. Backoff 1, 2, 4 … 30 s, reset once a
// connection has stayed up STABLE_MS.

import { STREAM_COLLECTIONS } from './records.js';

export const PATH = '/xrpc/network.bsky.jetstream.subscribeEvents';
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
export const CONNECT_TIMEOUT_MS = 10_000;
export const WATCHDOG_MS = 2_000;
export const STABLE_MS = 30_000;
export const FAILURES_BEFORE_DROPPING_CURSOR = 4;

export function streamUrl(host, cursor) {
  const collections = STREAM_COLLECTIONS.map((c) => `collections=${c}`).join('&');
  return `${host}${PATH}?${collections}&kinds=commit${cursor === null || cursor === undefined ? '' : `&cursor=${cursor}`}`;
}

export function createJetstream({
  hosts,
  log,
  /** The saved cursor for a host (a seq), or null. */
  cursorFor,
  /** Forget a host's cursor: it's stale. */
  dropCursor,
  /** Every payload, with { host, seq, time }. */
  onEvent,
  /** There may be a gap: compare the repos with the index. */
  reconcile = () => {},
  /** A connection opened. */
  onOpen = () => {},
  /** Before a recycle closes the socket (the indexer's flush, so the cursor is current). */
  beforeRecycle = async () => {},
  recycleMs = 15 * 60_000,
  now = () => Date.now(),
  open = (url) => new WebSocket(url),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRepeat = setInterval,
  clearRepeat = clearInterval,
}) {
  let current = null;
  let hostIndex = 0;
  let attempt = 0;
  let stopped = true;
  let retryTimer = null;
  let watchdog = null;
  let lastMessageAt = null;
  const failures = new Map();
  const counts = { messages: 0, unparseable: 0, otherTypes: 0, handlerErrors: 0, connects: 0, recycles: 0 };

  function connect() {
    retryTimer = null;
    if (stopped) return;
    const host = hosts[hostIndex % hosts.length];
    const cursor = cursorFor(host);
    const url = streamUrl(host, cursor);
    log.info('jetstream connecting', { host, cursor, fromLiveTail: cursor === null });
    counts.connects++;

    let sock;
    try {
      sock = open(url);
    } catch (err) {
      log.error('jetstream could not open socket', { host, err });
      hostIndex++;
      retry();
      return;
    }

    // Everything below is guarded on `current === self`: a replaced socket can still
    // deliver a late message or close, and acting on it would start a second reconnect
    // chain (two sockets, then four; see mentions/src/jetstream.js).
    const self = { sock, host, cursor, startedAt: now(), openedAt: null, lastMessageAt: null, messages: 0, recycling: false, fail };
    if (current) {
      try {
        current.sock.close();
      } catch {
        // already gone
      }
    }
    current = self;

    sock.onopen = () => {
      if (current !== self) return;
      self.openedAt = now();
      failures.set(host, 0);
      log.info('jetstream connected', { host, cursor });
      if (cursor === null) reconcile(`jetstream connected to ${host} from the live tail`);
      onOpen(host);
    };

    sock.onmessage = (msg) => {
      if (current !== self || self.openedAt === null) return;
      self.lastMessageAt = lastMessageAt = now();
      self.messages++;
      counts.messages++;
      let envelope;
      try {
        envelope = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString('utf8'));
      } catch {
        counts.unparseable++;
        return;
      }
      if (envelope?.$type !== 'message' || !envelope.payload || typeof envelope.payload !== 'object') {
        counts.otherTypes++;
        log.warn('jetstream sent something other than a message', { host, type: String(envelope?.$type ?? typeof envelope).slice(0, 100) });
        return;
      }
      const payload = envelope.payload;
      try {
        onEvent(payload, { host, seq: Number.isSafeInteger(payload.seq) ? payload.seq : null, time: payload.time });
      } catch (err) {
        counts.handlerErrors++;
        log.error('jetstream handler threw', { host, err, seq: payload.seq });
      }
    };

    // A failed upgrade fires `error` and, in Node, not always `close`: both settle here,
    // once.
    sock.onerror = (e) => fail('error', e?.message ?? e?.error?.message);
    sock.onclose = (e) => fail('closed', e?.code);

    function fail(why, detail) {
      if (current !== self) return;
      current = null;
      try {
        sock.close();
      } catch {
        // already gone
      }
      const connectedSeconds = self.openedAt === null ? 0 : Math.round((now() - self.openedAt) / 1000);
      log.warn('jetstream disconnected', { host, why, detail, opened: self.openedAt !== null, messages: self.messages, connectedSeconds });
      if (self.openedAt !== null) {
        if (now() - self.openedAt >= STABLE_MS) attempt = 0;
      } else if (cursor !== null) {
        const n = (failures.get(host) ?? 0) + 1;
        failures.set(host, n);
        if (n >= FAILURES_BEFORE_DROPPING_CURSOR) {
          log.warn('jetstream failing to connect while holding a cursor; dropping it', {
            host,
            cursor,
            failures: n,
            note: 'v2 refuses a cursor it no longer holds with a 400, which this runtime hides; a reconcile covers the gap',
          });
          dropCursor(host);
          failures.set(host, 0);
          attempt = 0;
        }
      } else {
        hostIndex++;
      }
      retry();
    }
  }

  function retry() {
    if (stopped || retryTimer) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    retryTimer = setTimer(connect, delay);
  }

  async function recycle(c) {
    c.recycling = true;
    try {
      await beforeRecycle();
    } catch (err) {
      log.warn('flush before recycling failed; reconnecting anyway', { err });
    }
    if (current !== c || stopped) return;
    current = null;
    try {
      c.sock.close();
    } catch {
      // already gone
    }
    counts.recycles++;
    log.info('jetstream recycling', { host: c.host, connectedSeconds: Math.round((now() - c.openedAt) / 1000), messages: c.messages });
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
    attempt = 0;
    connect();
  }

  function check() {
    const c = current;
    if (!c) return null;
    const t = now();
    if (c.openedAt === null && t - c.startedAt > CONNECT_TIMEOUT_MS) c.fail('connect timeout');
    else if (c.openedAt !== null && !c.recycling && t - c.openedAt >= recycleMs) return recycle(c);
    return null;
  }

  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      // Start on a host we hold a cursor for, so a restart picks up where it left off.
      hostIndex = Math.max(0, hosts.findIndex((h) => cursorFor(h) !== null));
      watchdog = setRepeat(check, WATCHDOG_MS);
      connect();
    },
    stop() {
      stopped = true;
      if (retryTimer) clearTimer(retryTimer);
      retryTimer = null;
      if (watchdog) clearRepeat(watchdog);
      watchdog = null;
      const c = current;
      current = null;
      try {
        c?.sock.close();
      } catch {
        // already gone
      }
    },
    /** The watchdog: connect timeout and recycling. Returns the recycle's promise, for tests. */
    check,
    get state() {
      const c = current;
      return {
        connected: Boolean(c && c.openedAt !== null),
        host: c?.host ?? null,
        openedAt: iso(c?.openedAt ?? null),
        /** The last message on any connection: the garden is quiet, so this can be hours ago. */
        lastMessageAt: iso(lastMessageAt),
      };
    },
    get counts() {
      return counts;
    },
  };
}
