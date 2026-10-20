/**
 * The hero Poe on the home page's sunburst tile ([data-pet] on its <img>).
 *
 * - Leans: mouse and pen only, Poe tilts and shifts a little toward the pointer
 *   (CSS reads --lean-x / --lean-y, each -1..1, in home.css).
 * - Pets: every click or tap plays one of a few motions (pickMotion; a squash, a wobble,
 *   a boop, a wiggle) with its height, tilt and speed jittered, and floats a heart or
 *   two up. A few pets in a row get a reaction (petReaction), shown as a face and a line
 *   in the tile's speech bubble; pets in between sometimes get a small one
 *   (petFlourish), so Poe never answers the same way twice. After PET_RESET_MS without
 *   a pet, everything settles back.
 * - Remembers: pets add up across visits (localStorage PETS_KEY), and some totals get
 *   a line of their own (milestoneLine). A reader who signed in on the blog is greeted
 *   by handle in the bubble (src/scripts/reader.ts).
 *
 * Nothing moves under reduced motion; the faces and lines still change.
 * mascot.ts keeps swapping faces on hover; data-mascot-hold pauses that while a
 * reaction face is showing.
 */

import { MASCOT_URLS, restoreMascot, type MascotFace } from './mascot';
import { readReader } from './reader';

export const PET_RESET_MS = 4000;
export const PETS_KEY = 'atpotato:pets';
/** Longer handles don't fit the bubble; those readers get a plain "hi again". */
const GREET_MAX_HANDLE = 24;
const HEART_MS = 1100;

/** The everyday pet motions (classes in home.css). The flip (is-spinning) is saved for reactions. */
export const PET_MOTIONS = ['is-squished', 'is-wobbling', 'is-booped', 'is-wiggling'] as const;
export type PetMotion = (typeof PET_MOTIONS)[number];

/** A motion other than the last one, so two pets in a row never look the same. */
export function pickMotion(previous: PetMotion | undefined, random: () => number = Math.random): PetMotion {
  const options = PET_MOTIONS.filter((motion) => motion !== previous);
  return options[Math.floor(random() * options.length)] ?? 'is-squished';
}

const FLOURISH_FACES: readonly MascotFace[] = ['wow', 'kawaii', 'happy', 'wink'];
const FLOURISH_LINES = ['boop', 'eep!', 'mrrp', 'hehe', '♪', 'oh!', '(˶ᵔ ᵕ ᵔ˶)', 'more pls', 'hm?'];
/** Past ten pets Poe keeps chatting now and then instead of repeating itself. */
const FRIEND_LINES = ['you again (◕‿◕)', 'i could do this all day', 'ok one more', "i'm getting so round", 'purr?', 'best day ever', 'my fan club'];

/** Sometimes a quick face and a word on a pet that has no reaction of its own; null most of the time. */
export function petFlourish(random: () => number = Math.random): PetReaction | null {
  if (random() > 0.3) return null;
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)] ?? list[0];
  return random() < 0.5 ? { face: pick(FLOURISH_FACES) } : { face: pick(FLOURISH_FACES), say: pick(FLOURISH_LINES) };
}

/** A line from FRIEND_LINES, other than the last one. */
function friendLine(previous: string | undefined, random: () => number): string {
  const options = FRIEND_LINES.filter((line) => line !== previous);
  return options[Math.floor(random() * options.length)] ?? FRIEND_LINES[0];
}

const jitter = (min: number, max: number) => min + Math.random() * (max - min);

export interface PetReaction {
  face?: MascotFace;
  say?: string;
  spin?: boolean;
  blush?: boolean;
}

/** What Poe does on the nth pet in a row (1-based). Old friends (10+ pets on earlier visits) hear so. */
export function petReaction(n: number, oldFriend = false): PetReaction {
  if (n === 3) return { face: 'wink', say: 'hehe' };
  if (n === 6) return { face: 'happy', say: 'stop it, you (⁄ ⁄•⁄ω⁄•⁄ ⁄)', blush: true };
  if (n === 8) return { face: 'happy', say: 'wheee', spin: true, blush: true };
  if (n >= 10) return { face: 'kawaii', say: oldFriend ? 'still best friends (◕‿◕)' : "ok ok, we're friends now", blush: true };
  return {};
}

