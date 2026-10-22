/**
 * The lens at hand (weather/index.html [data-weather-dock], weather.css .weather-dock): a
 * thin strip floating along the bottom of the screen, beside Poe, says what the page shows
 * ("1h · accounts"). A tap opens it upward to the lens's controls (bound by bindLens).
 * Another tap, Escape, or a tap anywhere else puts it away.
 *
 * It floats rather than sitting in the page: under a header whose height follows the
 * reading, a bar in the page slid out from under the finger with every change.
 *
 * It's also the page's map (initSections). The report's sections ([data-section]: the sky,
 * trends, patterns, where it lives) are listed in the panel to jump to, the one on screen
 * marked; the strip leads with its name; and the controls a section doesn't follow
 * (data-section-lens names the ones it does) are dimmed while it's on screen, with a line
 * saying so. Until the reader scrolls, a hint above the strip says there's more below.
 */

import { motionOK } from './roll';
import { WINDOW_INFO, type Lens, type LensState, type Window } from './weather-lens';

/** The header's period, above its number: "right now", or "the last 24 hours". */
export const periodWords = (w: Window) => (w === 'now' ? 'right now' : WINDOW_INFO[w].words);

/** The strip's parts: the window as the controls have it, the measure, and records' unit. */
export function dockParts(controls: HTMLElement, s: LensState): Array<[LensPart, string]> {
  const word = (sel: string) => controls.querySelector(sel)?.textContent?.trim() ?? '';
  const parts: Array<[LensPart, string]> = [
    ['window', word(`[data-lens-window="${s.window}"]`)],
    ['measure', word(`[data-lens-measure="${s.measure}"]`)],
  ];
  if (s.measure === 'records') parts.push(['unit', word(`[data-lens-unit] option[value="${s.unit}"]`)]);
  return parts.filter(([, w]) => w);
}

/** Hides the strip's parts named in `off` ("measure unit") and dots the rest: "1h · accounts". */
export function punctuate(now: HTMLElement, off: string): void {
  const hidden = new Set(off.split(' '));
  let first = true;
  for (const span of now.querySelectorAll<HTMLElement>('[data-part]')) {
    const part = span.dataset.part ?? '';
    span.hidden = hidden.has(part);
    const word = span.dataset.word ?? span.textContent ?? '';
    span.dataset.word = word;
    span.textContent = span.hidden || first ? word : ` · ${word}`;
    if (!span.hidden) first = false;
  }
}

/** What the strip says, in a line: "1h · accounts". */
export function dockSummary(controls: HTMLElement, s: LensState): string {
  return dockParts(controls, s)
    .map(([, w]) => w)
    .join(' · ');
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
  initSections(report, dock, () => open(false));
  const show = (s: LensState) => {
    // each part its own span, so a section the part doesn't reach can leave it out (initSections)
    now.replaceChildren(
      ...dockParts(panel, s).map(([part, w]) => {
        const span = document.createElement('span');
        span.dataset.part = part;
        span.textContent = w;
        return span;
      }),
    );
    punctuate(now, dock.dataset.lensOff ?? '');
    for (const el of periods) {
      el.textContent = periodWords(s.window);
      el.setAttribute('aria-label', `${periodWords(s.window)}. change what the report shows`);
    }
  };
  show(lens.get());
  lens.onChange(show);
}

// ---------- the page's map ----------

export type LensPart = 'window' | 'measure' | 'unit';

export interface Section {
  el: HTMLElement;
  key: string;
  label: string;
  /** The controls this section follows. */
  lens: Set<LensPart>;
}

/** What the panel says when a section follows only some of the controls. */
export const SECTION_NOTES: Record<string, string> = {
  window: 'down here only the window reaches: these keep their own counts.',
  unit: 'down here only the unit reaches: these keep their own times.',
  '': 'down here nothing up here reaches: these keep their own times and counts.',
};

/** The report's sections, top to bottom. */
export function sectionsOf(report: ParentNode): Section[] {
  return Array.from(report.querySelectorAll<HTMLElement>('[data-section]')).map((el) => ({
    el,
    key: el.dataset.section!,
    label: el.dataset.sectionLabel ?? el.dataset.section!,
    lens: new Set((el.dataset.sectionLens ?? 'window measure unit').split(/\s+/).filter(Boolean) as LensPart[]),
  }));
}

