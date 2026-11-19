import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfillActivity, CHECK_EVERY_MS, countDays, directoryFor, parseArgs, RESUME_AFTER_MS, stationBehind } from '../src/backfill-host-activity.js';
import { ActivityDay, ALL_INDEPENDENT, HostDirectory } from '../src/host-activity.js';
import { registerOf } from '../src/hll.js';

const NOW = Date.parse('2026-10-22T16:40:00Z');
const at = (iso) => `${iso.replace('Z', '')}.000000Z`;
/** An archive event as the SDK hands it over (raw). */
const commit = (did, iso) => ({ did, kind: 'commit', time: at(iso), commit: { operation: 'create', collection: 'app.bsky.feed.post', rev: 'r' } });

function directory() {
  const d = new HostDirectory();
  d.place('did:plc:euro1', 'eurosky.social');
  d.place('did:plc:euro2', 'eurosky.social');
  d.place('did:plc:black', 'blacksky.app');
  d.readAt = NOW;
  return d;
}

async function* stream(list) {
  for (const e of list) yield e;
}

test('parseArgs: whole UTC days before today, at most a month', () => {
  assert.deepEqual(parseArgs(['--from', '2026-10-20', '--to', '2026-10-21'], NOW).days, ['2026-10-20', '2026-10-21']);
  assert.equal(parseArgs(['--from', '2026-10-21', '--to', '2026-10-21', '--dry-run'], NOW).dryRun, true);
  assert.deepEqual(parseArgs(['--from', '2026-10-21', '--to', '2026-10-22'], NOW).days, ['2026-10-21', '2026-10-22'], 'today, as far as the archive goes');
  assert.throws(() => parseArgs(['--from', '2026-10-21', '--to', '2026-10-23'], NOW), /not be after today/);
  assert.throws(() => parseArgs(['--from', '2026-10-21', '--to', '2026-10-20'], NOW), /not be before/);
  assert.throws(() => parseArgs(['--from', '2026-10-21T00:00Z', '--to', '2026-10-21'], NOW), /must be days/);
  assert.throws(() => parseArgs(['--from', '2026-08-01', '--to', '2026-10-21'], NOW), /at most 31 days/);
  assert.throws(() => parseArgs(['--nope'], NOW), /unknown argument/);
});

test('countDays: counts each day\'s commits by accounts on independent hosts, hands each day over once it has settled', async () => {
  const handed = [];
  const read = await countDays({
    days: ['2026-10-20', '2026-10-21'],
    directory: directory(),
    events: stream([
      commit('did:plc:euro1', '2026-10-19T23:59:00Z'), // before the window
      commit('did:plc:euro1', '2026-10-20T01:00:00Z'),
      commit('did:plc:euro1', '2026-10-20T02:00:00Z'), // the same account again
      commit('did:plc:bsky', '2026-10-20T03:00:00Z'), // on Bluesky's hosts
      { did: 'did:plc:black', kind: 'identity', time: at('2026-10-20T04:00:00Z') },
      commit('did:plc:black', '2026-10-21T00:00:30Z'),
      commit('did:plc:euro2', '2026-10-20T23:59:50Z'), // a little late: still the 20th's
      commit('did:plc:euro2', '2026-10-21T00:03:00Z'), // the 20th has settled by now
      commit('did:plc:euro1', '2026-10-22T00:03:00Z'), // past the window: stop
      commit('did:plc:euro1', '2026-10-22T00:04:00Z'),
    ]),
    onDay: async (d) => handed.push([d.day, d.rows().map((r) => [r.hostname, r.dids])]),
  });
  assert.deepEqual(handed, [
    ['2026-10-20', [[ALL_INDEPENDENT, 2], ['eurosky.social', 2]]],
    ['2026-10-21', [[ALL_INDEPENDENT, 2], ['blacksky.app', 1], ['eurosky.social', 1]]],
  ]);
  assert.equal(read.events, 9, 'stops reading once the last day has settled');
  assert.equal(read.counted, 5);
});

test('directoryFor: the station\'s saved directory', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dir-')), 'host-directory.json');
  fs.writeFileSync(file, JSON.stringify(directory()));
  const d = await directoryFor({ file, log: () => {}, fetchImpl: async () => assert.fail('no reading with a saved directory') });
  assert.equal(d.hostOf('did:plc:black'), 'blacksky.app');
});

