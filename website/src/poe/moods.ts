/**
 * Poe's moods (SPEC 4.6) and the potato face each one shows.
 *
 *   resting  -> normal     corner potato, nothing going on (blinks and waves now and then, idle.ts)
 *   curious  -> kawaii     hover/focus on the corner potato; the open panel while idle
 *   nudge    -> wink       while the nudge bubble shows, or a page's line (say.ts, which
 *                          can ask for another face)
 *   digging  -> sleepy     a turn is in flight
 *   found    -> happy      an answer just landed (a few seconds)
 *   error    -> scawy      something went wrong
 *   offline  -> dead       not configured, or the visitor is offline
 */

import { MASCOT_URLS, type MascotFace } from '../scripts/mascot';

export type Mood = 'resting' | 'curious' | 'nudge' | 'digging' | 'found' | 'error' | 'offline';

export const MOOD_FACE: Record<Mood, MascotFace> = {
  resting: 'normal',
  curious: 'kawaii',
  nudge: 'wink',
  digging: 'sleepy',
  found: 'happy',
  error: 'scawy',
  offline: 'dead',
};

export function faceUrl(mood: Mood): string {
  return MASCOT_URLS[MOOD_FACE[mood]];
}

/** How long a passing mood lasts before Poe settles back down. */
export const FOUND_MS = 4000;
export const ERROR_MS = 6000;

export interface MoodState {
  /** Turn-driven mood (digging/found/error/offline) or null when idle. */
  turn: Mood | null;
  open: boolean;
  nudging: boolean;
  hovered: boolean;
}

/** The face for the corner potato. */
export function cornerMood(state: MoodState): Mood {
  if (state.turn) return state.turn;
  if (state.hovered) return 'curious';
  if (state.nudging) return 'nudge';
  return 'resting';
}

/** The face for the potato perched on the open panel. */
export function perchedMood(state: MoodState): Mood {
  return state.turn ?? 'curious';
}
