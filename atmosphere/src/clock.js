// clock.js
// When a record really happened, as opposed to when Jetstream handled it.
//
// Jetstream stamps every event with time_us, the moment it handled the event. That's
// the stream's position, and cursors, coverage and replay de-duplication all go by it.
// But it isn't always when the record was made: when Jetstream (or the relay upstream)
// pauses, events pile up and come out together, stamped late. On 2026-10-20 jetstream2
// sent nothing for 25 s from 17:37:35 and then the backlog at up to 2,100/s, so by
// time_us 17:37 read 263 records/s and 17:38 642, either side of a steady ~450.
//
// A commit also carries `rev`, a TID its PDS stamped when the record was written, before
// any relay or Jetstream got to it. Counted by rev, those two minutes were 450 and 455.
// So a new record goes in the second its rev says, within limits:
//
//   - never later than time_us (nothing is made after Jetstream has seen it), and never
//     more than MAX_EARLIER_S before it, so the minute writer knows how long to wait
//     before a minute can't change any more;
//   - a rev more than MAX_TRUSTED_LAG_S behind is an old record arriving now (a repo
//     being imported or moved), not a delay, and some revs decode to nonsense (1970,
//     say): both go by time_us, as do identity and account events, which have no rev.
//
// Normally rev is about 0.15 s behind time_us, so this changes nothing on a calm day.

export const MAX_EARLIER_S = 60;
export const MAX_TRUSTED_LAG_S = 300;

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

/** A TID's timestamp in microseconds since the epoch, or null if it isn't a TID. */
export function tidUs(tid) {
  if (typeof tid !== 'string' || tid.length !== 13) return null;
  let v = 0n;
  for (const ch of tid) {
    const i = TID_ALPHABET.indexOf(ch);
    if (i < 0) return null;
    v = v * 32n + BigInt(i);
  }
  // 64 bits: a zero top bit, 53 bits of microseconds, 10 bits of clock id.
  if (v >> 63n) return null;
  return Number(v >> 10n);
}

/** The microsecond a Jetstream message's record should be counted at. */
export function happenedUs(m) {
  const t = m?.time_us;
  if (typeof t !== 'number' || !Number.isFinite(t)) return t;
  if (m.kind !== 'commit') return t;
  const rev = tidUs(m.commit?.rev);
  if (rev === null || t - rev > MAX_TRUSTED_LAG_S * 1e6) return t;
  return Math.min(t, Math.max(rev, t - MAX_EARLIER_S * 1e6));
}
