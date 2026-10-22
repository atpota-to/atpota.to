/**
 * Anisota's brand mark and moon, for streamers who use it (anisota.net): the same drawings
 * as Anisota's own splash, MoonGlyph and porch mark (its src/utils/brandMoon.js, carved
 * style), so they match the app on screen.
 *
 *   mark     the brand mark (src/assets/anisota-mark.svg, a <symbol> without its moon) with
 *            tonight's moon redrawn where its moon was
 *   moon     the carved moon on its own, at tonight's phase
 *   loader   the mark with its moon running through a whole cycle every CYCLE_MS, in
 *            whole-day steps (stop-motion, never tweened), as Anisota's loading screen does
 *
 * Every <div data-ov-anisota="mark|moon|loader"> under the root gets one. "Tonight" comes
 * from scripts/moon.ts (the same math as Anisota's moonCalculator), so ?moon= previews a
 * phase here too, and it's looked at again every MOON_REFRESH_MS. A loader starts from
 * tonight's phase, so its first frame is the real moon.
 */

import { pageMoon, type MoonPhase } from '../scripts/moon';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const MARK_VIEWBOX = '0 0 516.02 741.26';
/** A square framing the moon's disc, so a moon's box is the moon. */
export const MOON_VIEWBOX = '60.6 55.9 217.3 217.3';
/** One lunar cycle on a loader, in CYCLE_DAYS steps. */
export const CYCLE_MS = 4000;
export const CYCLE_DAYS = 30;
export const MOON_REFRESH_MS = 10 * 60_000;

/** The round moon traced from Anisota's linocut prints, about (MOON_CX, MOON_CY). */
export const MOON_DISC =
  'M 277.17 164.49 L 277.60 175.16 L 276.70 185.87 L 274.27 196.35 L 270.34 206.37 L 265.46 215.93 L 259.90 225.08 L 253.93 234.00 L 246.94 242.20 L 238.79 249.24 L 229.27 254.35 L 219.55 258.62 L 209.84 262.53 L 199.90 265.60 L 189.88 268.31 L 179.63 270.13 L 169.23 270.74 L 158.83 270.13 L 148.53 268.57 L 138.53 265.69 L 128.82 262.05 L 119.35 257.82 L 110.38 252.56 L 102.03 246.37 L 94.06 239.66 L 86.80 232.14 L 80.29 223.92 L 75.01 214.85 L 71.13 205.12 L 67.90 195.23 L 65.47 185.13 L 63.92 174.86 L 62.72 164.49 L 62.03 153.93 L 62.34 143.23 L 64.37 132.68 L 68.12 122.61 L 73.08 113.10 L 78.83 104.08 L 85.16 95.49 L 92.16 87.42 L 100.09 80.24 L 108.68 73.87 L 117.73 68.14 L 127.35 63.38 L 137.91 61.23 L 148.67 61.12 L 159.07 61.35 L 169.23 61.64 L 179.33 61.94 L 189.42 62.97 L 199.20 65.69 L 208.47 69.77 L 217.59 74.01 L 226.59 78.65 L 235.80 83.37 L 244.73 88.99 L 252.60 96.07 L 259.31 104.30 L 264.63 113.50 L 268.66 123.31 L 271.96 133.33 L 274.59 143.53 L 276.36 153.94 Z';
