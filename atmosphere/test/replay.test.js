// Recounting minutes from Jetstream's history: the 17:37 pause, partial minutes, hang-ups, arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REWIND_US } from '../src/jetstream.js';
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

/** A Jetstream that replays `messages` from the cursor it's asked for, hanging up after `perConnection` of them. */
function fakeJetstream(messages, { perConnection = Infinity } = {}) {
  const asked = [];
  const open = (url) => {
    asked.push(url);
    const cursor = Number(new URL(url).searchParams.get('cursor'));
    const sock = { close() {} };
    queueMicrotask(() => {
      sock.onopen?.();
      let sent = 0;
      for (const m of messages) if (JSON.parse(m).time_us >= cursor && sent++ < perConnection) sock.onmessage?.({ data: m });
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

test('picks the replay back up when Jetstream hangs up partway, counting nothing twice', async () => {
  const msgs = [];
  for (let k = (T0 - 10) * 10; k <= (T0 + 300) * 10; k++) msgs.push(like(k * 100_000));
  // Bluesky's hosts hang up on a long replay; this one every 40 seconds of stream
  const net = fakeJetstream(msgs, { perConnection: 400 });
  const minutes = [];
  const resumed = [];
  await replayWindow({
    host: 'wss://js.example/subscribe',
    fromSec: T0,
    toSec: T0 + 180,
    open: net.open,
    resumeDelayMs: 0,
    onResume: (r) => resumed.push(r),
    onMinute: (m, tally, seconds) => minutes.push([m - T0, seconds, tally.creates.get('app.bsky.feed.like')]),
  });
  assert.deepEqual(minutes, [
    [0, 60, 600],
    [60, 60, 600],
    [120, 60, 600],
  ]);
  assert.ok(resumed.length >= 4, `resumed ${resumed.length} times`);
  // each pick-up asks for a little before the last event it got
  for (let i = 1; i < net.asked.length; i++) {
    const cursor = Number(new URL(net.asked[i]).searchParams.get('cursor'));
    assert.equal(cursor, resumed[i - 1].atUs - REWIND_US);
  }
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
    'DELETE atmosphere_minute_app?minute=in.(2026-10-20T17%3A37%3A00.000Z)',
    'POST atmosphere_minute_app?on_conflict=minute,domain',
    'POST rpc/atmosphere_roll_up_hour_apps',
    'POST rpc/atmosphere_roll_up_day_apps',
  ]);
});

test('minutes whose app rows fail to write are deleted again, so a rerun writes them whole', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const call = `${init.method} ${url.replace('https://db.example/rest/v1/', '')}`;
    calls.push(call);
    return call.startsWith('POST atmosphere_minute_app') ? new Response('bad domain', { status: 400 }) : new Response(null, { status: 204 });
  };
  const db = supabaseReplace({ url: 'https://db.example', key: 'k', fetch });
  await assert.rejects(db.minute({ minute: { minute: '2026-10-18T16:00:00.000Z' }, apps: [{ minute: '2026-10-18T16:00:00.000Z', domain: 'tangled.sh' }] }), /HTTP 400/);
  assert.deepEqual(calls, [
    'POST atmosphere_minute?on_conflict=minute',
    'DELETE atmosphere_minute_app?minute=in.(2026-10-18T16%3A00%3A00.000Z)',
    'POST atmosphere_minute_app?on_conflict=minute,domain',
    'DELETE atmosphere_minute?minute=in.(2026-10-18T16%3A00%3A00.000Z)',
  ]);
});

test('a replayed minute carries its active accounts, so rewriting its app rows keeps them', async () => {
  const { minuteRows } = await import('../src/writer.js');
  const msgs = [];
  for (let t = T0 - 6; t <= T0 + 130; t += 0.5) {
    const i = Math.round(t * 2);
    msgs.push(JSON.stringify({ did: `did:plc:r${i % 9}`, time_us: Math.round(t * 1e6), kind: 'commit', commit: { operation: 'create', collection: i % 3 ? 'app.bsky.feed.like' : 'sh.tangled.feed.star', rkey: 'x' } }));
  }
  const rows = [];
  await replayWindow({ host: 'wss://js.example/subscribe', fromSec: T0, toSec: T0 + 60, open: fakeJetstream(msgs).open, onMinute: (m, tally, seconds, accounts) => rows.push(minuteRows(m, tally, seconds, accounts)) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minute.dids, 9);
  assert.deepEqual(rows[0].apps.map((a) => [a.domain, a.dids]), [['tangled.sh', 3]]);
});
