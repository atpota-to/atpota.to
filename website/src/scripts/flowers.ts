/**
 * The garden's plants, seen from above, each one a little different.
 *
 * A plant's look is generated from a seed: its owner's DID and its record key, so it stays
 * the same everywhere and for everyone, and replanting grows a new one. Within its kind,
 * the seed picks a colourway, how many petals and how long and wide they are, the size of
 * the middle, two or three leaves at their own angles, a turn and a size, and now and then
 * something rarer: two-tone petals, a second ring, a four-leaf clover, or a ladybug.
 *
 * Care (0 to 1, how well it was tended while it grew; server/garden.ts counts it) makes the
 * rarer things likelier and the bloom a little fuller. The seed's rolls stay the same and
 * care only raises the bar each roll has to clear, so more care never takes anything away.
 *
 * The week it grew in (shared/garden-rules.js; the garden indexer settles it) shows too.
 * Wind leans every petal the same way and shakes them a little, and a gusty or stormy week
 * blows a petal or two off (they lie beside it, blown the same way across the patch). A
 * sky more mixed than usual cross-pollinates it: a petal, then every third, then every
 * other one takes a colour from somewhere else. A few kinds show the weather their own way:
 * a hydrangea is blue after a plain week and pink after a mixed one, a dandelion goes to
 * seed in the wind, an echeveria reddens at the tips, a prism aster's petals take the
 * colours of the apps that were in the air. A plant with no weather recorded looks exactly
 * as it always did. All of these rolls come after the old ones, so they move nothing else.
 *
 * Growth follows age: a sprout for SPROUT_DAYS, a bud until GROW_DAYS, then the bloom. A
 * plant in a patch that has closed is always in bloom. Every seed sprouts the same two
 * leaves; a seed's bud shows only its family (drawSeed), and the bloom shows what it is.
 *
 * Everything is built with createElementNS; nothing here touches innerHTML.
 */

import { familyOf, flowerSeed, hashSeed, PICKED_KINDS, seeded, SPECIES_IDS, type Family, type SpeciesId } from '../../shared/garden-rules.js';

export { flowerSeed, hashSeed, seeded };

/** Every kind a plant can be. */
export type FlowerKind = SpeciesId;
export const KINDS: readonly FlowerKind[] = SPECIES_IDS;
/** The kinds people pick themselves, where the garden doesn't give out seeds. */
export const FLOWER_KINDS = PICKED_KINDS;
export type Stage = 'sprout' | 'bud' | 'bloom';

/** petal, second petal (two-tone and inner rings), middle, middle's core (each kind uses them its own way) */
type Colourway = readonly [string, string, string, string];

export const COLOURWAYS: Record<FlowerKind, readonly Colourway[]> = {
  sunflower: [
    ['#FFC93C', '#FFB020', '#7A4E1D', '#8E5E28'],
    ['#FFE066', '#FFD23F', '#6B4423', '#80552C'],
    ['#F9A03F', '#E8772E', '#5A3A1A', '#6E4A24'],
    ['#E0662F', '#C2481E', '#4A2E14', '#5E3C1C'],
  ],
  rose: [
    ['#EE9AAB', '#E2809A', '#D0647E', '#B9506A'],
    ['#F5AE8E', '#EC9270', '#DD7753', '#C25E3E'],
    ['#D94A5E', '#C2364C', '#A3233A', '#7E1A2C'],
    ['#F8DCE2', '#F1C3CE', '#E7A6B6', '#D88A9C'],
    ['#F8DC82', '#F2CA5E', '#E8B444', '#D49A2C'],
  ],
  daisy: [
    ['#FFFFFF', '#F1ECE0', '#FFCD5E', '#F2A33A'],
    ['#FCE4EC', '#F6CBD9', '#FFCD5E', '#F2A33A'],
    ['#FFF4C2', '#FBE596', '#F2A33A', '#D9861F'],
    ['#FFFFFF', '#E4EEFF', '#F2A33A', '#D9861F'],
  ],
  violet: [
    ['#A98BEA', '#8E6BD9', '#FFE37A', '#F5C84A'],
    ['#C9B6F5', '#B39DEE', '#FFE37A', '#F5C84A'],
    ['#8696F2', '#6C7CE2', '#FFE37A', '#F5C84A'],
    ['#FFFFFF', '#E6DCFA', '#8E6BD9', '#6E4EC0'],
  ],
  poppy: [
    ['#FF6B4A', '#E8513A', '#3D2F1B', '#6E5A3A'],
    ['#E8323C', '#C8222C', '#2A1F14', '#5A4A30'],
    ['#FFB38A', '#FF9A6B', '#5A3A1A', '#8A6A44'],
    ['#FFFFFF', '#F1ECE4', '#3D2F1B', '#6E5A3A'],
    ['#F49AB0', '#E97A92', '#3D2F1B', '#6E5A3A'],
  ],
  tulip: [
    ['#F49AB0', '#E97A92', '#D96F8A', '#C25E78'],
    ['#E8323C', '#C8222C', '#A01C25', '#7E141C'],
    ['#FFD84A', '#F5C02A', '#E0A422', '#C48A16'],
    ['#9B6BD9', '#7E50C2', '#6A3FAE', '#55309A'],
    ['#FFFFFF', '#FCE4EC', '#F49AB0', '#E97A92'],
    ['#FF9A4A', '#F07F2E', '#D9661A', '#B85212'],
  ],
  cosmos: [
    ['#E0559A', '#C93F84', '#F5C84A', '#D9A21F'],
    ['#F4A6C8', '#E98AB2', '#F5C84A', '#D9A21F'],
    ['#FFFFFF', '#F6E4EE', '#F5C84A', '#D9A21F'],
    ['#F7A04B', '#E8832A', '#C9661A', '#8E4A12'],
    ['#8C2D3A', '#6E1F2B', '#3D1A14', '#2A120E'],
  ],
  marigold: [
    ['#F7931E', '#E8771A', '#C9661A', '#8E4A12'],
    ['#FFC93C', '#F5A623', '#E8901A', '#C47712'],
    ['#C1442E', '#FFB020', '#9E3322', '#7A2418'],
    ['#FFE066', '#FFD23F', '#F5B82E', '#D99A1E'],
  ],
  dandelion: [
    ['#FFD23F', '#FFC21A', '#E8A317', '#C98A12'],
    ['#FFE680', '#FFD84A', '#F2B82E', '#D99A1E'],
  ],
  // the clover's flower: a pompom
  clover: [
    ['#FFFFFF', '#F1ECE0', '#E3D9C0', '#D9D1BC'],
    ['#F6C3D6', '#EE9FBE', '#E07FA6', '#C9628A'],
    ['#E7E0F5', '#D2C6EE', '#BBA9E3', '#9F8BD6'],
  ],
  // four greens for the cushion
  moss: [
    ['#5B9A3C', '#77B04A', '#3F7A2C', '#8CC45A'],
    ['#6E8F3A', '#8DA94C', '#55702C', '#A3BD62'],
    ['#4E8F6A', '#68A77F', '#3A7353', '#86BF98'],
  ],
  // leaflets, leaflets, rib, middle
  fern: [
    ['#3E9A4A', '#2E7D3A', '#24642E', '#1B4F24'],
    ['#5FAE5A', '#4A9447', '#3A7A38', '#2C5E2B'],
    ['#7FB24A', '#6A9A3C', '#557F30', '#3F6224'],
    ['#8FB59A', '#7AA386', '#5E8A6B', '#4A7055'],
  ],
  lavender: [
    ['#9B7FD4', '#7E62C0', '#6A4FAE', '#55309A'],
    ['#B9A3E6', '#A08BD9', '#8E6BD9', '#6E4EC0'],
    ['#EDE7F6', '#DCD3EE', '#C9BEE4', '#B3A6D6'],
    ['#D9A6D9', '#C98AC9', '#B56FB5', '#9A579A'],
  ],
  // blue to pink: a hydrangea's colour follows the sky it grew under
  hydrangea: [
    ['#6C9BE0', '#88AEEA', '#4E7FCB', '#F5F2FF'],
    ['#8FA6EA', '#A9BBF0', '#6F88D6', '#F5F2FF'],
    ['#A992E0', '#BFA9EA', '#8E76CC', '#FFF5FB'],
    ['#D08BC9', '#DFA5D8', '#B66FB0', '#FFF5FB'],
    ['#EE8FB0', '#F5ABC4', '#D9708F', '#FFF5FB'],
  ],
  echeveria: [
    ['#8FB9A8', '#A7CBBE', '#6E9C8A', '#5C8A78'],
    ['#9FD3B0', '#B6E0C3', '#7DB991', '#5E9C72'],
    ['#B7A9C9', '#CBBFDA', '#9A8BB0', '#7E6F96'],
    ['#6FA77F', '#86B894', '#578F68', '#447A55'],
  ],
  // body, ribs, flower, flower's middle
  cactus: [
    ['#5C9E55', '#467F41', '#F06292', '#FFE37A'],
    ['#6DAA7A', '#548E61', '#FFD54F', '#FFF3B0'],
    ['#7A9E4E', '#5F803B', '#FF8A65', '#FFE37A'],
    ['#4F8F7A', '#3C7363', '#BA68C8', '#FFE37A'],
  ],
  // berry, berry, seeds, calyx
  strawberry: [
    ['#E53935', '#C62828', '#FFE37A', '#3E9A4A'],
    ['#C62828', '#9E1F1F', '#FFE37A', '#3E9A4A'],
    ['#FFF1EC', '#FAD9D0', '#E53935', '#3E9A4A'],
    ['#FFD54F', '#F2C14E', '#E53935', '#3E9A4A'],
  ],
  // cap, spots, rim
  toadstool: [
    ['#D9443A', '#FFF8EC', '#A3302A', '#7A2418'],
    ['#A0623A', '#C99A6A', '#7A4A2A', '#5A361E'],
    ['#F2C14E', '#FFF8EC', '#C99A2E', '#9E7A1E'],
    ['#8E6BD9', '#F1ECFF', '#6E4EC0', '#55309A'],
  ],
  monstera: [
    ['#2E7D4F', '#3E9A5E', '#1B4F31', '#3A7A4A'],
    ['#3E9A5E', '#52AD70', '#1B4F31', '#3A7A4A'],
    ['#2A6E58', '#3A8A6E', '#173F34', '#2E6B55'],
  ],
  // petals, corona tips, corona base, middle
  passionflower: [
    ['#F4F1FA', '#6C5CE0', '#3D2B8C', '#C9E3A5'],
    ['#D9443A', '#E8323C', '#7A1F1F', '#C9E3A5'],
    ['#B48EDB', '#7E50C2', '#3D2B8C', '#C9E3A5'],
  ],
  // petals, inner petals, the inner petals' mark, middle
  snowdrop: [
    ['#FFFFFF', '#F7F9F4', '#3E9A4A', '#9CC48A'],
    ['#FFFFFF', '#FBFAF0', '#E8C547', '#C9D98A'],
  ],
  'cherry-blossom': [
    ['#F8C8D8', '#F4A6C1', '#E26A93', '#B8325E'],
    ['#FFF4F7', '#FBE3EA', '#E26A93', '#B8325E'],
    ['#EE82A6', '#E46592', '#C2406E', '#8E2448'],
  ],
  // rind, stripes, shine (the third is Moon and Stars: no stripes, a moon and stars)
  watermelon: [
    ['#4E9A4A', '#1F5F2A', '#A5D6A0', '#3E8E41'],
    ['#2A4A2A', '#1E381E', '#6E8F6E', '#3E8E41'],
    ['#2E5A2E', '#2E5A2E', '#6E8F6E', '#3E8E41'],
  ],
  // lobes, lobes, stem
  pumpkin: [
    ['#F28C28', '#E07A1E', '#6B4A2A', '#3E8E41'],
    ['#F3EEDC', '#E6DFC8', '#6B6B4A', '#3E8E41'],
    ['#9FB3A0', '#8AA08B', '#5A5A3A', '#3E8E41'],
    ['#D9541E', '#C2461A', '#5A3A1A', '#3E8E41'],
  ],
  lotus: [
    ['#F8C8D8', '#F4A6C1', '#F5C84A', '#C9A227'],
    ['#FFF7F2', '#FBE3EA', '#F5C84A', '#C9A227'],
    ['#B9C9F5', '#9DB7F2', '#F5C84A', '#C9A227'],
  ],
  'storm-lily': [
    ['#3A3F8F', '#5B5FC7', '#FFE37A', '#2A2560'],
    ['#4A5568', '#677489', '#FFE37A', '#2D3748'],
    ['#6B3FD4', '#8A63E6', '#FFE37A', '#3D2B8C'],
  ],
  // its petals are the apps' colours; this is its middle
  'prism-aster': [['#FFD84A', '#F2A33A', '#FFD84A', '#F2A33A']],
};

