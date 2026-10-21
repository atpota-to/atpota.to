import { describe, expect, it } from 'vitest';
import {
  familyOf,
  FAMILIES,
  flowerSeed,
  isPickedKind,
  isSpecies,
  MIN_MINUTE_SECONDS,
  MIX,
  mixOfRank,
  PICKED_KINDS,
  pickSpecies,
  plantingWeather,
  seasonOf,
  SPECIES,
  SPECIES_IDS,
  speciesOf,
  speciesWeights,
  WEEK,
  weekWeather,
  WIND,
  windOf,
} from '../shared/garden-rules.js';
import { COLOURWAYS, KIND_INFO, KINDS } from '../src/scripts/flowers.js';

// shared/garden-rules.js: what a seed grows into and the weather it grows in. The garden
// indexer (garden/src/settle.js) settles each flower with these; the website draws them.

const seeds = Array.from({ length: 4000 }, (_, i) => flowerSeed(`did:plc:${String(i).padStart(24, 'q')}`, `3m${i.toString(36)}`));
const hour = (perSecond: number, share = 0.004, seconds = 3600) => ({ seconds, creates: perSecond * seconds, elsewhere: perSecond * seconds * share });

describe('the kinds', () => {
  it('every kind has a family, a look, and words for the field guide; the picked ones are among them', () => {
    expect(SPECIES_IDS).toHaveLength(27);
    expect(new Set(SPECIES_IDS).size).toBe(SPECIES_IDS.length);
    expect([...KINDS]).toEqual([...SPECIES_IDS]);
    for (const s of SPECIES) {
      expect(FAMILIES).toContain(s.family);
      expect(familyOf(s.id)).toBe(s.family);
      expect(speciesOf(s.id)).toBe(s);
      expect(COLOURWAYS[s.id].length).toBeGreaterThan(0);
      expect(KIND_INFO[s.id].name).toMatch(/^[a-z ]+$/);
      expect(KIND_INFO[s.id].origin).toMatch(/\.$/);
    }
    for (const k of PICKED_KINDS) expect(isSpecies(k) && isPickedKind(k)).toBe(true);
    expect(isSpecies('seed')).toBe(false);
    expect(isPickedKind('cactus')).toBe(false);
    expect(familyOf('triffid')).toBeNull();
  });
});

