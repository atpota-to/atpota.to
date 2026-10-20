/**
 * The hero Poe on the home page's sunburst tile ([data-pet] on its <img>).
 *
 * - Leans: mouse and pen only, Poe tilts and shifts a little toward the pointer
 *   (CSS reads --lean-x / --lean-y, each -1..1, in home.css).
 * - Pets: every click or tap squashes Poe and floats a heart up. A few pets in a
 *   row get a reaction (petReaction), shown as a face and a line in the tile's
 *   speech bubble. After PET_RESET_MS without a pet, everything settles back.
 *
 * Nothing moves under reduced motion; the faces and lines still change.
 * mascot.ts keeps swapping faces on hover; data-mascot-hold pauses that while a
 * reaction face is showing.
 */

import { MASCOT_URLS, restoreMascot, type MascotFace } from './mascot';

export const PET_RESET_MS = 4000;
const HEART_MS = 1100;

export interface PetReaction {
  face?: MascotFace;
  say?: string;
  spin?: boolean;
  blush?: boolean;
}

/** What Poe does on the nth pet in a row (1-based). */
export function petReaction(n: number): PetReaction {
  if (n === 3) return { face: 'wink', say: 'hehe' };
  if (n === 6) return { face: 'happy', say: 'stop it, you (⁄ ⁄•⁄ω⁄•⁄ ⁄)', blush: true };
  if (n === 8) return { face: 'happy', say: 'wheee', spin: true, blush: true };
  if (n >= 10) return { face: 'kawaii', say: "ok ok, we're friends now", blush: true };
  return {};
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEART_PATH = 'M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.5 5c2.1 0 3.5 1.2 5.5 3.2C14 6.2 15.4 5 17.5 5 21 5 23 8.6 21.6 11.8 19.5 16.4 12 21 12 21z';

function heartSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', HEART_PATH);
  svg.appendChild(path);
  return svg;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Restarts the animation that `cls` adds, and drops the class once it ends. */
function replay(el: Element, cls: string): void {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

export function initPet(root: ParentNode = document): void {
  const img = root.querySelector<HTMLImageElement>('img[data-pet]');
  const tile = img?.closest<HTMLElement>('[data-mascot-trigger]');
  if (!img || !tile || img.dataset.petBound === 'true') return;
  img.dataset.petBound = 'true';
  const bubble = tile.querySelector<HTMLElement>('[data-pet-say]');

  // lean toward the pointer
  tile.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' || reducedMotion()) return;
    const box = img.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const x = clamp((event.clientX - (box.left + box.width / 2)) / (tileBox.width / 2));
    const y = clamp((event.clientY - (box.top + box.height / 2)) / (tileBox.height / 2));
    img.style.setProperty('--lean-x', x.toFixed(3));
    img.style.setProperty('--lean-y', y.toFixed(3));
  });
  tile.addEventListener('pointerleave', () => {
    img.style.removeProperty('--lean-x');
    img.style.removeProperty('--lean-y');
  });

  // pet
  let count = 0;
  let resetTimer: number | undefined;

  const say = (text: string | undefined) => {
    if (!bubble) return;
    const parent = bubble.parentElement;
    if (text) {
      bubble.textContent = text;
      parent?.setAttribute('data-saying', '');
      if (parent && !reducedMotion()) replay(parent, 'is-popping');
    } else {
      bubble.textContent = '';
      parent?.removeAttribute('data-saying');
    }
  };

  const heart = () => {
    if (reducedMotion()) return;
    const span = document.createElement('span');
    span.className = 'home-heart';
    span.appendChild(heartSvg());
    const box = img.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    span.style.left = `${box.left - tileBox.left + box.width / 2 + (Math.random() * 80 - 40)}px`;
    span.style.top = `${box.top - tileBox.top + box.height * 0.3}px`;
    span.style.setProperty('--dx', `${Math.round(Math.random() * 90 - 45)}px`);
    span.style.setProperty('--rot', `${Math.round(Math.random() * 40 - 20)}deg`);
    tile.appendChild(span);
    window.setTimeout(() => span.remove(), HEART_MS);
  };

  const settle = () => {
    count = 0;
    img.classList.remove('is-blushing');
    say(undefined);
    restoreMascot(img);
  };

  img.addEventListener('click', () => {
    count += 1;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(settle, PET_RESET_MS);
    heart();

    const reaction = petReaction(count);
    if (!reducedMotion()) {
      if (reaction.spin) replay(img, 'is-spinning');
      else replay(img, 'is-squished');
    }
    if (reaction.face) {
      img.dataset.mascotHold = '';
      img.src = MASCOT_URLS[reaction.face];
    }
    if (reaction.blush) img.classList.add('is-blushing');
    if (reaction.say) say(reaction.say);
  });
}
