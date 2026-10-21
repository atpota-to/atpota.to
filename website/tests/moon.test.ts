// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { litPath, moonPhase, paintMoons, phaseAt, previewPhase } from '../src/scripts/moon.js';
import { iconFor } from '../src/scripts/weather-forecast.js';

describe('moonPhase', () => {
  it('lands on real new and full moons', () => {
    // the 2024 total eclipse was a new moon; 10 and 26 October 2026 are a new and a full moon
    for (const iso of ['2024-04-08T18:21:00Z', '2026-10-10T15:50:00Z']) {
      const m = moonPhase(new Date(iso));
      expect(m.name, iso).toBe('new moon');
      expect(m.illumination, iso).toBeLessThan(0.001);
    }
    const full = moonPhase(new Date('2026-10-26T04:12:00Z'));
    expect(full.name).toBe('full moon');
    expect(full.illumination).toBeGreaterThan(0.999);
  });

  it("agrees with cocoon's /api/moon/phase", () => {
    // its answer for 2026-10-21T12:00:00Z: phase 0.3377, illumination 0.7617, waxing gibbous
    const m = moonPhase(new Date('2026-10-21T12:00:00Z'));
    expect(m.phase).toBeCloseTo(0.3377, 4);
    expect(m.illumination).toBeCloseTo(0.7617, 4);
    expect(m.waxing).toBe(true);
    expect(m.name).toBe('waxing gibbous');
  });

  it('names each part of the cycle', () => {
    expect([0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9].map((p) => phaseAt(p).name)).toEqual([
      'new moon',
      'waxing crescent',
      'first quarter',
      'waxing gibbous',
      'full moon',
      'waning gibbous',
      'last quarter',
      'waning crescent',
    ]);
  });
});

describe('litPath', () => {
  it('lights the right side while waxing and the left while waning', () => {
    expect(litPath(50, 50, 23, phaseAt(0.1))).toMatch(/^M50 27A23 23 0 0 1 50 73A[\d.]+ 23 0 0 0 50 27Z$/);
    expect(litPath(50, 50, 23, phaseAt(0.9))).toMatch(/^M50 27A23 23 0 0 0 50 73A[\d.]+ 23 0 0 1 50 27Z$/);
  });

  it('bulges the terminator outward past the quarters', () => {
    expect(litPath(50, 50, 23, phaseAt(0.4))).toContain('0 0 1 50 27Z');
    expect(litPath(50, 50, 23, phaseAt(0.6))).toContain('0 0 0 50 27Z');
  });

  it('draws nothing at a new moon and a whole disc at full', () => {
    expect(litPath(50, 50, 23, phaseAt(0))).toBe('');
    expect(litPath(50, 50, 23, phaseAt(0.5))).toBe('M50 27A23 23 0 0 0 50 73A23 23 0 0 0 50 27Z');
  });
});

describe('paintMoons', () => {
  it('fills in every moon on the page from its disc', () => {
    document.body.innerHTML = '<svg><path data-moon-lit="32 32 30" d="old"/><path data-moon-lit="50 50 23"/><path data-moon-lit="nonsense" d="kept"/></svg>';
    paintMoons(document, phaseAt(0.25));
    const [a, b, c] = document.querySelectorAll('path');
    expect(a!.getAttribute('d')).toBe('M32 2A30 30 0 0 1 32 62A0 30 0 0 0 32 2Z');
    expect(b!.getAttribute('d')).toBe('M50 27A23 23 0 0 1 50 73A0 23 0 0 0 50 27Z');
    expect(c!.getAttribute('d')).toBe('kept');
  });

  it('previews a phase from ?moon=', () => {
    expect(previewPhase('?moon=0.5')).toBe(0.5);
    expect(previewPhase('?moon=')).toBeUndefined();
    expect(previewPhase('?moon=full')).toBeUndefined();
    expect(previewPhase('?scene=night')).toBeUndefined();
  });
});

describe('the forecast moon', () => {
  it('is drawn in the phase it is given', () => {
    expect(iconFor('calm', true, phaseAt(0))).not.toContain('class="wf-moon"');
    expect(iconFor('calm', true, phaseAt(0.5))).toContain('class="wf-moon"');
    expect(iconFor('light', true, phaseAt(0.25))).toContain('wf-moon-rim');
    expect(iconFor('calm', false, phaseAt(0.5))).not.toContain('wf-moon');
  });
});
