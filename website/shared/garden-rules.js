// @ts-check
/**
 * The garden's rules: what a seed grows into, and how the network weather shapes it.
 *
 * Shared by the website (server/garden.ts reads what was settled; src/scripts/flowers.ts
 * draws it) and the garden indexer on the droplet (garden/src/settle.js), which works out
 * each flower once and stores it in Supabase (garden_growth). Plain JavaScript so both can
 * run it; garden-rules.d.ts gives the website its types. Nothing here touches the network.
 *
 * A seed's species comes from three things, all fixed in the minute it was planted:
 *   the seed       FNV-1a of "<did>/<rkey>", the same seed that picks its colours
 *   the season     its patch's, or the season of the planting date for a garden without one
 *   the weather    the weather station's reading for that minute: how windy (new records a
 *                  second, the /weather conditions) and how mixed the sky was (the share of
 *                  records outside Bluesky, as a rank against the 30 days before)
 * Then the seven days it grows decide how its bloom looks: a windy week leans and
 * scatters it, a mixed sky cross-pollinates it.
 *
 * Changing a rule changes which flowers grow from then on, never one already settled:
 * bump RULE_VERSION, and the indexer stores it beside each flower it settles.
 */

export const RULE_VERSION = 1;

/** What a sprout record's `kind` says when the garden decides what grows. */
export const SEED = 'seed';

export const SEASONS = /** @type {const} */ (['spring', 'summer', 'autumn', 'winter']);
export const FAMILIES = /** @type {const} */ (['flower', 'leafy', 'succulent', 'fruit', 'fungus']);

/**
 * Everything a seed can grow into. `rarity` sets its base chance; `boost` doubles it in that
 * season; `season` means only in that season; `likesWind` and `likesMix` raise it in that
 * weather; `onlyWind` and `onlyMix` mean nothing else will do (and then `onlyWeight` is its
 * chance in that weather).
 */
export const SPECIES = /** @type {const} */ ([
  { id: 'sunflower', family: 'flower', rarity: 'common', boost: 'summer' },
  { id: 'rose', family: 'flower', rarity: 'common' },
  { id: 'daisy', family: 'flower', rarity: 'common', boost: 'spring' },
  { id: 'violet', family: 'flower', rarity: 'common', boost: 'spring' },
  { id: 'poppy', family: 'flower', rarity: 'common', boost: 'summer' },
  { id: 'tulip', family: 'flower', rarity: 'common', boost: 'spring' },
  { id: 'cosmos', family: 'flower', rarity: 'common', likesMix: 2 },
  { id: 'marigold', family: 'flower', rarity: 'common', boost: 'autumn' },
  { id: 'dandelion', family: 'flower', rarity: 'common', likesWind: [3, 4] },
  { id: 'clover', family: 'leafy', rarity: 'common' },
  { id: 'moss', family: 'leafy', rarity: 'common', likesWind: [0] },
  { id: 'fern', family: 'leafy', rarity: 'common', likesWind: [0, 1] },
  { id: 'lavender', family: 'flower', rarity: 'uncommon', boost: 'summer' },
  { id: 'hydrangea', family: 'flower', rarity: 'uncommon', likesMix: 2 },
  { id: 'echeveria', family: 'succulent', rarity: 'uncommon' },
  { id: 'cactus', family: 'succulent', rarity: 'uncommon' },
  { id: 'strawberry', family: 'fruit', rarity: 'uncommon', boost: 'summer' },
  { id: 'toadstool', family: 'fungus', rarity: 'uncommon', boost: 'autumn', likesWind: [0] },
  { id: 'monstera', family: 'leafy', rarity: 'rare' },
  { id: 'passionflower', family: 'flower', rarity: 'rare', likesMix: 3 },
  { id: 'snowdrop', family: 'flower', rarity: 'seasonal', season: 'winter' },
  { id: 'cherry-blossom', family: 'flower', rarity: 'seasonal', season: 'spring' },
  { id: 'watermelon', family: 'fruit', rarity: 'seasonal', season: 'summer' },
  { id: 'pumpkin', family: 'fruit', rarity: 'seasonal', season: 'autumn' },
  { id: 'lotus', family: 'flower', rarity: 'weather', onlyWind: 0, onlyWeight: 6 },
  { id: 'storm-lily', family: 'flower', rarity: 'weather', onlyWind: 4, onlyWeight: 8 },
  { id: 'prism-aster', family: 'flower', rarity: 'weather', onlyMix: 4, onlyWeight: 12 },
]);

