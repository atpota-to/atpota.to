// settle.js
// Works out, once, what each flower grew into and the weather it grew in, with the shared
// rules (website/shared/garden-rules.js), and stores it in garden_growth. Every
// SETTLE_SECONDS it asks garden_unsettled for the flowers with something left to settle,
// oldest first, and for each:
//
//  (a) Planted. Its planting time is the one the garden trusts: when Jetstream first
//      relayed it, if its own createdAt is missing or more than 10 minutes off from that;
//      else createdAt; else the time in its TID record key. Three minutes after planting
//      (the station writes a minute about a minute and a quarter after it ends), the
//      station's reading for that minute (garden_minute_weather) gives the weather it was
//      planted in. With no reading yet it waits, up to 30 minutes after planting, in case
//      the station is behind; then it settles with no weather. A seed grows into a species
//      from its own seed, its patch's season (or the planting date's) and that weather; a
//      kind its planter picked stays what it is.
//  (b) Grown. Seven days and ten minutes after planting, the seven days' hours
//      (garden_week_weather) give the weather it grew in, and the busiest apps outside
//      Bluesky while it grew.
//
// A flower can do both in one pass (one found by a reconcile, planted weeks ago). What's
// settled stays settled: a new rule is a new RULE_VERSION, stored beside each flower.
// A row that fails is logged and comes back next pass; Supabase being down ends the pass.
//
// It waits for the first reconcile to finish before settling anything, so a seed found by
// that first pass is settled once its patch (and the patch's season) is in the index too.

import { flowerSeed, pickSpecies, plantingWeather, RULE_VERSION, seasonOf, SEASONS, SEED, WEEK, weekWeather } from '../../website/shared/garden-rules.js';

export const BATCH = 100;
export const PLANT_WAIT_MS = 3 * 60_000;
export const WEATHER_WAIT_MS = 30 * 60_000;
export const GROW_MS = WEEK.days * 86_400_000 + 10 * 60_000;
export const TRUST_MS = 10 * 60_000;
export const MIN_WEEK_HISTORY = 24;
export const APP_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
export const MAX_APPS = 7;
export const MAX_SPECIES = 64;

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/** The time in a TID record key (ms), or null (the same as tidTime in website/server/garden.ts). */
export function tidTime(rkey) {
  if (typeof rkey !== 'string' || !TID_RE.test(rkey)) return null;
  let n = 0n;
  for (const ch of rkey) n = n * 32n + BigInt(S32.indexOf(ch));
  // 1 bit (zero), 53 bits of microseconds, 10 bits of clock id.
  return Number((n >> 10n) / 1000n);
}

const parse = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);

