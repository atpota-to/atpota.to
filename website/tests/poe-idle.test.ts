import { describe, expect, it } from 'vitest';
import { BLINK_GAP_MS, BLINK_MS, GLANCE_FACES, GLANCE_MS, MAX_WAVES, NAP_AFTER_MS, WAVE_MS, idleGap, nextBeat, shouldNap, startIdle, type IdleBeat } from '../src/poe/idle.js';

/** A seeded random (mulberry32), so a failure replays. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plays `beats` beats and returns them with the rest time each one landed at. */
function run(beats: number, canWave: boolean, random: () => number): Array<{ at: number; beat: IdleBeat }> {
  const plan = startIdle();
  const out: Array<{ at: number; beat: IdleBeat }> = [];
  for (let i = 0; i < beats; i++) {
    const beat = nextBeat(plan, idleGap(random), canWave, random);
    out.push({ at: plan.elapsed, beat });
  }
  return out;
}

describe('idle beats', () => {
  it('waits a few seconds between beats, always longer than a beat lasts', () => {
    expect(idleGap(() => 0)).toBe(3500);
    expect(idleGap(() => 1)).toBe(7500);
    const longest = Math.max(WAVE_MS, GLANCE_MS, BLINK_MS * 2 + BLINK_GAP_MS);
    expect(idleGap(() => 0)).toBeGreaterThan(longest);
  });

  it('mostly blinks, sometimes twice, and glances now and then', () => {
    const random = seeded(7);
    const kinds = run(400, false, random).map(({ beat }) => (beat.kind === 'blink' ? `blink${beat.times}` : beat.kind));
    const share = (kind: string) => kinds.filter((k) => k === kind).length / kinds.length;
    expect(share('blink1')).toBeGreaterThan(0.6);
    expect(share('blink2')).toBeGreaterThan(0.05);
    expect(share('glance')).toBeGreaterThan(0.05);
    expect(share('glance')).toBeLessThan(0.3);
  });

  it('glances only with friendly eyes, never the same face twice in a row', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const glances = run(200, true, seeded(seed)).flatMap(({ beat }) => (beat.kind === 'glance' ? [beat.face] : []));
      for (const face of glances) expect(GLANCE_FACES).toContain(face);
      for (let i = 1; i < glances.length; i++) expect(glances[i]).not.toBe(glances[i - 1]);
    }
    expect(GLANCE_FACES).not.toContain('scawy');
    expect(GLANCE_FACES).not.toContain('dead');
  });

  it('waves first after about nine seconds of rest, then rarely, at most MAX_WAVES times', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const waves = run(400, true, seeded(seed))
        .filter(({ beat }) => beat.kind === 'wave')
        .map(({ at }) => at);
      expect(waves).toHaveLength(MAX_WAVES);
      expect(waves[0]).toBeGreaterThanOrEqual(9000);
      expect(waves[0]).toBeLessThan(9000 + 7500);
      for (let i = 1; i < waves.length; i++) expect(waves[i]! - waves[i - 1]!).toBeGreaterThanOrEqual(40_000);
    }
  });

  it('never waves when waving is off', () => {
    expect(run(400, false, seeded(3)).some(({ beat }) => beat.kind === 'wave')).toBe(false);
  });
});

describe('nap', () => {
  it('dozes off after a minute of no input, not before', () => {
    expect(shouldNap(NAP_AFTER_MS - 1)).toBe(false);
    expect(shouldNap(NAP_AFTER_MS)).toBe(true);
    expect(NAP_AFTER_MS).toBe(60_000);
  });
});
