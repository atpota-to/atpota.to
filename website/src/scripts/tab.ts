/**
 * The tab notices you leaving, once in a while. While the page is in a background
 * tab its title reads "come back (◕︵◕)" and the favicon becomes Poe, blinking
 * sleepily. Coming back says hi for a moment, then the real title and favicon return.
 *
 * It stays rare so it reads as a surprise, not a nag:
 * - only on pages whose title doesn't say what you're reading (PLEA_PAGES). A blog
 *   post, guide or weather report in a background tab keeps its title, so you can
 *   still find it among the others.
 * - only on a chance each time you leave (PLEA_CHANCE), and at most once per tab
 *   (sessionStorage PLEADED_KEY, which lasts as long as the tab does).
 *
 * Browsers slow timers in background tabs, so the blink may only tick once a
 * second or so; that is fine for a sleepy blink. No blinking under reduced motion.
 */

import { MASCOT_URLS } from './mascot';

export const AWAY_TITLE = 'come back (◕︵◕)';
export const BACK_TITLE = "yay, you're back (◕‿◕)";
export const BACK_MS = 1800;
/** <body data-page> values that may plead. */
export const PLEA_PAGES: ReadonlySet<string> = new Set(['home', 'about', 'notfound']);
export const PLEA_CHANCE = 1 / 3;
export const PLEADED_KEY = 'tab:pleaded';
const BLINK_MS = 900;

export function initTabTitle(doc: Document = document, random: () => number = Math.random): void {
  if (!PLEA_PAGES.has(doc.body?.dataset.page ?? '')) return;

  const icon = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const restIcon = icon?.getAttribute('href') ?? null;
  const restType = icon?.getAttribute('type') ?? null;
  let restTitle = doc.title;
  let blinkTimer: number | undefined;
  let backTimer: number | undefined;
  // Kept here too, for when sessionStorage is blocked.
  let pleadedHere = false;

  const pleaded = () => {
    if (pleadedHere) return true;
    try {
      return window.sessionStorage.getItem(PLEADED_KEY) === '1';
    } catch {
      return false;
    }
  };
  const markPleaded = () => {
    pleadedHere = true;
    try {
      window.sessionStorage.setItem(PLEADED_KEY, '1');
    } catch {
      // blocked site data: this page view remembers, which is enough
    }
  };

  const setIcon = (href: string | null, type: string | null) => {
    if (!icon || href === null) return;
    icon.href = href;
    if (type) icon.type = type;
    else icon.removeAttribute('type');
  };
  const reduce = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Put the real title and favicon back, from any point in the plea.
  const settle = () => {
    window.clearInterval(blinkTimer);
    window.clearTimeout(backTimer);
    if (doc.title === AWAY_TITLE || doc.title === BACK_TITLE) doc.title = restTitle;
    setIcon(restIcon, restType);
  };

  const leave = () => {
    settle();
    if (pleaded() || random() >= PLEA_CHANCE) return;
    markPleaded();
    restTitle = doc.title;
    doc.title = AWAY_TITLE;
    setIcon(MASCOT_URLS.normal, 'image/svg+xml');
    if (!reduce()) {
      let shut = false;
      blinkTimer = window.setInterval(() => {
        shut = !shut;
        setIcon(shut ? MASCOT_URLS.sleepy : MASCOT_URLS.normal, 'image/svg+xml');
      }, BLINK_MS);
    }
  };

  const come = () => {
    if (doc.title !== AWAY_TITLE) return;
    window.clearInterval(blinkTimer);
    doc.title = BACK_TITLE;
    setIcon(MASCOT_URLS.happy, 'image/svg+xml');
    backTimer = window.setTimeout(settle, BACK_MS);
  };

  doc.addEventListener('visibilitychange', () => (doc.visibilityState === 'hidden' ? leave() : come()));
  // Leaving through a link: put the real title back before the page is stored in history.
  window.addEventListener('pagehide', settle);
}
