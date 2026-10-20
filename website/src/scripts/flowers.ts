/**
 * The flower patch's flowers, seen from above, each one a little different.
 *
 * A flower's look is generated from a seed: its owner's DID and its record key, so it
 * stays the same everywhere and for everyone, and replanting grows a new one. Within its
 * kind, the seed picks a colourway, how many petals and how long and wide they are, the
 * size of the middle, two or three leaves at their own angles, a turn and a size, and now
 * and then something rarer: two-tone petals, a second ring of petals, or a ladybug on a
 * leaf.
 *
 * Care (0 to 1, how well it was tended while it grew; server/garden.ts counts it) makes the
 * rarer things likelier and the bloom a little fuller. The seed's rolls stay the same and
 * care only raises the bar each roll has to clear, so more care never takes anything away.
 *
 * Growth follows age: a sprout for SPROUT_DAYS, a bud until GROW_DAYS, then the bloom. A
 * flower in a patch that has closed is always in bloom.
 *
 * Everything is built with createElementNS; nothing here touches innerHTML.
 */

export const FLOWER_KINDS = ['sunflower', 'rose', 'daisy', 'violet', 'poppy', 'tulip'] as const;
export type FlowerKind = (typeof FLOWER_KINDS)[number];
export type Stage = 'sprout' | 'bud' | 'bloom';

/** petal, second petal (two-tone and inner rings), middle, middle's core */
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
};

const LEAF_COLOURS = ['#39B54A', '#2E9E3F'] as const;

export interface Leaf {
  angle: number;
  length: number;
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
}

/** FNV-1a: a string to 32 bits. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small seeded random in [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PETALS: Record<FlowerKind, (r: () => number) => number> = {
  sunflower: (r) => 10 + Math.floor(r() * 7),
  daisy: (r) => 10 + Math.floor(r() * 9),
  violet: (r) => (r() < 0.12 ? 6 : 5),
  poppy: (r) => (r() < 0.2 ? 5 : 4),
  rose: (r) => 3 + Math.floor(r() * 3),
  tulip: (r) => (r() < 0.15 ? 4 : 3),
};

const CAN_DOUBLE: ReadonlySet<FlowerKind> = new Set(['sunflower', 'daisy', 'poppy']);

/** The look of one flower, from its seed (use flowerSeed) and care. Same seed and care, same flower. */
export function variantFor(kind: FlowerKind, seed: number, care = 0): Variant {
  const c = Number.isFinite(care) ? Math.min(1, Math.max(0, care)) : 0;
  const r = seeded(seed);
  const ways = COLOURWAYS[kind];
  const colourway = ways[Math.floor(r() * ways.length)] ?? ways[0]!;
  const petals = PETALS[kind](r);
  const between = (lo: number, hi: number) => lo + r() * (hi - lo);
  const leafCount = r() < 0.3 ? 3 : 2;
  const first = r() * 360;
  const leaves = Array.from({ length: leafCount }, (_, i) => ({
    angle: Math.round(first + (360 / leafCount) * i + between(-25, 25)),
    length: Number(between(0.8, 1.2).toFixed(2)),
  }));
  // Every roll is made whatever the kind or care, so the rolls after it stay the same.
  const petalLength = between(0.88, 1.12);
  const petalWidth = between(0.82, 1.18);
  const centerSize = between(0.85, 1.2);
  const twoTone = r() < 0.1 + 0.2 * c;
  const double = r() < 0.1 + 0.2 * c;
  const ladybug = r() < 0.025 + 0.055 * c;
  const rotation = Math.round(r() * 360);
  const scale = between(0.86, 1);
  return {
    colourway,
    petals,
    petalLength: Number((petalLength * (1 + 0.08 * c)).toFixed(2)),
    petalWidth: Number(petalWidth.toFixed(2)),
    centerSize: Number(centerSize.toFixed(2)),
    twoTone: kind !== 'rose' && twoTone,
    double: CAN_DOUBLE.has(kind) && double,
    ladybug,
    leaves,
    rotation,
    scale: Number(Math.min(1, scale + 0.08 * c).toFixed(2)),
  };
}

