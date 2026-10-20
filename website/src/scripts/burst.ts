/**
 * Little celebrations: a handful of leaves or hearts bursting out of an element, and a
 * "poe:cheer" event so the corner Poe hops (src/poe/ui.ts). The blog uses them when a
 * reader subscribes, recommends a post or comments. Nothing bursts under reduced motion;
 * the cheer is skipped there too. Neither ever throws: a celebration must not turn a
 * save that worked into an error.
 */

export type BurstKind = 'leaves' | 'hearts';

const COUNT: Record<BurstKind, number> = { leaves: 14, hearts: 10 };
const BURST_MS = 900;

function reducedMotion(win: Window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function burst(from: Element, kind: BurstKind, win: Window = window): void {
  try {
    spray(from, kind, win);
  } catch {
    // a missed celebration is fine
  }
}

function spray(from: Element, kind: BurstKind, win: Window): void {
  if (reducedMotion(win)) return;
  const doc = from.ownerDocument;
  const box = from.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const n = COUNT[kind];
  for (let i = 0; i < n; i++) {
    const bit = doc.createElement('span');
    bit.className = `burst burst--${kind}`;
    bit.setAttribute('aria-hidden', 'true');
    const angle = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.6;
    const distance = 60 + Math.random() * 70;
    bit.style.left = `${x}px`;
    bit.style.top = `${y}px`;
    bit.style.setProperty('--dx', `${Math.round(Math.cos(angle) * distance)}px`);
    bit.style.setProperty('--dy', `${Math.round(Math.sin(angle) * distance - 30)}px`);
    bit.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
    bit.dataset.shade = String(i % 3);
    doc.body.appendChild(bit);
    setTimeout(() => bit.remove(), BURST_MS);
  }
}

/** Asks the corner Poe for a happy hop. */
export function cheer(win: Window = window): void {
  try {
    win.dispatchEvent(new CustomEvent('poe:cheer'));
  } catch {
    // no corner Poe to tell
  }
}
