// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { COLOURWAYS, drawFlower, FLOWER_KINDS, flowerSeed, hashSeed, sampleVariant, seeded, stageFor, variantFor, type FlowerKind } from '../src/scripts/flowers.js';

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
    const petals: Record<FlowerKind, [number, number]> = { sunflower: [10, 16], daisy: [10, 18], violet: [5, 6], poppy: [4, 5], rose: [3, 5], tulip: [3, 4] };
    for (const kind of FLOWER_KINDS) {
      for (const seed of seeds) {
        const v = variantFor(kind, seed);
        expect(COLOURWAYS[kind]).toContain(v.colourway);
        expect(v.petals).toBeGreaterThanOrEqual(petals[kind][0]);
        expect(v.petals).toBeLessThanOrEqual(petals[kind][1]);
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

  it('grows from sprout to bud to bloom over its first days', () => {
    const planted = '2026-10-01T00:00:00Z';
    const at = Date.parse(planted);
    expect(stageFor(planted, at + 1000)).toBe('sprout');
    expect(stageFor(planted, at + DAY + 1)).toBe('bud');
    expect(stageFor(planted, at + 3 * DAY + 1)).toBe('bloom');
    expect(stageFor('not a date', at)).toBe('sprout');
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
