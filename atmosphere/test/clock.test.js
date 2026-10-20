// When a record really happened: its rev (a TID), within limits, else Jetstream's time_us.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { happenedUs, MAX_EARLIER_S, MAX_TRUSTED_LAG_S, tidUs } from '../src/clock.js';

const ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
/** A TID for a microsecond (clock id 0). */
function tid(us) {
  let v = BigInt(us) << 10n;
  let s = '';
  for (let i = 0; i < 13; i++) {
    s = ALPHABET[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
}

const T = 1_792_517_855_000_000; // 2026-10-20T17:37:35Z, when jetstream2 paused
const commit = (timeUs, rev) => ({ kind: 'commit', time_us: timeUs, commit: { operation: 'create', collection: 'app.bsky.feed.like', rev } });

test('reads a TID', () => {
  assert.equal(tidUs(tid(T)), T);
  assert.equal(tidUs('3m3qo2vutsw2b') > 1.7e15, true, 'a real rev from 2026');
  assert.equal(tidUs('not-a-tid'), null);
  assert.equal(tidUs('3m3qo2vutsw2!'), null);
  assert.equal(tidUs(undefined), null);
});

test('a record let out late after a pause goes back to when it was made', () => {
  assert.equal(happenedUs(commit(T + 25e6, tid(T + 1e6))), T + 1e6);
});

test('but never more than a minute back, and never later than Jetstream saw it', () => {
  assert.equal(happenedUs(commit(T + 200e6, tid(T))), T + 200e6 - MAX_EARLIER_S * 1e6);
  assert.equal(happenedUs(commit(T, tid(T + 3e6))), T, 'a PDS clock running a little fast');
});

test('an old record arriving now, or a rev that is no clock, goes by time_us', () => {
  assert.equal(happenedUs(commit(T, tid(T - (MAX_TRUSTED_LAG_S + 1) * 1e6))), T);
  assert.equal(happenedUs(commit(T, '2222222222222')), T, 'decodes to 1970');
  assert.equal(happenedUs(commit(T, undefined)), T);
  assert.equal(happenedUs({ kind: 'identity', time_us: T }), T);
  assert.equal(happenedUs({ kind: 'commit' }), undefined, 'no time at all: the station counts it as bad');
});
