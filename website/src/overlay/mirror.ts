/**
 * Poe facing the other way, for the bottom-left corner: every face mirrored, except the @
 * on its tummy, which would read backwards. The mascot SVGs (src/assets/mascot) are
 * 515 wide; the @ is the run of skin-coloured (#a58650) paths after the face (the first
 * #725b36 one), centred at x 259.1 in every face. Mirroring the rest about the middle and
 * shifting the @ by 515 - 2 * 259.1 keeps it in the same place on the tummy, the right
 * way round. A drawing with no face (the arm) is mirrored whole.
 *
 * The mirrored faces are data: URLs made once per page, from the same files.
 */

import { MASCOT_ARM_URL, MASCOT_URLS, MASCOT_WAVE_URL, type MascotFace } from '../scripts/mascot';

export const VIEW_WIDTH = 515;
export const AT_CENTER_X = 259.1;
const FACE = '#725b36';
const AT = '#a58650';

export interface Faces {
  face: Record<MascotFace, string>;
  wave: string;
  arm: string;
}

export const RIGHT_FACES: Faces = { face: MASCOT_URLS, wave: MASCOT_WAVE_URL, arm: MASCOT_ARM_URL };

const colour = (el: Element, attr: string) => (el.getAttribute(attr) ?? '').toLowerCase();

/** The SVG mirrored left to right, with its tummy @ still reading the right way. */
export function mirrorSvg(text: string, parser: DOMParser = new DOMParser()): string {
  const doc = parser.parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName.toLowerCase() !== 'svg') return text;
  const parts = [...svg.children];
  const face = parts.findIndex((el) => colour(el, 'fill') === FACE || colour(el, 'stroke') === FACE);
  const isAt = (el: Element, i: number) => face >= 0 && i > face && colour(el, 'fill') === AT;
  const ns = 'http://www.w3.org/2000/svg';
  const mirrored = doc.createElementNS(ns, 'g');
  mirrored.setAttribute('transform', `matrix(-1 0 0 1 ${VIEW_WIDTH} 0)`);
  const at = doc.createElementNS(ns, 'g');
  at.setAttribute('transform', `translate(${(VIEW_WIDTH - 2 * AT_CENTER_X).toFixed(1)} 0)`);
  parts.forEach((el, i) => (isAt(el, i) ? at : mirrored).append(el));
  svg.append(mirrored);
  if (at.childElementCount) svg.append(at);
  return new XMLSerializer().serializeToString(svg);
}

const dataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

let left: Promise<Faces> | null = null;

/** Every face facing right (into the screen from the bottom-left), made once. Falls back to the usual faces. */
export function leftFaces(fetchImpl: typeof fetch = fetch): Promise<Faces> {
  left ??= (async () => {
    const flip = async (url: string) => dataUrl(mirrorSvg(await (await fetchImpl(url)).text()));
    const entries = await Promise.all(Object.entries(MASCOT_URLS).map(async ([name, url]) => [name, await flip(url)] as const));
    return { face: Object.fromEntries(entries) as Record<MascotFace, string>, wave: await flip(MASCOT_WAVE_URL), arm: await flip(MASCOT_ARM_URL) };
  })().catch(() => {
    left = null;
    return RIGHT_FACES;
  });
  return left;
}
