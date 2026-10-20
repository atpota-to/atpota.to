/**
 * The tab notices you leaving. While the page is in a background tab its title
 * reads "come back (◕︵◕)" and the favicon becomes Poe, blinking sleepily. Coming
 * back says hi for a moment, then the real title and favicon return.
 *
 * Browsers slow timers in background tabs, so the blink may only tick once a
 * second or so; that is fine for a sleepy blink. No blinking under reduced motion.
 */

import { MASCOT_URLS } from './mascot';

export const AWAY_TITLE = 'come back (◕︵◕)';
export const BACK_TITLE = "yay, you're back (◕‿◕)";
export const BACK_MS = 1800;
const BLINK_MS = 900;

export function initTabTitle(doc: Document = document): void {
  const icon = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const restIcon = icon?.getAttribute('href') ?? null;
  const restType = icon?.getAttribute('type') ?? null;
  let restTitle = doc.title;
  let blinkTimer: number | undefined;
  let backTimer: number | undefined;

  const setIcon = (href: string | null, type: string | null) => {
    if (!icon || href === null) return;
    icon.href = href;
    if (type) icon.type = type;
    else icon.removeAttribute('type');
  };
  const reduce = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const leave = () => {
    window.clearTimeout(backTimer);
    if (doc.title !== AWAY_TITLE && doc.title !== BACK_TITLE) restTitle = doc.title;
    doc.title = AWAY_TITLE;
    setIcon(MASCOT_URLS.normal, 'image/svg+xml');
    window.clearInterval(blinkTimer);
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
    backTimer = window.setTimeout(() => {
      doc.title = restTitle;
      setIcon(restIcon, restType);
    }, BACK_MS);
  };

  doc.addEventListener('visibilitychange', () => (doc.visibilityState === 'hidden' ? leave() : come()));
  // Leaving through a link: put the real title back before the page is stored in history.
  window.addEventListener('pagehide', () => {
    window.clearInterval(blinkTimer);
    window.clearTimeout(backTimer);
    if (doc.title === AWAY_TITLE || doc.title === BACK_TITLE) doc.title = restTitle;
    setIcon(restIcon, restType);
  });
}
