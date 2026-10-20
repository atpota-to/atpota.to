import { describe, expect, it } from 'vitest';
import { countSketch, decodeSketch, emptySketch, fromBytea, mergeSketch } from '../server/hll.js';

// The station's half (atmosphere/src/hll.js, plain JS): it hashes DIDs into sketches.
// The website only reads them, so the two are checked against each other here.
interface Sketch {
  add(packed: number): Sketch;
  merge(other: Sketch): Sketch;
  estimate(): number;
  encode(): Buffer;
}
const STATION_HLL = new URL('../../atmosphere/src/hll.js', import.meta.url).href;
const { registerOf, Sketch } = (await import(STATION_HLL)) as { registerOf: (did: string) => number; Sketch: new () => Sketch };

const sketchOf = (salt: string, from: number, to: number) => {
  const s = new Sketch();
  for (let i = from; i < to; i++) s.add(registerOf(`did:plc:${salt}${i}`));
  return s;
};
const bytea = (s: Sketch) => `\\x${s.encode().toString('hex')}`;

describe('reading the station\'s sketches', () => {
  it('counts what the station counts, sparse and dense', () => {
    for (const [salt, n] of [['y', 40], ['z', 2000], ['x', 30_000]] as const) {
      const s = sketchOf(salt, 0, n);
      expect(countSketch(fromBytea(bytea(s))!)).toBe(s.estimate());
    }
    // pinned with the station's own test (atmosphere/test/hll.test.js)
    expect(countSketch(fromBytea(bytea(sketchOf('x', 0, 30_000)))!)).toBe(29_702);
  });

  it('merges as a union, as the station does', () => {
    const a = sketchOf('m', 0, 6000);
    const b = sketchOf('m', 3000, 9000);
    const merged = mergeSketch(mergeSketch(emptySketch(), fromBytea(bytea(a))!), fromBytea(bytea(b))!);
    expect(countSketch(merged)).toBe(new Sketch().merge(a).merge(b).estimate());
    expect(countSketch(emptySketch())).toBe(0);
  });

  it('refuses anything that is not a sketch', () => {
    for (const bad of [null, 7, '', '020c', '\\x', '\\x02', '\\x020e', '\\x020c0001', '\\x020c10000101', '\\x020c00013f', '\\x010c01', '\\xzz']) expect(fromBytea(bad)).toBeNull();
    expect(decodeSketch(new Uint8Array([2, 12]))).not.toBeNull();
  });
});