test('backfillActivity: reads the archive\'s segments for the days, merges with rows already there, writes each day', async () => {
  const DAY_US = 86_400e6;
  const from = Date.parse('2026-10-20T00:00:00Z') * 1000;
  const segments = [{ name: 's0', index: 0, sizeBytes: 1e9, eventCount: 1000, minSeq: 1, maxSeq: 1000, minWitnessedAt: from - DAY_US, maxWitnessedAt: from + 2 * DAY_US }];
  const fetch = async () => Response.json({ segments });
  let asked = null;
  class Jetstream {
    snapshot(opts) {
      asked = opts;
      return stream([commit('did:plc:euro1', '2026-10-20T01:00:00Z'), commit('did:plc:euro1', '2026-10-21T00:05:00Z')]);
    }
  }
  // an earlier run already wrote blacksky.app for the 20th
  const before = new ActivityDay('2026-10-20');
  before.add('blacksky.app', registerOf('did:plc:black'));
  const upserts = [];
  const rest = { getAll: async () => before.rows(), upsert: async (table, conflict, rows) => upserts.push({ table, conflict, rows }) };
  const out = await backfillActivity({ args: parseArgs(['--from', '2026-10-20', '--to', '2026-10-20'], NOW), host: 'https://js.example', apiKey: 'k', rest, Jetstream, directory: directory(), fetch, log: () => {}, warn: () => {}, now: () => NOW });
  assert.equal(asked.raw, true);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].table, 'atmosphere_host_active_day');
  assert.deepEqual(upserts[0].rows.map((r) => [r.hostname, r.dids]).sort(), [[ALL_INDEPENDENT, 2], ['blacksky.app', 1], ['eurosky.social', 1]]);
  assert.deepEqual(out.written, [{ day: '2026-10-20', independent: 2, hosts: 2 }]);
});

test('backfillActivity: a dry run writes nothing, and a day the archive never reached is an error', async () => {
  const from = Date.parse('2026-10-20T00:00:00Z') * 1000;
  const segments = [{ name: 's0', index: 0, sizeBytes: 1e9, eventCount: 1000, minSeq: 1, maxSeq: 1000, minWitnessedAt: from - 86_400e6, maxWitnessedAt: from + 3 * 86_400e6 }];
  class Jetstream {
    snapshot() {
      return stream([commit('did:plc:euro1', '2026-10-20T01:00:00Z')]);
    }
  }
  await assert.rejects(
    backfillActivity({ args: parseArgs(['--from', '2026-10-20', '--to', '2026-10-21'], NOW), host: 'https://js.example', apiKey: 'k', rest: null, Jetstream, directory: directory(), fetch: async () => Response.json({ segments }), log: () => {}, warn: () => {}, now: () => NOW }),
    /ran out before 2026-10-21/,
  );
});

test('backfillActivity: today, as far as the archive goes, written again after the station\'s next write', async () => {
  const today = Date.parse('2026-10-22T00:00:00Z') * 1000;
  // the archive's last sealed segment ends at 15:00 today
  const segments = [{ name: 's0', index: 0, sizeBytes: 1e9, eventCount: 1000, minSeq: 1, maxSeq: 1000, minWitnessedAt: today - 86_400e6, maxWitnessedAt: today + 15 * 3600e6 }];
  class Jetstream {
    snapshot() {
      return stream([commit('did:plc:euro1', '2026-10-22T06:00:00Z'), commit('did:plc:black', '2026-10-22T14:00:00Z')]);
    }
  }
  const db = [];
  const station = new ActivityDay('2026-10-22');
  station.add('eurosky.social', registerOf('did:plc:euro2')); // what the station heard this afternoon
  db.push(...station.rows());
  const rest = {
    getAll: async () => db.slice(),
    upsert: async (table, conflict, rows) => {
      for (const r of rows) {
        const i = db.findIndex((x) => x.day === r.day && x.hostname === r.hostname);
        if (i >= 0) db[i] = r;
        else db.push(r);
      }
    },
  };
  const slept = [];
  const said = [];
  await backfillActivity({
    args: parseArgs(['--from', '2026-10-22', '--to', '2026-10-22'], NOW), host: 'https://js.example', apiKey: 'k', rest, Jetstream, directory: directory(),
    fetch: async () => Response.json({ segments }), log: (m) => said.push(m), warn: () => {}, now: () => NOW,
    // the station's next write crosses the backfill's and drops the morning
    sleep: async (ms) => {
      slept.push(ms);
      db.splice(0, db.length, ...station.rows());
    },
  });
  assert.match(said.join('\n'), /today is counted up to 2026-10-22T14:58:54/);
  assert.equal(slept.length, 1);
  assert.equal(db.find((r) => r.hostname === ALL_INDEPENDENT).dids, 3, 'the morning and the afternoon, both');
});

test('backfillActivity: today is refused while the archive hasn\'t reached it', async () => {
  const segments = [{ name: 's0', index: 0, sizeBytes: 1e9, eventCount: 1000, minSeq: 1, maxSeq: 1000, minWitnessedAt: Date.parse('2026-10-21T00:00:00Z') * 1000, maxWitnessedAt: Date.parse('2026-10-21T23:59:00Z') * 1000 }];
  await assert.rejects(
    backfillActivity({ args: parseArgs(['--from', '2026-10-22', '--to', '2026-10-22'], NOW), host: 'https://js.example', apiKey: 'k', rest: null, Jetstream: class {}, directory: directory(), fetch: async () => Response.json({ segments }), log: () => {}, warn: () => {}, now: () => NOW }),
    /doesn't reach today yet/,
  );
});

