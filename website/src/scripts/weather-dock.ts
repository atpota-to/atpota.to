/**
 * The lens at hand (weather/index.html, weather.css .weather-dock): once the bar under the
 * header has scrolled away, a thin strip along the bottom of the screen, beside Poe, says
 * what the page shows ("1h · accounts"). A tap opens it upward to the bar's own controls,
 * copied here and bound with the bar's (bindLens), so the two always agree. Another tap,
 * Escape, or scrolling back up to the bar puts it away.
 */

import type { Lens, LensState } from './weather-lens';

/** What the strip says: the window as the bar has it, the measure, and records' unit. */
export function dockSummary(bar: HTMLElement, s: LensState): string {
  const word = (sel: string) => bar.querySelector(sel)?.textContent?.trim() ?? '';
  const parts = [word(`[data-lens-window="${s.window}"]`), word(`[data-lens-measure="${s.measure}"]`)];
  if (s.measure === 'records') {
    const unit = word(`[data-lens-unit] option[value="${s.unit}"]`);
    parts.push(s.unit === 'total' ? unit : `per ${unit}`);
  }
  return parts.filter(Boolean).join(' · ');
}

/** A copy of the bar's controls, with ids of their own so labels still find theirs. */
function copyControls(bar: HTMLElement): DocumentFragment {
  const copy = document.createDocumentFragment();
  for (const child of Array.from(bar.children)) copy.append(child.cloneNode(true));
  const own = (id: string) => `weather-dock-${id}`;
  for (const el of Array.from(copy.querySelectorAll<HTMLElement>('[id]'))) el.id = own(el.id);
  for (const attr of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls']) {
    for (const el of Array.from(copy.querySelectorAll<HTMLElement>(`[${attr}]`))) {
      el.setAttribute(attr, el.getAttribute(attr)!.split(/\s+/).map(own).join(' '));
    }
  }
  return copy;
}

export function initLensDock(report: HTMLElement, lens: Lens): void {
  const bar = report.querySelector<HTMLElement>('.weather-lens');
  if (!bar || report.querySelector('.weather-dock') || typeof IntersectionObserver === 'undefined') return;

  const dock = document.createElement('div');
  dock.className = 'weather-dock';
  dock.inert = true;

  const panel = document.createElement('div');
  panel.className = 'weather-dock__panel';
  panel.id = 'weather-dock-panel';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'what the report shows');
  panel.hidden = true;
  panel.append(copyControls(bar));

  const strip = document.createElement('button');
  strip.type = 'button';
  strip.className = 'weather-dock__strip';
  strip.setAttribute('aria-expanded', 'false');
  strip.setAttribute('aria-controls', panel.id);
  strip.innerHTML =
    '<span class="weather-dock__label">showing</span> <span class="weather-dock__now" data-dock-now></span>' +
    '<svg class="weather-dock__chev" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M6 12l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const now = strip.querySelector<HTMLElement>('[data-dock-now]')!;

  dock.append(panel, strip);
  bar.after(dock);

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

  // out of sight above, not still to come: only then is the strip needed
  new IntersectionObserver(([entry]) => {
    const shown = !entry.isIntersecting && entry.boundingClientRect.top < 0;
    dock.inert = !shown;
    if (shown) dock.dataset.shown = '';
    else {
      delete dock.dataset.shown;
      open(false);
    }
  }).observe(bar);

  const show = (s: LensState) => void (now.textContent = dockSummary(bar, s));
  show(lens.get());
  lens.onChange(show);
}