/** The ring's carved inner edge. */
const MOON_INNER =
  'M 247.38 164.49 L 247.70 172.22 L 247.35 180.03 L 245.63 187.67 L 242.82 194.97 L 239.18 201.88 L 235.02 208.45 L 230.56 214.82 L 225.60 220.86 L 219.56 225.82 L 212.66 229.48 L 205.58 232.50 L 198.45 235.03 L 191.28 237.17 L 184.06 239.04 L 176.70 240.32 L 169.23 240.72 L 161.76 240.34 L 154.37 239.17 L 147.18 237.19 L 140.20 234.57 L 133.48 231.38 L 127.06 227.60 L 121.00 223.26 L 115.26 218.46 L 109.92 213.17 L 105.33 207.18 L 101.65 200.61 L 98.61 193.74 L 96.25 186.63 L 94.68 179.32 L 93.54 171.94 L 92.68 164.49 L 92.02 156.88 L 91.96 149.12 L 93.17 141.42 L 95.79 134.07 L 99.41 127.17 L 103.64 120.66 L 108.27 114.46 L 113.35 108.61 L 119.01 103.30 L 125.27 98.70 L 131.91 94.67 L 139.14 91.84 L 146.91 90.90 L 154.60 90.93 L 162.00 91.12 L 169.23 91.43 L 176.40 91.68 L 183.56 92.45 L 190.46 94.50 L 197.04 97.35 L 203.52 100.34 L 209.94 103.57 L 216.56 106.81 L 223.19 110.53 L 229.19 115.28 L 234.20 121.08 L 238.07 127.69 L 240.95 134.78 L 243.34 142.01 L 245.45 149.33 L 246.82 156.85 Z';
/** The always-lit "O" ring (fill-rule evenodd). */
export const MOON_RING = `${MOON_DISC} ${MOON_INNER}`;

const CX = 169.23;
const CY = 164.49;
/** The terminator's radius: the disc's 107 less the ring's 30. */
const INNER_R = 77;

// the carved terminator's wobble: anchored to height, so it doesn't flicker as it sweeps
const JAG_STEPS = 48;
const JAG_FACETS = 7;
const JAG_AMP = 0.05 * INNER_R;
const JAG_NOISE = [0.25, 0.794, 0.551, -0.55, -0.4, 0.747, -0.989, 0.642];

function jagAt(t: number): number {
  const u = ((-t + 1) / 2) * JAG_FACETS;
  const i = Math.max(0, Math.min(JAG_FACETS - 1, Math.floor(u)));
  return JAG_NOISE[i]! + (JAG_NOISE[i + 1]! - JAG_NOISE[i]!) * (u - i);
}

const OUTER = (() => {
  const n = MOON_DISC.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map(Number);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i]!, n[i + 1]!]);
  return pts;
})();

/** The disc's outline on the lit side, bottom to top (the trace runs 0 right, 1/4 bottom, 3/4 top). */
function outerLitSide(waxing: boolean): Array<[number, number]> {
  const n = OUTER.length;
  const bottom = Math.round(n / 4);
  const top = Math.round((3 * n) / 4);
  const idx: number[] = [];
  if (waxing) {
    for (let i = bottom; i >= 0; i--) idx.push(i);
    for (let i = n - 1; i >= top; i--) idx.push(i);
  } else for (let i = bottom; i <= top; i++) idx.push(i);
  return idx.map((i) => OUTER[i]!);
}

/**
 * The lit part of the moon: the carved terminator inside the ring, then the disc's own
 * edge on the lit side (overlapping the ring, so no hairline seam). Empty at new, the
 * whole disc at full.
 */
export function moonLitPath(m: Pick<MoonPhase, 'illumination' | 'waxing'>): string {
  const { illumination: illum, waxing } = m;
  if (illum <= 0.004) return 'M 0 0 Z';
  if (illum >= 0.996) return MOON_DISC;
  const b = INNER_R * Math.abs(1 - 2 * illum);
  const sign = waxing !== illum > 0.5 ? 1 : -1;
  const phaseScale = Math.sqrt(Math.max(0, 1 - Math.abs(1 - 2 * illum)));
  const d = [`M ${CX} ${(CY - INNER_R).toFixed(2)}`];
  for (let k = 1; k < JAG_STEPS; k++) {
    const t = -1 + (2 * k) / JAG_STEPS;
    const taper = Math.sqrt(Math.max(0, 1 - t * t));
    d.push(`L ${(CX + sign * b * taper + JAG_AMP * jagAt(t) * taper * phaseScale).toFixed(2)} ${(CY + t * INNER_R).toFixed(2)}`);
  }
  d.push(`L ${CX} ${(CY + INNER_R).toFixed(2)}`);
  for (const [x, y] of outerLitSide(waxing)) d.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
  d.push(`L ${CX} ${(CY - INNER_R).toFixed(2)} Z`);
  return d.join(' ');
}

