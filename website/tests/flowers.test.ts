// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FAMILIES } from '../shared/garden-rules.js';
import { bloomsAt, COLOURWAYS, drawFlower, drawSeed, FLOWER_KINDS, flowerSeed, hashSeed, KINDS, sampleVariant, seeded, seedVariant, stageFor, variantFor, type FlowerKind, type GrewIn } from '../src/scripts/flowers.js';
import looksBefore from './flower-looks-before-weather.json';

const DAY = 24 * 60 * 60 * 1000;
const seeds = Array.from({ length: 400 }, (_, i) => flowerSeed(`did:plc:${String(i).padStart(24, 'a')}`, `3k${i}`));

describe('generative flowers', () => {
  it('the same DID and record key always grow the same flower', () => {
    expect(hashSeed('did:plc:x/3k1')).toBe(hashSeed('did:plc:x/3k1'));
    expect(flowerSeed('did:plc:x', '3k1')).not.toBe(flowerSeed('did:plc:x', '3k2'));
    expect(variantFor('daisy', 42)).toEqual(variantFor('daisy', 42));
    const r = seeded(7);
    const values = Array.from({ length: 1000 }, r);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(990);
  });

  it('every variant stays in range for its kind', () => {
    const petals: Partial<Record<FlowerKind, [number, number]>> = { sunflower: [10, 16], daisy: [10, 18], violet: [5, 6], poppy: [4, 5], rose: [3, 5], tulip: [3, 4] };
    for (const kind of FLOWER_KINDS) {
      for (const seed of seeds) {
        const v = variantFor(kind, seed);
        expect(COLOURWAYS[kind]).toContain(v.colourway);
        expect(v.petals).toBeGreaterThanOrEqual(petals[kind]![0]);
        expect(v.petals).toBeLessThanOrEqual(petals[kind]![1]);
        expect(v.leaves.length === 2 || v.leaves.length === 3).toBe(true);
        expect(v.scale).toBeGreaterThanOrEqual(0.86);
        expect(v.scale).toBeLessThanOrEqual(1);
        if (kind === 'rose') expect(v.twoTone).toBe(false);
        if (kind === 'violet' || kind === 'rose' || kind === 'tulip') expect(v.double).toBe(false);
      }
    }
  });

  it('varies: a patch of one kind has many looks, and now and then a rare one', () => {
    const daisies = seeds.map((s) => variantFor('daisy', s));
    expect(new Set(daisies.map((v) => v.colourway)).size).toBe(COLOURWAYS.daisy.length);
    expect(new Set(daisies.map((v) => v.petals)).size).toBeGreaterThan(5);
    expect(daisies.some((v) => v.twoTone)).toBe(true);
    expect(daisies.some((v) => v.double)).toBe(true);
    expect(daisies.some((v) => v.ladybug)).toBe(true);
    expect(daisies.filter((v) => v.ladybug).length).toBeLessThan(daisies.length / 10);
  });

  it('grows from sprout to bud to bloom over its first week; a closed patch is all in bloom', () => {
    const planted = '2026-10-01T00:00:00Z';
    const at = Date.parse(planted);
    expect(stageFor(planted, at + 1000)).toBe('sprout');
    expect(stageFor(planted, at + 2 * DAY - 1)).toBe('sprout');
    expect(stageFor(planted, at + 2 * DAY)).toBe('bud');
    expect(stageFor(planted, at + 7 * DAY - 1)).toBe('bud');
    expect(stageFor(planted, at + 7 * DAY)).toBe('bloom');
    expect(bloomsAt(planted)).toBe(at + 7 * DAY);
    expect(stageFor('not a date', at)).toBe('sprout');
    expect(stageFor(planted, at + 1000, false)).toBe('bloom');
  });

  it('care makes rarer blooms likelier, and never takes one away', () => {
    const rarities = (care: number) =>
      FLOWER_KINDS.flatMap((kind) =>
        seeds.map((seed) => {
          const v = variantFor(kind, seed, care);
          return { twoTone: v.twoTone, double: v.double, ladybug: v.ladybug, petalLength: v.petalLength, scale: v.scale };
        }),
      );
    const levels = [0, 0.14, 0.29, 0.43, 0.57, 0.71, 0.86, 1].map(rarities);
    for (let l = 1; l < levels.length; l++) {
      levels[l]!.forEach((v, i) => {
        const before = levels[l - 1]![i]!;
        for (const key of ['twoTone', 'double', 'ladybug'] as const) if (before[key]) expect(v[key]).toBe(true);
        expect(v.petalLength).toBeGreaterThanOrEqual(before.petalLength);
        expect(v.scale).toBeGreaterThanOrEqual(before.scale);
      });
    }
    const count = (level: ReturnType<typeof rarities>, key: 'twoTone' | 'double' | 'ladybug') => level.filter((v) => v[key]).length;
    for (const key of ['twoTone', 'double', 'ladybug'] as const) expect(count(levels.at(-1)!, key)).toBeGreaterThan(count(levels[0]!, key) * 1.5);
    // only the rolls' bars move: colourway, petals and leaves stay put
    const plain = variantFor('daisy', 42, 0);
    const tended = variantFor('daisy', 42, 1);
    expect([tended.colourway, tended.petals, tended.leaves, tended.rotation]).toEqual([plain.colourway, plain.petals, plain.leaves, plain.rotation]);
    // nonsense care is no care
    expect(variantFor('daisy', 42, Number.NaN)).toEqual(plain);
    expect(variantFor('daisy', 42, 5)).toEqual(tended);
  });

  it('draws the petals it was dealt, as a quiet svg', () => {
    const v = { ...variantFor('daisy', 1), petals: 13, double: false, ladybug: false, leaves: [{ angle: 0, length: 1 }, { angle: 180, length: 1 }] };
    const svg = drawFlower(document, 'daisy', 'bloom', v);
    expect(svg.getAttribute('viewBox')).toBe('-20 -20 40 40');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('home-flower')).toBe(true);
    // two leaves, then thirteen petals
    expect(svg.querySelectorAll('ellipse')).toHaveLength(2 + 13);
    expect(drawFlower(document, 'daisy', 'bloom', { ...v, double: true }).querySelectorAll('ellipse')).toHaveLength(2 + 26);
    // a sprout is two leaves and a dot; a bud is a closed head
    expect(drawFlower(document, 'daisy', 'sprout', v).querySelectorAll('ellipse')).toHaveLength(2);
    expect(drawFlower(document, 'daisy', 'bud', v).querySelectorAll('circle')).toHaveLength(2);
    // a ladybug sits on a leaf
    expect(drawFlower(document, 'daisy', 'bloom', { ...v, ladybug: true }).querySelectorAll('circle').length).toBeGreaterThan(svg.querySelectorAll('circle').length);
  });

  it('the picker shows a plain flower for each kind', () => {
    for (const kind of FLOWER_KINDS) {
      const v = sampleVariant(kind);
      expect(v.colourway).toBe(COLOURWAYS[kind][0]);
      expect([v.twoTone, v.double, v.ladybug, v.rotation, v.scale]).toEqual([false, false, false, 0, 1]);
      expect(drawFlower(document, kind, 'bloom', v).childElementCount).toBe(1);
    }
  });
});

