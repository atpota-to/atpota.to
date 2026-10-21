/**
 * Pages talking through Poe: a line in a chat bubble beside the corner potato, the way
 * the weather report's alerts arrive (src/scripts/weather-alerts.ts), or an explanation
 * in the chat itself, the way the weather report's info buttons answer "what's this?".
 * The widget signs itself up for both when it mounts (ui.ts), so a page only needs this
 * module:
 *
 *   say(line)        ->  PoeWidget.say()      ->  a bubble by the potato, and Poe pulls a face
 *   explain(answer)  ->  PoeWidget.explain()  ->  the chat opens on the reader's question and
 *                                                Poe's answer, written ahead of time: no
 *                                                model, no wait, nothing sent anywhere
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

export interface PoeExplanation {
  /** The reader's side of the chat: what tapping the button asks ("what's the diversity index?"). */
  question: string;
  /** Poe's answer, in its voice, rendered like any of its answers: paragraphs, "- " lists, `code`, a trailing kaomoji. */
  answer: string;
  /** What focus goes back to when the chat closes: the button, usually. */
  opener?: Element | null;
  /** How the button was pressed: from the keyboard, the cursor goes in the input. */
  via?: 'keyboard' | 'pointer';
}

type Speaker = (line: PoeLine) => PoeSpeech | null;
type Explainer = (explanation: PoeExplanation) => boolean;

let speaker: Speaker | null = null;
let explainer: Explainer | null = null;

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

/** The widget signs up here too; the returned function signs it off again. */
export function setExplainer(fn: Explainer): () => void {
  explainer = fn;
  return () => {
    if (explainer === fn) explainer = null;
  };
}

/** Opens Poe's chat on `explanation`: false when it can't (no Poe on the page, or another dialog open). */
export function explain(explanation: PoeExplanation): boolean {
  try {
    return explainer?.(explanation) ?? false;
  } catch {
    return false;
  }
}
