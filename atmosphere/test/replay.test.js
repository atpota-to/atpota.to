// Recounting minutes from Jetstream's history: the 17:37 pause, partial minutes, arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_S, parseArgs, replayWindow, supabaseReplace, WRITE_LAG_S } from '../src/replay.js';

const T0 = 1_792_512_000; // 2026-10-20T16:00:00Z
const ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
function tid(us) {
  let v = BigInt(us) << 10n;
  let s = '';
  for (let i = 0; i < 13; i++) {
    s = ALPHABET[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
}
const like = (timeUs, revUs = timeUs) => JSON.stringify({ kind: 'commit', time_us: timeUs, commit: { operation: 'create', collection: 'app.bsky.feed.like', rev: tid(revUs) } });

/** A Jetstream that replays `messages` from the cursor it's asked for. */
function fakeJetstream(messages) {
  const asked = [];
  const open = (url) => {
    asked.push(url);
    const cursor = Number(new URL(url).searchParams.get('cursor'));
    const sock = { close() {} };
    queueMicrotask(() => {
      sock.onopen?.();
      for (const m of messages) if (JSON.parse(m).time_us >= cursor) sock.onmessage?.({ data: m });
      sock.onclose?.();
    });
    return sock;
  };
  return { open, asked };
}

test('recounts the 17:37 pause as it happened: ten a second all along', async () => {
  const msgs = [];
  for (let k = (T0 - 10) * 10; k <= (T0 + 35) * 10; k++) msgs.push(like(k * 100_000));
  // 25 s of nothing, then the backlog all stamped at T0 + 60, carrying when it was made
  for (let k = (T0 + 35) * 10 + 1; k < (T0 + 60) * 10; k++) msgs.push(like((T0 + 60) * 1e6 + (k % 100), k * 100_000));
  for (let k = (T0 + 60) * 10; k <= (T0 + 200) * 10; k++) msgs.push(like(k * 100_000));
  const net = fakeJetstream(msgs);
  const minutes = [];
  const { firstUs } = await replayWindow({ host: 'wss://js.example/subscribe', fromSec: T0, toSec: T0 + 120, open: net.open, onMinute: (m, tally, seconds) => minutes.push([m - T0, seconds, tally.creates.get('app.bsky.feed.like')]) });
  assert.deepEqual(minutes, [
    [0, 60, 600],
    [60, 60, 600],
  ]);
  assert.equal(new URL(net.asked[0]).searchParams.get('cursor'), String((T0 - LEAD_S) * 1e6), 'starts a little early');
  assert.equal(firstUs, (T0 - LEAD_S) * 1e6);
});

test('a minute from before Jetstream\'s lookback comes back partial, so it can be left alone', async () => {
  const msgs = [];
  for (let k = (T0 + 30) * 10; k <= (T0 + 200) * 10; k++) msgs.push(like(k * 100_000));
  const minutes = [];
  const { firstUs } = await replayWindow({ host: 'wss://js.example/subscribe', fromSec: T0, toSec: T0 + 120, open: fakeJetstream(msgs).open, onMinute: (m, _t, seconds) => minutes.push([m - T0, seconds]) });
  assert.deepEqual(minutes, [
    [0, 30],
    [60, 60],
  ]);
  assert.equal(firstUs, (T0 + 30) * 1e6, 'later than asked: that is where its lookback starts');
});

test('fails if Jetstream hangs up before the window is read', async () => {
  const msgs = [];
  for (let k = T0 * 10; k <= (T0 + 70) * 10; k++) msgs.push(like(k * 100_000));
  await assert.rejects(replayWindow({ host: 'wss://js.example/subscribe', fromSec: T0, toSec: T0 + 120, open: fakeJetstream(msgs).open, onMinute() {} }), /closed before the window was read/);
});

test('takes whole minutes, not too close to now, not too much at once', () => {
  const now = (T0 + 3600) * 1000;
  const a = parseArgs(['--from', '2026-10-20T16:00:30Z', '--to', '2026-10-20T16:05Z', '--dry-run'], now);
  assert.deepEqual([a.fromSec, a.toSec, a.dryRun], [T0, T0 + 300, true]);
  assert.throws(() => parseArgs(['--from', '2026-10-20T16:00Z', '--to', '2026-10-20T16:00Z'], now), /after --from/);
  assert.throws(() => parseArgs(['--from', '2026-10-20T16:00Z', '--to', new Date(now - (WRITE_LAG_S - 60) * 1000).toISOString()], now), /minutes ago/);
  assert.throws(() => parseArgs(['--from', '2026-10-17T16:00Z', '--to', '2026-10-20T16:00Z'], now), /at most 48 hours/);
  assert.throws(() => parseArgs(['--from', 'yesterday'], now), /--from must be a time/);
  assert.throws(() => parseArgs(['--force'], now), /unknown argument/);
});

test('rewriting a minute replaces its app rows, then re-sums the roll-up', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace('https://db.example/rest/v1/', '')}`);
    return new Response(null, { status: 204 });
  };
  const db = supabaseReplace({ url: 'https://db.example', key: 'k', fetch });
  await db.minute({ minute: { minute: '2026-10-20T17:37:00.000Z' }, apps: [{ minute: '2026-10-20T17:37:00.000Z', domain: 'tangled.sh' }] });
  await db.rollUp('2026-10-20T17:37:00.000Z');
  assert.deepEqual(calls, [
    'POST atmosphere_minute?on_conflict=minute',
    'DELETE atmosphere_minute_app?minute=eq.2026-10-20T17%3A37%3A00.000Z',
    'POST atmosphere_minute_app?on_conflict=minute,domain',
    'POST rpc/atmosphere_roll_up_day_apps',
  ]);
});