describe('the weather', () => {
  it('names the wind from new records a second, as the weather report does', () => {
    expect([0, 299.9, 300, 399, 400, 499, 500, 599, 600, 5000].map(windOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(WIND[windOf(452)]).toBe('breezy');
  });

  it('ranks a minute’s sky against the month before', () => {
    expect([0, 0.19, 0.2, 0.69, 0.7, 0.89, 0.9, 0.989, 0.99, 1].map(mixOfRank)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(MIX[mixOfRank(0.995)]).toBe('most mixed');
  });

  it('the minute a seed was planted: no reading, or one the station barely heard, is no weather; too little history is a usual sky', () => {
    expect(plantingWeather({ seconds: 60, creates: 60 * 650, rank: 0.995, history: 40_000 })).toEqual({ wind: 4, mix: 4 });
    expect(plantingWeather({ seconds: 60, creates: 60 * 250, rank: 0.1, history: 40_000 })).toEqual({ wind: 0, mix: 0 });
    expect(plantingWeather({ seconds: 60, creates: 60 * 450, rank: 0.995, history: 30 })).toEqual({ wind: 2, mix: 1 });
    expect(plantingWeather({ seconds: 60, creates: 60 * 450, rank: null, history: 40_000 })).toEqual({ wind: 2, mix: 1 });
    expect(plantingWeather({ seconds: MIN_MINUTE_SECONDS - 1, creates: 9000, rank: 0.5, history: 40_000 })).toBeNull();
    expect(plantingWeather(null)).toBeNull();
  });

  it('the week it grew in: stormy hours make a stormy week, then gusty, calm and light; anything else is breezy', () => {
    const week = (make: (i: number) => ReturnType<typeof hour>) => Array.from({ length: 7 * 24 }, (_, i) => make(i));
    expect(weekWeather(week((i) => hour(i < WEEK.stormyHours ? 650 : 450)), 0.005)?.wind).toBe(4);
    expect(weekWeather(week((i) => hour(i < WEEK.stormyHours - 1 ? 650 : 450)), 0.005)?.wind).toBe(2);
    expect(weekWeather(week((i) => hour(i < WEEK.gustyHours ? 550 : 450)), 0.005)?.wind).toBe(3);
    expect(weekWeather(week((i) => hour(i < WEEK.calmHours ? 250 : 450)), 0.005)?.wind).toBe(0);
    expect(weekWeather(week((i) => hour(i < WEEK.lightHours ? 350 : 450)), 0.005)?.wind).toBe(1);
    expect(weekWeather(week(() => hour(450)), 0.005)?.wind).toBe(2);
  });

  it('a week’s sky is the share of its hours more mixed than the month before usually was', () => {
    const share = (mixed: number) => Array.from({ length: 168 }, (_, i) => hour(450, i < mixed * 168 ? 0.01 : 0.003));
    expect([0.05, 0.3, 0.5, 0.7, 0.9].map((m) => weekWeather(share(m), 0.005)?.mix)).toEqual([0, 1, 2, 3, 4]);
    // nothing to compare with: a usual sky
    expect(weekWeather(share(0.9), null)?.mix).toBe(1);
  });

  it('a week the station heard too little of has no weather, and short hours don’t count', () => {
    expect(weekWeather(Array.from({ length: 70 }, () => hour(450)), 0.005)).toBeNull();
    expect(weekWeather([], 0.005)).toBeNull();
    const patchy = Array.from({ length: 168 }, (_, i) => hour(i % 2 ? 650 : 450, 0.004, i % 2 ? WEEK.minHourSeconds - 1 : 3600));
    expect(weekWeather(patchy, 0.005)).toEqual({ wind: 2, mix: 0 });
  });

  it('seasons are the northern meteorological ones, in UTC', () => {
    const at = (iso: string) => seasonOf(Date.parse(iso));
    expect([at('2026-03-01T00:00:00Z'), at('2026-05-31T23:59:59Z'), at('2026-06-01T00:00:00Z'), at('2026-09-01T00:00:00Z'), at('2026-11-30T23:00:00Z'), at('2026-12-01T00:00:00Z'), at('2027-02-28T00:00:00Z')]).toEqual([
      'spring',
      'spring',
      'summer',
      'autumn',
      'autumn',
      'winter',
      'winter',
    ]);
  });
});

describe('what a seed grows into', () => {
  const tally = (season: string, weather: { wind: number; mix: number } | null) => {
    const n = new Map<string, number>();
    for (const s of seeds) {
      const k = pickSpecies(s, season, weather);
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    return n;
  };

  it('is the same every time for the same seed, season and minute', () => {
    for (const s of seeds.slice(0, 50)) expect(pickSpecies(s, 'autumn', { wind: 2, mix: 1 })).toBe(pickSpecies(s, 'autumn', { wind: 2, mix: 1 }));
  });

  it('a season’s own kinds come up only in that season', () => {
    const autumn = tally('autumn', { wind: 2, mix: 1 });
    expect(autumn.get('pumpkin')).toBeGreaterThan(0);
    for (const k of ['snowdrop', 'cherry-blossom', 'watermelon']) expect(autumn.get(k)).toBeUndefined();
    expect(tally('winter', { wind: 2, mix: 1 }).get('snowdrop')).toBeGreaterThan(0);
  });

  it('a storm, a calm minute and the most mixed sky of the month each bring something nothing else does', () => {
    const usual = tally('autumn', { wind: 2, mix: 1 });
    for (const k of ['storm-lily', 'lotus', 'prism-aster']) expect(usual.get(k)).toBeUndefined();
    expect(tally('autumn', { wind: 4, mix: 1 }).get('storm-lily')).toBeGreaterThan(0);
    expect(tally('autumn', { wind: 0, mix: 1 }).get('lotus')).toBeGreaterThan(0);
    expect(tally('autumn', { wind: 2, mix: 4 }).get('prism-aster')).toBeGreaterThan(0);
    // no weather recorded: a usual minute, and none of them
    const none = tally('autumn', null);
    for (const k of ['storm-lily', 'lotus', 'prism-aster']) expect(none.get(k)).toBeUndefined();
  });

  it('weather tips the odds: dandelions in a gust, moss in a calm, cosmos under a mixed sky; common kinds stay commonest', () => {
    const w = (season: string, weather: { wind: number; mix: number } | null) => Object.fromEntries(SPECIES.map((s, i) => [s.id, speciesWeights(season, weather)[i]!]));
    expect(w('autumn', { wind: 4, mix: 1 }).dandelion).toBeGreaterThan(w('autumn', { wind: 2, mix: 1 }).dandelion!);
    expect(w('autumn', { wind: 0, mix: 1 }).moss).toBeGreaterThan(w('autumn', { wind: 2, mix: 1 }).moss!);
    expect(w('spring', { wind: 2, mix: 2 }).cosmos).toBeGreaterThan(w('spring', { wind: 2, mix: 1 }).cosmos!);
    const usual = tally('summer', { wind: 2, mix: 1 });
    expect(usual.get('daisy')!).toBeGreaterThan(usual.get('monstera') ?? 0);
    expect([...usual.values()].reduce((a, b) => a + b, 0)).toBe(seeds.length);
  });
});
