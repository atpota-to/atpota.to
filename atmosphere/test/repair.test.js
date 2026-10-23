import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AFTER_ABORT_MS, createRepair, gapsIn, HEALTHY_FOR_MS, LOOKBACK_S, MAX_RUN_S, MAX_TRIES, replayChild, replayCommand, runsOf } from '../src/repair.js';

const iso = (s) => new Date(s * 1000).toISOString();
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const T = Date.parse('2026-10-23T02:00:00Z');

test('gapsIn: minutes with no row or a short one; runsOf: back to back as runs', () => {
  const from = Date.parse('2026-10-22T20:00:00Z') / 1000;
  const rows = [
    { minute: '2026-10-22T20:00:00+00:00', seconds_covered: 60 },
    { minute: '2026-10-22T20:01:00+00:00', seconds_covered: 12 },
    // 20:02 has no row
    { minute: '2026-10-22T20:03:00+00:00', seconds_covered: 60 },
    { minute: '2026-10-22T20:04:00+00:00', seconds_covered: 59 },
  ];
  const gaps = gapsIn(rows, from, from + 300);
  assert.deepEqual(gaps, [from + 60, from + 120, from + 240]);
  assert.deepEqual(runsOf(gaps), [[from + 60, from + 180], [from + 240, from + 300]]);
});

/** A database of minute rows, every minute whole but `short`, which a replay fixes unless it's in `gone`. */
function setup({ short = [], gone = [], replayImpl } = {}) {
  let t = T;
  let ok = true;
  const db = new Map(short.map((m) => [m, 10]));
  const replays = [];
  const repair = createRepair({
    healthy: () => ok,
    writtenBefore: () => Math.floor(t / 60_000) * 60,
    covered: async (fromIso, toIso) => {
      const rows = [];
      for (let m = Date.parse(fromIso) / 1000; m < Date.parse(toIso) / 1000; m += 60) rows.push({ minute: iso(m), seconds_covered: db.get(m) ?? 60 });
      return rows;
    },
    replay:
      replayImpl ??
      (async ({ fromSec, toSec }) => {
        replays.push([fromSec, toSec]);
        for (let m = fromSec; m < toSec; m += 60) if (!gone.includes(m)) db.delete(m);
      }),
    log: quiet,
    now: () => t,
  });
  return {
    repair,
    replays,
    db,
    advance: (ms) => (t += ms),
    setHealthy: (v) => (ok = v),
  };
}

test('waits until the station has been healthy a while, then replays the oldest run of missed minutes', async () => {
  const gap = Math.floor((T / 1000 - 5 * 3600) / 60) * 60;
  const s = setup({ short: [gap, gap + 60, gap + 3600] });
  s.repair.tick();
  await s.repair.scan();
  assert.equal(s.replays.length, 0, 'not healthy for long enough yet');
  s.advance(HEALTHY_FOR_MS);
  await s.repair.scan();
  assert.deepEqual(s.replays, [[gap, gap + 120]]);
  assert.equal(s.repair.status.missing, 1);
  await s.repair.scan();
  assert.deepEqual(s.replays.at(-1), [gap + 3600, gap + 3660]);
  assert.equal(s.repair.status.missing, 0);
  assert.equal(s.db.size, 0);
});

test('a long run is replayed a piece at a time; nothing older than the lookback', async () => {
  const start = Math.floor((T / 1000 - 6 * 3600) / 60) * 60;
  const old = Math.floor((T / 1000 - LOOKBACK_S - 3600) / 60) * 60;
  const short = [old];
  for (let m = start; m < start + 3 * 3600; m += 60) short.push(m);
  const s = setup({ short });
  s.repair.tick();
  s.advance(HEALTHY_FOR_MS);
  await s.repair.scan();
  assert.deepEqual(s.replays, [[start, start + MAX_RUN_S]]);
});

test('a minute Jetstream no longer has is left alone after a couple of tries', async () => {
  const gap = Math.floor((T / 1000 - 3600) / 60) * 60;
  const s = setup({ short: [gap], gone: [gap] });
  s.repair.tick();
  s.advance(HEALTHY_FOR_MS);
  for (let i = 0; i < MAX_TRIES + 2; i++) await s.repair.scan();
  assert.equal(s.replays.length, MAX_TRIES);
  assert.equal(s.repair.status.missing, 0);
  assert.equal(s.repair.status.lost, 1);
});

test('stops the replay when the station falls behind, and rests before trying again', async () => {
  const gap = Math.floor((T / 1000 - 3600) / 60) * 60;
  let seen = null;
  let calls = 0;
  const s = setup({
    short: [gap],
    replayImpl: ({ signal }) =>
      new Promise((resolve, reject) => {
        calls++;
        seen = signal;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { aborted: true })));
      }),
  });
  s.repair.tick();
  s.advance(HEALTHY_FOR_MS);
  const running = s.repair.scan();
  await new Promise((r) => setImmediate(r));
  assert.ok(s.repair.status.repairing, 'says what it is repairing');
  s.setHealthy(false);
  s.repair.tick();
  await running;
  assert.equal(seen.aborted, true);
  assert.equal(s.repair.status.repairing, null);
  s.setHealthy(true);
  s.repair.tick();
  s.advance(HEALTHY_FOR_MS);
  // resting: no replay starts before AFTER_ABORT_MS
  await s.repair.scan();
  assert.equal(calls, 1);
  s.advance(AFTER_ABORT_MS);
  void s.repair.scan();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, 'and tries again after');
});

test('replayCommand: its own scope under systemd, else niced', () => {
  const [cmd, args] = replayCommand(['--from', 'x'], { INVOCATION_ID: 'abc' });
  assert.equal(cmd, 'systemd-run');
  assert.ok(args.includes('--scope') && args.includes('MemoryMax=320M'));
  assert.deepEqual(replayCommand(['--from', 'x'], {})[0], 'nice');
});

test('replayChild: SIGTERM when stopped (never SIGSTOP), and says it was stopped', async () => {
  const killed = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig) => {
      killed.push(sig);
      setImmediate(() => child.emit('close', null));
    };
    return child;
  };
  const controller = new AbortController();
  const p = replayChild({ fromSec: 0, toSec: 60, host: 'wss://js.example/subscribe', signal: controller.signal, log: quiet, spawnImpl });
  controller.abort();
  await assert.rejects(p, (err) => err.aborted === true);
  assert.deepEqual(killed, ['SIGTERM']);
});

test('replayChild: a failed replay rejects with its last words', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.emit('data', 'jetstream went quiet for 30 s\n');
      child.emit('close', 1);
    });
    return child;
  };
  await assert.rejects(replayChild({ fromSec: 0, toSec: 60, host: 'wss://x', log: quiet, spawnImpl }), /exited 1: jetstream went quiet/);
});
