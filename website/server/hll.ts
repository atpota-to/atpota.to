/**
 * Active-account sketches, read: the weather station's HyperLogLog sketches
 * (atmosphere/src/hll.js) decoded, merged and counted. Only the reading half: the
 * station does the hashing, so no DID ever reaches the website. The sums are the
 * station's, register for register; if one changes, change the other.
 *
 * A sketch is bytes: [format, precision = 12, ...]. Format 1 (dense) is 4096 registers,
 * a byte each; format 2 (sparse) is 3 bytes per non-zero register: index (2 bytes, big
 * endian), value. Merging takes each register's maximum. The count is Ertl's improved
 * estimator, within about 1.6% of the truth.
 */

export const P = 12;
export const M = 1 << P;
export const Q = 64 - P;
const DENSE = 1;
const SPARSE = 2;

export type Registers = Uint8Array;

export const emptySketch = (): Registers => new Uint8Array(M);

/** A sketch from its bytes, or null for anything that isn't one. */
export function decodeSketch(b: Uint8Array): Registers | null {
  if (b.length < 2 || b[1] !== P) return null;
  const r = emptySketch();
  if (b[0] === DENSE && b.length === 2 + M) r.set(b.subarray(2));
  else if (b[0] === SPARSE && (b.length - 2) % 3 === 0) {
    for (let o = 2; o < b.length; o += 3) {
      const i = (b[o]! << 8) | b[o + 1]!;
      if (i >= M) return null;
      r[i] = b[o + 2]!;
    }
  } else return null;
  for (const v of r) if (v > Q + 1) return null;
  return r;
}

/** A sketch as PostgREST answers bytea ("\x" and hex), or null. */
export function fromBytea(x: unknown): Registers | null {
  if (typeof x !== 'string' || !/^\\x(?:[0-9a-f]{2})+$/i.test(x)) return null;
  return decodeSketch(Buffer.from(x.slice(2), 'hex'));
}

/** Merges `from` into `into` and answers `into`. */
export function mergeSketch(into: Registers, from: Registers): Registers {
  for (let i = 0; i < M; i++) if (from[i]! > into[i]!) into[i] = from[i]!;
  return into;
}

function sigma(x: number): number {
  if (x === 1) return Infinity;
  let y = 1;
  let z = x;
  for (;;) {
    x *= x;
    const before = z;
    z += x * y;
    y += y;
    if (z === before) return z;
  }
}

function tau(x: number): number {
  if (x === 0 || x === 1) return 0;
  let y = 1;
  let z = 1 - x;
  for (;;) {
    x = Math.sqrt(x);
    const before = z;
    y *= 0.5;
    z -= (1 - x) ** 2 * y;
    if (z === before) return z / 3;
  }
}

/** How many accounts a sketch holds. */
export function countSketch(r: Registers): number {
  const c = new Array<number>(Q + 2).fill(0);
  for (const v of r) c[v]!++;
  if (c[0] === M) return 0;
  let z = M * tau(1 - c[Q + 1]! / M);
  for (let k = Q; k >= 1; k--) z = 0.5 * (z + c[k]!);
  z += M * sigma(c[0]! / M);
  return Math.round((M * M) / (2 * Math.LN2) / z);
}