/** Every species, by id. */
export const SPECIES_IDS = SPECIES.map((s) => s.id);

/** The kinds people picked themselves before seeds (and still may, where seeds are off). */
export const PICKED_KINDS = /** @type {const} */ (['sunflower', 'rose', 'daisy', 'violet', 'poppy', 'tulip']);

const BY_ID = new Map(SPECIES.map((s) => [/** @type {string} */ (s.id), s]));

/** @param {unknown} value */
export function isSpecies(value) {
  return typeof value === 'string' && BY_ID.has(value);
}

/** @param {unknown} value */
export function isPickedKind(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (PICKED_KINDS).includes(value);
}

/** @param {string} id */
export function speciesOf(id) {
  return BY_ID.get(id) ?? null;
}

/** @param {string} id */
export function familyOf(id) {
  return BY_ID.get(id)?.family ?? null;
}

/* ---------- seeds ---------- */

/** FNV-1a: a string to 32 bits. @param {string} text */
export function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small seeded random in [0, 1). @param {number} seed */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A flower's seed: its owner's DID and its record key. @param {string} did @param {string} rkey */
export function flowerSeed(did, rkey) {
  return hashSeed(`${did}/${rkey}`);
}

/* ---------- weather ---------- */

/** How windy, from new records a second: calm, light, breezy, gusty, stormy. */
export const WIND = /** @type {const} */ (['calm', 'light', 'breezy', 'gusty', 'stormy']);
/** How mixed the sky was against the 30 days before: plainer, usual, mixed, very mixed, most mixed. */
export const MIX = /** @type {const} */ (['plainer', 'usual', 'mixed', 'very mixed', 'most mixed']);

/** New records a second where light, breezy, gusty and stormy start (server/atmosphere.ts CONDITIONS). */
export const WIND_STARTS = /** @type {const} */ ([300, 400, 500, 600]);
/** A minute's sky rank (the share of the past 30 days' minutes it was more mixed than) where usual, mixed, very mixed and most mixed start. */
export const MIX_RANKS = /** @type {const} */ ([0.2, 0.7, 0.9, 0.99]);
/** A minute the station heard for less than this many seconds doesn't count. */
export const MIN_MINUTE_SECONDS = 30;
/** Fewer minutes of history than this to rank against, and every sky is usual. */
export const MIN_HISTORY_MINUTES = 60;

/**
 * The week a flower grows in. Hours the station heard for at least MIN_HOUR_SECONDS count.
 * The wind is the first that holds: STORMY_HOURS stormy hours make a stormy week, GUSTY_HOURS
 * gusty or stormy ones a gusty week, CALM_HOURS calm ones a calm week, LIGHT_HOURS calm or
 * light ones a light week; anything else is breezy. The sky is the share of its hours more
 * mixed than the 30 days before were 70% of the time, banded by MIXED_SHARES. A week the
 * station heard less than MIN_COVERAGE of has no weather. Tune these once there's a month
 * of history; a change is a new RULE_VERSION.
 */
export const WEEK = /** @type {const} */ ({
  days: 7,
  minHourSeconds: 1800,
  minCoverage: 0.5,
  stormyHours: 6,
  gustyHours: 24,
  calmHours: 48,
  lightHours: 84,
  mixedShares: [0.15, 0.4, 0.6, 0.8],
  /** How mixed an hour has to be to count: this quantile of the 30 days before. */
  mixedQuantile: 0.7,
});

/** @param {number} perSecond */
export function windOf(perSecond) {
  let i = 0;
  while (i < WIND_STARTS.length && perSecond >= WIND_STARTS[i]) i++;
  return i;
}

/** @param {number} rank 0 to 1 */
export function mixOfRank(rank) {
  let i = 0;
  while (i < MIX_RANKS.length && rank >= MIX_RANKS[i]) i++;
  return i;
}

/**
 * The weather in the minute a seed was planted, from the station's reading for it; null
 * when the station has none.
 * @param {{ seconds: number, creates: number, rank: number | null, history: number } | null | undefined} minute
 */