/** A line for some all-time pet totals, or null. */
export function milestoneLine(total: number): string | null {
  if (total === 25) return "that's 25 pets all time (◕‿◕)";
  if (total === 50) return "50 pets. we're basically family";
  if (total === 100) return "100 pets! you're my favourite";
  if (total === 250) return "250 pets. i'm telling the other potatoes";
  if (total >= 500 && total % 500 === 0) return `${total} pets. legend.`;
  return null;
}

/** The bubble's hint, with the reader's handle when it fits. */
export function greeting(handle: string | null, touch: boolean): string | null {
  if (!handle) return null;
  const action = touch ? 'tap me' : 'hover me';
  return handle.length <= GREET_MAX_HANDLE ? `hi @${handle}! ${action} (◕‿◕)` : `hi again! ${action} (◕‿◕)`;
}

function readPets(): number {
  try {
    const n = Number(window.localStorage.getItem(PETS_KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function savePets(total: number): void {
  try {
    window.localStorage.setItem(PETS_KEY, String(total));
  } catch {
    // storage blocked: the count lasts for this page only
  }
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

  // say hi by name
  const handle = readReader();
  for (const [selector, touch] of [['.only-hover', false], ['.only-touch', true]] as const) {
    const hint = bubble?.parentElement?.querySelector<HTMLElement>(selector);
    const text = greeting(handle, touch);
    if (hint && text) hint.textContent = text;
  }

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
  let total = readPets();
  const oldFriend = total >= 10;
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

  const heart = (big = false) => {
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
    span.style.setProperty('--size', `${Math.round(big ? jitter(26, 34) : jitter(16, 28))}px`);
    span.style.setProperty('--rise', `${Math.round(-jitter(90, 160))}px`);
    span.style.setProperty('--heart-dur', `${Math.round(jitter(850, 1100))}ms`);
    tile.appendChild(span);
    window.setTimeout(() => span.remove(), HEART_MS);
  };

  /** One heart usually, now and then two; a reaction gets a little burst, staggered. */
  const hearts = (reacted: boolean) => {
    const n = reacted ? 3 : Math.random() < 0.25 ? 2 : 1;
    heart(reacted);
    for (let i = 1; i < n; i++) window.setTimeout(() => heart(reacted), i * jitter(70, 140));
  };

  let lastMotion: PetMotion | undefined;
  let lastFriendLine: string | undefined;

  /** Plays a motion with its own hop, tilt and speed, so no two pets look alike. */
  const move = (flip: boolean) => {
    if (reducedMotion()) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    img.style.setProperty('--pet-hop', `${Math.round(jitter(16, 40))}px`);
    img.style.setProperty('--pet-tilt', `${(side * jitter(2, 7)).toFixed(1)}deg`);
    img.style.setProperty('--flip-dir', String(side));
    for (const cls of [...PET_MOTIONS, 'is-spinning']) img.classList.remove(cls);
    if (flip) {
      img.style.removeProperty('--pet-dur');
      replay(img, 'is-spinning');
      return;
    }
    const motion = pickMotion(lastMotion);
    lastMotion = motion;
    const base = { 'is-squished': 700, 'is-wobbling': 760, 'is-booped': 420, 'is-wiggling': 620 }[motion];
    img.style.setProperty('--pet-dur', `${Math.round(base * jitter(0.85, 1.15))}ms`);
    replay(img, motion);
  };

  const settle = () => {
    count = 0;
    img.classList.remove('is-blushing');
    say(undefined);
    restoreMascot(img);
  };

  img.addEventListener('click', () => {
    count += 1;
    total += 1;
    savePets(total);
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(settle, PET_RESET_MS);
    const fixed = petReaction(count, oldFriend);
    const hasOwn = fixed.face !== undefined || fixed.say !== undefined;
    // between the set reactions, now and then a small one; past ten, a fresh line now and then
    let reaction: PetReaction = fixed;
    if (!hasOwn) reaction = petFlourish() ?? {};
    else if (count > 10 && Math.random() < 0.4) {
      lastFriendLine = friendLine(lastFriendLine, Math.random);
      reaction = { ...fixed, say: lastFriendLine };
    }
    // past ten, once in a while Poe flips again on its own
    const flip = reaction.spin === true || (count > 10 && Math.random() < 0.12);
    hearts(hasOwn && (fixed.say !== undefined || flip));
    move(flip);
    if (reaction.face) {
      img.dataset.mascotHold = '';
      img.src = MASCOT_URLS[reaction.face];
    }
    if (reaction.blush) img.classList.add('is-blushing');
    const milestone = milestoneLine(total);
    if (milestone) say(milestone);
    else if (reaction.say) say(reaction.say);
  });
}