/** The planting time the garden trusts (ms), or null when nothing gives one. */
export function trustedPlantedAt({ created_at, first_seen_at, rkey }) {
  const seen = parse(first_seen_at);
  const created = parse(created_at);
  if (Number.isFinite(seen) && (!Number.isFinite(created) || Math.abs(created - seen) > TRUST_MS)) return seen;
  if (Number.isFinite(created)) return created;
  return tidTime(rkey);
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** garden_minute_weather's answer as plantingWeather wants it (bigints may come as strings). */
export function minuteOf(m) {
  if (!m || typeof m !== 'object') return null;
  const rank = num(m.rank);
  return { seconds: Number(m.seconds), creates: Number(m.creates), history: Number(m.history), rank: Number.isFinite(rank) ? rank : null };
}

/** What a sprout grows into. */
export function speciesFor({ did, rkey, kind, season }, plantedMs, weather) {
  if (kind === SEED) return pickSpecies(flowerSeed(did, rkey), SEASONS.includes(season) ? season : seasonOf(plantedMs), weather);
  return String(kind ?? '').slice(0, MAX_SPECIES);
}

/** garden_week_weather's answer as the garden_growth columns for a grown flower (without grown_at). */
export function grownValues(week) {
  const hours = (Array.isArray(week?.hours) ? week.hours : []).map((h) => ({ seconds: Number(h?.seconds) || 0, creates: Number(h?.creates) || 0, elsewhere: Number(h?.elsewhere) || 0 }));
  const history = Number(week?.history);
  const t = num(week?.threshold);
  const threshold = history >= MIN_WEEK_HISTORY && Number.isFinite(t) ? t : null;
  const weather = weekWeather(hours, threshold);
  const apps = weather && Array.isArray(week?.apps) ? week.apps.filter((a) => typeof a === 'string' && APP_RE.test(a)).slice(0, MAX_APPS) : [];
  return { grown: true, grow_wind: weather?.wind ?? null, grow_mix: weather?.mix ?? null, grow_apps: apps };
}

const iso = (ms) => new Date(ms).toISOString();
/** Supabase unreachable or failing (supabase.js gives status 0 for no answer), not this row. */
const isOutage = (err) => err?.status === 0 || err?.status >= 500;

export function createSettler({ rpc, upsert, patch, log, now = () => Date.now(), ready = () => true }) {
  let running = null;
  const counts = { settled: 0, grown: 0, waiting: 0, skipped: 0, failed: 0 };

  async function settleRow(row) {
    let plantedMs;
    if (!row.settled) {
      plantedMs = trustedPlantedAt(row);
      if (plantedMs === null) {
        counts.skipped++;
        return;
      }
      const age = now() - plantedMs;
      // A seed's species needs its patch's season: wait a while for the patch to be indexed.
      if (age < PLANT_WAIT_MS || (row.kind === SEED && row.patch_indexed === false && age < WEATHER_WAIT_MS)) {
        counts.waiting++;
        return;
      }
      const minute = await rpc('garden_minute_weather', { p_at: iso(plantedMs) });
      if (!minute && age < WEATHER_WAIT_MS) {
        counts.waiting++;
        return;
      }
      const weather = plantingWeather(minuteOf(minute));
      const species = speciesFor(row, plantedMs, weather);
      await upsert('garden_growth', 'sprout_uri', [
        { sprout_uri: row.uri, planted_at: iso(plantedMs), species, plant_wind: weather?.wind ?? null, plant_mix: weather?.mix ?? null, rule_version: RULE_VERSION },
      ]);
      counts.settled++;
      log.info('flower settled', { uri: row.uri, kind: row.kind, species, plantedAt: iso(plantedMs), wind: weather?.wind ?? null, mix: weather?.mix ?? null });
    } else {
      plantedMs = parse(row.planted_at);
      if (!Number.isFinite(plantedMs)) {
        counts.skipped++;
        return;
      }
    }
    if (now() < plantedMs + GROW_MS) return;
    const week = await rpc('garden_week_weather', { p_from: iso(plantedMs), p_quantile: WEEK.mixedQuantile });
    const values = { ...grownValues(week), grown_at: iso(now()) };
    await patch('garden_growth', `sprout_uri=eq.${encodeURIComponent(row.uri)}`, values);
    counts.grown++;
    log.info('flower grown', { uri: row.uri, wind: values.grow_wind, mix: values.grow_mix, apps: values.grow_apps });
  }

  async function pass() {
    if (!ready()) return;
    let rows;
    try {
      rows = await rpc('garden_unsettled', { p_limit: BATCH });
    } catch (err) {
      log.warn('could not read unsettled flowers', { err });
      return;
    }
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (typeof row?.uri !== 'string') continue;
      try {
        await settleRow(row);
      } catch (err) {
        counts.failed++;
        log.warn('could not settle flower', { uri: row.uri, err });
        if (isOutage(err)) return;
      }
    }
  }

  return {
    /** One pass; a tick while one runs returns that one. */
    tick() {
      running ??= pass().finally(() => {
        running = null;
      });
      return running;
    },
    get counts() {
      return counts;
    },
  };
}