/** The section on screen: the last whose top has passed the upper third of the view (the first, before any has). */
export function currentSection(sections: Section[], viewHeight: number): Section | null {
  let at: Section | null = sections[0] ?? null;
  for (const s of sections) if (s.el.getBoundingClientRect().top <= viewHeight * 0.35) at = s;
  return at;
}

/** "more below: trends, patterns and where it lives". */
export function hintWords(labels: string[]): string {
  if (!labels.length) return 'more below';
  const list = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `more below: ${list}`;
}

/** Jump to a section: smoothly unless the reader asked for less motion. */
function jump(section: Section): void {
  section.el.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' });
  section.el.focus?.({ preventScroll: true });
}

export function initSections(report: HTMLElement, dock: HTMLElement, close: () => void): void {
  const sections = sectionsOf(report);
  const nav = dock.querySelector<HTMLElement>('[data-dock-nav]');
  const label = dock.querySelector<HTMLElement>('[data-dock-section]');
  const note = dock.querySelector<HTMLElement>('[data-dock-note]');
  const hint = dock.querySelector<HTMLAnchorElement>('[data-dock-hint]');
  const panel = dock.querySelector<HTMLElement>('.weather-dock__panel');
  if (sections.length < 2 || !nav || !panel) return;
  const win = dock.ownerDocument.defaultView ?? window;
  // each section can be landed on (for the jump's focus) without joining the tab order
  for (const s of sections) if (!s.el.hasAttribute('tabindex')) s.el.setAttribute('tabindex', '-1');

  const links = sections.map((s) => {
    const a = dock.ownerDocument.createElement('a');
    a.className = 'weather-dock__jump';
    a.href = `#${s.el.id}`;
    a.textContent = s.label;
    a.addEventListener('click', (event) => {
      event.preventDefault();
      close();
      jump(s);
      win.history?.replaceState?.(win.history.state, '', `#${s.el.id}`);
    });
    nav.append(a);
    return a;
  });
  const parts: Record<LensPart, HTMLElement | null> = {
    window: panel.querySelector<HTMLElement>('[data-lens-window]')?.closest<HTMLElement>('.weather-seg') ?? null,
    measure: panel.querySelector<HTMLElement>('[data-lens-measure]')?.closest<HTMLElement>('.weather-seg') ?? null,
    unit: panel.querySelector<HTMLElement>('[data-lens-unit]'),
  };

  let shown: string | null = null;
  let scrolled = false;
  const update = () => {
    const at = currentSection(sections, win.innerHeight);
    if (at && at.key !== shown) {
      shown = at.key;
      dock.dataset.section = at.key;
      if (label) label.textContent = at.label;
      links.forEach((a, i) => (sections[i] === at ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
      // the strip leaves out what doesn't reach this section ("accounts" means nothing to the hosts)
      dock.dataset.lensOff = (Object.keys(parts) as LensPart[]).filter((p) => !at.lens.has(p)).join(' ');
      const now = dock.querySelector<HTMLElement>('[data-dock-now]');
      if (now) punctuate(now, dock.dataset.lensOff);
      for (const [part, el] of Object.entries(parts) as Array<[LensPart, HTMLElement | null]>) {
        if (!el) continue;
        if (at.lens.has(part)) delete el.dataset.inactive;
        else el.dataset.inactive = '';
      }
      if (note) {
        const all = at.lens.size === 3;
        note.hidden = all;
        note.textContent = all ? '' : (SECTION_NOTES[[...at.lens].sort().join(' ')] ?? SECTION_NOTES['']!);
      }
    }
    if (hint) {
      // once the reader has scrolled, they know: it doesn't come back
      if (win.scrollY > 80) scrolled = true;
      const below = sections.filter((s) => s.el.getBoundingClientRect().top > win.innerHeight);
      hint.hidden = scrolled || below.length === 0;
      if (!hint.hidden) {
        const words = hint.querySelector<HTMLElement>('[data-dock-hint-words]');
        if (words) words.textContent = hintWords(below.map((s) => s.label));
        hint.href = `#${below[0]!.el.id}`;
      }
    }
  };
  hint?.addEventListener('click', (event) => {
    const next = sections.find((s) => `#${s.el.id}` === hint.getAttribute('href'));
    if (!next) return;
    event.preventDefault();
    jump(next);
  });
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };
  win.addEventListener('scroll', soon, { passive: true });
  win.addEventListener('resize', soon, { passive: true });
  update();
}
