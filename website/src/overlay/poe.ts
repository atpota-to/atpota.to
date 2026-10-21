/**
 * Poe on stream: the corner potato from the website (src/poe/ui.ts), bigger, on a
 * transparent page, with nothing to click. It lives the same idle life (blinks, glances
 * and a wave now and then, src/poe/idle.ts), except that on stream it never stops waving,
 * and it bobs a little faster when the atmosphere is busy (setPace).
 *
 * When the stream has been quiet for `napMs` (nothing in the chat, nothing said), Poe
 * dozes off like the website's potato: eyes shut, slow breaths, z's drifting up. The next
 * thing that happens (stir(), or a line to say) startles it awake for WAKE_MS first.
 *
 * Lines (the weather, hellos to chatters, thanks to followers) come up in a bubble over
 * its head one at a time, each for its `ms`, with a face, the person's avatar when there
 * is one, a little sound (sounds.ts), and sometimes a hop or a burst. The queue keeps the
 * most important ones (`rank`) when lines pile up, and drops any that waited longer than
 * STALE_MS: by then they aren't news.
 *
 * Every word reaches the page through textContent.
 */

import { burst, type BurstKind } from '../scripts/burst';
import { MASCOT_ARM_URL, MASCOT_URLS, MASCOT_WAVE_URL, preloadFaces, type MascotFace } from '../scripts/mascot';
import { BLINK_GAP_MS, BLINK_MS, CHEER_MS, GLANCE_MS, MAX_WAVES, WAKE_MS, WAVE_MS, idleGap, nextBeat, startIdle, type IdleBeat } from '../poe/idle';
import { SILENT, type Sound, type Sounds } from './sounds';

export interface OverlayLine {
  label?: string;
  text: string;
  sub?: string;
  face?: MascotFace;
  /** The person's avatar (chat.ts avatarUrl checks it), beside the words. */
  avatar?: string | null;
  sound?: Sound;
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
/** Quiet for this long and Poe dozes off, unless ?nap= says otherwise. */
export const NAP_MS = 5 * 60_000;
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
  /** Something happened on the stream: no nap yet, and wake up if napping. */
  stir(): void;
  setPace(recordsPerSecond: number): void;
}

export interface OverlayPoeOptions {
  sounds?: Sounds;
  /** Quiet this long and Poe naps; 0 never. */
  napMs?: number;
  win?: Window;
  now?: () => number;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = cls;
  return node;
}

export function mountOverlayPoe(host: HTMLElement, options: OverlayPoeOptions = {}): OverlayPoe {
  const { sounds = SILENT, napMs = NAP_MS, win = window, now = () => Date.now() } = options;
  const doc = host.ownerDocument;
  const bubble = el(doc, 'div', 'ov-bubble');
  bubble.hidden = true;
  bubble.setAttribute('role', 'status');
  const avatar = el(doc, 'img', 'ov-bubble__avatar');
  avatar.alt = '';
  avatar.hidden = true;
  avatar.referrerPolicy = 'no-referrer';
  const words = el(doc, 'div', 'ov-bubble__words');
  const label = el(doc, 'p', 'ov-bubble__label');
  const text = el(doc, 'p', 'ov-bubble__text');
  const sub = el(doc, 'p', 'ov-bubble__sub');
  words.append(label, text, sub);
  bubble.append(avatar, words);

  const potato = el(doc, 'div', 'ov-potato');
  const arm = el(doc, 'img', 'ov-potato__arm');
  arm.src = MASCOT_ARM_URL;
  arm.alt = '';
  const img = el(doc, 'img', 'ov-potato__img');
  img.src = MASCOT_URLS.normal;
  img.alt = 'poe, the atpotato potato';
  const zzz = el(doc, 'span', 'ov-potato__zzz');
  zzz.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) zzz.append(Object.assign(doc.createElement('i'), { textContent: 'z' }));
  potato.append(arm, img, zzz);
  host.append(bubble, potato);
  preloadFaces();

  // ---------- faces ----------
  let talkFace: MascotFace | null = null;
  let beatSrc: string | null = null;
  let napping = false;
  const show = () => {
    const src = beatSrc ?? (talkFace ? MASCOT_URLS[talkFace] : napping ? MASCOT_URLS.sleepy : MASCOT_URLS.normal);
    if (img.getAttribute('src') !== src) img.src = src;
  };

  // ---------- idle life ----------
  const plan = startIdle();
  let frameTimer: number | undefined;
  let busy = false;
  let lastStir = now();
  const endBeat = () => {
    win.clearTimeout(frameTimer);
    busy = false;
    beatSrc = null;
    delete potato.dataset.waving;
    delete potato.dataset.hopping;
    delete potato.dataset.startled;
    show();
  };
  const play = (frames: Array<[string | null, number]>, attr?: 'waving' | 'hopping' | 'startled') => {
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
  const nap = () => {
    endBeat();
    napping = true;
    potato.dataset.napping = 'true';
    sounds.play('yawn');
    show();
  };
  /** Wakes with a start; true when Poe was asleep (so a line waits for the jump). */
  const wake = (): boolean => {
    lastStir = now();
    if (!napping) return false;
    napping = false;
    delete potato.dataset.napping;
    play([[MASCOT_URLS.wow, WAKE_MS]], 'startled');
    return true;
  };
  const idle = () => {
    const gap = idleGap();
    win.setTimeout(() => {
      idle();
      if (busy || talkFace || napping) return;
      if (napMs > 0 && now() - lastStir >= napMs) return nap();
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
    if (line.avatar) avatar.src = line.avatar;
    else avatar.removeAttribute('src');
    avatar.hidden = !line.avatar;
    bubble.hidden = false;
    bubble.classList.remove('is-leaving');
    talkFace = line.face ?? 'wink';
    if (line.hop) hop(talkFace);
    else if (line.wave) wave();
    else endBeat();
    sounds.play(line.sound ?? 'talk');
    if (line.burst) burst(potato, line.burst, win);
    win.setTimeout(() => {
      bubble.classList.add('is-leaving');
      talkFace = null;
      lastStir = now();
      show();
      win.setTimeout(() => {
        bubble.hidden = true;
        talking = false;
        next();
      }, LINE_GAP_MS);
    }, line.ms ?? LINE_MS);
  };

  return {
    say(line) {
      queue = enqueue(queue, line, now(), pushed++);
      if (wake()) win.setTimeout(next, WAKE_MS);
      else next();
    },
    stir() {
      wake();
    },
    setPace(rate) {
      potato.style.setProperty('--bob', `${bobMs(rate)}ms`);
    },
  };
}