export function flowerSeed(did: string, rkey: string): number {
  return hashSeed(`${did}/${rkey}`);
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Match server/garden.ts. */
export const SPROUT_DAYS = 2;
export const GROW_DAYS = 7;

/** A sprout, then a bud, then in bloom; every flower in a closed patch is in bloom. */
export function stageFor(plantedAt: string, now: number, open = true): Stage {
  if (!open) return 'bloom';
  const age = now - Date.parse(plantedAt);
  if (!Number.isFinite(age) || age < SPROUT_DAYS * DAY_MS) return 'sprout';
  if (age < GROW_DAYS * DAY_MS) return 'bud';
  return 'bloom';
}

/** When a flower planted at `plantedAt` blooms (ms since the epoch). */
export function bloomsAt(plantedAt: string): number {
  return Date.parse(plantedAt) + GROW_DAYS * DAY_MS;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const f2 = (n: number) => n.toFixed(2);

function node<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, typeof value === 'number' ? f2(value) : value);
  return el;
}

/** A ring of `n` petals: ellipses (or circles) pointing out from the middle. */
function ring(doc: Document, opts: { n: number; dist: number; rx: number; ry: number; turn?: number; fill: (i: number) => string }): SVGGElement {
  const g = node(doc, 'g', {});
  for (let i = 0; i < opts.n; i++) {
    const angle = (360 / opts.n) * i + (opts.turn ?? 0);
    g.append(node(doc, 'ellipse', { cx: 0, cy: -opts.dist, rx: opts.rx, ry: opts.ry, fill: opts.fill(i), transform: `rotate(${f2(angle)})` }));
  }
  return g;
}

function bloom(doc: Document, kind: FlowerKind, v: Variant): SVGGElement {
  const [petal, petal2, mid, core] = v.colourway;
  const L = v.petalLength;
  const W = v.petalWidth;
  const C = v.centerSize;
  const fill = (i: number) => (v.twoTone && i % 2 === 1 ? petal2 : petal);
  const g = node(doc, 'g', {});
  switch (kind) {
    case 'sunflower':
      g.append(ring(doc, { n: v.petals, dist: 11 * L, rx: 3.6 * W, ry: 6.6 * L, fill }));
      if (v.double) g.append(ring(doc, { n: v.petals, dist: 8 * L, rx: 3 * W, ry: 5 * L, turn: 180 / v.petals, fill: () => petal2 }));
      g.append(node(doc, 'circle', { r: 7.2 * C, fill: mid }), node(doc, 'circle', { r: 4.2 * C, fill: core }));
      break;
    case 'daisy':
      g.append(ring(doc, { n: v.petals, dist: 10 * L, rx: 2.4 * W, ry: 6.6 * L, fill }));
      if (v.double) g.append(ring(doc, { n: v.petals, dist: 7 * L, rx: 2 * W, ry: 4.6 * L, turn: 180 / v.petals, fill: () => petal2 }));
      g.append(node(doc, 'circle', { r: 4.6 * C, fill: mid }), node(doc, 'circle', { r: 2 * C, fill: core }));
      break;
    case 'violet':
      g.append(ring(doc, { n: v.petals, dist: 7 * L, rx: 6.6 * W, ry: 6.6 * W, fill }));
      g.append(node(doc, 'circle', { r: 2.8 * C, fill: mid }), node(doc, 'circle', { r: 1.2 * C, fill: core }));
      break;
    case 'poppy':
      g.append(ring(doc, { n: v.petals, dist: 6 * L, rx: 8.4 * W, ry: 8.4 * W, fill }));
      if (v.double) g.append(ring(doc, { n: v.petals, dist: 3.6 * L, rx: 5.6 * W, ry: 5.6 * W, turn: 180 / v.petals, fill: () => petal2 }));
      g.append(node(doc, 'circle', { r: 3.8 * C, fill: mid }), node(doc, 'circle', { r: 1.6 * C, fill: core }));
      break;
    case 'rose': {
      // concentric petals, each a little off-centre, darkening towards the middle
      const shades = [petal, petal2, mid, core];
      for (let k = 0; k < v.petals; k++) {
        const r = 11.5 * W * (1 - k / (v.petals + 0.6));
        const wobble = ((k % 2 === 0 ? 1 : -1) * 0.7 * (k + 1)) / v.petals;
        g.append(node(doc, 'circle', { cx: wobble, cy: -wobble, r, fill: shades[Math.min(shades.length - 1, Math.round((k / Math.max(1, v.petals - 1)) * 3))]! }));
      }
      break;
    }
    case 'tulip':
      g.append(ring(doc, { n: v.petals, dist: 5 * L, rx: 6 * W, ry: 8.6 * L, fill }));
      g.append(node(doc, 'circle', { r: 3.6 * C, fill: mid }));
      break;
  }
  return g;
}

