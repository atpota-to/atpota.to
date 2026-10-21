// Settling flowers: the trusted planting time, waiting for the weather, species from the
// shared rules, and the grown week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowerSeed, pickSpecies, plantingWeather, RULE_VERSION, seasonOf, WEEK, weekWeather } from '../../website/shared/garden-rules.js';
import { createSettler, GROW_MS, grownValues, tidTime, trustedPlantedAt } from '../src/settle.js';

const quiet = { info() {}, warn() {}, error() {} };
const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const MIN = 60_000;
const PLANTED = Date.parse('2026-10-20T22:48:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** A TID for a time (ms), clock id 0. */
function tid(ms) {
  const S32 = '234567abcdefghijklmnopqrstuvwxyz';
  let n = BigInt(ms) * 1000n << 10n;
  let s = '';
  for (let i = 0; i < 13; i++) {
    s = S32[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

const RKEY = tid(PLANTED);
const unsettled = (extra = {}) => ({
  uri: `at://${DID}/to.atpota.garden.sprout/${RKEY}`,
  did: DID,
  rkey: RKEY,
  kind: 'seed',
  created_at: iso(PLANTED).replace('.000Z', '+00:00'),
  first_seen_at: iso(PLANTED + 1500).replace('Z', '+00:00'),
  season: 'autumn',
  settled: false,
  planted_at: null,
  ...extra,
});

// a stormy, very mixed minute, against plenty of history
const MINUTE = { minute: '2026-10-20T22:48:00+00:00', seconds: 60, creates: 40_000, elsewhere: 900, history: 43_000, rank: 0.995 };

function harness({ rows, minute = MINUTE, week = null, now, failOn = null }) {
  const calls = [];
  const clock = { ms: now };
  const settler = createSettler({
    log: quiet,
    now: () => clock.ms,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (failOn === name) throw Object.assign(new Error(`${name}: HTTP 500`), { status: 500 });
      if (name === 'garden_unsettled') return rows;
      if (name === 'garden_minute_weather') return typeof minute === 'function' ? minute(args) : minute;
      if (name === 'garden_week_weather') return week;
      throw new Error(name);
    },
    upsert: async (table, conflict, values) => calls.push({ name: 'upsert', table, conflict, values }),
    patch: async (table, query, values) => calls.push({ name: 'patch', table, query, values }),
  });
  return { settler, calls, clock, upserts: () => calls.filter((c) => c.name === 'upsert'), patches: () => calls.filter((c) => c.name === 'patch') };
}

test('the TID time of a record key (website/server/garden.ts tidTime)', () => {
  assert.equal(tidTime('3l6ui4ihq3c2k'), Date.parse('2024-10-19T12:25:46.684Z'));
  assert.equal(tidTime(tid(PLANTED)), PLANTED);
  assert.equal(tidTime('self'), null);
  assert.equal(tidTime('zzzzzzzzzzzzz'), null, 'the top bit must be zero');
});

test('the planting time the garden trusts', () => {
  const seen = '2026-10-20T22:48:01.500+00:00';
  // createdAt within 10 minutes of when Jetstream relayed it: createdAt
  assert.equal(trustedPlantedAt({ created_at: '2026-10-20T22:45:00+00:00', first_seen_at: seen, rkey: RKEY }), Date.parse('2026-10-20T22:45:00Z'));
  // backdated (or postdated) by more than 10 minutes: when Jetstream relayed it
  assert.equal(trustedPlantedAt({ created_at: '2026-10-01T00:00:00+00:00', first_seen_at: seen, rkey: RKEY }), Date.parse(seen));
  assert.equal(trustedPlantedAt({ created_at: '2027-01-01T00:00:00+00:00', first_seen_at: seen, rkey: RKEY }), Date.parse(seen));
  // no createdAt: when relayed
  assert.equal(trustedPlantedAt({ created_at: null, first_seen_at: seen, rkey: RKEY }), Date.parse(seen));
  // found by a backfill (never relayed): createdAt
  assert.equal(trustedPlantedAt({ created_at: '2026-10-01T00:00:00+00:00', first_seen_at: null, rkey: RKEY }), Date.parse('2026-10-01T00:00:00Z'));
  // neither: the record key
  assert.equal(trustedPlantedAt({ created_at: null, first_seen_at: null, rkey: RKEY }), PLANTED);
  assert.equal(trustedPlantedAt({ created_at: 'nope', first_seen_at: undefined, rkey: 'self' }), null);
});

test('under 3 minutes after planting, it waits', async () => {
  const h = harness({ rows: [unsettled()], now: PLANTED + 2 * MIN });
  await h.settler.tick();
  assert.deepEqual(h.calls.map((c) => c.name), ['garden_unsettled']);
  assert.equal(h.settler.counts.waiting, 1);
});

test('a seed grows into what the shared rules say, from its seed, season and planting weather', async () => {
  const h = harness({ rows: [unsettled()], now: PLANTED + 3 * MIN });
  await h.settler.tick();
  const minuteCall = h.calls.find((c) => c.name === 'garden_minute_weather');
  assert.deepEqual(minuteCall.args, { p_at: iso(PLANTED) });
  const weather = plantingWeather(MINUTE);
  assert.deepEqual(weather, { wind: 4, mix: 4 });
  const [up] = h.upserts();
  assert.equal(up.table, 'garden_growth');
  assert.equal(up.conflict, 'sprout_uri');
  assert.deepEqual(up.values, [
    {
      sprout_uri: unsettled().uri,
      planted_at: iso(PLANTED),
      species: pickSpecies(flowerSeed(DID, RKEY), 'autumn', weather),
      plant_wind: 4,
      plant_mix: 4,
      rule_version: RULE_VERSION,
    },
  ]);
  assert.equal(h.patches().length, 0, 'not grown yet');
});

test('the weather numbers may come back as strings; they are coerced', async () => {
  const stringy = Object.fromEntries(Object.entries(MINUTE).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
  const h = harness({ rows: [unsettled()], minute: stringy, now: PLANTED + 3 * MIN });
  await h.settler.tick();
  assert.equal(h.upserts()[0].values[0].plant_wind, 4);
  assert.equal(h.upserts()[0].values[0].plant_mix, 4);
});

test('no reading for the minute: it waits up to 30 minutes, then settles with no weather', async () => {
  const h = harness({ rows: [unsettled()], minute: null, now: PLANTED + 29 * MIN });
  await h.settler.tick();
  assert.equal(h.upserts().length, 0);
  h.clock.ms = PLANTED + 30 * MIN;
  await h.settler.tick();
  const [row] = h.upserts()[0].values;
  assert.equal(row.plant_wind, null);
  assert.equal(row.plant_mix, null);
  assert.equal(row.species, pickSpecies(flowerSeed(DID, RKEY), 'autumn', null));
});

test('the season is the patch\'s, else the planting date\'s', async () => {
  const winter = harness({ rows: [unsettled({ season: 'winter' })], now: PLANTED + 3 * MIN });
  await winter.settler.tick();
  assert.equal(winter.upserts()[0].values[0].species, pickSpecies(flowerSeed(DID, RKEY), 'winter', { wind: 4, mix: 4 }));
  for (const season of [null, 'monsoon']) {
    const h = harness({ rows: [unsettled({ season })], now: PLANTED + 3 * MIN });
    await h.settler.tick();
    assert.equal(seasonOf(PLANTED), 'autumn');
    assert.equal(h.upserts()[0].values[0].species, pickSpecies(flowerSeed(DID, RKEY), 'autumn', { wind: 4, mix: 4 }));
  }
  // across seeds, the season really decides: some differ between winter and summer
  const differs = Array.from({ length: 200 }, (_, i) => flowerSeed(DID, `k${i}`)).some((s) => pickSpecies(s, 'winter', null) !== pickSpecies(s, 'summer', null));
  assert.ok(differs);
});

test('a seed whose patch isn\'t indexed yet waits for it (its season), up to 30 minutes', async () => {
  const early = harness({ rows: [unsettled({ season: null, patch_indexed: false })], now: PLANTED + 10 * MIN });
  await early.settler.tick();
  assert.equal(early.upserts().length, 0);
  assert.equal(early.settler.counts.waiting, 1);
  const late = harness({ rows: [unsettled({ season: null, patch_indexed: false })], now: PLANTED + 31 * MIN });
  await late.settler.tick();
  assert.equal(late.upserts().length, 1);
  // a kind its planter picked doesn't need a season
  const picked = harness({ rows: [unsettled({ kind: 'rose', season: null, patch_indexed: false })], now: PLANTED + 10 * MIN });
  await picked.settler.tick();
  assert.equal(picked.upserts()[0].values[0].species, 'rose');
});

test('a kind its planter picked stays what it is', async () => {
  const h = harness({ rows: [unsettled({ kind: 'tulip' }), unsettled({ uri: 'at://x/y/z', kind: 'k'.repeat(80) })], now: PLANTED + 3 * MIN });
  await h.settler.tick();
  assert.equal(h.upserts()[0].values[0].species, 'tulip');
  assert.equal(h.upserts()[0].values[0].plant_wind, 4, 'its planting weather is still kept');
  assert.equal(h.upserts()[1].values[0].species, 'k'.repeat(64));
});

const hour = (i, perSecond, elsewhereShare) => ({ hour: iso(PLANTED + i * 3600_000), seconds: 3600, creates: perSecond * 3600, elsewhere: Math.round(perSecond * 3600 * elsewhereShare) });
const WEEK_ANSWER = {
  hours: Array.from({ length: 168 }, (_, i) => hour(i, i < 10 ? 650 : 450, i % 2 ? 0.05 : 0.01)),
  history: 700,
  threshold: 0.03,
  apps: ['tangled.sh', 'whtwnd.com', 'Not An App', 'a.b.c', 'smokesignal.events', 'frontpage.fyi', 'bsky.app', 'pckt.blog', 'leaflet.pub', 'grain.social'],
};

test('grown: seven days and ten minutes on, the week\'s weather and its busiest apps', async () => {
  const row = unsettled({ settled: true, planted_at: iso(PLANTED).replace('.000Z', '+00:00') });
  const h = harness({ rows: [row], week: WEEK_ANSWER, now: PLANTED + GROW_MS - 1 });
  await h.settler.tick();
  assert.equal(h.patches().length, 0, 'not yet');
  h.clock.ms = PLANTED + GROW_MS;
  await h.settler.tick();
  const week = h.calls.find((c) => c.name === 'garden_week_weather');
  assert.deepEqual(week.args, { p_from: iso(PLANTED), p_quantile: WEEK.mixedQuantile });
  const [p] = h.patches();
  assert.equal(p.table, 'garden_growth');
  assert.equal(p.query, `sprout_uri=eq.${encodeURIComponent(row.uri)}`);
  const expected = weekWeather(WEEK_ANSWER.hours, 0.03);
  assert.deepEqual(expected, { wind: 4, mix: 2 }, 'ten stormy hours; half the hours more mixed than usual');
  assert.deepEqual(p.values, {
    grown: true,
    grow_wind: expected.wind,
    grow_mix: expected.mix,
    grow_apps: ['tangled.sh', 'whtwnd.com', 'smokesignal.events', 'frontpage.fyi', 'bsky.app', 'pckt.blog', 'leaflet.pub'],
    grown_at: iso(PLANTED + GROW_MS),
  });
  assert.equal(h.upserts().length, 0, 'already settled');
});

test('a week with too little history ranks no sky; a week the station barely heard has no weather and no apps', () => {
  const thin = grownValues({ ...WEEK_ANSWER, history: 23 });
  assert.equal(thin.grow_mix, weekWeather(WEEK_ANSWER.hours, null).mix);
  assert.equal(thin.grow_mix, 1);
  const unheard = grownValues({ hours: WEEK_ANSWER.hours.slice(0, 10).map((h) => ({ ...h, seconds: String(h.seconds), creates: String(h.creates) })), history: 700, threshold: 0.03, apps: ['tangled.sh'] });
  assert.deepEqual(unheard, { grown: true, grow_wind: null, grow_mix: null, grow_apps: [] });
});

test('a flower found long after it was planted settles and grows in one pass', async () => {
  const row = unsettled({ first_seen_at: null, created_at: iso(PLANTED) });
  const h = harness({ rows: [row], minute: null, week: WEEK_ANSWER, now: PLANTED + 30 * 86_400_000 });
  await h.settler.tick();
  assert.equal(h.upserts().length, 1);
  assert.equal(h.patches().length, 1);
});

test('waits for the first reconcile before settling anything', async () => {
  const calls = [];
  const settler = createSettler({ rpc: async (n) => calls.push(n), upsert: async () => {}, patch: async () => {}, log: quiet, ready: () => false });
  await settler.tick();
  assert.deepEqual(calls, []);
});

test('one row failing does not stop the rest; Supabase being down ends the pass', async () => {
  const rows = [unsettled({ uri: 'at://a/b/1' }), unsettled({ uri: 'at://a/b/2' })];
  let n = 0;
  const h = harness({
    rows,
    now: PLANTED + 3 * MIN,
    minute: () => {
      if (n++ === 0) throw Object.assign(new Error('HTTP 400'), { status: 400 });
      return MINUTE;
    },
  });
  await h.settler.tick();
  assert.equal(h.upserts().length, 1);
  assert.equal(h.settler.counts.failed, 1);
  const down = harness({ rows, now: PLANTED + 3 * MIN, failOn: 'garden_minute_weather' });
  await down.settler.tick();
  assert.equal(down.calls.filter((c) => c.name === 'garden_minute_weather').length, 1);
});
