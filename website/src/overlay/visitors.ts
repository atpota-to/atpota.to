/**
 * Visitors on stream: now and then one of the home page hero's visitors (src/scripts/scene.ts
 * and scene-art.ts, the same drawings) drops by Poe's corner, and Poe pulls a face at it:
 *
 *   butterfly  flutters in and sits on Poe's head for a while (day)
 *   moth       loops about over Poe's head (night: 8pm to 6am where the stream is)
 *   bird       hops in along the bottom edge, looks about, and hops off (day)
 *   snail      crawls up beside Poe, rests, and crawls back
 *   worm       pops up out of a hole beside Poe and goes back down
 *
 * They come from the side facing into the screen, so they never fall off its edge, and
 * they're as big as Poe is (setScale). The first comes after FIRST_MS, then one every
 * GAP_MIN_MS to GAP_MIN_MS + GAP_SPREAD_MS; ?demo brings them every DEMO_GAP_MS.
 * Decoration only (aria-hidden); every path is a static string.
 */

import { bird, snail, BIRD_COLOURS, type BirdType } from '../scripts/scene-art';
import { BUTTERFLY_ART, MOTH_ART, WORM_ART } from '../scripts/scene';
import type { MascotFace } from '../scripts/mascot';
import type { Side } from './config';

export const VISITOR_KINDS = ['butterfly', 'moth', 'bird', 'snail', 'worm'] as const;
export type VisitorKind = (typeof VISITOR_KINDS)[number];

export const FIRST_MS = 90_000;
export const GAP_MIN_MS = 4 * 60_000;
export const GAP_SPREAD_MS = 5 * 60_000;
export const DEMO_GAP_MS = 25_000;

/** Poe's face when each arrives (as on the home page). */
export const VISITOR_FACE: Record<VisitorKind, MascotFace> = { butterfly: 'wow', moth: 'wow', bird: 'happy', snail: 'kawaii', worm: 'happy' };

export function isNight(date: Date): boolean {
  const h = date.getHours();
  return h >= 20 || h < 6;
}

/** Who might come by at this hour. */
export function visitorsFor(date: Date): VisitorKind[] {
  return isNight(date) ? ['moth', 'snail', 'worm'] : ['butterfly', 'bird', 'snail', 'worm'];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function art(doc: Document, viewBox: string, inner: string, width: number): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(width));
  svg.setAttribute('focusable', 'false');
  // static strings from scene.ts / scene-art.ts only
  svg.innerHTML = inner;
  return svg;
}

/**
 * A point on a visitor's way, in px for Poe's corner: x from the screen's edge on Poe's
 * side, growing into the screen (Poe's middle is half the corner's width), y up from the
 * bottom of the screen. place() turns it into the corner's own coordinates.
 */
interface Step {
  x: number;
  y: number;
  /** Facing into the screen (1) or back out (-1). */
  face?: 1 | -1;
  at: number;
}

export interface Visit {
  kind: VisitorKind;
  /** How long it stays on screen. */
  ms: number;
  /** When Poe notices it, in ms from the start. */
  notice: number;
}

/** Where a visitor goes (Steps, at = 0 to 1 of its stay), for Poe's corner `w` wide. */
export function pathFor(kind: VisitorKind, w: number, random: () => number = Math.random): { steps: Step[]; visit: Visit } {
  const head = { x: w * 0.48, y: w * 0.62 };
  const beside = w * 1.05;
  const far = w * 2.6;
  switch (kind) {
    case 'butterfly': {
      const ms = 22_000;
      return {
        visit: { kind, ms, notice: 4500 },
        steps: [
          { x: far, y: w * 1.3, at: 0 },
          { x: w * 1.3, y: w * 1.05, at: 0.1 },
          { x: w * 0.8, y: w * 0.95, at: 0.16 },
          { x: head.x, y: head.y + 6, at: 0.22 },
          { x: head.x, y: head.y + 6, at: 0.78 },
          { x: w * 0.9, y: w * 1.0, at: 0.86 },
          { x: far, y: w * 1.5, at: 1 },
        ],
      };
    }
    case 'moth': {
      const ms = 16_000;
      const steps: Step[] = [{ x: far, y: w * 1.2, at: 0 }];
      for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * Math.PI * 4;
        steps.push({ x: head.x + Math.cos(a) * w * 0.32, y: head.y + w * 0.22 + Math.sin(a) * w * 0.12, at: 0.15 + (i / 8) * 0.7 });
      }
      steps.push({ x: far, y: w * 1.4, at: 1 });
      return { visit: { kind, ms, notice: 3000 }, steps };
    }
    case 'bird': {
      const ms = 18_000;
      const steps: Step[] = [];
      const hops = 6;
      // hop in, one arc at a time
      for (let i = 0; i <= hops; i++) {
        const x = far - ((far - beside) * i) / hops;
        steps.push({ x, y: 0, face: -1, at: (i / hops) * 0.3 });
        if (i < hops) steps.push({ x: x - (far - beside) / hops / 2, y: w * 0.08, face: -1, at: ((i + 0.5) / hops) * 0.3 });
      }
      steps.push({ x: beside, y: 0, face: -1, at: 0.7 });
      for (let i = 1; i <= hops; i++) {
        const x = beside + ((far - beside) * i) / hops;
        steps.push({ x: x - (far - beside) / hops / 2, y: w * 0.08, face: 1, at: 0.7 + ((i - 0.5) / hops) * 0.3 });
        steps.push({ x, y: 0, face: 1, at: 0.7 + (i / hops) * 0.3 });
      }
      return { visit: { kind, ms, notice: 5000 + Math.round(random() * 500) }, steps };
    }
    case 'snail': {
      const ms = 70_000;
      return {
        visit: { kind, ms, notice: 30_000 },
        steps: [
          { x: far, y: 0, face: -1, at: 0 },
          { x: beside, y: 0, face: -1, at: 0.45 },
          { x: beside, y: 0, face: 1, at: 0.55 },
          { x: far, y: 0, face: 1, at: 1 },
        ],
      };
    }
    case 'worm': {
      const ms = 9000;
      return { visit: { kind, ms, notice: 1500 }, steps: [{ x: beside, y: 0, at: 0 }, { x: beside, y: 0, at: 1 }] };
    }
  }
}

