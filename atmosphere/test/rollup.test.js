// Account rollups: which hour, day and month a minute is in, merging once, and letting go of a period.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerOf, Sketch } from '../src/hll.js';
import { createRollup, fromBytea, mergeMinute, periodEnd, periodStart, toBytea } from '../src/rollup.js';

const at = (s) => Date.parse(s) / 1000;
const iso = (sec) => new Date(sec * 1000).toISOString();

test('periods are UTC hours, days and months', () => {
  const m = at('2026-12-31T23:59:00Z');
  assert.equal(iso(periodStart('minute', m + 30)), '2026-12-31T23:59:00.000Z');
  assert.equal(iso(periodStart('hour', m)), '2026-12-31T23:00:00.000Z');
  assert.equal(iso(periodStart('day', m)), '2026-12-31T00:00:00.000Z');
  assert.equal(iso(periodStart('month', m)), '2026-12-01T00:00:00.000Z');
  assert.equal(iso(periodEnd('month', periodStart('month', m))), '2027-01-01T00:00:00.000Z');
  assert.equal(iso(periodEnd('month', at('2027-02-01T00:00:00Z'))), '2027-03-01T00:00:00.000Z');
  assert.equal(iso(periodEnd('day', at('2026-10-20T00:00:00Z'))), '2026-10-21T00:00:00.000Z');
});

test('sketches go to PostgREST as bytea and come back the same', () => {
  const s = new Sketch().add(registerOf('did:plc:a')).add(registerOf('did:plc:b'));
  const text = toBytea(s.encode());
  assert.match(text, /^\\x020c[0-9a-f]{12}$/);
  assert.deepEqual(fromBytea(text).registers, s.registers);
  assert.throws(() => fromBytea('020c'), /not bytea/);
});

const minute = (m, dids, apps = {}) => ({
  minute: m,
  seconds: 60,
  bluesky: new Sketch().addAll(dids.map(registerOf)),
  elsewhere: new Sketch().addAll(Object.values(apps).flat().map(registerOf)),
  apps: new Map(Object.entries(apps).map(([d, ids]) => [d, new Sketch().addAll(ids.map(registerOf))])),
});

test('a minute merges into a period once', () => {
  const e = { period: 'hour', t: 0, through: null, seconds: 0, bluesky: new Sketch(), elsewhere: new Sketch(), apps: new Map(), dirty: false, dirtyApps: new Set() };
  assert.equal(mergeMinute(e, minute(60, ['did:plc:a'], { 'tangled.sh': ['did:plc:t'] })), true);
  assert.equal(mergeMinute(e, minute(60, ['did:plc:a'])), false);
  assert.equal(mergeMinute(e, minute(0, ['did:plc:z'])), false, 'nor one before it');
  assert.deepEqual([e.seconds, e.through, e.bluesky.estimate(), e.apps.get('tangled.sh').estimate(), [...e.dirtyApps]], [60, 60, 1, 1, ['tangled.sh']]);
});

test('a period that ends unwritten is written before the next one starts', async () => {
  const posted = [];
  const rest = {
    getAll: async () => [],
    upsert: async (table, conflict, rows) => posted.push(...rows.map((r) => [table, r.period, r.t, r.seconds ?? r.dids])),
  };
  const rollup = createRollup({ rest });
  // 16:57 and 16:58 (no flush: not fifth minutes), then 16:59 is never heard, then 17:00
  await rollup.add(minute(at('2026-10-20T16:57:00Z'), ['did:plc:a']));
  await rollup.add(minute(at('2026-10-20T16:58:00Z'), ['did:plc:b'], { 'tangled.sh': ['did:plc:t'] }));
  assert.deepEqual(posted, []);
  await rollup.add(minute(at('2026-10-20T17:00:00Z'), ['did:plc:c']));
  assert.deepEqual(posted, [
    ['atmosphere_account_app_sketch', 'hour', '2026-10-20T16:00:00.000Z', 1],
    ['atmosphere_account_sketch', 'hour', '2026-10-20T16:00:00.000Z', 120],
  ]);
  assert.equal(rollup.entries.get('hour').t, at('2026-10-20T17:00:00Z'));
  assert.equal(rollup.entries.get('day').seconds, 180);
});

test('a failed load is retried, never written over', async () => {
  let fail = true;
  const posted = [];
  const rest = {
    getAll: async () => {
      if (fail) throw new Error('supabase down');
      return [];
    },
    upsert: async (table, conflict, rows) => posted.push(...rows),
  };
  const rollup = createRollup({ rest });
  const m = minute(at('2026-10-20T16:04:00Z'), ['did:plc:a']);
  await assert.rejects(rollup.add(m), /supabase down/);
  assert.deepEqual(posted, []);
  fail = false;
  await rollup.add(m);
  assert.deepEqual(posted.filter((r) => r.period === 'hour').map((r) => r.seconds), [60]);
});