/** What each kind is called, where it comes from, and what's special about it (the field guide's words). */
export const KIND_INFO: Record<FlowerKind, { name: string; origin: string; note?: string }> = {
  sunflower: { name: 'sunflower', origin: 'any season, most often in summer.' },
  rose: { name: 'rose', origin: 'any season.' },
  daisy: { name: 'daisy', origin: 'any season, most often in spring.' },
  violet: { name: 'violet', origin: 'any season, most often in spring.' },
  poppy: { name: 'poppy', origin: 'any season, most often in summer.' },
  tulip: { name: 'tulip', origin: 'any season, most often in spring.' },
  cosmos: { name: 'cosmos', origin: 'any season. likelier when the sky is more mixed than usual.' },
  marigold: { name: 'marigold', origin: 'any season, most often in autumn.' },
  dandelion: { name: 'dandelion', origin: 'any season. likelier in a gust or a storm.', note: 'goes to seed in a windy week, and storms carry the seeds off.' },
  clover: { name: 'clover', origin: 'any season.', note: 'tending makes a four-leaf likelier.' },
  moss: { name: 'moss', origin: 'any season. likelier in a calm minute.', note: 'the more it’s tended, the more spore stalks.' },
  fern: { name: 'fern', origin: 'any season. likelier when the air is calm or light.', note: 'a mixed sky tints its frond tips.' },
  lavender: { name: 'lavender', origin: 'any season, most often in summer.', note: 'wind bends its spikes.' },
  hydrangea: { name: 'hydrangea', origin: 'any season. likelier under a mixed sky.', note: 'blue after a plain week, pink after a mixed one, the way real ones follow their soil.' },
  echeveria: { name: 'echeveria', origin: 'any season.', note: 'goes red at the tips after a gusty or stormy week.' },
  cactus: { name: 'cactus', origin: 'any season.', note: 'well tended, it can flower twice.' },
  strawberry: { name: 'strawberry', origin: 'any season, most often in summer.', note: 'more berries the more it’s tended.' },
  toadstool: { name: 'toadstool', origin: 'any season. likelier in autumn and in calm minutes.', note: 'well tended, it can come up as a fairy ring.' },
  monstera: { name: 'monstera', origin: 'any season. rare.', note: 'a mixed sky gives it cream speckles.' },
  passionflower: { name: 'passionflower', origin: 'any season. rare, likelier under a very mixed sky.', note: 'a mixed sky colours the tips of its filaments.' },
  snowdrop: { name: 'snowdrop', origin: 'only in winter patches.' },
  'cherry-blossom': { name: 'cherry blossom', origin: 'only in spring patches.', note: 'drops petals in the wind.' },
  watermelon: { name: 'watermelon', origin: 'only in summer patches.', note: 'tending makes it bigger. one in three is a moon and stars.' },
  pumpkin: { name: 'pumpkin', origin: 'only in autumn patches.', note: 'tending makes it bigger.' },
  lotus: { name: 'lotus', origin: 'only from a seed planted in a calm minute.', note: 'grows on its own lily pad.' },
  'storm-lily': { name: 'storm lily', origin: 'only from a seed planted in a storm.', note: 'every petal carries a lightning stripe.' },
  'prism-aster': { name: 'prism aster', origin: 'only from a seed planted in the most mixed minute of the month.', note: 'each petal takes the colour of an app that was in the air.' },
};

export function kindName(kind: FlowerKind): string {
  return KIND_INFO[kind].name;
}

const LEAF_COLOURS = ['#39B54A', '#2E9E3F'] as const;
const BUD = '#5FAE5A';
/** Colours a mixed sky brings in from elsewhere. */
const POLLEN = ['#8E6BD9', '#4FA6D3', '#E8323C', '#FFC93C', '#F49AB0', '#FF8A3D', '#2FB5A3', '#3E5BD8'] as const;
/** A prism aster's colours, when the apps in the air don't give it enough of its own. */
const PRISM = ['#E8323C', '#FF8A3D', '#FFC93C', '#7BC74D', '#2FB5A3', '#4FA6D3', '#3E5BD8', '#8E6BD9', '#E05FA0'] as const;

export interface Leaf {
  angle: number;
  length: number;
}

/** The week a plant grew in: how windy and how mixed (0 to 4 each), and the busiest apps outside Bluesky. */
export interface GrewIn {
  wind: number;
  mix: number;
  apps?: readonly string[];
}

export interface Variant {
  colourway: Colourway;
  petals: number;
  petalLength: number;
  petalWidth: number;
  centerSize: number;
  twoTone: boolean;
  double: boolean;
  ladybug: boolean;
  leaves: Leaf[];
  rotation: number;
  scale: number;
  /** Its seed and care, for the kinds that roll a little more as they draw. */
  seed: number;
  care: number;
  /** Which colourway, and the petal roll (some kinds count fronds or barrels with it). */
  way: number;
  petalRoll: number;
  /** A clover with four leaves. */
  fourLeaf: boolean;
  /** The week it grew in (null: no weather recorded). */
  wind: number | null;
  mix: number | null;
  /** Petals in a colour from elsewhere: which petal, how many, and the colours. */
  cross: { level: number; petal: number; colours: readonly [string, string] } | null;
  /** Every petal leans this many degrees, and each is shaken by up to its jitter. */
  sweep: number;
  jitter: readonly number[];
  /** Petals the wind took (where around the ring each was, 0 to 1). */
  lost: readonly number[];
  /** The colours of the apps in the air while it grew (a prism aster's petals). */
  hues: readonly string[];
}

const PETALS: Partial<Record<FlowerKind, (roll: number) => number>> = {
  sunflower: (x) => 10 + Math.floor(x * 7),
  daisy: (x) => 10 + Math.floor(x * 9),
  violet: (x) => (x < 0.12 ? 6 : 5),
  poppy: (x) => (x < 0.2 ? 5 : 4),
  rose: (x) => 3 + Math.floor(x * 3),
  tulip: (x) => (x < 0.15 ? 4 : 3),
  cosmos: (x) => (x < 0.25 ? 7 : 8),
  marigold: (x) => 12 + Math.floor(x * 4),
  dandelion: (x) => 20 + Math.floor(x * 6),
  passionflower: () => 10,
  snowdrop: () => 3,
  'cherry-blossom': () => 5,
  lotus: () => 8,
  'storm-lily': () => 6,
  'prism-aster': (x) => 14 + Math.floor(x * 5),
};

