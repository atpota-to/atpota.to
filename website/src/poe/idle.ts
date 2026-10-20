/**
 * Poe's idle life on the corner potato. While Poe rests it blinks every few
 * seconds, now and then glances with different eyes, and a few times per page
 * waves its leaf arm, so it reads as something you can tap.
 *
 * Kept small on purpose: every beat is over within two seconds, the wave stops
 * after MAX_WAVES or once the visitor has opened Poe, and ui.ts plays nothing
 * under reduced motion, in a hidden tab, or while Poe is open, busy, hovered or
 * nudging.
 *
 * After a minute with no input at all (no pointer, keys, wheel, touch or
 * scrolling) Poe dozes off: eyes shut, slow breathing, a few floating z's. The
 * next bit of input startles it awake for a moment (WAKE_MS on the wow face).
 *
 * Planning only; ui.ts owns the timers and the DOM.
 */

import type { MascotFace } from '../scripts/mascot';

export type IdleBeat = { kind: 'blink'; times: 1 | 2 } | { kind: 'glance'; face: MascotFace } | { kind: 'wave' };

/** Eyes shut for one blink, and open between the two of a double blink. */
export const BLINK_MS = 140;
export const BLINK_GAP_MS = 160;
export const GLANCE_MS = 1300;
/** Matches the poe-wave animation in poe.css (checked in tests/poe-styles.test.ts). */
export const WAVE_MS = 1600;
export const MAX_WAVES = 3;
export const NAP_AFTER_MS = 60_000;
/** Matches the poe-startle animation in poe.css. */
export const WAKE_MS = 900;

/** Whether Poe should doze off, `quietFor` ms after the visitor's last input. */
export function shouldNap(quietFor: number): boolean {
  return quietFor >= NAP_AFTER_MS;
}

const GAP_MIN_MS = 3500;
const GAP_SPREAD_MS = 4000;
const FIRST_WAVE_MS = 9000;
const WAVE_EVERY_MIN_MS = 40_000;
const WAVE_EVERY_SPREAD_MS = 30_000;
const GLANCE_CHANCE = 0.15;
const DOUBLE_BLINK_CHANCE = 0.15;

/** The faces a glance picks from: sparkly eyes, happy eyes, a wink. */
export const GLANCE_FACES: readonly MascotFace[] = ['kawaii', 'happy', 'wink'];

export interface IdlePlan {
  /** Resting time so far, summed from the gaps before each beat that played. */
  elapsed: number;
  waves: number;
  nextWaveAt: number;
  lastGlance: MascotFace | null;
}

export function startIdle(): IdlePlan {
  return { elapsed: 0, waves: 0, nextWaveAt: FIRST_WAVE_MS, lastGlance: null };
}

/** How long until the next beat. Always longer than the longest beat. */
export function idleGap(random: () => number = Math.random): number {
  return GAP_MIN_MS + Math.round(random() * GAP_SPREAD_MS);
}

/** What Poe does after resting for `gap` more ms. Updates `plan`. */
export function nextBeat(plan: IdlePlan, gap: number, canWave: boolean, random: () => number = Math.random): IdleBeat {
  plan.elapsed += gap;
  if (canWave && plan.waves < MAX_WAVES && plan.elapsed >= plan.nextWaveAt) {
    plan.waves += 1;
    plan.nextWaveAt = plan.elapsed + WAVE_EVERY_MIN_MS + Math.round(random() * WAVE_EVERY_SPREAD_MS);
    return { kind: 'wave' };
  }
  const roll = random();
  if (roll < GLANCE_CHANCE) {
    const faces = GLANCE_FACES.filter((face) => face !== plan.lastGlance);
    const face = faces[Math.floor((roll / GLANCE_CHANCE) * faces.length)] ?? faces[0]!;
    plan.lastGlance = face;
    return { kind: 'glance', face };
  }
  return { kind: 'blink', times: roll < GLANCE_CHANCE + DOUBLE_BLINK_CHANCE ? 2 : 1 };
}
