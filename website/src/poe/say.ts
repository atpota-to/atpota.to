/**
 * Pages talking through Poe: a line in a chat bubble beside the corner potato, the way
 * the weather report's alerts arrive (src/scripts/weather-alerts.ts). The widget signs
 * itself up as the speaker when it mounts (ui.ts), so a page only needs this module:
 *
 *   say(line)  ->  PoeWidget.say()  ->  a bubble by the potato, and Poe pulls a face
 *
 * Poe says one line at a time, and none while its panel is open or its nudge bubble is
 * up; say() is null then (and when there's no Poe on the page), and the page can try
 * again later. A line goes after `ms` (held while it's hovered or focused), from its
 * close button, on Escape, or when the panel opens, and `onGone` hears about it whichever
 * way it went. The words only reach the page through textContent.
 */

import type { BurstKind } from '../scripts/burst';
import type { MascotFace } from '../scripts/mascot';

/** How long a line stays up unless it says otherwise. */
export const SAY_MS = 9000;

export interface PoeLine {
  /** A small label over the words ("weather alert"). */
  label?: string;
  /** What Poe says. A trailing kaomoji stays on screen but out of the screen reader. */
  text: string;
  /** A quieter second line. */
  sub?: string;
  /** Poe's face while it talks; a wink unless said. */
  face?: MascotFace;
  /** A little burst out of the bubble as it lands. */
  burst?: BurstKind;
  ms?: number;
  /** A quiet text button under the words; pressing it also sends the line away. */
  action?: { label: string; run: () => void };
  /** Called once the bubble has gone, however it went. */
  onGone?: () => void;
}

export interface PoeSpeech {
  /** Takes the line away now (onGone still runs). */
  close(): void;
}

type Speaker = (line: PoeLine) => PoeSpeech | null;

let speaker: Speaker | null = null;

/** The widget signs up here when it mounts; the returned function signs it off again. */
export function setSpeaker(fn: Speaker): () => void {
  speaker = fn;
  return () => {
    if (speaker === fn) speaker = null;
  };
}

/** Asks the corner Poe to say `line`: null when it can't right now. */
export function say(line: PoeLine): PoeSpeech | null {
  try {
    return speaker?.(line) ?? null;
  } catch {
    return null;
  }
}