const CAN_DOUBLE: ReadonlySet<FlowerKind> = new Set(['sunflower', 'daisy', 'poppy', 'cosmos', 'cactus', 'toadstool']);
/** Kinds whose petals can't be two-tone. */
const ONE_TONE: ReadonlySet<FlowerKind> = new Set([
  'rose',
  'dandelion',
  'clover',
  'moss',
  'fern',
  'hydrangea',
  'echeveria',
  'cactus',
  'strawberry',
  'toadstool',
  'monstera',
  'watermelon',
  'pumpkin',
  'prism-aster',
]);
/** Kinds a mixed sky doesn't cross-pollinate (their colour shows the sky some other way, or not at all). */
const NO_CROSS: ReadonlySet<FlowerKind> = new Set(['hydrangea', 'watermelon', 'prism-aster']);
/** Kinds whose main ring of petals the wind can strip. */
const LOSES: ReadonlySet<FlowerKind> = new Set(['sunflower', 'rose', 'daisy', 'violet', 'poppy', 'tulip', 'cosmos', 'marigold', 'passionflower', 'snowdrop', 'cherry-blossom', 'lotus', 'storm-lily', 'prism-aster']);

const clampCare = (care: number) => (Number.isFinite(care) ? Math.min(1, Math.max(0, care)) : 0);
const isLevel = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4;

export interface RarityOdds {
  /** Null where the kind can't grow that look. */
  twoTone: number | null;
  double: number | null;
  ladybug: number;
}

/** The chance of each rarer look for a kind, at this much care (0 to 1). */
export function rarityOdds(kind: FlowerKind, care: number): RarityOdds {
  const c = clampCare(care);
  return {
    twoTone: ONE_TONE.has(kind) ? null : 0.1 + 0.2 * c,
    double: CAN_DOUBLE.has(kind) ? 0.1 + 0.2 * c : null,
    ladybug: 0.025 + 0.055 * c,
  };
}

/** A colour for an app, the same everywhere. */
function hueOf(domain: string): string {
  return PRISM[hashSeed(domain) % PRISM.length]!;
}

/**
 * The look of one plant, from its seed (use flowerSeed), care and the week it grew in.
 * Same seed, care and week, same plant.
 */
export function variantFor(kind: FlowerKind, seed: number, care = 0, grew: GrewIn | null = null): Variant {
  const c = clampCare(care);
  const odds = rarityOdds(kind, c);
  const r = seeded(seed);
  const ways = COLOURWAYS[kind];
  let way = Math.floor(r() * ways.length);
  const petalRoll = r();
  const petals = PETALS[kind]?.(petalRoll) ?? 0;
  const between = (lo: number, hi: number) => lo + r() * (hi - lo);
  const leafCount = r() < 0.3 ? 3 : 2;
  const first = r() * 360;
  const leaves = Array.from({ length: leafCount }, (_, i) => ({
    angle: Math.round(first + (360 / leafCount) * i + between(-25, 25)),
    length: Number(between(0.8, 1.2).toFixed(2)),
  }));
  // Every roll is made whatever the kind, care or weather, so the rolls after it stay the same.
  const petalLength = between(0.88, 1.12);
  const petalWidth = between(0.82, 1.18);
  const centerSize = between(0.85, 1.2);
  const twoTone = r() < (odds.twoTone ?? 0);
  const double = r() < (odds.double ?? 0);
  const ladybug = r() < odds.ladybug;
  const rotation = Math.round(r() * 360);
  const scale = between(0.86, 1);
  // The weather's rolls, after all the others.
  const mixRoll = r();
  const pickRoll = r();
  const lostRoll = r();
  const extraRoll = r();
  const fourRoll = r();

  const wind = grew && isLevel(grew.wind) ? grew.wind : null;
  const mix = grew && isLevel(grew.mix) ? grew.mix : null;
  if (kind === 'hydrangea' && mix !== null) way = Math.max(0, Math.min(ways.length - 1, mix + (extraRoll < 0.25 ? -1 : extraRoll > 0.75 ? 1 : 0)));
  let cross: Variant['cross'] = null;
  if (mix !== null && !NO_CROSS.has(kind) && mixRoll < [0, 0.04, 0.45, 0.75, 1][mix]!) {
    let i = Math.floor(pickRoll * POLLEN.length);
    if (POLLEN[i]!.toLowerCase() === ways[way]![0].toLowerCase()) i = (i + 1) % POLLEN.length;
    cross = { level: Math.max(1, mix - 1), petal: Math.floor(pickRoll * Math.max(1, petals || 6)), colours: [POLLEN[i]!, POLLEN[(i + 3) % POLLEN.length]!] };
  }
  const shake = seeded(seed ^ 0x9e3779b9);
  const jitterDeg = wind === null ? 0 : [0, 1.5, 3, 5, 8][wind]!;
  const jitter = Array.from({ length: 24 }, () => (shake() * 2 - 1) * jitterDeg);
  const lostCount = wind === 4 ? 1 + (lostRoll < 0.55 ? 1 : 0) : wind === 3 ? (lostRoll < 0.35 ? 1 : 0) : 0;
  const at = shake();
  const lost = LOSES.has(kind) ? [at, (at + 0.5) % 1].slice(0, lostCount) : [];
  const apps = (grew?.apps ?? []).filter((a) => typeof a === 'string');
  const hues = apps.length >= 3 ? apps.map(hueOf) : PRISM.slice(seed % 3).concat(PRISM.slice(0, seed % 3)).slice(0, 7);
  return {
    colourway: ways[way]!,
    petals,
    petalLength: Number((petalLength * (1 + 0.08 * c)).toFixed(2)),
    petalWidth: Number(petalWidth.toFixed(2)),
    centerSize: Number(centerSize.toFixed(2)),
    twoTone,
    double,
    ladybug,
    leaves,
    rotation,
    scale: Number(Math.min(1, scale + 0.08 * c).toFixed(2)),
    seed,
    care: c,
    way,
    petalRoll,
    fourLeaf: kind === 'clover' && fourRoll < 0.03 + 0.12 * c,
    wind,
    mix,
    cross,
    sweep: wind === null ? 0 : [0, 3, 8, 14, 21][wind]!,
    jitter,
    lost,
    hues,
  };
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Match server/garden.ts. */
export const SPROUT_DAYS = 2;
export const GROW_DAYS = 7;

/** A sprout, then a bud, then in bloom; every plant in a closed patch is in bloom. */
export function stageFor(plantedAt: string, now: number, open = true): Stage {
  if (!open) return 'bloom';
  const age = now - Date.parse(plantedAt);
  if (!Number.isFinite(age) || age < SPROUT_DAYS * DAY_MS) return 'sprout';
  if (age < GROW_DAYS * DAY_MS) return 'bud';
  return 'bloom';
}

/** When a plant planted at `plantedAt` blooms (ms since the epoch). */
export function bloomsAt(plantedAt: string): number {
  return Date.parse(plantedAt) + GROW_DAYS * DAY_MS;
}

/* ---------- drawing ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const f2 = (n: number) => n.toFixed(2);
type Attrs = Record<string, string | number>;
type El = SVGElement;

/** Makes svg nodes for one drawing. */
interface Pen {
  el(tag: string, attrs: Attrs, kids?: El[]): El;
  g(kids: El[], transform?: string): El;
  circle(r: number, fill: string, cx?: number, cy?: number, extra?: Attrs): El;
  ellipse(rx: number, ry: number, fill: string, transform?: string | null, cx?: number, cy?: number): El;
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, extra?: Attrs): El;
  path(d: string, attrs: Attrs): El;
}

function pen(doc: Document): Pen {
  const el = (tag: string, attrs: Attrs, kids: El[] = []): El => {
    const node = doc.createElementNS(SVG_NS, tag) as El;
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, typeof value === 'number' ? f2(value) : value);
    if (kids.length) node.append(...kids);
    return node;
  };
  return {
    el,
    g: (kids, transform) => el('g', transform ? { transform } : {}, kids),
    circle: (r, fill, cx = 0, cy = 0, extra = {}) => el('circle', { cx, cy, r, fill, ...extra }),
    ellipse: (rx, ry, fill, transform, cx = 0, cy = 0) => el('ellipse', transform ? { cx, cy, rx, ry, fill, transform } : { cx, cy, rx, ry, fill }),
    line: (x1, y1, x2, y2, stroke, width, extra = {}) => el('line', { x1, y1, x2, y2, stroke, 'stroke-width': width, 'stroke-linecap': 'round', ...extra }),
    path: (d, attrs) => el('path', { d, ...attrs }),
  };
}

const n2 = (n: number) => String(Math.round(n * 100) / 100);
const rot = (deg: number) => `rotate(${n2(deg)})`;
const move = (x: number, y: number) => `translate(${n2(x)} ${n2(y)})`;