/** A step as a transform in the corner, for side `side`: the left corner turns it all around. */
export function place(step: Step, w: number, side: Side, size: number): string {
  // x was measured into the screen from the corner's outer edge
  const fromLeft = side === 'right' ? w - step.x : step.x;
  const facing = (step.face ?? 1) * (side === 'right' ? -1 : 1);
  return `translate(${(fromLeft - size / 2).toFixed(1)}px, ${(-step.y).toFixed(1)}px) scaleX(${facing})`;
}

export interface Visitors {
  /** Sends one now (or a given kind). */
  visit(kind?: VisitorKind): void;
  setEnabled(on: boolean): void;
  setSide(side: Side): void;
  /** Poe's size, as a fraction of its usual. */
  setScale(k: number): void;
}

export interface VisitorOptions {
  /** Poe's corner: visitors are drawn inside it. */
  corner: HTMLElement;
  /** Poe's face for a while. */
  react(face: MascotFace, ms: number): void;
  side: Side;
  scale: number;
  demo?: boolean;
  win?: Window;
  now?: () => Date;
  random?: () => number;
}

/** Usual sizes, at Poe's usual size. */
const SIZE: Record<VisitorKind, number> = { butterfly: 46, moth: 46, bird: 64, snail: 84, worm: 26 };
const POE_WIDTH = 300;

export function createVisitors(opts: VisitorOptions): Visitors {
  const { corner, react } = opts;
  const win = opts.win ?? window;
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? Math.random;
  const doc = corner.ownerDocument;
  let side = opts.side;
  let k = opts.scale;
  let enabled = true;
  let busy = false;
  let timer: number | undefined;

  const stage = doc.createElement('div');
  stage.className = 'ov-visitors';
  stage.setAttribute('aria-hidden', 'true');
  corner.prepend(stage);

  const birdTypes = Object.keys(BIRD_COLOURS) as BirdType[];
  const draw = (kind: VisitorKind, size: number): Element => {
    const wrap = doc.createElement('span');
    wrap.className = `ov-visit ov-visit--${kind}`;
    if (kind === 'butterfly') wrap.append(art(doc, ...BUTTERFLY_ART, size));
    else if (kind === 'moth') wrap.append(art(doc, ...MOTH_ART, size));
    else if (kind === 'worm') {
      const hole = doc.createElement('span');
      hole.className = 'ov-visit__hole';
      const burrow = doc.createElement('span');
      burrow.className = 'ov-visit__burrow';
      burrow.append(art(doc, ...WORM_ART, size));
      wrap.append(hole, burrow);
    } else if (kind === 'snail') wrap.append(art(doc, '-52 -56 104 60', snail(['potato', 'butter', 'sky'][Math.floor(random() * 3)] as 'potato'), size));
    else wrap.append(art(doc, '-44 -48 80 54', bird(birdTypes[Math.floor(random() * birdTypes.length)]!, `ov-bird-${Date.now()}`), size));
    return wrap;
  };

  const schedule = (ms: number) => {
    win.clearTimeout(timer);
    timer = win.setTimeout(() => {
      schedule(opts.demo ? DEMO_GAP_MS : GAP_MIN_MS + random() * GAP_SPREAD_MS);
      if (enabled && !busy && doc.visibilityState !== 'hidden') send();
    }, ms);
  };

  function send(kind?: VisitorKind): void {
    const pool = visitorsFor(now());
    const chosen = kind ?? pool[Math.floor(random() * pool.length)]!;
    const w = POE_WIDTH * k;
    const size = SIZE[chosen] * k;
    const { steps, visit } = pathFor(chosen, w, random);
    const el = draw(chosen, size) as HTMLElement;
    stage.append(el);
    busy = true;
    const done = () => {
      el.remove();
      busy = false;
    };
    if (typeof el.animate !== 'function') {
      win.setTimeout(done, visit.ms);
    } else {
      const anim = el.animate(
        steps.map((s) => ({ offset: s.at, transform: place(s, w, side, size) })),
        { duration: visit.ms, easing: 'linear', fill: 'both' },
      );
      anim.finished.then(done, done);
    }
    win.setTimeout(() => react(VISITOR_FACE[chosen], 3500), visit.notice);
  }

  schedule(opts.demo ? 4000 : FIRST_MS);
  return {
    visit: (kind) => {
      if (!busy) send(kind);
    },
    setEnabled(on) {
      enabled = on;
      stage.hidden = !on;
    },
    setSide(s) {
      side = s;
    },
    setScale(next) {
      k = next;
    },
  };
}
