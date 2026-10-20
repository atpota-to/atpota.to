// The HyperLogLog sketch: hashing, estimates, merging and the bytes it's stored as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DENSE, estimateFromHistogram, M, P, Q, registerOf, Sketch, SPARSE, SPARSE_MAX } from '../src/hll.js';

const did = (i, salt = 'a') => `did:plc:${salt}${i.toString(36).padStart(22, '0')}`;
const sketchOf = (n, salt) => {
  const s = new Sketch();
  for (let i = 0; i < n; i++) s.add(registerOf(did(i, salt)));
  return s;
};

test('a DID is always the same register update, and in range', () => {
  const p = registerOf('did:plc:ewvi7nxzyoun6zhxrhs64oiz');
  assert.equal(p, registerOf('did:plc:ewvi7nxzyoun6zhxrhs64oiz'));
  for (let i = 0; i < 2000; i++) {
    const q = registerOf(did(i));
    assert.ok(q >>> 6 < M);
    assert.ok((q & 63) >= 1 && (q & 63) <= Q + 1);
  }
});

test('counts small numbers exactly and large ones within a few percent', () => {
  assert.equal(new Sketch().estimate(), 0);
  assert.equal(sketchOf(1).estimate(), 1);
  assert.equal(sketchOf(7).estimate(), 7);
  for (const n of [1000, 20_000, 200_000]) {
    const e = sketchOf(n, `n${n}`).estimate();
    assert.ok(Math.abs(e - n) / n < 0.05, `${n} accounts estimated as ${e}`);
  }
});

test('the same account twice is one account', () => {
  const s = sketchOf(500);
  const again = sketchOf(500);
  assert.equal(s.merge(again).estimate(), sketchOf(500).estimate());
  for (let i = 0; i < 500; i++) s.add(registerOf(did(i)));
  assert.equal(s.estimate(), sketchOf(500).estimate());
});

test('merging is a union: overlapping sets count their overlap once', () => {
  const a = new Sketch();
  const b = new Sketch();
  for (let i = 0; i < 6000; i++) a.add(registerOf(did(i)));
  for (let i = 3000; i < 9000; i++) b.add(registerOf(did(i)));
  const both = new Sketch().merge(a).merge(b);
  const e = both.estimate();
  assert.ok(Math.abs(e - 9000) / 9000 < 0.05, `union estimated as ${e}`);
  // merging is order-free and idempotent
  assert.deepEqual(new Sketch().merge(b).merge(a).merge(a).registers, both.registers);
});

test('sparse while it is smaller, dense after, and both decode to the same registers', () => {
  const small = sketchOf(40);
  const bytes = small.encode();
  assert.equal(bytes[0], SPARSE);
  assert.equal(bytes[1], P);
  const used = small.registers.filter(Boolean).length;
  assert.equal(bytes.length, 2 + 3 * used);
  assert.deepEqual(Sketch.decode(bytes).registers, small.registers);

  const big = sketchOf(5000);
  assert.ok(big.registers.filter(Boolean).length > SPARSE_MAX);
  const dense = big.encode();
  assert.equal(dense[0], DENSE);
  assert.equal(dense.length, 2 + M);
  assert.deepEqual(Sketch.decode(dense).registers, big.registers);
  assert.equal(Sketch.decode(Buffer.from(dense.toString('base64'), 'base64')).estimate(), big.estimate());

  assert.deepEqual([...new Sketch().encode()], [SPARSE, P]);
});

test('decode refuses bytes that are not a sketch', () => {
  for (const bad of [[], [SPARSE], [SPARSE, 14], [SPARSE, P, 0, 1], [DENSE, P, 1, 2, 3], [SPARSE, P, 0x10, 0x00, 1], [SPARSE, P, 0, 1, Q + 2], [9, P]]) {
    assert.throws(() => Sketch.decode(Buffer.from(bad)), /not a sketch/, JSON.stringify(bad));
  }
});

test('the estimator from a histogram: empty, one register, all full', () => {
  const c = new Array(Q + 2).fill(0);
  c[0] = M;
  assert.equal(estimateFromHistogram(c), 0);
  c[0] = M - 1;
  c[1] = 1;
  assert.equal(estimateFromHistogram(c), 1);
  const full = new Array(Q + 2).fill(0);
  full[Q + 1] = M;
  assert.equal(estimateFromHistogram(full), Infinity);
});

test('the same bytes Postgres builds: atmosphere_accounts.sql rebuilds these from sha256() in SQL', () => {
  // Checked against Supabase on 2026-10-20: registers from sha256(did) in SQL, merged with
  // atmosphere_hll_union and counted with atmosphere_hll_estimate.
  const x0 = registerOf('did:plc:x0');
  assert.deepEqual([x0 >>> 6, x0 & 63], [705, 1]);
  const y = sketchOf(0);
  for (let i = 0; i < 40; i++) y.add(registerOf(`did:plc:y${i}`));
  assert.equal(
    y.encode().toString('hex'),
    '020c00640100d80300ec0301550301d00103350204070304490304e50504f60104f901058d03064804066f02069e0306c50107470407820308650509130109680209700209c3020aa9050aba020ae3010b3a010bd9020c29010c96020cd7010cf8030d1c020d45010dbe050e37020e43010e8d030ef2010f2001',
  );
  const counted = (salt, n) => {
    const s = new Sketch();
    for (let i = 0; i < n; i++) s.add(registerOf(`did:plc:${salt}${i}`));
    return s.estimate();
  };
  assert.equal(counted('x', 30_000), 29_702);
  assert.equal(counted('z', 2000), 1974);
});
