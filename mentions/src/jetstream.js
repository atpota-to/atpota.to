// jetstream.js
// Jetstream v2 consumer.
//
// Endpoint shape, confirmed against the live service on 2026-09-18:
//   wss://<host>/xrpc/network.bsky.jetstream.subscribeEvents
//     ?collections=app.bsky.feed.post&kinds=commit[&cursor=<seq>]
//
// Three things the v1 consumers on this box do differently, each of which
// silently breaks if carried over:
//
//   Wire format. v2 wraps everything in {"$type":"message","payload":{...}}
//   with the commit fields flat on payload (did, rkey, cid, collection,
//   operation, record, seq, time). v1 nested them under `commit` and carried
//   `time_us`. Code written for v1 matches nothing at all against v2 -- no
//   error, just a consumer that never fires.
//
//   Cursor space. v2's cursor is a `seq`, and replay is exact: cursor=seq-1000
//   lands 1000 events back, measured. v1's cursor was a microsecond timestamp.
//   Handing v2 a v1-style time_us does NOT error -- it silently resumes from
//   some unrelated point. The two must never be mixed, so cursors are stored
//   per host and only ever read back as a seq.
//
//   Stale cursors. v1 silently started from the oldest event it still had. v2
//   answers HTTP 400 and refuses the connection. Node's built-in WebSocket
//   does not expose the status code -- a 400 and a 503 both arrive as
//   "Received network error or non-101 status code" -- so rather than parse
//   error strings, a run of consecutive failures while holding a cursor drops
//   the cursor and retries from the live tail. That recovers from both causes,
//   and the notification sweep covers the gap it leaves.

import { config } from './config.js';
import { logger } from './logger.js';
import { loadCursor, saveCursor, clearCursor } from './db.js';
import { POST_COLLECTION } from './matcher.js';

const FAILURES_BEFORE_DROPPING_CURSOR = 4;

function buildUrl(host, { withCursor }) {
  const url = new URL(config.jetstreamPath, host.replace(/^ws/, 'http'));
  url.protocol = host.startsWith('wss') ? 'wss:' : 'ws:';
  url.searchParams.set('collections', POST_COLLECTION);
  url.searchParams.set('kinds', 'commit');
  if (withCursor) {
    const seq = loadCursor(host);
    if (seq != null) {
      url.searchParams.set('cursor', String(Math.max(1, seq - config.cursorRewindSeq)));
      return { url: url.toString(), cursor: seq };
    }
  }
  return { url: url.toString(), cursor: null };
}