describe('every kind, and the weather it grew in', () => {
  const weathers: Array<GrewIn | null> = [null, { wind: 0, mix: 0 }, { wind: 2, mix: 1 }, { wind: 3, mix: 3 }, { wind: 4, mix: 4, apps: ['leaflet.pub', 'tangled.org', 'frontpage.fyi'] }];

  it('a flower with no weather recorded looks exactly as it did before there was weather', () => {
    for (const [key, before] of Object.entries(looksBefore)) {
      const [kind, end, care] = key.split(' ') as [FlowerKind, string, string];
      const did = end === 'b' ? 'did:plc:aaaaaaaaaaaaaaaaaaaaaaab' : 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';
      const v = variantFor(kind, flowerSeed(did, end === 'b' ? '3m2kq7xz6ac2a' : 'self'), Number(care));
      const { colourway, petals, petalLength, petalWidth, centerSize, twoTone, double, ladybug, leaves, rotation, scale } = v;
      expect({ colourway, petals, petalLength, petalWidth, centerSize, twoTone, double, ladybug, leaves, rotation, scale }).toEqual(before);
      expect([v.sweep, v.lost, v.cross, v.jitter.every((j) => j === 0)]).toEqual([0, [], null, true]);
    }
  });

  it('draws every kind at every stage, in any weather, as a quiet svg', () => {
    for (const kind of KINDS) {
      for (const seed of seeds.slice(0, 12)) {
        for (const grew of weathers) {
          for (const stage of ['sprout', 'bud', 'bloom'] as const) {
            const svg = drawFlower(document, kind, stage, variantFor(kind, seed, 0.6, grew));
            expect(svg.getAttribute('viewBox')).toBe('-20 -20 40 40');
            expect(svg.getAttribute('aria-hidden')).toBe('true');
            expect(svg.querySelectorAll('*').length).toBeGreaterThan(2);
            expect(svg.outerHTML).not.toMatch(/NaN|undefined|Infinity/);
          }
        }
      }
    }
  });

  it('the week shows without moving anything the seed and care decided', () => {
    for (const kind of KINDS) {
      for (const seed of seeds.slice(0, 60)) {
        const plain = variantFor(kind, seed, 0.5);
        const wild = variantFor(kind, seed, 0.5, { wind: 4, mix: 4 });
        expect([wild.petals, wild.leaves, wild.rotation, wild.scale, wild.twoTone, wild.double, wild.ladybug, wild.fourLeaf]).toEqual([
          plain.petals,
          plain.leaves,
          plain.rotation,
          plain.scale,
          plain.twoTone,
          plain.double,
          plain.ladybug,
          plain.fourLeaf,
        ]);
        // a hydrangea's colour is the one thing that follows the sky
        if (kind !== 'hydrangea') expect(wild.colourway).toBe(plain.colourway);
      }
    }
  });

  it('wind leans every petal the same way and strips one or two in a storm; a still week leaves it be', () => {
    const stormy = seeds.map((s) => variantFor('daisy', s, 0, { wind: 4, mix: 1 }));
    expect(stormy.every((v) => v.sweep === 21 && v.lost.length >= 1 && v.lost.length <= 2)).toBe(true);
    const gusty = seeds.map((s) => variantFor('daisy', s, 0, { wind: 3, mix: 1 }));
    expect(gusty.some((v) => v.lost.length === 1) && gusty.some((v) => v.lost.length === 0)).toBe(true);
    const calm = seeds.map((s) => variantFor('daisy', s, 0, { wind: 0, mix: 1 }));
    expect(calm.every((v) => v.sweep === 0 && v.lost.length === 0 && v.jitter.every((j) => j === 0))).toBe(true);
    // a lost petal lies beside it, outside the turned plant, so the whole patch blows one way
    const v = { ...stormy[0]!, petals: 13 };
    const svg = drawFlower(document, 'daisy', 'bloom', v);
    expect(svg.childElementCount).toBe(1 + v.lost.length);
    expect(svg.children[0]!.querySelectorAll('ellipse').length).toBe(v.leaves.length + 13 - v.lost.length + (v.double ? 13 : 0));
    // kinds without petals to lose keep them
    expect(variantFor('cactus', seeds[0]!, 0, { wind: 4, mix: 1 }).lost).toEqual([]);
  });

  it('a sky more mixed than usual cross-pollinates: rarely under a usual one, always under the most mixed', () => {
    const under = (mix: number) => seeds.map((s) => variantFor('daisy', s, 0, { wind: 2, mix }));
    expect(under(1).filter((v) => v.cross).length).toBeLessThan(seeds.length * 0.1);
    expect(under(4).every((v) => v.cross?.level === 3)).toBe(true);
    const v = under(4)[0]!;
    const fills = [...drawFlower(document, 'daisy', 'bloom', { ...v, petals: 12, double: false }).querySelectorAll('g g ellipse')].map((e) => e.getAttribute('fill'));
    expect(fills).toContain(v.cross!.colours[0]);
    expect(fills).toContain(v.cross!.colours[1]);
  });

  it('some kinds show the weather their own way', () => {
    // a hydrangea is blue after a plain week and pink after a mixed one
    const ways = (mix: number) => seeds.slice(0, 200).map((s) => variantFor('hydrangea', s, 0, { wind: 2, mix }).way);
    expect(Math.max(...ways(0))).toBeLessThanOrEqual(1);
    expect(Math.min(...ways(4))).toBeGreaterThanOrEqual(3);
    // a dandelion goes to seed in the wind
    const lines = (wind: number) => drawFlower(document, 'dandelion', 'bloom', variantFor('dandelion', 7, 0, { wind, mix: 1 })).querySelectorAll('line').length;
    expect(lines(0)).toBe(0);
    expect(lines(2)).toBeGreaterThan(20);
    expect(lines(4)).toBeLessThan(lines(2));
    // a prism aster wears the colours of the apps in the air
    const prism = variantFor('prism-aster', 9, 0, { wind: 2, mix: 4, apps: ['leaflet.pub', 'tangled.org', 'frontpage.fyi'] });
    expect(prism.hues).toHaveLength(3);
    const fills = new Set([...drawFlower(document, 'prism-aster', 'bloom', prism).querySelectorAll('ellipse')].map((e) => e.getAttribute('fill')));
    for (const h of prism.hues) expect(fills).toContain(h);
    // tending makes a four-leaf clover likelier
    const four = (care: number) => seeds.filter((s) => variantFor('clover', s, care).fourLeaf).length;
    expect(four(1)).toBeGreaterThan(four(0) * 2);
    expect(seeds.some((s) => variantFor('daisy', s, 1).fourLeaf)).toBe(false);
  });

  it('a seed gives nothing away: the same sprout as anything, a bud that shows only its family, and no bloom until it is known', () => {
    for (const seed of seeds.slice(0, 20)) {
      const sprout = drawSeed(document, 'sprout', seedVariant(seed), null).outerHTML;
      expect(drawSeed(document, 'sprout', seedVariant(seed), 'fungus').outerHTML).toBe(sprout);
      for (const kind of ['storm-lily', 'cactus', 'moss'] as const) expect(drawFlower(document, kind, 'sprout', variantFor(kind, seed)).outerHTML).toBe(sprout);
    }
    const buds = FAMILIES.map((f) => drawSeed(document, 'bud', seedVariant(1), f).outerHTML);
    expect(new Set(buds).size).toBe(FAMILIES.length);
    expect(buds).not.toContain(drawSeed(document, 'bud', seedVariant(1), null).outerHTML);
    // in bloom, but not yet known: it stays a bud
    expect(drawSeed(document, 'bloom', seedVariant(1), 'leafy').outerHTML).toBe(drawSeed(document, 'bud', seedVariant(1), 'leafy').outerHTML);
  });
});
