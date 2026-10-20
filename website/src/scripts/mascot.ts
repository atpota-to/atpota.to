/**
 * Mascot expressions. Any <img data-mascot="<rest face>"> swaps to a random
 * different face on hover (mouse/pen), on focus of its focusable ancestor (or of
 * an ancestor marked [data-mascot-trigger]), and on tap (restores after 700ms).
 * It restores the original src on leave/blur. All faces are preloaded and decoded
 * once a mascot is on the page, so the swap does not flicker.
 *
 *   <img data-mascot="kawaii" src="/src/assets/mascot/potato-kawaii.svg" alt="...">
 *   optional: data-mascot-faces="wow wink"   (restrict the pool)
 *   optional: data-mascot-dark="sleepy"      (rest face while the dark theme is on)
 *   set by code: data-mascot-rest="wow"      (rest face for now, over both of the above;
 *                                             setMascotRest(), e.g. the home page's scene)
 *
 * While the image carries data-mascot-hold (set by the home page's petting, home.ts)
 * hover and tap leave its face alone; restoreMascot() puts the rest face back.
 */

import { getTheme } from './theme';

import arm from '../assets/mascot/potato-arm.svg';
import blob from '../assets/mascot/potato-blob.svg';
import dead from '../assets/mascot/potato-dead.svg';
import happy from '../assets/mascot/potato-happy.svg';
import kawaii from '../assets/mascot/potato-kawaii.svg';
import normal from '../assets/mascot/potato-normal.svg';
import scawy from '../assets/mascot/potato-scawy.svg';
import sleepy from '../assets/mascot/potato-sleepy.svg';
import wave from '../assets/mascot/potato-wave.svg';
import wink from '../assets/mascot/potato-wink.svg';
import wow from '../assets/mascot/potato-wow.svg';

export const MASCOT_URLS = { normal, kawaii, happy, wink, wow, sleepy, scawy, dead } as const;
export type MascotFace = keyof typeof MASCOT_URLS;
export const MASCOT_BLOB_URL: string = blob;
/** Poe's wave (src/poe/idle.ts): the happy face without its left arm, and that arm on its own. */
export const MASCOT_WAVE_URL: string = wave;
export const MASCOT_ARM_URL: string = arm;

/** Faces the hover/tap swap picks from (spec section 2, Mascot). No scawy: Poe never looks angry
    on its own. A page can still opt in with data-mascot-faces, as the 404 does. */
export const SWAP_FACES: readonly MascotFace[] = ['kawaii', 'wow', 'wink', 'happy', 'dead'];

const TAP_RESTORE_MS = 700;

function isFace(value: string | undefined): value is MascotFace {
  return value !== undefined && Object.prototype.hasOwnProperty.call(MASCOT_URLS, value);
}

export function pickFace(rest: MascotFace | undefined, current: MascotFace | undefined, pool: readonly MascotFace[] = SWAP_FACES, random: () => number = Math.random): MascotFace {
  const options = pool.filter((face) => face !== rest && face !== current);
  const list = options.length > 0 ? options : pool.filter((face) => face !== rest);
  const fallback: MascotFace = rest === 'kawaii' ? 'wow' : 'kawaii';
  return list[Math.floor(random() * list.length)] ?? fallback;
}

let preloaded = false;

export function preloadFaces(): void {
  if (preloaded) return;
  preloaded = true;
  const run = () => {
    for (const url of [...Object.values(MASCOT_URLS), MASCOT_WAVE_URL, MASCOT_ARM_URL]) {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      img.decode?.().catch(() => undefined);
    }
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 1500 });
  else window.setTimeout(run, 200);
}

const restorers = new WeakMap<HTMLImageElement, () => void>();
const refreshers = new WeakMap<HTMLImageElement, () => void>();

/** Drops data-mascot-hold and shows the rest face again. */
export function restoreMascot(img: HTMLImageElement): void {
  restorers.get(img)?.();
}

/** Rests on `face` from now on (undefined: the usual rest face). A swap or a hold in progress finishes first. */
export function setMascotRest(img: HTMLImageElement, face: MascotFace | undefined): void {
  if (face) img.dataset.mascotRest = face;
  else delete img.dataset.mascotRest;
  refreshers.get(img)?.();
}

export function bindMascot(img: HTMLImageElement): void {
  if (img.dataset.mascotBound === 'true') return;
  img.dataset.mascotBound = 'true';

  const daySrc = img.getAttribute('src') ?? '';
  const dayFace = isFace(img.dataset.mascot) ? img.dataset.mascot : undefined;
  const darkFace = isFace(img.dataset.mascotDark) ? img.dataset.mascotDark : undefined;
  const night = () => darkFace !== undefined && getTheme() === 'dark';
  const override = () => (isFace(img.dataset.mascotRest) ? img.dataset.mascotRest : undefined);
  const restFace = () => override() ?? (night() ? darkFace : dayFace);
  const restSrc = () => {
    const face = override() ?? (night() ? darkFace : undefined);
    return face ? MASCOT_URLS[face] : daySrc;
  };
  const poolAttr = (img.dataset.mascotFaces ?? '').split(/\s+/).filter(isFace);
  const pool = poolAttr.length > 0 ? poolAttr : SWAP_FACES;
  let current: MascotFace | undefined;
  let tapTimer: number | undefined;

  const held = () => img.dataset.mascotHold !== undefined;
  const swap = () => {
    window.clearTimeout(tapTimer);
    if (held()) return;
    current = pickFace(restFace(), current, pool);
    img.src = MASCOT_URLS[current];
  };
  const restore = () => {
    window.clearTimeout(tapTimer);
    if (held()) return;
    current = undefined;
    const rest = restSrc();
    if (img.getAttribute('src') !== rest) img.src = rest;
  };
  restorers.set(img, () => {
    delete img.dataset.mascotHold;
    restore();
  });
  refreshers.set(img, () => {
    if (current === undefined) restore();
  });
  if (override()) restore();
  if (darkFace) {
    restore();
    window.addEventListener('theme:change', () => {
      if (current === undefined) restore();
    });
  }

  // Hover/tap listen on the nearest [data-mascot-trigger] (e.g. a whole tile) or the image.
  const hoverTarget: HTMLElement = img.closest<HTMLElement>('[data-mascot-trigger]') ?? img;
  hoverTarget.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'touch') swap();
  });
  hoverTarget.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch') restore();
  });
  hoverTarget.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    swap();
    tapTimer = window.setTimeout(restore, TAP_RESTORE_MS);
  });

  // Keyboard focus on the trigger or a focusable ancestor (a tile link, a button).
  const focusTarget = img.closest<HTMLElement>('[data-mascot-trigger], a[href], button, [tabindex]');
  if (focusTarget) {
    focusTarget.addEventListener('focusin', swap);
    focusTarget.addEventListener('focusout', (event) => {
      if (!(event.relatedTarget instanceof Node && focusTarget.contains(event.relatedTarget))) restore();
    });
  }
}

export function initMascots(root: ParentNode = document): void {
  const imgs = root.querySelectorAll<HTMLImageElement>('img[data-mascot]');
  if (imgs.length === 0) return;
  imgs.forEach(bindMascot);
  preloadFaces();
}
