/**
 * Poe on stream: the corner potato from the website (src/poe/ui.ts), bigger, on a
 * transparent page, with nothing to click. It lives the same idle life (blinks, glances
 * and a wave now and then, src/poe/idle.ts), except that on stream it never stops waving
 * and never naps, and it bobs a little faster when the atmosphere is busy (setPace).
 *
 * Lines (the weather, hellos to chatters, thanks to followers) come up in a bubble over
 * its head one at a time, each for its `ms`, with a face and sometimes a hop or a burst.
 * The queue keeps the most important ones (`rank`) when lines pile up, and drops any that
 * waited longer than STALE_MS: by then they aren't news.
 *
 * Every word reaches the page through textContent.
 */

import { burst, type BurstKind } from '../scripts/burst';
import { MASCOT_ARM_URL, MASCOT_URLS, MASCOT_WAVE_URL, preloadFaces, type MascotFace } from '../scripts/mascot';
import { BLINK_GAP_MS, BLINK_MS, CHEER_MS, GLANCE_MS, MAX_WAVES, WAVE_MS, idleGap, nextBeat, startIdle, type IdleBeat } from '../poe/idle';

export interface OverlayLine {
  label?: string;
  text: string;
  sub?: string;
  face?: MascotFace;
  /** A hop as it lands (a follow, a pet). */
  hop?: boolean;
  wave?: boolean;
  burst?: BurstKind;
  /** Higher stays when the queue is full; ties keep the newest. */
  rank?: number;
  ms?: number;
}

export const LINE_MS = 7000;
/** A beat of quiet between lines. */
export const LINE_GAP_MS = 1200;
export const MAX_LINES = 4;
export const STALE_MS = 45_000;
/** How long one breath takes at a usual 450 records a second, and the limits either way. */
const BOB_MS = 3200;
const BOB_MIN_MS = 1400;
const BOB_MAX_MS = 5000;
const BASELINE = 450;

/** The breathing pace for `recordsPerSecond`: busier is quicker. */
export function bobMs(recordsPerSecond: number): number {
  if (!(recordsPerSecond > 0)) return BOB_MS;
  return Math.round(Math.max(BOB_MIN_MS, Math.min(BOB_MAX_MS, BOB_MS * (BASELINE / recordsPerSecond))));
}

interface Queued {
  line: OverlayLine;
  at: number;
  n: number;
}

/** Adds `line` to `queue`, keeping the MAX_LINES most important (ties: the newest) in the order they came. */
export function enqueue(queue: Queued[], line: OverlayLine, at: number, n: number): Queued[] {
  const rank = (q: Queued) => q.line.rank ?? 0;
  return [...queue, { line, at, n }]
    .sort((x, y) => rank(y) - rank(x) || y.n - x.n)
    .slice(0, MAX_LINES)
    .sort((x, y) => x.n - y.n);
}

export interface OverlayPoe {
  say(line: OverlayLine): void;
  setPace(recordsPerSecond: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = cls;
  return node;
}

export function mountOverlayPoe(host: HTMLElement, win: Window = window, now: () => number = () => Date.now()): OverlayPoe {
  const doc = host.ownerDocument;
  const bubble = el(doc, 'div', 'ov-bubble');
  bubble.hidden = true;
  bubble.setAttribute('role', 'status');
  const label = el(doc, 'p', 'ov-bubble__label');
  const text = el(doc, 'p', 'ov-bubble__text');
  const sub = el(doc, 'p', 'ov-bubble__sub');
  bubble.append(label, text, sub);

  const potato = el(doc, 'div', 'ov-potato');
  const arm = el(doc, 'img', 'ov-potato__arm');
  arm.src = MASCOT_ARM_URL;
  arm.alt = '';
  const img = el(doc, 'img', 'ov-potato__img');
  img.src = MASCOT_URLS.normal;
  img.alt = 'poe, the atpotato potato';
  potato.append(arm, img);
  host.append(bubble, potato);
  preloadFaces();

  // ---------- faces ----------
  let talkFace: MascotFace | null = null;
  let beatSrc: string | null = null;
  const show = () => {
    const src = beatSrc ?? (talkFace ? MASCOT_URLS[talkFace] : MASCOT_URLS.normal);
    if (img.getAttribute('src') !== src) img.src = src;
  };

  // ---------- idle life ----------
  const plan = startIdle();
  let frameTimer: number | undefined;
  let busy = false;
  const endBeat = () => {
    win.clearTimeout(frameTimer);
    busy = false;
    beatSrc = null;
    delete potato.dataset.waving;
    delete potato.dataset.hopping;
    show();
  };
  const play = (frames: Array<[string | null, number]>, attr?: 'waving' | 'hopping') => {
    endBeat();
    busy = true;
    if (attr) potato.dataset[attr] = 'true';
    const step = (i: number) => {
      const frame = frames[i];
      if (!frame) return endBeat();
      beatSrc = frame[0];
      show();
      frameTimer = win.setTimeout(() => step(i + 1), frame[1]);
    };
    step(0);
  };
  const wave = () => play([[MASCOT_WAVE_URL, WAVE_MS]], 'waving');
  const hop = (face: MascotFace) => play([[MASCOT_URLS[face], CHEER_MS]], 'hopping');
  const playBeat = (beat: IdleBeat) => {
    const shut = MASCOT_URLS.sleepy;
    if (beat.kind === 'wave') return wave();
    if (beat.kind === 'glance') return play([[MASCOT_URLS[beat.face], GLANCE_MS]]);
    play(
      beat.times === 2
        ? [
            [shut, BLINK_MS],
            [null, BLINK_GAP_MS],
            [shut, BLINK_MS],
          ]
        : [[shut, BLINK_MS]],
    );
  };
  const idle = () => {
    const gap = idleGap();
    win.setTimeout(() => {
      idle();
      if (busy || talkFace) return;
      // On stream there's no "once they've found it": keep waving every minute or so.
      if (plan.waves >= MAX_WAVES) plan.waves = 0;
      playBeat(nextBeat(plan, gap, true));
    }, gap);
  };
  idle();

  // ---------- lines ----------
  let queue: Queued[] = [];
  let pushed = 0;
  let talking = false;
  let wait: number | undefined;

  const next = () => {
    if (talking) return;
    const t = now();
    queue = queue.filter((q) => t - q.at < STALE_MS);
    const first = queue.shift();
    if (!first) return;
    const { line } = first;
    talking = true;
    label.textContent = line.label ?? '';
    label.hidden = !line.label;
    text.textContent = line.text;
    sub.textContent = line.sub ?? '';
    sub.hidden = !line.sub;
    bubble.hidden = false;
    bubble.classList.remove('is-leaving');
    talkFace = line.face ?? 'wink';
    if (line.hop) hop(talkFace);
    else if (line.wave) wave();
    else endBeat();
    if (line.burst) burst(potato, line.burst, win);
    wait = win.setTimeout(() => {
      bubble.classList.add('is-leaving');
      talkFace = null;
      show();
      wait = win.setTimeout(() => {
        bubble.hidden = true;
        talking = false;
        next();
      }, LINE_GAP_MS);
    }, line.ms ?? LINE_MS);
  };

  return {
    say(line) {
      queue = enqueue(queue, line, now(), pushed++);
      next();
    },
    setPace(rate) {
      potato.style.setProperty('--bob', `${bobMs(rate)}ms`);
    },
  };
}
