// Types for garden-rules.js (plain JavaScript, so the droplet's indexer runs it too).

export declare const RULE_VERSION: number;
export declare const SEED: 'seed';

export declare const SEASONS: readonly ['spring', 'summer', 'autumn', 'winter'];
export type Season = (typeof SEASONS)[number];
export declare const FAMILIES: readonly ['flower', 'leafy', 'succulent', 'fruit', 'fungus'];
export type Family = (typeof FAMILIES)[number];
export type Rarity = 'common' | 'uncommon' | 'rare' | 'seasonal' | 'weather';

export type SpeciesId =
  | 'sunflower'
  | 'rose'
  | 'daisy'
  | 'violet'
  | 'poppy'
  | 'tulip'
  | 'cosmos'
  | 'marigold'
  | 'dandelion'
  | 'clover'
  | 'moss'
  | 'fern'
  | 'lavender'
  | 'hydrangea'
  | 'echeveria'
  | 'cactus'
  | 'strawberry'
  | 'toadstool'
  | 'monstera'
  | 'passionflower'
  | 'snowdrop'
  | 'cherry-blossom'
  | 'watermelon'
  | 'pumpkin'
  | 'lotus'
  | 'storm-lily'
  | 'prism-aster';

export interface Species {
  readonly id: SpeciesId;
  readonly family: Family;
  readonly rarity: Rarity;
  readonly boost?: Season;
  readonly season?: Season;
  readonly likesWind?: readonly number[];
  readonly likesMix?: number;
  readonly onlyWind?: number;
  readonly onlyMix?: number;
  readonly onlyWeight?: number;
}

export declare const SPECIES: readonly Species[];
export declare const SPECIES_IDS: readonly SpeciesId[];
export declare const PICKED_KINDS: readonly ['sunflower', 'rose', 'daisy', 'violet', 'poppy', 'tulip'];
export type PickedKind = (typeof PICKED_KINDS)[number];

export declare function isSpecies(value: unknown): value is SpeciesId;
export declare function isPickedKind(value: unknown): value is PickedKind;
export declare function speciesOf(id: string): Species | null;
export declare function familyOf(id: string): Family | null;

export declare function hashSeed(text: string): number;
export declare function seeded(seed: number): () => number;
export declare function flowerSeed(did: string, rkey: string): number;

/** 0 to 4: calm, light, breezy, gusty, stormy. */
export declare const WIND: readonly ['calm', 'light', 'breezy', 'gusty', 'stormy'];
/** 0 to 4: plainer, usual, mixed, very mixed, most mixed. */
export declare const MIX: readonly ['plainer', 'usual', 'mixed', 'very mixed', 'most mixed'];
export declare const WIND_STARTS: readonly number[];
export declare const MIX_RANKS: readonly number[];
export declare const MIN_MINUTE_SECONDS: number;
export declare const MIN_HISTORY_MINUTES: number;
export declare const WEEK: {
  readonly days: number;
  readonly minHourSeconds: number;
  readonly minCoverage: number;
  readonly stormyHours: number;
  readonly gustyHours: number;
  readonly calmHours: number;
  readonly lightHours: number;
  readonly mixedShares: readonly number[];
  readonly mixedQuantile: number;
};

/** How windy and how mixed, each 0 to 4. */
export interface Weather {
  wind: number;
  mix: number;
}

export declare function windOf(perSecond: number): number;
export declare function mixOfRank(rank: number): number;
export declare function plantingWeather(minute: { seconds: number; creates: number; rank: number | null; history: number } | null | undefined): Weather | null;
export declare function weekWeather(hours: ReadonlyArray<{ seconds: number; creates: number; elsewhere: number }>, threshold: number | null): Weather | null;

export declare const BASE_WEIGHT: { readonly common: number; readonly uncommon: number; readonly rare: number; readonly seasonal: number };
export declare function seasonOf(ms: number): Season;
export declare function speciesWeights(season: string, weather: Weather | null): number[];
export declare function pickSpecies(seed: number, season: string, weather: Weather | null): SpeciesId;
