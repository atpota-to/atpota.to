/**
 * About page behaviour. main.ts imports this module when <body data-page="about"> and
 * calls init() once.
 *
 * - Poe on the surface: a pet bursts a few hearts and the corner Poe hops along
 *   (burst.ts); mascot.ts already swaps the face on hover and tap. Pets here count
 *   the same as the home page's: the same total in this browser (pet.ts), and for a
 *   reader signed in with Bluesky the same record in their own repo (pet-sync.ts),
 *   read the same way (the higher of saved and local wins). The pill beside Poe shows
 *   the total once there is one. Signing in is offered on the home page, not here.
 * - The big numbers on the golden potatoes ("65,000", "$1,000") count up the first time
 *   they come into view. They wait at zero until then, so the count never jumps back;
 *   screen readers get the real number from a hidden copy beside it. Without
 *   IntersectionObserver, or under reduced motion, they keep the number the page was
 *   written with.
 */

import { sharedAuth, type Auth } from '../blog/auth';
import { burst, cheer } from './burst';
import { countLabel, readPets, savePets } from './pet';
import { createPetSync } from './pet-sync';

export const COUNT_MS = 1200;

export interface Stat {
  before: string;
  value: number;
  after: string;
}

/** "$1,000" -> { before: "$", value: 1000, after: "" }; null when there's no number to count. */
export function parseStat(text: string): Stat | null {
  const match = /^(\D*)(\d[\d,]*)(.*)$/s.exec(text.trim());
  if (!match) return null;
  const value = Number(match[2]!.replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return { before: match[1]!, value, after: match[3]! };
}

export function formatStat(stat: Stat, value: number): string {
  return `${stat.before}${Math.round(value).toLocaleString('en-US')}${stat.after}`;
}

/** Fast at first, settling onto the number. */
export function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function reducedMotion(win: Window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function countUp(el: HTMLElement, stat: Stat, win: Window): void {
  const final = formatStat(stat, stat.value);
  let start: number | undefined;
  const step = (now: number) => {
    start ??= now;
    const t = Math.min(1, (now - start) / COUNT_MS);
    el.textContent = t < 1 ? formatStat(stat, stat.value * easeOut(t)) : final;
    if (t < 1) win.requestAnimationFrame(step);
  };
  win.requestAnimationFrame(step);
}

export function initStats(root: ParentNode = document, win: Window & typeof globalThis = window): void {
  if (reducedMotion(win) || !('IntersectionObserver' in win)) return;
  const stats = new Map<Element, Stat>();
  for (const el of root.querySelectorAll<HTMLElement>('.moment__stat strong')) {
    const stat = parseStat(el.textContent ?? '');
    if (!stat) continue;
    stats.set(el, stat);
    const spoken = el.ownerDocument.createElement('span');
    spoken.className = 'visually-hidden';
    spoken.textContent = el.textContent;
    el.after(spoken);
    el.setAttribute('aria-hidden', 'true');
    el.textContent = formatStat(stat, 0);
  }
  if (stats.size === 0) return;

  const observer = new win.IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        countUp(entry.target as HTMLElement, stats.get(entry.target)!, win);
      }
    },
    { threshold: 0.6 },
  );
  for (const el of stats.keys()) observer.observe(el);
}

export interface PoeOptions {
  /** Defaults to sharedAuth(window); null means pets stay in this browser only. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
}

export function initPoe(root: ParentNode = document, win: Window = window, opts: PoeOptions = {}): void {
  const poe = root.querySelector<HTMLElement>('[data-about-poe]');
  if (!poe) return;
  const pill = root.querySelector<HTMLElement>('[data-about-pets]');
  const pillN = pill?.querySelector<HTMLElement>('[data-about-pets-n]');

  const stored = readPets();
  let total = stored;
  const show = (bump: boolean) => {
    if (!pill || !pillN || total <= 0) return;
    pill.hidden = false;
    pillN.textContent = countLabel(total);
    if (bump && !reducedMotion(win)) {
      pill.classList.remove('is-bumping');
      void pill.offsetWidth;
      pill.classList.add('is-bumping');
    }
  };
  show(false);

  const auth = opts.auth === undefined ? sharedAuth(win) : opts.auth;
  const sync = createPetSync(auth, { fetchImpl: opts.fetchImpl });

  poe.addEventListener('click', () => {
    total += 1;
    savePets(total);
    sync.save(total);
    show(true);
    burst(poe, 'hearts', win);
    cheer(win);
  });

  // signed in: the saved count, and the pets keep going to the reader's repo
  // (after the page has settled: the OAuth library only loads for readers already signed in)
  if (auth?.eager) {
    const begin = () =>
      void sync
        .start()
        .then((saved) => {
          if (saved === null) return;
          total = Math.max(stored, saved) + (total - stored);
          savePets(total);
          sync.save(total);
          show(false);
        })
        .catch(() => undefined);
    const idle = (win as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle.call(win, begin, { timeout: 2000 });
    else win.setTimeout(begin, 300);
  }
  const flush = () => sync.flush();
  win.addEventListener('pagehide', flush);
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'hidden') flush();
  });
}

export function init(): void {
  initPoe();
  initStats();
}