/** A phase from its elongation in degrees (0 new, 180 full). */
export function phaseOf(deg: number): Pick<MoonPhase, 'illumination' | 'waxing'> {
  const e = ((deg % 360) + 360) % 360;
  return { illumination: (1 - Math.cos((e * Math.PI) / 180)) / 2, waxing: e < 180 };
}

export type AnisotaKind = 'mark' | 'moon' | 'loader';

let ids = 0;

/** One drawing: an <svg> whose moon can be set to any phase. */
export function drawAnisota(doc: Document, kind: AnisotaKind): { svg: SVGSVGElement; set(m: Pick<MoonPhase, 'illumination' | 'waxing'>): void } {
  const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string>) => {
    const node = doc.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const clipId = `ov-anisota-moon-${++ids}`;
  const svg = el('svg', { viewBox: kind === 'moon' ? MOON_VIEWBOX : MARK_VIEWBOX, class: `ov-anisota__${kind === 'moon' ? 'moon' : 'mark'}`, 'aria-hidden': 'true', focusable: 'false' });
  if (kind !== 'moon') svg.append(el('use', { href: '#anisota-mark' }));
  const lit = el('path', { d: 'M 0 0 Z' });
  const clip = el('clipPath', { id: clipId });
  clip.append(lit);
  const disc = el('g', { 'clip-path': `url(#${clipId})` });
  disc.append(el('path', { d: MOON_DISC, fill: 'currentColor' }));
  svg.append(clip, el('path', { d: MOON_RING, 'fill-rule': 'evenodd', fill: 'currentColor' }), disc);
  return { svg, set: (m) => lit.setAttribute('d', moonLitPath(m)) };
}

export interface AnisotaOptions {
  win?: Window;
  /** Tonight's moon (pageMoon: the real one, or ?moon='s). */
  moon?: () => MoonPhase;
}

/** Draws into every [data-ov-anisota] under root, and keeps them going. */
export function mountAnisota(root: ParentNode, opts: AnisotaOptions = {}): { refresh(): void } {
  const win = opts.win ?? window;
  const moon = opts.moon ?? pageMoon;
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const still: Array<ReturnType<typeof drawAnisota>> = [];
  const loaders: Array<ReturnType<typeof drawAnisota>> = [];
  const names = [...root.querySelectorAll<HTMLElement>('[data-ov-moon-name]')];
  const lits = [...root.querySelectorAll<HTMLElement>('[data-ov-moon-lit]')];
  for (const box of root.querySelectorAll<HTMLElement>('[data-ov-anisota]')) {
    const kind = box.dataset.ovAnisota as AnisotaKind;
    if (kind !== 'mark' && kind !== 'moon' && kind !== 'loader') continue;
    const d = drawAnisota(doc, kind);
    box.replaceChildren(d.svg);
    (kind === 'loader' ? loaders : still).push(d);
  }

  let tonight = moon();
  const refresh = () => {
    tonight = moon();
    for (const d of still) d.set(tonight);
    const name = tonight.name.charAt(0).toUpperCase() + tonight.name.slice(1);
    for (const n of names) n.textContent = name;
    for (const l of lits) l.textContent = `${Math.round(tonight.illumination * 100)}% lit`;
  };
  refresh();
  win.setInterval(refresh, MOON_REFRESH_MS);

  if (loaders.length) {
    const base = tonight.phase * 360;
    let day = 0;
    const step = () => {
      const m = phaseOf(base + (day / CYCLE_DAYS) * 360);
      for (const d of loaders) d.set(m);
    };
    step();
    const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduced)
      win.setInterval(() => {
        day = (day + 1) % CYCLE_DAYS;
        step();
      }, CYCLE_MS / CYCLE_DAYS);
  }
  return { refresh };
}
