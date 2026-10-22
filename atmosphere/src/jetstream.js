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
//
// A replay has to outrun the live stream to catch up, and on a busy box it may not: on
// 2026-10-21 the station replayed at a fifth of real time and fell further behind every
// second, so it had no reading to give for over an hour. So once the stream is BEHIND_MS
// behind, the watchdog times how fast it's catching up; if it won't be back within
// CATCHUP_MS, it gives the replay up and reconnects at the live tail. The minutes it
// skipped are left out (a minute with no covered seconds is never written) and logged,
// for src/replay.js to fill in.

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
/** Further behind the live stream than this, the station has no reading to give (its window is the last minute). */
export const BEHIND_MS = 60_000;
/** How long a replay is watched before it's judged on how fast it's catching up. */
export const CATCHUP_SAMPLE_MS = 30_000;
/** A replay that won't be back within BEHIND_MS of live in this long is given up for the live tail. */
export const CATCHUP_MS = 5 * 60_000;

const iso = (ms) => new Date(ms).toISOString();

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
  /** Each parsed message, after the station has it (host-activity.js). */
  observe = null,
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
  /** The next connection starts at the live tail, not from a cursor. */
  let skipToLive = false;

  function cursorFor() {
    if (skipToLive) return null;
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
    const self = { sock, base, startedAt: now(), openedAt: null, lastMessageAt: null, messages: 0, behind: null, fail };
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
      if (self.messages++ === 0) {
        attempt = 0;
        // at the live tail now; later reconnects resume from a cursor again
        if (cursor === null) skipToLive = false;
      }
      let m;
      try {
        m = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString('utf8'));
      } catch {
        station.counts.unparseable++;
        return;
      }
      station.ingest(m?.time_us, eventOfMessage(m), happenedUs(m), accountOf(m));
      observe?.(m);
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
    else if (c.openedAt !== null) checkCatchingUp(c, t);
  }

  /** Behind the live stream: is it catching up fast enough? If not, skip to the live tail. */
  function checkCatchingUp(c, t) {
    const behindMs = station.lastUs === null ? 0 : t - station.lastUs / 1000;
    if (behindMs <= BEHIND_MS) {
      c.behind = null;
      return;
    }
    if (!c.behind) {
      c.behind = { since: t, behindMs };
      return;
    }
    const watched = t - c.behind.since;
    if (watched < CATCHUP_SAMPLE_MS) return;
    // milliseconds of lag won back per millisecond watched
    const rate = (c.behind.behindMs - behindMs) / watched;
    const needs = rate > 0 ? (behindMs - BEHIND_MS) / rate : Infinity;
    if (needs <= CATCHUP_MS) return;
    const gapFromMs = station.lastUs / 1000;
    log.warn('jetstream too far behind, skipping to the live tail', {
      host: c.base,
      behindSeconds: Math.round(behindMs / 1000),
      catchingUp: Math.round((1 + rate) * 100) / 100,
      // the minutes in here go unwritten: refill them with src/replay.js
      gapFrom: iso(gapFromMs),
      gapTo: iso(t),
    });
    skipToLive = true;
    c.fail('behind');
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