/** Petal shapes, centred on 0,0 and pointing up. */
type Shape = (p: Pen, rx: number, ry: number, fill: string) => El;
const pointed: Shape = (p, rx, ry, fill) => p.path(`M0 ${n2(ry)} Q${n2(rx * 1.25)} 0 0 ${n2(-ry)} Q${n2(-rx * 1.25)} 0 0 ${n2(ry)}Z`, { fill });
const SHAPES = {
  oval: (p: Pen, rx: number, ry: number, fill: string) => p.ellipse(rx, ry, fill),
  point: pointed,
  notch: (p: Pen, rx: number, ry: number, fill: string) =>
    p.path(
      `M0 ${n2(ry)} C${n2(rx * 1.1)} ${n2(ry * 0.5)} ${n2(rx * 1.1)} ${n2(-ry * 0.5)} ${n2(rx * 0.8)} ${n2(-ry)} L${n2(rx * 0.32)} ${n2(-ry * 0.72)} L0 ${n2(-ry * 0.95)} L${n2(-rx * 0.32)} ${n2(-ry * 0.72)} L${n2(-rx * 0.8)} ${n2(-ry)} C${n2(-rx * 1.1)} ${n2(-ry * 0.5)} ${n2(-rx * 1.1)} ${n2(ry * 0.5)} 0 ${n2(ry)}Z`,
      { fill },
    ),
  heart: (p: Pen, rx: number, ry: number, fill: string) =>
    p.path(
      `M0 ${n2(ry)} C${n2(rx * 1.2)} ${n2(ry * 0.3)} ${n2(rx * 1.1)} ${n2(-ry)} ${n2(rx * 0.35)} ${n2(-ry)} Q0 ${n2(-ry)} 0 ${n2(-ry * 0.72)} Q0 ${n2(-ry)} ${n2(-rx * 0.35)} ${n2(-ry)} C${n2(-rx * 1.1)} ${n2(-ry)} ${n2(-rx * 1.2)} ${n2(ry * 0.3)} 0 ${n2(ry)}Z`,
      { fill },
    ),
  bolt: (p: Pen, rx: number, ry: number, fill: string): El =>
    p.g([
      pointed(p, rx, ry, fill),
      p.path(`M0 ${n2(ry * 0.72)} L${n2(rx * 0.32)} ${n2(ry * 0.1)} L${n2(-rx * 0.28)} ${n2(-ry * 0.1)} L${n2(rx * 0.2)} ${n2(-ry * 0.7)}`, {
        fill: 'none',
        stroke: '#FFE37A',
        'stroke-width': 0.55,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    ]),
} satisfies Record<string, Shape>;
type ShapeName = keyof typeof SHAPES;

interface RingOpts {
  n: number;
  dist: number;
  rx: number;
  ry: number;
  turn?: number;
  fill: (i: number) => string;
  shape?: Shape;
  /** The ring the wind can strip. */
  main?: boolean;
}

/** A ring of `n` petals pointing out from the middle, leaning and shaken by the week's wind. */
function ring(p: Pen, v: Variant, o: RingOpts): El[] {
  const shape = o.shape ?? SHAPES.oval;
  const lost = o.main ? new Set(v.lost.map((f) => Math.floor(f * o.n))) : null;
  const out: El[] = [];
  for (let i = 0; i < o.n; i++) {
    if (lost?.has(i)) continue;
    const angle = (360 / o.n) * i + (o.turn ?? 0) + (v.jitter[i % v.jitter.length] ?? 0);
    const t = v.sweep ? `${rot(angle)} ${move(0, -o.dist)} ${rot(v.sweep)}` : `${rot(angle)} ${move(0, -o.dist)}`;
    out.push(p.g([shape(p, o.rx, o.ry, o.fill(i))], t));
  }
  return out;
}

/** Petal colours: the colourway, two-tone with care, and petals from elsewhere under a mixed sky. */
function petalFill(v: Variant): (i: number) => string {
  const [petal, petal2] = v.colourway;
  return (i) => {
    const base = v.twoTone && i % 2 === 1 ? petal2 : petal;
    const x = v.cross;
    if (!x) return base;
    if (x.level === 1) return i === x.petal ? x.colours[0] : base;
    if (x.level === 2) return i % 3 === x.petal % 3 ? x.colours[0] : base;
    return i % 2 === 0 ? base : (i >> 1) % 2 === 0 ? x.colours[0] : x.colours[1];
  };
}

function leavesOf(p: Pen, v: Variant, o: { rx?: number; ry?: number; dist?: number; colours?: readonly string[] } = {}): El[] {
  const rx = o.rx ?? 7.5;
  const ry = o.ry ?? 3.4;
  const dist = o.dist ?? 11;
  const colours = o.colours ?? LEAF_COLOURS;
  return v.leaves.map((leaf, i) => p.ellipse(rx * leaf.length, ry, colours[i % colours.length]!, rot(leaf.angle), dist * leaf.length, 0));
}

function ladybug(p: Pen, leaf: Leaf): El {
  return p.g(
    [p.circle(1.3, '#2A1F14', 2.6, 0), p.circle(2.5, '#D9443A'), p.path('M-2.5 0 L2.5 0', { stroke: '#2A1F14', 'stroke-width': 0.6 }), p.circle(0.55, '#2A1F14', -1, -1), p.circle(0.55, '#2A1F14', -1, 1)],
    `${rot(leaf.angle)} ${move(13 * leaf.length, 0)}`,
  );
}

function trefoil(p: Pen, s: number, four: boolean, turn = 0): El[] {
  const n = four ? 4 : 3;
  const out: El[] = [];
  for (let i = 0; i < n; i++) {
    const colour = LEAF_COLOURS[i % 2]!;
    out.push(
      p.g(
        [
          p.path(`M0 0 L${n2(-3.4 * s)} ${n2(-4.6 * s)} L${n2(3.4 * s)} ${n2(-4.6 * s)}Z`, { fill: colour }),
          p.circle(2.6 * s, colour, -1.6 * s, -5.2 * s),
          p.circle(2.6 * s, colour, 1.6 * s, -5.2 * s),
          p.path(`M${n2(-1.8 * s)} ${n2(-5.8 * s)} Q0 ${n2(-3.8 * s)} ${n2(1.8 * s)} ${n2(-5.8 * s)}`, { fill: 'none', stroke: '#BFE6B0', 'stroke-width': 0.5, 'stroke-linecap': 'round' }),
        ],
        rot(turn + (360 / n) * i),
      ),
    );
  }
  out.push(p.circle(s, LEAF_COLOURS[1]));
  return out;
}

function mossCushion(p: Pen, v: Variant, radius: number, count: number): El[] {
  const r = seeded(v.seed ^ 0x3055);
  const out: El[] = [];
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * radius;
    const size = 1.6 + r() * 2.2;
    out.push(p.circle(size, v.colourway[Math.floor(r() * 4)]!, Math.cos(a) * d, Math.sin(a) * d));
  }
  return out;
}

function frond(p: Pen, v: Variant, i: number): El[] {
  const [a, b, rib] = v.colourway;
  const L = v.petalLength;
  const out: El[] = [p.line(0, -1.2, 0, -16 * L, rib, 0.7)];
  for (let t = 0; t < 8; t++) {
    const y = -3 - t * 1.75 * L;
    const z = (1 - t / 9) * 2.7;
    const colour = v.cross && t >= 6 ? v.cross.colours[i % 2]! : t % 2 ? b : a;
    out.push(p.ellipse(z, 0.95, colour, `rotate(-28 ${n2(z * 0.9)} ${n2(y)})`, z * 0.9, y), p.ellipse(z, 0.95, colour, `rotate(28 ${n2(-z * 0.9)} ${n2(y)})`, -z * 0.9, y));
  }
  return out;
}

function lavenderSpikes(p: Pen, v: Variant, open: boolean): El[] {
  const [a, b] = v.colourway;
  const n = 5 + Math.floor(v.petalRoll * 5);
  const out: El[] = [];
  for (let i = 0; i < n; i++) {
    const spike: El[] = [p.line(0, -2, 0, -15 * v.petalLength, '#7FA37A', 0.6)];
    for (let t = 0; t < 6; t++) {
      let colour = open ? (t % 2 ? b : a) : '#B9C7B0';
      if (open && v.cross && (t + i) % (5 - v.cross.level) === 0) colour = v.cross.colours[t % 2]!;
      spike.push(p.ellipse(1.35 * v.petalWidth, 1, colour, null, 0, -(7 + t * 1.35) * v.petalLength));
    }
    out.push(p.g(spike, rot((360 / n) * i + (v.jitter[i] ?? 0) * 2 + v.sweep * 0.8)));
  }
  return out;
}

function lavenderTuft(p: Pen, v: Variant): El[] {
  return Array.from({ length: 7 }, (_, i) => p.ellipse(0.9, 6, '#8FAE8A', `${rot(i * 51 + v.leaves[0]!.angle)} ${move(0, -4)}`));
}

function hydrangeaDome(p: Pen, v: Variant, colours: readonly string[]): El[] {
  const r = seeded(v.seed ^ 0x4d2);
  const spots: Array<[number, number]> = [[0, 0]];
  for (let i = 0; i < 6; i++) spots.push([Math.cos((i / 6) * Math.PI * 2) * 4.7, Math.sin((i / 6) * Math.PI * 2) * 4.7]);
  for (let i = 0; i < 11; i++) spots.push([Math.cos((i / 11) * Math.PI * 2 + 0.3) * 9.2, Math.sin((i / 11) * Math.PI * 2 + 0.3) * 9.2]);
  return spots.map(([x, y]) => {
    const turn = r() * 90;
    const colour = r() < 0.5 ? colours[0]! : colours[1]!;
    const floret = Array.from({ length: 4 }, (_, q) => p.ellipse(1.55 * v.petalWidth, 1.75, colour, `${rot(q * 90)} ${move(0, -1.5)}`));
    return p.g([...floret, p.circle(0.55, colours[3]!)], `${move(x, y)} ${rot(turn)}`);
  });
}

function rosette(p: Pen, v: Variant, full: boolean): El[] {
  const [a, b, mid] = v.colourway;
  const n = 8 + Math.floor(v.petalRoll * 3);
  const L = v.petalLength;
  const W = v.petalWidth;
  const tip = v.wind !== null && v.wind >= 3 ? '#E0687A' : v.cross ? v.cross.colours[0] : null;
  const leaf: Shape = (pp, rx, ry, fill) => (tip && full ? pp.g([SHAPES.point(pp, rx, ry, fill), pp.ellipse(rx * 0.35, ry * 0.28, tip, null, 0, -ry * 0.68)]) : SHAPES.point(pp, rx, ry, fill));
  return [
    ...(full ? ring(p, v, { n, dist: 9 * L, rx: 3.6 * W, ry: 6 * L, fill: () => a, shape: leaf }) : []),
    ...ring(p, v, { n: n - 1, dist: 5.8 * L, rx: 3 * W, ry: 4.8 * L, turn: 180 / n, fill: () => b, shape: leaf }),
    ...ring(p, v, { n: 5, dist: 2.8, rx: 2, ry: 3, turn: 20, fill: () => a, shape: SHAPES.point }),
    p.circle(1.4, mid),
  ];
}

function cactusBarrels(p: Pen, v: Variant, flowering: boolean): El[] {
  const [body, rib, flower, middle] = v.colourway;
  const count = v.petalRoll < 0.6 ? 1 : v.petalRoll < 0.9 ? 2 : 3;
  const spots: Array<[number, number, number]> = [
    [0, 0, 10],
    [-4.5, 3, 8.2],
    [6, -5, 5.4],
    [-3, -8.5, 4.4],
  ];
  const used = count === 1 ? [spots[0]!] : count === 2 ? [spots[1]!, spots[2]!] : [spots[1]!, spots[2]!, spots[3]!];
  return used.map(([x, y, size], i) => {
    const R = size * v.petalLength;
    const parts: El[] = [p.circle(R, body)];
    const ribs = 10 + Math.round(R / 2);
    for (let k = 0; k < ribs; k++) parts.push(p.g([p.line(0, -R * 0.18, 0, -R * 0.94, rib, 0.5), p.circle(0.42, '#F4EFDC', 0, -R * 0.55), p.circle(0.42, '#F4EFDC', 0, -R * 0.84)], rot((360 / ribs) * k)));
    if (flowering && (i === 0 || v.double)) {
      const colour = v.cross ? v.cross.colours[0] : flower;
      parts.push(...ring(p, v, { n: 7, dist: 2.6, rx: 1.7, ry: 3, fill: () => colour }), p.circle(1.2, middle));
    }
    if (!flowering && i === 0) parts.push(p.circle(1.4, '#F4A6C1'));
    return p.g(parts, move(x, y));
  });
}

function berry(p: Pen, colour: string, seeds: string): El {
  const parts: El[] = [p.path('M0 -3.6 C3.2 -3.6 3.4 -0.6 2.2 1.8 C1.2 3.6 -1.2 3.6 -2.2 1.8 C-3.4 -0.6 -3.2 -3.6 0 -3.6Z', { fill: colour })];
  for (const [x, y] of [
    [-1, -1.6],
    [1, -1.4],
    [0, 0],
    [-1.2, 1],
    [1.1, 1.2],
    [0, 2.2],
  ] as const)
    parts.push(p.ellipse(0.28, 0.4, seeds, null, x, y));
  for (let q = 0; q < 5; q++) parts.push(p.ellipse(0.6, 1.3, '#3E9A4A', `${move(0, -3.8)} ${rot(q * 72)} ${move(0, -1)}`));
  return p.g(parts);
}

function strawberryLeaves(p: Pen, v: Variant): El[] {
  return v.leaves.map((leaf, i) =>
    p.g(
      [-38, 0, 38].map((d, j) => p.ellipse(2.9, 4.3, LEAF_COLOURS[(i + j) % 2]!, `${rot(d)} ${move(0, -4.6)}`)),
      `${rot(leaf.angle + 90)} ${move(0, -7.5)}`,
    ),
  );
}

function bigLeaves(p: Pen, v: Variant, R: number): El[] {
  return v.leaves.map((leaf, i) => {
    const colour = LEAF_COLOURS[i % 2]!;
    const vein = { opacity: 0.7 };
    return p.g(
      [
        p.circle(R, colour, 0, -R * 0.2),
        p.circle(R * 0.85, colour, -R * 0.7, R * 0.55),
        p.circle(R * 0.85, colour, R * 0.7, R * 0.55),
        p.line(0, 0, 0, -R * 0.9, '#7FCB7F', 0.4, vein),
        p.line(0, 0, -R * 0.9, R * 0.6, '#7FCB7F', 0.4, vein),
        p.line(0, 0, R * 0.9, R * 0.6, '#7FCB7F', 0.4, vein),
      ],
      `${rot(leaf.angle)} ${move(0, -11)}`,
    );
  });
}

function vine(p: Pen, v: Variant): El {
  return p.path('M0 0 C4 -2 7 -1 9 2 C11 5 14 4 14.5 2 C15 0.5 13.5 0 13 1', { fill: 'none', stroke: '#4E8F3A', 'stroke-width': 0.8, 'stroke-linecap': 'round', transform: rot(v.leaves[0]!.angle + 150) });
}

function melonBlossom(p: Pen, v: Variant): El {
  return p.g([...ring(p, v, { n: 5, dist: 2.2, rx: 1.8, ry: 3, fill: () => '#FFC93C', shape: SHAPES.point }), p.circle(1.2, '#F5A623')], move(2, 1));
}

function lilyPad(p: Pen): El[] {
  const a = (8 * Math.PI) / 180;
  const out: El[] = [p.path(`M0 0 L${n2(17 * Math.cos(-a))} ${n2(17 * Math.sin(-a))} A17 17 0 1 0 ${n2(17 * Math.cos(a))} ${n2(17 * Math.sin(a))} Z`, { fill: '#4E9A4A' })];
  for (let i = 0; i < 9; i++) out.push(p.line(0, 0, 0, -15, '#6BB35F', 0.45, { transform: rot(i * 36 + 36) }));
  return out;
}

const cherrySpots: ReadonlyArray<readonly [number, number, number]> = [
  [2, -1, 1],
  [-8, 6, 0.85],
  [10, -8, 0.9],
  [9, 5, 0.75],
  [-3, -7, 0.7],
];

function cherryTwig(p: Pen): El[] {
  return [
    p.path('M-15 11 C-8 6 -3 3 2 -1 C6 -4 10 -8 15 -12 M2 -1 C4 3 7 5 11 6', { fill: 'none', stroke: '#6B4A3A', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
    p.ellipse(3, 1.4, '#8DA34A', 'rotate(-30)', -6, 1),
    p.ellipse(3, 1.4, '#A0864A', 'rotate(20)', 9, 4),
  ];
}

interface KindDrawing {
  /** The bloom, inside the turned and scaled group. */
  bloom(p: Pen, v: Variant): El[];
  /** Its own bud (a plain green bud with a dot of its colour, by default). */
  bud?(p: Pen, v: Variant): El[];
  /** What grows under the bloom: two or three leaves by default, or nothing. */
  foliage?: ((p: Pen, v: Variant) => El[]) | null;
  /** The shape of a petal the wind took. */
  petal?: ShapeName;
  /** What the wind carried off, drawn outside the turn so it all blows the same way across the patch. */
  drift?(p: Pen, v: Variant): El[];
  /** The leaf a ladybug sits on. */
  bugLeaf?: number;
}

const DRAWINGS: Record<FlowerKind, KindDrawing> = {
  sunflower: {
    bloom(p, v) {
      const [, petal2, mid, core] = v.colourway;
      const out = ring(p, v, { n: v.petals, dist: 11 * v.petalLength, rx: 3.6 * v.petalWidth, ry: 6.6 * v.petalLength, fill: petalFill(v), main: true });
      if (v.double) out.push(...ring(p, v, { n: v.petals, dist: 8 * v.petalLength, rx: 3 * v.petalWidth, ry: 5 * v.petalLength, turn: 180 / v.petals, fill: () => petal2 }));
      out.push(p.circle(7.2 * v.centerSize, mid), p.circle(4.2 * v.centerSize, core));
      return out;
    },
  },
  daisy: {
    bloom(p, v) {
      const [, petal2, mid, core] = v.colourway;
      const out = ring(p, v, { n: v.petals, dist: 10 * v.petalLength, rx: 2.4 * v.petalWidth, ry: 6.6 * v.petalLength, fill: petalFill(v), main: true });
      if (v.double) out.push(...ring(p, v, { n: v.petals, dist: 7 * v.petalLength, rx: 2 * v.petalWidth, ry: 4.6 * v.petalLength, turn: 180 / v.petals, fill: () => petal2 }));
      out.push(p.circle(4.6 * v.centerSize, mid), p.circle(2 * v.centerSize, core));
      return out;
    },
  },
  violet: {
    bloom(p, v) {
      const [, , mid, core] = v.colourway;
      return [...ring(p, v, { n: v.petals, dist: 7 * v.petalLength, rx: 6.6 * v.petalWidth, ry: 6.6 * v.petalWidth, fill: petalFill(v), main: true }), p.circle(2.8 * v.centerSize, mid), p.circle(1.2 * v.centerSize, core)];
    },
  },
  poppy: {
    bloom(p, v) {
      const [, petal2, mid, core] = v.colourway;
      const out = ring(p, v, { n: v.petals, dist: 6 * v.petalLength, rx: 8.4 * v.petalWidth, ry: 8.4 * v.petalWidth, fill: petalFill(v), main: true });
      if (v.double) out.push(...ring(p, v, { n: v.petals, dist: 3.6 * v.petalLength, rx: 5.6 * v.petalWidth, ry: 5.6 * v.petalWidth, turn: 180 / v.petals, fill: () => petal2 }));
      out.push(p.circle(3.8 * v.centerSize, mid), p.circle(1.6 * v.centerSize, core));
      return out;
    },
  },
  rose: {
    // concentric petals, each a little off-centre, darkening towards the middle
    bloom(p, v) {
      const shades = v.colourway;
      const lost = new Set(v.lost.map((f) => 1 + Math.floor(f * Math.max(1, v.petals - 1))));
      const out: El[] = [];
      for (let k = 0; k < v.petals; k++) {
        if (lost.has(k) && k < v.petals - 1) continue;
        const r = 11.5 * v.petalWidth * (1 - k / (v.petals + 0.6));
        const wobble = (((k % 2 === 0 ? 1 : -1) * 0.7 * (k + 1)) / v.petals) * (1 + v.sweep / 6);
        let fill = shades[Math.min(shades.length - 1, Math.round((k / Math.max(1, v.petals - 1)) * 3))]!;
        if (v.cross && k === 1) fill = v.cross.colours[0];
        if (v.cross && v.cross.level >= 3 && k === 3) fill = v.cross.colours[1];
        out.push(p.circle(r, fill, wobble, -wobble));
      }
      return out;
    },
  },
  tulip: {
    bloom(p, v) {
      return [...ring(p, v, { n: v.petals, dist: 5 * v.petalLength, rx: 6 * v.petalWidth, ry: 8.6 * v.petalLength, fill: petalFill(v), main: true }), p.circle(3.6 * v.centerSize, v.colourway[2])];
    },
  },
  cosmos: {
    petal: 'notch',
    bloom(p, v) {
      const [, petal2, mid, core] = v.colourway;
      const out = ring(p, v, { n: v.petals, dist: 9 * v.petalLength, rx: 4.4 * v.petalWidth, ry: 6.6 * v.petalLength, fill: petalFill(v), shape: SHAPES.notch, main: true });
      if (v.double) out.push(...ring(p, v, { n: v.petals, dist: 6 * v.petalLength, rx: 3.2 * v.petalWidth, ry: 4.6 * v.petalLength, turn: 180 / v.petals, fill: () => petal2, shape: SHAPES.notch }));
      out.push(p.circle(3.3 * v.centerSize, mid));
      for (let q = 0; q < 8; q++) out.push(p.circle(0.4, core, 0, 0, { transform: `${rot(q * 45)} ${move(0, -1.8)}` }));
      return out;
    },
  },
  marigold: {
    bloom(p, v) {
      const [a, b, mid] = v.colourway;
      return [
        ...ring(p, v, { n: v.petals, dist: 9.4 * v.petalLength, rx: 3.3 * v.petalWidth, ry: 3.6 * v.petalWidth, fill: petalFill(v), main: true }),
        ...ring(p, v, { n: v.petals - 3, dist: 6.3 * v.petalLength, rx: 3.1 * v.petalWidth, ry: 3.3 * v.petalWidth, turn: 15, fill: () => b }),
        ...ring(p, v, { n: 7, dist: 3.3, rx: 2.6, ry: 2.6, turn: 7, fill: (i) => (i % 2 ? a : b) }),
        p.circle(1.8, mid),
      ];
    },
  },
  dandelion: {
    foliage: (p, v) => leavesOf(p, v, { rx: 8.6, ry: 2.6 }),
    // a yellow head in a still week; in the wind it goes to seed, and storms take the seeds
    bloom(p, v) {
      const [, b, mid] = v.colourway;
      if (v.wind === null || v.wind <= 1) {
        return [
          ...ring(p, v, { n: v.petals, dist: 7.4 * v.petalLength, rx: 1.3 * v.petalWidth, ry: 4.6 * v.petalLength, fill: petalFill(v) }),
          ...ring(p, v, { n: v.petals - 6, dist: 4.4 * v.petalLength, rx: 1.1 * v.petalWidth, ry: 3.2 * v.petalLength, turn: 7, fill: () => b }),
          p.circle(2.2, mid),
        ];
      }
      const r = seeded(v.seed ^ 0xd00d);
      const gone = v.wind === 4 ? 0.6 : v.wind === 3 ? 0.3 : 0;
      const out: El[] = [];
      for (let i = 0; i < 30; i++) {
        const angle = 12 * i + r() * 6;
        if (r() < gone) continue;
        out.push(p.g([p.line(0, -1.8, 0, -10.6 * v.petalLength, '#EDE6D3', 0.42), p.circle(1, '#FFFDF5', 0, -11 * v.petalLength, { opacity: 0.95 })], rot(angle)));
      }
      out.push(p.circle(2.4, '#9C8A5A'), p.circle(1.2, '#7A6A40'));
      return out;
    },
    drift(p, v) {
      if (v.wind === null || v.wind < 3) return [];
      const seeds: ReadonlyArray<readonly [number, number, number]> = v.wind === 4 ? [[14, 4, 20], [17.5, 11, 35], [12, 16, 10]] : [[15, 7, 25]];
      return seeds.map(([x, y, a]) => p.g([p.line(0, 0, 0, -3.2, '#EDE6D3', 0.35), p.circle(0.8, '#FFFDF5', 0, -3.4)], `${move(x, y)} ${rot(a)}`));
    },
  },
  clover: {
    foliage: null,
    bugLeaf: 1,
    bloom(p, v) {
      const [a, b, mid] = v.colourway;
      const out: El[] = [];
      for (const leaf of v.leaves.slice(1)) out.push(p.g(trefoil(p, 0.8, false, 20), `${rot(leaf.angle)} ${move(10 * leaf.length, 0)}`));
      out.push(...trefoil(p, 1.2, v.fourLeaf));
      const fill = v.cross ? (i: number) => (i % 2 ? v.cross!.colours[0] : a) : (i: number) => (i % 2 ? b : a);
      const head = v.leaves[0]!;
      out.push(p.g([p.circle(4, b), ...ring(p, v, { n: 12, dist: 3.4, rx: 0.95, ry: 2, fill }), p.circle(1.6, mid)], `${rot(head.angle)} ${move(11 * head.length, 0)}`));
      return out;
    },
    bud(p, v) {
      const head = v.leaves[0]!;
      return [...trefoil(p, 1, false), p.g([p.circle(2.4, '#DDEBD0')], `${rot(head.angle)} ${move(10 * head.length, 0)}`)];
    },
  },
  moss: {
    foliage: null,
    bloom(p, v) {
      const out = mossCushion(p, v, 12, 34);
      const r = seeded(v.seed ^ 0x5a1);
      const stalks = 4 + Math.round(v.care * 6);
      for (let i = 0; i < stalks; i++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * 9;
        const turn = r() * 360 + v.sweep * 3;
        const length = 4 + r() * 3;
        const capsule = v.cross && i % 2 === 0 ? v.cross.colours[0] : '#B5652E';
        out.push(p.g([p.line(0, 0, 0, -length, '#C08A4A', 0.45), p.ellipse(0.7, 1.2, capsule, null, 0, -length)], `${move(Math.cos(a) * d, Math.sin(a) * d)} ${rot(turn)}`));
      }
      return out;
    },
    bud: (p, v) => mossCushion(p, v, 8, 20),
  },
  fern: {
    foliage: null,
    bloom(p, v) {
      const n = 5 + Math.floor(v.petalRoll * 4);
      const out: El[] = [];
      for (let i = 0; i < n; i++) out.push(p.g(frond(p, v, i), rot((360 / n) * i + (v.jitter[i] ?? 0) * 2 + v.sweep * 0.6)));
      out.push(p.circle(1.4, v.colourway[3]));
      return out;
    },
    bud(p, v) {
      const curls = [0, 120, 240].map((a) => p.path('M0 0 C0 -5 1 -8 4 -8 C6.5 -8 7 -5 5 -4 C3.5 -3.3 3 -5 4 -5.5', { fill: 'none', stroke: v.colourway[0], 'stroke-width': 1.5, 'stroke-linecap': 'round', transform: rot(a) }));
      return [...curls, p.circle(1.4, v.colourway[3])];
    },
  },
  lavender: {
    foliage: lavenderTuft,
    bloom: (p, v) => lavenderSpikes(p, v, true),
    bud: (p, v) => [...lavenderTuft(p, v), ...lavenderSpikes(p, v, false)],
  },
  hydrangea: {
    foliage: (p, v) => leavesOf(p, v, { rx: 8.5, ry: 4.6, dist: 12 }),
    bloom: (p, v) => hydrangeaDome(p, v, v.colourway),
    bud: (p, v) => [...leavesOf(p, v, { rx: 8.5, ry: 4.6, dist: 12 }), ...hydrangeaDome(p, v, ['#CFE3B8', '#BFD9A5', '#BFD9A5', '#E6F0D8'])],
  },
  echeveria: {
    foliage: null,
    bloom(p, v) {
      const out = rosette(p, v, true);
      out.push(p.line(3, 0, 15, -4.5, '#C9A27A', 0.7));
      for (const [x, y] of [
        [11, -3.2],
        [13, -3.9],
        [15, -4.5],
      ] as const)
        out.push(p.circle(1.3, '#FF8A65', x, y), p.circle(0.5, '#FFD54F', x, y));
      return out;
    },
    bud: (p, v) => rosette(p, v, false),
  },
  cactus: {
    foliage: null,
    bloom: (p, v) => cactusBarrels(p, v, true),
    bud: (p, v) => cactusBarrels(p, v, false),
  },
  strawberry: {
    foliage: strawberryLeaves,
    bloom(p, v) {
      const [colour, , seeds] = v.colourway;
      const berries = 1 + Math.floor(v.care * 3.2);
      const start = v.leaves[0]!.angle + 60;
      const out: El[] = [];
      for (let i = 0; i < berries; i++) out.push(p.g([berry(p, colour, seeds)], `${rot(start + i * 70)} ${move(0, -8.5)}`));
      const petal = v.cross ? v.cross.colours[0] : '#FFFFFF';
      out.push(...ring(p, v, { n: 5, dist: 2.3, rx: 2, ry: 2, fill: () => petal }), p.circle(1.5, '#F5C84A'));
      return out;
    },
    bud: (p, v) => [...strawberryLeaves(p, v), p.circle(2.4, '#F4F1E8'), ...ring(p, v, { n: 5, dist: 2.2, rx: 0.7, ry: 1.4, fill: () => '#3E9A4A' })],
  },
  toadstool: {
    foliage: (p, v) => Array.from({ length: 5 }, (_, i) => p.ellipse(0.8, 5.5, LEAF_COLOURS[i % 2]!, `${rot(v.leaves[0]!.angle + i * 72)} ${move(0, -9)}`)),
    bloom(p, v) {
      const [cap, spots, rim] = v.colourway;
      const spot = v.cross ? v.cross.colours[0] : spots;
      const r = seeded(v.seed ^ 0x70ad);
      if (v.double) {
        // a fairy ring
        return Array.from({ length: 7 }, (_, i) => {
          const a = (i / 7) * Math.PI * 2;
          const R = 2.6 + r() * 1.2;
          return p.g(
            [p.circle(R, cap), p.circle(R - 0.2, 'none', 0, 0, { stroke: rim, 'stroke-width': 0.4 }), p.circle(R * 0.28, spot, -R * 0.3, -R * 0.25), p.circle(R * 0.2, spot, R * 0.35, R * 0.2)],
            move(Math.cos(a) * 10.5, Math.sin(a) * 10.5),
          );
        });
      }
      const R = 9 * v.petalLength;
      const out: El[] = [p.circle(R, cap), p.circle(R - 0.4, 'none', 0, 0, { stroke: rim, 'stroke-width': 0.7 })];
      const count = 5 + Math.floor(r() * 4);
      for (let i = 0; i < count; i++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * (R - 2.2);
        out.push(p.circle(0.8 + r() * 0.9, spot, Math.cos(a) * d, Math.sin(a) * d));
      }
      return out;
    },
    bud(p, v) {
      return [...(DRAWINGS.toadstool.foliage?.(p, v) ?? []), p.circle(3.6, '#F1E6CF'), p.circle(3.2, 'none', 0, 0, { stroke: '#D8C9A8', 'stroke-width': 0.5 })];
    },
  },
  monstera: {
    foliage: null,
    bloom(p, v) {
      const [a, b, vein, middle] = v.colourway;
      const n = v.petalRoll < 0.4 ? 4 : 3;
      const r = seeded(v.seed ^ 0x3057);
      const out: El[] = [];
      for (let i = 0; i < n; i++) {
        const colour = i % 2 ? b : a;
        const leaf: El[] = [];
        for (let f = -3; f <= 3; f++) leaf.push(p.ellipse(1.55 * v.petalWidth, 6.2 * v.petalLength, colour, `${rot(f * 17)} ${move(0, -8.4)}`));
        leaf.push(p.circle(3, colour, 0, -3.4), p.line(0, -1, 0, -13, vein, 0.35, { opacity: 0.6 }));
        // a mixed sky: cream speckles
        if (v.cross) for (let q = 0; q < 9; q++) leaf.push(p.g([p.circle(0.5 + r() * 0.5, '#F4EFDC')], `${rot((Math.floor(r() * 7) - 3) * 17)} ${move((r() - 0.5) * 1.6, -(4 + r() * 9))}`));
        out.push(p.g(leaf, rot((360 / n) * i + (v.jitter[i] ?? 0) * 2 + v.sweep * 0.5)));
      }
      out.push(p.circle(1.6, middle));
      return out;
    },
    bud: (p, v) => [p.ellipse(1.8, 7, '#7CC47A', `${rot(v.leaves[0]!.angle)} ${move(0, -6)}`), p.ellipse(5, 2.6, LEAF_COLOURS[1], rot(v.leaves[1]!.angle), 6, 0)],
  },
  passionflower: {
    bloom(p, v) {
      const [petal, tips, base, middle] = v.colourway;
      const out = ring(p, v, { n: 10, dist: 8.4 * v.petalLength, rx: 2.6 * v.petalWidth, ry: 6.4 * v.petalLength, fill: v.cross ? () => petal : petalFill(v), main: true });
      const outer = v.cross ? v.cross.colours[0] : tips;
      for (let i = 0; i < 40; i++) {
        const tip = i % 2 && v.cross && v.cross.level >= 3 ? v.cross.colours[1] : outer;
        out.push(p.g([p.line(0, -3.6, 0, -5.4, base, 0.45), p.line(0, -5.4, 0, -7, '#FFFFFF', 0.45), p.line(0, -7, 0, -10.2 * v.petalLength, tip, 0.45)], rot(9 * i + v.sweep * 0.5)));
      }
      out.push(p.circle(2.6, middle));
      for (let q = 0; q < 5; q++) out.push(p.ellipse(0.9, 1.7, '#E8C547', `${rot(q * 72)} ${move(0, -3)}`));
      for (let q = 0; q < 3; q++) out.push(p.circle(0.55, '#7A3E8A', 0, 0, { transform: `${rot(q * 120 + 36)} ${move(0, -1.4)}` }));
      return out;
    },
  },
  snowdrop: {
    foliage: (p, v) => v.leaves.map((leaf, i) => p.ellipse(9.5 * leaf.length, 1.7, i % 2 ? '#7FA88A' : '#6E9A7A', rot(leaf.angle), 10 * leaf.length, 0)),
    bloom(p, v) {
      const [, inner, mark, middle] = v.colourway;
      const innerPetal: Shape = (pp, rx, ry, fill) => pp.g([pp.ellipse(rx, ry, fill), pp.ellipse(rx * 0.45, ry * 0.2, mark, null, 0, -ry * 0.62)]);
      return [
        ...ring(p, v, { n: 3, dist: 6 * v.petalLength, rx: 3.4 * v.petalWidth, ry: 7 * v.petalLength, fill: petalFill(v), main: true }),
        ...ring(p, v, { n: 3, dist: 3.2, rx: 2.5, ry: 3.8, turn: 60, fill: () => inner, shape: innerPetal }),
        p.circle(1.4, middle),
      ];
    },
    bud: (p, v) => [...(DRAWINGS.snowdrop.foliage?.(p, v) ?? []), p.ellipse(2.6, 4.6, '#FFFFFF', null, 0, -1), p.circle(1.3, '#9CC48A', 0, 3.4)],
  },
  'cherry-blossom': {
    petal: 'heart',
    foliage: cherryTwig,
    bloom(p, v) {
      const [a, b, mid, stamens] = v.colourway;
      const blossoms = 3 + Math.floor(v.care * 2.5);
      const out: El[] = [];
      for (let i = 0; i < blossoms; i++) {
        const [x, y, z] = cherrySpots[i]!;
        const parts = [
          ...ring(p, v, { n: 5, dist: 3.4 * z, rx: 2.7 * z * v.petalWidth, ry: 3.4 * z * v.petalLength, fill: i === 0 ? petalFill(v) : (j) => (v.twoTone && j % 2 ? b : a), shape: SHAPES.heart, main: i === 0 }),
          p.circle(z, mid),
        ];
        for (let q = 0; q < 6; q++) parts.push(p.circle(0.32 * z, stamens, 0, 0, { transform: `${rot(q * 60 + 15)} ${move(0, -1.6)}` }));
        out.push(p.g(parts, move(x, y)));
      }
      return out;
    },
    bud: (p, v) => [...cherryTwig(p), ...cherrySpots.slice(0, 3).map(([x, y]) => p.circle(1.6, v.colourway[1], x, y))],
    drift(p, v) {
      if (v.wind === null || v.wind < 2) return [];
      return (
        [
          [-16, 13, 30],
          [16, -15, 200],
          [17.5, 3, 100],
        ] as const
      )
        .slice(0, v.wind - 1)
        .map(([x, y, a]) => p.g([SHAPES.heart(p, 2.6, 3.4, v.colourway[0])], `${move(x, y)} ${rot(a)} scale(0.6)`));
    },
  },
  watermelon: {
    foliage: (p, v) => [...bigLeaves(p, v, 3.6), vine(p, v)],
    bloom(p, v) {
      const [rind, stripes, shine] = v.colourway;
      const size = 0.72 + 0.38 * v.care;
      const rx = 8.6 * size;
      const ry = 6.4 * size;
      const out: El[] = [p.ellipse(rx, ry, rind)];
      if (v.way === 2) {
        // moon and stars
        const r = seeded(v.seed ^ 0x5a7);
        out.push(p.circle(1.8 * size, '#FFD84A', -rx * 0.3, -ry * 0.2));
        for (let i = 0; i < 12; i++) {
          const a = r() * Math.PI * 2;
          const d = Math.sqrt(r());
          out.push(p.circle(0.35 + r() * 0.35, '#FFD84A', Math.cos(a) * d * rx * 0.85, Math.sin(a) * d * ry * 0.85));
        }
      } else for (let k = -3; k <= 3; k++) out.push(p.ellipse(rx * (1 - Math.abs(k) / 4.6) * 0.95, 0.85 * size, stripes, null, 0, k * 1.75 * size));
      out.push(p.el('ellipse', { cx: -rx * 0.3, cy: -ry * 0.45, rx: rx * 0.3, ry: ry * 0.16, fill: shine, opacity: 0.5, transform: 'rotate(-12)' }));
      return [p.g(out, move(2, 1))];
    },
    bud: (p, v) => [...bigLeaves(p, v, 3.4), vine(p, v), melonBlossom(p, v)],
  },
  pumpkin: {
    foliage: (p, v) => [...bigLeaves(p, v, 4.6), vine(p, v)],
    bloom(p, v) {
      const [a, b, stem] = v.colourway;
      const size = 0.72 + 0.38 * v.care;
      const R = 7 * size;
      const out: El[] = [];
      for (let i = 0; i < 10; i++) {
        let colour = i % 2 ? b : a;
        if (v.cross && (i === v.cross.petal % 10 || (v.cross.level >= 2 && i === (v.cross.petal + 5) % 10))) colour = v.cross.colours[0];
        out.push(p.ellipse(R * 0.42, R * 0.62, colour, `${rot(i * 36)} ${move(0, -R * 0.42)}`));
      }
      out.push(p.circle(R * 0.28, b), p.circle(1.5 * size, stem), p.el('rect', { x: -0.6 * size, y: -2.6 * size, width: 1.2 * size, height: 2.6 * size, rx: 0.4, fill: stem }));
      return [p.g(out, move(2, 1))];
    },
    bud: (p, v) => [...bigLeaves(p, v, 4), vine(p, v), melonBlossom(p, v)],
  },
  lotus: {
    petal: 'point',
    foliage: lilyPad,
    bloom(p, v) {
      const [, b, pod, dots] = v.colourway;
      const fill = petalFill(v);
      const out = [
        ...ring(p, v, { n: 8, dist: 7.4 * v.petalLength, rx: 3.2 * v.petalWidth, ry: 6 * v.petalLength, fill, shape: SHAPES.point, main: true }),
        ...ring(p, v, { n: 8, dist: 5 * v.petalLength, rx: 2.8 * v.petalWidth, ry: 4.8 * v.petalLength, turn: 22.5, fill: () => b, shape: SHAPES.point }),
        ...ring(p, v, { n: 6, dist: 2.8, rx: 2, ry: 3.2, turn: 10, fill, shape: SHAPES.point }),
        p.circle(2.5, pod),
      ];
      for (let q = 0; q < 7; q++) out.push(p.circle(0.38, dots, 0, 0, { transform: `${rot(q * 51)} ${move(0, -1.4)}` }));
      return out;
    },
    bud: (p, v) => [...lilyPad(p), SHAPES.point(p, 3, 5.2, v.colourway[1]), p.ellipse(1.6, 1.2, '#4E8F3A', null, 0, 4)],
  },
  'storm-lily': {
    petal: 'point',
    bloom(p, v) {
      const [, , anthers, middle] = v.colourway;
      const out = ring(p, v, { n: 6, dist: 7.2 * v.petalLength, rx: 3 * v.petalWidth, ry: 7.4 * v.petalLength, fill: petalFill(v), shape: SHAPES.bolt, main: true });
      for (let q = 0; q < 6; q++) out.push(p.g([p.line(0, 0, 0, -6.6, '#E8E2FF', 0.4), p.circle(0.85, anthers, 0, -6.8)], rot(q * 60 + 30)));
      out.push(p.circle(1.8, middle));
      return out;
    },
    bud: (p, v) => [...leavesOf(p, v), p.ellipse(3, 5.5, v.colourway[0]), p.circle(0.7, '#FFE37A', 1, -2)],
  },
  'prism-aster': {
    bloom(p, v) {
      const h = v.hues;
      return [
        ...ring(p, v, { n: v.petals, dist: 9.6 * v.petalLength, rx: 1.9 * v.petalWidth, ry: 6 * v.petalLength, fill: (i) => h[i % h.length]!, main: true }),
        ...ring(p, v, { n: v.petals, dist: 6.2 * v.petalLength, rx: 1.6 * v.petalWidth, ry: 4 * v.petalLength, turn: 180 / v.petals, fill: (i) => h[(i + 3) % h.length]! }),
        p.circle(3.2 * v.centerSize, v.colourway[0]),
        p.circle(1.6 * v.centerSize, v.colourway[1]),
      ];
    },
    bud: (p, v) => [...leavesOf(p, v), p.circle(6.5, BUD), ...v.hues.slice(0, 6).map((h, i) => p.circle(1, h, 0, 0, { transform: `${rot(i * 60)} ${move(0, -3.4)}` }))],
  },
};

/** Petals the wind took, lying beside the plant, all blown the same way across the patch. */
function windfall(p: Pen, kind: FlowerKind, v: Variant): El[] {
  if (!v.lost.length || !LOSES.has(kind)) return [];
  const shape = SHAPES[DRAWINGS[kind].petal ?? 'oval'];
  const colour = kind === 'prism-aster' ? v.hues[0]! : v.colourway[0];
  const spots = [
    [14.5, 8, 62],
    [17.5, 15, 118],
  ] as const;
  return v.lost.map((_, i) => {
    const [x, y, a] = spots[i] ?? spots[0];
    return p.el('g', { transform: `${move(x, y)} ${rot(a)} scale(0.75)`, opacity: 0.92 }, [shape(p, 2.6, 4.6, colour)]);
  });
}

function sprout(p: Pen, v: Variant): El[] {
  const angle = v.leaves[0]?.angle ?? 0;
  return [p.ellipse(6.5, 3.2, LEAF_COLOURS[0], rot(angle - 25), -5, 0), p.ellipse(6.5, 3.2, '#4CC45C', rot(angle + 25), 5, 0), p.circle(1.6, LEAF_COLOURS[1])];
}

function svgFor(doc: Document, p: Pen, v: Variant, inner: El[], outside: El[] = []): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  for (const [k, value] of Object.entries({ viewBox: '-20 -20 40 40', class: 'home-flower', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, value);
  svg.append(p.g(inner, `rotate(${v.rotation}) scale(${f2(v.scale)})`), ...outside);
  return svg;
}

/** One plant from above, as an SVG (viewBox -20 -20 40 40). */
export function drawFlower(doc: Document, kind: FlowerKind, stage: Stage, v: Variant): SVGSVGElement {
  const p = pen(doc);
  const d = DRAWINGS[kind];
  if (stage === 'sprout') return svgFor(doc, p, v, sprout(p, v));
  if (stage === 'bud') return svgFor(doc, p, v, d.bud ? d.bud(p, v) : [...leavesOf(p, v), p.circle(6.5, BUD), p.circle(3.4, v.colourway[0])]);
  const inner = [...(d.foliage === undefined ? leavesOf(p, v) : d.foliage ? d.foliage(p, v) : []), ...d.bloom(p, v)];
  if (v.ladybug) inner.push(ladybug(p, v.leaves[Math.min(v.leaves.length - 1, d.bugLeaf ?? 0)]!));
  return svgFor(doc, p, v, inner, [...windfall(p, kind, v), ...(d.drift?.(p, v) ?? [])]);
}

/** A neutral look for a seed nobody knows yet: leaves and turn from its seed, nothing else. */
export function seedVariant(seed: number): Variant {
  return variantFor('daisy', seed);
}

/**
 * A seed before anyone knows what it is: the same two leaves as every sprout, then a bud
 * that shows only its family (or a plain bud while even that's unknown). It stays a bud
 * until the garden says what bloomed.
 */
export function drawSeed(doc: Document, stage: Stage, v: Variant, family: Family | null): SVGSVGElement {
  const p = pen(doc);
  if (stage === 'sprout') return svgFor(doc, p, v, sprout(p, v));
  const plain = (cream: string) => [...leavesOf(p, v), p.circle(6.5, BUD), p.circle(3.4, cream)];
  const buds: Record<Family, () => El[]> = {
    flower: () => plain('#E4EDCB'),
    leafy: () => [
      ...[0, 120, 240].map((a) => p.path('M0 0 C0 -5 1 -8 4 -8 C6.5 -8 7 -5 5 -4 C3.5 -3.3 3 -5 4 -5.5', { fill: 'none', stroke: '#4A9447', 'stroke-width': 1.5, 'stroke-linecap': 'round', transform: rot(a + v.rotation / 3) })),
      p.circle(1.4, '#2C5E2B'),
    ],
    succulent: () => [
      ...ring(p, { ...v, sweep: 0, lost: [] }, { n: 7, dist: 5.4, rx: 2.8, ry: 4.4, fill: () => '#9DBFA9', shape: SHAPES.point }),
      ...ring(p, { ...v, sweep: 0, lost: [] }, { n: 5, dist: 2.6, rx: 1.9, ry: 2.8, turn: 20, fill: () => '#B6D2BE', shape: SHAPES.point }),
    ],
    fruit: () => [...bigLeaves(p, v, 3.8), vine(p, v), melonBlossom(p, v)],
    fungus: () => [p.circle(3.6, '#F1E6CF'), p.circle(3.2, 'none', 0, 0, { stroke: '#D8C9A8', 'stroke-width': 0.5 })],
  };
  return svgFor(doc, p, v, family ? buds[family]() : plain('#D9E8C4'));
}

export { familyOf };

/** The plain look a kind shows in the picker and the field guide: its first colourway, no rarities, no weather. */
export function sampleVariant(kind: FlowerKind): Variant {
  const base = variantFor(kind, hashSeed(kind));
  return { ...base, colourway: COLOURWAYS[kind][0]!, way: 0, twoTone: false, double: false, ladybug: false, fourLeaf: false, rotation: 0, scale: 1 };
}
