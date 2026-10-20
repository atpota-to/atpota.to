// station.js
// The last hour of the firehose, one tally per second, keyed by each event's own time
// (time_us), not by when it arrived. A reconnect that replays from a cursor therefore
// fills the right seconds.
//
// Coverage. A second is only counted if this process saw the whole of it: within one
// connection, every second from the first event's (rounded up) to the one before the
// latest event's. A second outside that is MISSING, not quiet: it is left out of sums
// and shows as null in `series`, and `seconds` says how many were actually covered.
//
// Replays. When a connection drops, the next one resumes a little before the last
// time_us seen, and every replayed event at or before that time_us is dropped, so the
// overlap is never counted twice. Out-of-order events inside one connection are kept.

import { addEvent, COLLECTIONS, emptyTally, mergeTally, splitOf, summarize } from './atmosphere.js';

export const RETAIN_SECONDS = 3600;
/** Events stamped further ahead of this clock than this are ignored (clock skew). */
export const FUTURE_SECONDS = 5;
export const WINDOW_SECONDS = 60;
/** The rolling window ends this long ago, so late events have arrived. */
export const SETTLE_SECONDS = 2;
/** A window with fewer covered seconds than this is no reading at all. */
export const MIN_COVERED = 30;

const iso = (second) => new Date(second * 1000).toISOString();

export class Station {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** second -> { tally, covered } */
    this.buckets = new Map();
    /** The open connection's coverage, or null when disconnected. */
    this.session = null;
    /** The highest time_us seen on any connection. */
    this.lastUs = null;
    /** The latest second marked covered, on any connection. */
    this.coveredThrough = null;
    this.counts = { messages: 0, counted: 0, replayed: 0, tooOld: 0, future: 0, badTime: 0, unparseable: 0 };
  }

  get connected() {
    return this.session !== null;
  }

  /** A connection opened. Events at or before `dropThroughUs` were already counted. */
  beginSession({ dropThroughUs = null } = {}) {
    this.session = { firstUs: null, markedThrough: null, dropThroughUs };
  }

  endSession() {
    this.session = null;
  }

  bucket(second) {
    let b = this.buckets.get(second);
    if (!b) {
      b = { tally: emptyTally(), covered: false };
      this.buckets.set(second, b);
    }
    return b;
  }

  /**
   * One Jetstream message: its time_us, and what it counts as. A message that counts as
   * nothing (null) still moves coverage on: the stream was flowing.
   */
  ingest(timeUs, event) {
    const s = this.session;
    if (!s) return;
    this.counts.messages++;
    if (typeof timeUs !== 'number' || !Number.isFinite(timeUs) || timeUs <= 0) {
      this.counts.badTime++;
      return;
    }
    const second = Math.floor(timeUs / 1e6);
    const nowSec = this.now() / 1000;
    if (second > nowSec + FUTURE_SECONDS) {
      this.counts.future++;
      return;
    }
    this.cover(s, timeUs, nowSec);
    if (this.lastUs === null || timeUs > this.lastUs) this.lastUs = timeUs;
    if (s.dropThroughUs !== null && timeUs <= s.dropThroughUs) {
      this.counts.replayed++;
      return;
    }
    if (second < nowSec - RETAIN_SECONDS) {
      this.counts.tooOld++;
      return;
    }
    if (event) {
      addEvent(this.bucket(second).tally, event);
      this.counts.counted++;
    }
  }

  /** Marks every second this connection has now seen from start to end. */
  cover(s, timeUs, nowSec) {
    if (s.firstUs === null) s.firstUs = timeUs;
    const through = Math.floor(timeUs / 1e6) - 1;
    if (s.markedThrough !== null && through <= s.markedThrough) return;
    const from = Math.max(Math.ceil(s.firstUs / 1e6), s.markedThrough === null ? -Infinity : s.markedThrough + 1, Math.floor(nowSec) - RETAIN_SECONDS);
    for (let second = from; second <= through; second++) this.bucket(second).covered = true;
    s.markedThrough = through;
    if (this.coveredThrough === null || through > this.coveredThrough) this.coveredThrough = through;
  }

  /** Forgets seconds older than the hour kept. */
  prune() {
    const oldest = Math.floor(this.now() / 1000) - RETAIN_SECONDS;
    for (const second of this.buckets.keys()) if (second < oldest) this.buckets.delete(second);
  }

  /** Covered seconds in [from, to), summed into one tally. */
  sum(from, to, perSecond) {
    const tally = emptyTally();
    let seconds = 0;
    for (let second = from; second < to; second++) {
      const b = this.buckets.get(second);
      if (!b?.covered) {
        perSecond?.(second, null);
        continue;
      }
      seconds++;
      mergeTally(tally, b.tally);
      perSecond?.(second, b.tally);
    }
    return { tally, seconds };
  }

  /** The last WINDOW_SECONDS complete seconds, ending SETTLE_SECONDS ago. */
  window(nowMs = this.now()) {
    const to = Math.floor(nowMs / 1000) - SETTLE_SECONDS;
    const from = to - WINDOW_SECONDS;
    const series = [];
    const { tally, seconds } = this.sum(from, to, (t, b) => {
      series.push(b ? { t, ...splitOf(b), posts: b.creates.get(COLLECTIONS.posts) ?? 0 } : null);
    });
    return { from, to, tally, seconds, series };
  }

  /** The rolling reading for GET /v1/now, or null when too little of the window was covered. */
  reading(nowMs = this.now()) {
    const w = this.window(nowMs);
    if (w.seconds < MIN_COVERED) return null;
    const reading = summarize(w.tally, w.seconds, iso(w.to));
    reading.window = { from: iso(w.from), to: iso(w.to) };
    reading.series = w.series;
    return reading;
  }

  /** One minute (its start, in epoch seconds), summed. */
  minute(minuteSec) {
    return this.sum(minuteSec, minuteSec + 60);
  }
}
