// hll.js
// Active accounts: how many different DIDs wrote something, without keeping any DIDs.
// A HyperLogLog sketch (Flajolet et al. 2007) with 2^12 registers: each DID is hashed,
// the first 12 bits pick a register and the register keeps the longest run of leading
// zeros seen in the other 52 bits. A sketch is 4 KB however many accounts it holds,
// two sketches merge by taking each register's maximum (so minutes add up to hours, days
// and months, and merging the same minute twice changes nothing), and the count it
// gives is within about 1.6% (1.04 / sqrt(4096)) of the truth.
//
// The count comes from Ertl's improved estimator ("New cardinality estimation algorithms
// for HyperLogLog sketches", 2017): no bias tables, and right from a handful of
// accounts to billions. atmosphere/sql/atmosphere_accounts.sql does exactly the same
// sums in Postgres, over the same bytes. If either changes, change both.
//
// On the wire and in Supabase a sketch is bytes: [format, precision, ...]
//   format 1 (dense)   then 4096 bytes, register i at offset 2 + i
//   format 2 (sparse)  then 3 bytes per non-zero register, by index: index (2 bytes, big
//                      endian), value. Used while that's smaller than dense, which is most
//                      apps most minutes.

import crypto from 'node:crypto';

export const P = 12;
export const M = 1 << P;
/** Bits of the hash left for the run of zeros; a register holds 0 to Q + 1. */
export const Q = 64 - P;
export const DENSE = 1;
export const SPARSE = 2;
/** The most non-zero registers a sparse sketch holds before dense is smaller. */
export const SPARSE_MAX = Math.floor((M - 1) / 3);

/**
 * A DID as one register update, packed into a small integer: (register << 6) | value,
 * from the first 64 bits of its SHA-256 (for the spread, not the secrecy: DIDs are
 * public). Postgres has sha256() built in, so a sketch can be rebuilt there from DIDs.
 */
export function registerOf(did) {
  const h = crypto.hash('sha256', did, 'buffer');
  const hi = h.readUInt32BE(0);
  const lo = h.readUInt32BE(4);
  const index = hi >>> (32 - P);
  const rest = hi & ((1 << (32 - P)) - 1);
  const value = rest !== 0 ? Math.clz32(rest) - P + 1 : lo !== 0 ? 32 - P + Math.clz32(lo) + 1 : Q + 1;
  return (index << 6) | value;
}

function sigma(x) {
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

function tau(x) {
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

/** Ertl's estimate from a histogram: c[k] registers hold k, for k = 0 … Q + 1. */
export function estimateFromHistogram(c) {
  if (c[0] === M) return 0;
  let z = M * tau(1 - c[Q + 1] / M);
  for (let k = Q; k >= 1; k--) z = 0.5 * (z + c[k]);
  z += M * sigma(c[0] / M);
  return Math.round((M * M) / (2 * Math.LN2) / z);
}

export class Sketch {
  constructor(registers = new Uint8Array(M)) {
    this.registers = registers;
  }

  /** One packed update from registerOf. */
  add(packed) {
    const i = packed >>> 6;
    const v = packed & 63;
    if (v > this.registers[i]) this.registers[i] = v;
    return this;
  }

  addAll(packed) {
    for (const p of packed) this.add(p);
    return this;
  }

  merge(other) {
    const a = this.registers;
    const b = other.registers;
    for (let i = 0; i < M; i++) if (b[i] > a[i]) a[i] = b[i];
    return this;
  }

  /** How many different accounts went in, give or take 1.6%. */
  estimate() {
    const c = new Array(Q + 2).fill(0);
    for (const v of this.registers) c[v]++;
    return estimateFromHistogram(c);
  }

  /** The bytes described at the top: sparse while that's smaller, else dense. */
  encode() {
    const r = this.registers;
    let used = 0;
    for (const v of r) if (v) used++;
    if (used > SPARSE_MAX) {
      const out = Buffer.alloc(2 + M);
      out[0] = DENSE;
      out[1] = P;
      out.set(r, 2);
      return out;
    }
    const out = Buffer.alloc(2 + used * 3);
    out[0] = SPARSE;
    out[1] = P;
    let o = 2;
    for (let i = 0; i < M; i++) {
      if (!r[i]) continue;
      out[o++] = i >>> 8;
      out[o++] = i & 0xff;
      out[o++] = r[i];
    }
    return out;
  }

  /** A sketch from encode's bytes; throws on anything else. */
  static decode(bytes) {
    const b = Buffer.from(bytes);
    if (b.length < 2 || b[1] !== P) throw new Error('not a sketch');
    const s = new Sketch();
    if (b[0] === DENSE && b.length === 2 + M) {
      s.registers.set(b.subarray(2));
    } else if (b[0] === SPARSE && (b.length - 2) % 3 === 0) {
      for (let o = 2; o < b.length; o += 3) {
        const i = (b[o] << 8) | b[o + 1];
        if (i >= M) throw new Error('not a sketch');
        s.registers[i] = b[o + 2];
      }
    } else throw new Error('not a sketch');
    for (const v of s.registers) if (v > Q + 1) throw new Error('not a sketch');
    return s;
  }
}