function ladybug(doc: Document, leaf: Leaf): SVGGElement {
  const g = node(doc, 'g', { transform: `rotate(${leaf.angle}) translate(${f2(13 * leaf.length)} 0)` });
  g.append(
    node(doc, 'circle', { cx: 2.6, cy: 0, r: 1.3, fill: '#2A1F14' }),
    node(doc, 'circle', { r: 2.5, fill: '#D9443A' }),
    node(doc, 'path', { d: 'M-2.5 0 L2.5 0', stroke: '#2A1F14', 'stroke-width': 0.6 }),
    node(doc, 'circle', { cx: -1, cy: -1, r: 0.55, fill: '#2A1F14' }),
    node(doc, 'circle', { cx: -1, cy: 1, r: 0.55, fill: '#2A1F14' }),
  );
  return g;
}

/** One flower from above, as an SVG (viewBox -20 -20 40 40). */
export function drawFlower(doc: Document, kind: FlowerKind, stage: Stage, v: Variant): SVGSVGElement {
  const svg = node(doc, 'svg', { viewBox: '-20 -20 40 40', class: 'home-flower', 'aria-hidden': 'true', focusable: 'false' });
  const g = node(doc, 'g', { transform: `rotate(${v.rotation}) scale(${f2(v.scale)})` });
  if (stage === 'sprout') {
    const angle = v.leaves[0]?.angle ?? 0;
    g.append(
      node(doc, 'ellipse', { cx: -5, cy: 0, rx: 6.5, ry: 3.2, fill: LEAF_COLOURS[0], transform: `rotate(${angle - 25})` }),
      node(doc, 'ellipse', { cx: 5, cy: 0, rx: 6.5, ry: 3.2, fill: '#4CC45C', transform: `rotate(${angle + 25})` }),
      node(doc, 'circle', { r: 1.6, fill: LEAF_COLOURS[1] }),
    );
  } else {
    v.leaves.forEach((leaf, i) => {
      g.append(node(doc, 'ellipse', { cx: 11 * leaf.length, cy: 0, rx: 7.5 * leaf.length, ry: 3.4, fill: LEAF_COLOURS[i % 2]!, transform: `rotate(${leaf.angle})` }));
    });
    if (stage === 'bud') g.append(node(doc, 'circle', { r: 6.5, fill: '#5FAE5A' }), node(doc, 'circle', { r: 3.4, fill: v.colourway[0] }));
    else g.append(bloom(doc, kind, v));
    if (v.ladybug && v.leaves[0]) g.append(ladybug(doc, v.leaves[0]));
  }
  svg.append(g);
  return svg;
}

/** The plain look a kind shows in the picker and while choosing a plot. */
export function sampleVariant(kind: FlowerKind): Variant {
  const base = variantFor(kind, hashSeed(kind));
  return { ...base, colourway: COLOURWAYS[kind][0]!, twoTone: false, double: false, ladybug: false, rotation: 0, scale: 1 };
}
