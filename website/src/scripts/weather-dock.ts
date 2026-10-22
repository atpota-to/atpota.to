/**
 * The lens at hand (weather/index.html [data-weather-dock], weather.css .weather-dock): a
 * thin strip floating along the bottom of the screen, beside Poe, says what the page shows
 * ("1h · accounts"). A tap opens it upward to the lens's controls (bound by bindLens).
 * Another tap, Escape, or a tap anywhere else puts it away.
 *
 * It floats rather than sitting in the page: under a header whose height follows the
 * reading, a bar in the page slid out from under the finger with every change.
 */

import { WINDOW_INFO, type Lens, type LensState, type Window } from './weather-lens';

/** The header's period, above its number: "right now", or "the last 24 hours". */
export const periodWords = (w: Window) => (w === 'now' ? 'right now' : WINDOW_INFO[w].words);

/** What the strip says: the window as the controls have it, the measure, and records' unit. */
export function dockSummary(controls: HTMLElement, s: LensState): string {
  const word = (sel: string) => controls.querySelector(sel)?.textContent?.trim() ?? '';
  const parts = [word(`[data-lens-window="${s.window}"]`), word(`[data-lens-measure="${s.measure}"]`)];
  if (s.measure === 'records') parts.push(word(`[data-lens-unit] option[value="${s.unit}"]`));
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
  // the header's period ("the last 24 hours") opens it too, on the window that's showing
  for (const opener of report.querySelectorAll<HTMLElement>('[data-lens-open]')) {
    opener.addEventListener('click', () => {
      open(true);
      panel.querySelector<HTMLElement>('[data-lens-window][aria-pressed="true"]')?.focus();
    });
  }
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

  const periods = report.querySelectorAll<HTMLElement>('[data-r-period]');
  const show = (s: LensState) => {
    now.textContent = dockSummary(panel, s);
    for (const el of periods) {
      el.textContent = periodWords(s.window);
      el.setAttribute('aria-label', `${periodWords(s.window)}. change what the report shows`);
    }
  };
  show(lens.get());
  lens.onChange(show);
}
