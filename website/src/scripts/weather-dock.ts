/**
 * The lens at hand (weather/index.html [data-weather-dock], weather.css .weather-dock): a
 * thin strip floating along the bottom of the screen, beside Poe, says what the page shows
 * ("1h · accounts"). A tap opens it upward to the lens's controls (bound by bindLens).
 * Another tap, Escape, or a tap anywhere else puts it away.
 *
 * It floats rather than sitting in the page: under a header whose height follows the
 * reading, a bar in the page slid out from under the finger with every change.
 */

import type { Lens, LensState } from './weather-lens';

/** What the strip says: the window as the controls have it, the measure, and records' unit. */
export function dockSummary(controls: HTMLElement, s: LensState): string {
  const word = (sel: string) => controls.querySelector(sel)?.textContent?.trim() ?? '';
  const parts = [word(`[data-lens-window="${s.window}"]`), word(`[data-lens-measure="${s.measure}"]`)];
  if (s.measure === 'records') {
    const unit = word(`[data-lens-unit] option[value="${s.unit}"]`);
    parts.push(s.unit === 'total' ? unit : `per ${unit}`);
  }
  return parts.filter(Boolean).join(' · ');
}

export function initLensDock(report: HTMLElement, lens: Lens): void {
  const dock = report.querySelector<HTMLElement>('[data-weather-dock]');
  const panel = dock?.querySelector<HTMLElement>('.weather-dock__panel');
  const strip = dock?.querySelector<HTMLButtonElement>('.weather-dock__strip');
  const now = dock?.querySelector<HTMLElement>('[data-dock-now]');
  if (!dock || !panel || !strip || !now || dock.dataset.bound === 'true') return;
  dock.dataset.bound = 'true';
  dock.hidden = false;

  const open = (yes: boolean) => {
    panel.hidden = !yes;
    strip.setAttribute('aria-expanded', String(yes));
    if (yes) dock.dataset.open = '';
    else delete dock.dataset.open;
  };
  strip.addEventListener('click', () => open(panel.hidden));
  dock.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    open(false);
    strip.focus();
  });
  // a tap anywhere else puts it away
  dock.ownerDocument.addEventListener(
    'pointerdown',
    (event) => {
      if (!panel.hidden && !dock.contains(event.target as Node)) open(false);
    },
    { passive: true },
  );

  const show = (s: LensState) => void (now.textContent = dockSummary(panel, s));
  show(lens.get());
  lens.onChange(show);
}