test('countDays: leaves out a short dense stretch', async () => {
  const handed = [];
  const skip = [[Date.parse('2026-10-20T16:27:00Z') * 1000, Date.parse('2026-10-20T16:31:00Z') * 1000, 7571]];
  const read = await countDays({
    days: ['2026-10-20'],
    directory: directory(),
    skip,
    events: stream([commit('did:plc:euro1', '2026-10-20T10:00:00Z'), commit('did:plc:black', '2026-10-20T16:29:00Z')]),
    onDay: async (d) => handed.push(d.rows().map((r) => [r.hostname, r.dids])),
  });
  assert.deepEqual(handed, [[[ALL_INDEPENDENT, 1], ['eurosky.social', 1]]]);
  assert.equal(read.skipped, 1);
});

test('stationBehind: a reason when the station says it is behind, nothing when it keeps up or isn\'t there', async () => {
  assert.equal(await stationBehind(async () => Response.json({ ok: true }), 'http://x/healthz'), null);
  assert.equal(await stationBehind(async () => Response.json({ ok: false, connected: true, lagSeconds: 42, covered60: 18 }, { status: 503 }), 'http://x/healthz'), 'lag 42 s, 18 of 60 s heard');
  assert.equal(await stationBehind(async () => Response.json({ ok: false, connected: false }, { status: 503 }), 'http://x/healthz'), 'disconnected');
  assert.equal(await stationBehind(async () => { throw new Error('ECONNREFUSED'); }, 'http://x/healthz'), null);
});

test('backfillActivity: steps aside while the station is behind, closing its download, then picks up a segment back', async () => {
  const day = Date.parse('2026-10-20T00:00:00Z') * 1000;
  const H = 3600e6;
  // three segments of the 20th, then one past it
  const segments = [0, 1, 2, 3].map((i) => ({ name: `s${i}`, index: i, sizeBytes: 1e9, eventCount: 1000, minSeq: i * 100 + 1, maxSeq: i * 100 + 100, minWitnessedAt: day + (i === 0 ? -H : i * 8 * H), maxWitnessedAt: day + (i === 3 ? 26 * H : (i + 1) * 8 * H) }));
  const events = [
    [1, commit('did:plc:euro1', '2026-10-20T01:00:00Z')],
    [101, commit('did:plc:euro2', '2026-10-20T09:00:00Z')],
    [201, commit('did:plc:black', '2026-10-20T17:00:00Z')],
    [301, commit('did:plc:euro1', '2026-10-21T00:05:00Z')],
  ];
  const asked = [];
  let closed = 0;
  const aborted = [];
  class Jetstream {
    snapshot({ afterSeq, signal }) {
      asked.push(afterSeq);
      return (async function* () {
        try {
          for (const [seq, e] of events) if (seq > afterSeq) yield e;
        } finally {
          // as the SDK does: closed early without an abort, it finishes its downloads first
          aborted.push(signal.aborted);
          closed++;
        }
      })();
    }
  }
  // the clock moves a check's worth on every look; the station is behind at the second check, then fine
  let t = NOW;
  const now = () => (t += CHECK_EVERY_MS / 2);
  let checks = 0;
  const behind = async () => (++checks === 2 ? 'lag 42 s, 18 of 60 s heard' : null);
  const said = [];
  const slept = [];
  const upserts = [];
  const rest = { getAll: async () => [], upsert: async (table, conflict, rows) => upserts.push(rows) };
  const out = await backfillActivity({
    args: parseArgs(['--from', '2026-10-20', '--to', '2026-10-20'], NOW), host: 'https://js.example', apiKey: 'k', rest, Jetstream, directory: directory(),
    fetch: async () => Response.json({ segments }), log: (m) => said.push(m), warn: () => {}, now, sleep: async (ms) => slept.push(ms), behind,
  });
  assert.match(said.join('\n'), /fallen behind \(lag 42 s/);
  assert.match(said.join('\n'), /picking up again at segment #1/);
  assert.deepEqual(asked, [0, 100], "read again from the segment before where it stopped");
  assert.equal(closed, 2, 'the first download was closed when it stepped aside');
  assert.deepEqual(aborted, [true, false], 'the snapshot it stepped aside from was aborted, so its downloads were dropped');
  assert.ok(slept.reduce((a, b) => a + b, 0) >= RESUME_AFTER_MS);
  assert.equal(upserts.length, 1, 'the day is written once');
  assert.deepEqual(out.written, [{ day: '2026-10-20', independent: 3, hosts: 2 }]);
});