export function plantingWeather(minute) {
  if (!minute || !(minute.seconds >= MIN_MINUTE_SECONDS) || !(minute.creates >= 0)) return null;
  const wind = windOf(minute.creates / minute.seconds);
  const mix = minute.rank === null || !(minute.history >= MIN_HISTORY_MINUTES) || !Number.isFinite(minute.rank) ? 1 : mixOfRank(minute.rank);
  return { wind, mix };
}

/**
 * The weather of the week a flower grew in, from the station's hours in it and how mixed an
 * hour usually was before (the WEEK.mixedQuantile of the 30 days before, as a share of
 * records outside Bluesky, 0 to 1); null when the station heard too little of it.
 * @param {ReadonlyArray<{ seconds: number, creates: number, elsewhere: number }>} hours
 * @param {number | null} threshold
 */
export function weekWeather(hours, threshold) {
  const heard = hours.reduce((n, h) => n + (h.seconds > 0 ? h.seconds : 0), 0);
  if (heard < WEEK.minCoverage * WEEK.days * 86_400) return null;
  const counted = hours.filter((h) => h.seconds >= WEEK.minHourSeconds && h.creates > 0);
  if (!counted.length) return null;
  const by = [0, 0, 0, 0, 0];
  let mixed = 0;
  for (const h of counted) {
    by[windOf(h.creates / h.seconds)]++;
    if (threshold !== null && h.elsewhere / h.creates > threshold) mixed++;
  }
  const wind =
    by[4] >= WEEK.stormyHours ? 4 : by[3] + by[4] >= WEEK.gustyHours ? 3 : by[0] >= WEEK.calmHours ? 0 : by[0] + by[1] >= WEEK.lightHours ? 1 : 2;
  let mix = 1;
  if (threshold !== null) {
    const share = mixed / counted.length;
    mix = 0;
    while (mix < WEEK.mixedShares.length && share >= WEEK.mixedShares[mix]) mix++;
  }
  return { wind, mix };
}

/* ---------- what a seed grows into ---------- */

export const BASE_WEIGHT = /** @type {const} */ ({ common: 10, uncommon: 4, rare: 1.2, seasonal: 5 });

/** The northern meteorological season of a moment (UTC): March to May is spring. @param {number} ms */
export function seasonOf(ms) {
  const m = new Date(ms).getUTCMonth();
  return SEASONS[Math.floor(((m + 10) % 12) / 3)];
}

/**
 * Each species' chance (unnormalised, in SPECIES order) for a seed planted in `season` in
 * `weather` (null: no weather recorded, which is a usual minute that no weather-only
 * species grows from).
 * @param {string} season
 * @param {{ wind: number, mix: number } | null} weather
 */
export function speciesWeights(season, weather) {
  return SPECIES.map((s) => {
    const sp = /** @type {any} */ (s);
    if (sp.season) return sp.season === season ? BASE_WEIGHT.seasonal : 0;
    if (sp.onlyWind !== undefined) return weather && weather.wind === sp.onlyWind ? sp.onlyWeight : 0;
    if (sp.onlyMix !== undefined) return weather && weather.mix >= sp.onlyMix ? sp.onlyWeight : 0;
    let w = BASE_WEIGHT[/** @type {'common' | 'uncommon' | 'rare'} */ (sp.rarity)];
    if (sp.boost === season) w *= 2;
    if (weather && sp.likesWind?.includes(weather.wind)) w *= 2.5;
    if (weather && sp.likesMix !== undefined && weather.mix >= sp.likesMix) w *= 2.5;
    return w;
  });
}

/**
 * What a seed grows into. Its own roll (from its seed, apart from the rolls for its look)
 * against the weights for its season and planting weather.
 * @param {number} seed
 * @param {string} season
 * @param {{ wind: number, mix: number } | null} weather
 */
export function pickSpecies(seed, season, weather) {
  const weights = speciesWeights(season, weather);
  const total = weights.reduce((a, b) => a + b, 0);
  let x = seeded(seed ^ 0x5eed)() * total;
  for (let i = 0; i < SPECIES.length; i++) {
    x -= weights[i];
    if (x < 0) return SPECIES[i].id;
  }
  return SPECIES[0].id;
}