function createConnection(host, onEvent, stats) {
  let ws = null;
  let backoff = config.reconnectBaseMs;
  let consecutiveFailures = 0;
  let skipCursor = false;         // set after repeated failures while holding one
  let openedOnce = false;
  let closedByUs = false;
  let lastSaved = 0;
  let pendingSeq = null;

  function persist(force) {
    if (pendingSeq == null) return;
    const now = Date.now();
    if (!force && now - lastSaved < config.cursorSaveMs) return;
    saveCursor(host, pendingSeq);
    lastSaved = now;
  }

  function connect() {
    if (closedByUs) return;
    const { url, cursor } = buildUrl(host, { withCursor: !skipCursor });
    logger.info('jetstream connecting', {
      host, resumingFrom: cursor, fromLiveTail: cursor == null,
    });

    let sock;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      logger.error('jetstream could not construct socket', { host, err });
      scheduleReconnect();
      return;
    }

    // `sock` supersedes whatever came before. Everything below is guarded on
    // `ws === sock`, because a socket that has been replaced can still deliver
    // a late close or a stray message, and acting on one would start a SECOND
    // reconnect chain for this host. Two chains means two live sockets, then
    // four -- every event counted twice over, and enough event-loop pressure to
    // delay the stats timer by minutes. Observed on 2026-09-18 as a reported
    // 240 posts/s against a firehose actually delivering 48.
    const previous = ws;
    ws = sock;
    if (previous && previous !== sock) {
      try { previous.close(); } catch { /* already gone */ }
    }

    // Per-attempt, not per-host: the whole point is that a superseded attempt
    // cannot settle on behalf of the current one.
    let attemptSettled = false;

    sock.onopen = () => {
      if (ws !== sock) return;
      openedOnce = true;
      consecutiveFailures = 0;
      backoff = config.reconnectBaseMs;
      logger.info('jetstream connected', { host, resumedFrom: cursor });
      if (skipCursor) {
        // We got here by dropping a cursor. Say so once, loudly: this is a gap,
        // and the notification sweep is what covers it.
        logger.warn('jetstream resumed from live tail after dropping a stale cursor', {
          host, note: 'gap in coverage; notification sweep should backfill mentions',
        });
        skipCursor = false;
      }
    };

    sock.onmessage = (msgEvent) => {
      if (ws !== sock) return;   // superseded socket still draining
      stats.received++;
      let envelope;
      try {
        envelope = JSON.parse(
          typeof msgEvent.data === 'string' ? msgEvent.data : Buffer.from(msgEvent.data).toString('utf8')
        );
      } catch {
        stats.unparseable++;
        return;
      }
      const payload = envelope?.payload;
      if (!payload) return;

      if (typeof payload.seq === 'number' && Number.isFinite(payload.seq)) {
        pendingSeq = payload.seq;
        persist(false);
      }

      try {
        onEvent(payload, host);
      } catch (err) {
        stats.handlerErrors++;
        logger.error('jetstream handler threw', { host, err, seq: payload.seq });
      }
    };

    // A failed HTTP upgrade (the 503 us-east was serving on 2026-09-18, or the
    // 400 v2 answers to an aged-out cursor) fires `error` and, in this runtime,
    // NOT `close`. Assuming close always follows leaves a dead socket that never
    // retries -- silently, for the life of the process. Both events funnel into
    // one settle path guarded by a flag so a runtime that fires both does not
    // schedule two reconnects.
    sock.onerror = () => settle(null);
    sock.onclose = (ev) => settle(ev?.code);

    function settle(code) {
      if (attemptSettled || closedByUs) return;
      if (ws !== sock) return;          // a superseded attempt settles nothing
      attemptSettled = true;
      persist(true);
      if (!openedOnce) {
        consecutiveFailures++;
        // Node's WebSocket hides the HTTP status, so we infer: if we are
        // holding a cursor and cannot get a connection open, the cursor is the
        // most likely reason (v2 rejects one that has aged out with a 400).
        if (consecutiveFailures >= FAILURES_BEFORE_DROPPING_CURSOR && loadCursor(host) != null && !skipCursor) {
          logger.warn('jetstream failing to connect while holding a cursor; dropping it', {
            host, consecutiveFailures, code,
            note: 'v2 rejects an aged-out cursor with 400 and the status is not visible here',
          });
          clearCursor(host);
          pendingSeq = null;
          skipCursor = true;
          backoff = config.reconnectBaseMs;
        }
      } else {
        openedOnce = false;
      }
      scheduleReconnect(code);
    }
  }

  function scheduleReconnect(code) {
    if (closedByUs) return;
    logger.warn('jetstream disconnected; reconnecting', { host, inMs: backoff, code });
    // Deliberately NOT unref'd: while every socket is down, this timer is the
    // only thing holding the event loop open, and a process that exits here
    // looks like a crash loop under Restart=always.
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, config.reconnectMaxMs);
  }

  connect();

  return {
    host,
    flush: () => persist(true),
    close() {
      closedByUs = true;
      persist(true);
      try { ws?.close(); } catch { /* already gone */ }
    },
  };
}

export function connectJetstream({ onEvent, stats }) {
  logger.info('starting jetstream', { hosts: config.jetstreamHosts });
  const conns = config.jetstreamHosts.map((h) => createConnection(h, onEvent, stats));
  return {
    flush: () => conns.forEach((c) => c.flush()),
    close: () => conns.forEach((c) => c.close()),
  };
}
