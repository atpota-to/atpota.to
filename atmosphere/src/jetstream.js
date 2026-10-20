// jetstream.js
// One unfiltered Jetstream connection (no wantedCollections: everything), feeding the
// station. Its own connection and its own process: the mentions service on this box
// filters to app.bsky.feed.post and must not go down with this one.
//
// Jetstream v1 (/subscribe), not v2, because the website's reference sampler reads v1
// and the counts must agree. v1 messages carry `time_us`, and v1's cursor is a time_us.
// (The mentions service speaks v2, whose cursor is a seq. The two must never be mixed;
// see its jetstream.js.)
//
// On reconnect it resumes REWIND_US before the last time_us seen and the station drops
// what it already counted. A failed attempt (one that never delivered a message) moves on
// to the next URL; a connection that worked and then dropped retries the same one.

import { accountOf } from './accounts.js';
import { eventOfMessage } from './atmosphere.js';
import { happenedUs } from './clock.js';

export const DEFAULT_URLS = ['wss://jetstream2.us-east.bsky.network/subscribe', 'wss://jetstream1.us-east.bsky.network/subscribe'];
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
export const REWIND_US = 2_000_000;
/** The whole firehose is hundreds of events a second; this much silence is a dead socket. */
export const STALL_MS = 15_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const WATCHDOG_MS = 2_000;

export function withCursor(base, cursor) {
  if (cursor === null) return base;
  const url = new URL(base);
  url.searchParams.set('cursor', String(cursor));
  return url.toString();
}

export function createJetstream({
  station,
  log,
  urls = DEFAULT_URLS,
  now = () => Date.now(),
  open = (url) => new WebSocket(url),
  /** How far back a cursor may reach. */
  maxReplaySeconds = 1800,
  /** Where the first connection starts (a time_us), or null for the live tail. */
  startCursorUs = null,
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

  function cursorFor() {
    const cursor = station.lastUs !== null ? station.lastUs - REWIND_US : startCursorUs;
    if (cursor === null) return null;
    return Math.round(Math.max(cursor, (now() - maxReplaySeconds * 1000) * 1000));
  }

  function connect() {
    retryTimer = null;
    if (stopped) return;
    const base = urls[hostIndex % urls.length];
    const cursor = cursorFor();
    const dropThroughUs = station.lastUs;
    const url = withCursor(base, cursor);
    log.info('jetstream connecting', { host: base, cursor, replaySeconds: cursor === null ? 0 : Math.round(now() / 1000 - cursor / 1e6) });

    let sock;
    try {
      sock = open(url);
    } catch (err) {
      log.error('jetstream could not open socket', { host: base, err });
      hostIndex++;
      retry();
      return;
    }

    // Everything below is guarded on `current === attempt`: a replaced socket can still
    // deliver a late message or close, and acting on it would count events twice or start
    // a second reconnect chain.
    const self = { sock, base, startedAt: now(), openedAt: null, lastMessageAt: null, messages: 0, fail };
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
      station.beginSession({ dropThroughUs });
      log.info('jetstream connected', { host: base, cursor });
    };

    sock.onmessage = (msg) => {
      if (current !== self || self.openedAt === null) return;
      self.lastMessageAt = now();
      if (self.messages++ === 0) attempt = 0;
      let m;
      try {
        m = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString('utf8'));
      } catch {
        station.counts.unparseable++;
        return;
      }
      station.ingest(m?.time_us, eventOfMessage(m), happenedUs(m), accountOf(m));
    };

    sock.onerror = (e) => fail('error', e?.message ?? e?.error?.message);
    sock.onclose = (e) => fail('closed', e?.code);

    function fail(why, detail) {
      if (current !== self) return;
      current = null;
      station.endSession();
      try {
        sock.close();
      } catch {
        // already gone
      }
      const connectedSeconds = self.openedAt === null ? 0 : Math.round((now() - self.openedAt) / 1000);
      log.warn('jetstream disconnected', { host: base, why, detail, messages: self.messages, connectedSeconds });
      if (self.messages === 0) hostIndex++;
      retry();
    }
  }

  function retry() {
    if (stopped || retryTimer) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    retryTimer = setTimer(connect, delay);
  }

  function check() {
    const c = current;
    if (!c) return;
    const t = now();
    if (c.openedAt === null && t - c.startedAt > CONNECT_TIMEOUT_MS) c.fail('connect timeout');
    else if (c.openedAt !== null && t - (c.lastMessageAt ?? c.openedAt) > STALL_MS) c.fail('stalled');
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
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
      station.endSession();
      try {
        c?.sock.close();
      } catch {
        // already gone
      }
    },
    /** For tests and stats: the URL index in use and the socket. */
    get state() {
      return { host: current?.base ?? null, hostIndex, attempt, connected: station.connected };
    },
    check,
  };
}
