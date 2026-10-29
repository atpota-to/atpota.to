/**
 * The lens at hand (weather/index.html [data-weather-dock], weather.css .weather-dock): a
 * thin strip floating along the bottom of the screen, beside Poe, says what the page shows
 * ("1h · accounts"). A tap opens it upward to the lens's controls (bound by bindLens).
 * Another tap, Escape, or a tap anywhere else puts it away.
 *
 * It floats rather than sitting in the page: under a header whose height follows the
 * reading, a bar in the page slid out from under the finger with every change.
 *
 * It also knows where the reader is (initSections). The controls the report's section on
 * screen ([data-section]: the sky, trends, patterns, where it lives) doesn't follow
 * (data-section-lens names the ones it does) are dimmed while it's on screen, with a line
 * saying so, and the strip leaves them out.
 *
 * A topic's page (/weather/<topic>, weather-topics.ts) is one section: the controls that
 * don't reach its tiles are dimmed for the whole page.
 */

import { WINDOW_INFO, type Lens, type LensState, type Window } from './weather-lens';
import { topicOf, type Topic } from './weather-topics';

/** A topic's page that only the lens's unit reaches (today's): its unit works whatever the measure (weather-lens.ts bindLens). */
export const unitAloneOn = (topic: Topic | null) => !!topic && topic.lens.includes('unit') && !topic.lens.includes('measure');

/** The header's period, above its number: "right now", or "the last 24 hours". */
export const periodWords = (w: Window) => (w === 'now' ? 'right now' : WINDOW_INFO[w].words);

/**
 * The strip's parts: the window as the controls have it, the measure, and records' unit.
 * `unitAlone` is a page only the unit reaches (a topic's, like today's), whose tiles always
 * count records: its unit is in the strip whatever the measure.
 */
export function dockParts(controls: HTMLElement, s: LensState, unitAlone = false): Array<[LensPart, string]> {
  const word = (sel: string) => controls.querySelector(sel)?.textContent?.trim() ?? '';
  const parts: Array<[LensPart, string]> = [
    ['window', word(`[data-lens-window="${s.window}"]`)],
    ['measure', word(`[data-lens-measure="${s.measure}"]`)],
  ];
  if (s.measure === 'records' || unitAlone) parts.push(['unit', word(`[data-lens-unit] option[value="${s.unit}"]`)]);
  return parts.filter(([, w]) => w);
}

/**
 * Hides the strip's parts named in `off` ("measure unit") and dots the rest: "1h · accounts".
 * If that would hide them all, it shows them all: a blank strip would say nothing at all.
 */
export function punctuate(now: HTMLElement, off: string): void {
  const spans = [...now.querySelectorAll<HTMLElement>('[data-part]')];
  const named = off.split(' ');
  const hidden = new Set(spans.every((span) => named.includes(span.dataset.part ?? '')) ? [] : named);
  let first = true;
  for (const span of spans) {
    const part = span.dataset.part ?? '';
    span.hidden = hidden.has(part);
    const word = span.dataset.word ?? span.textContent ?? '';
    span.dataset.word = word;
    span.textContent = span.hidden || first ? word : ` · ${word}`;
    if (!span.hidden) first = false;
  }
}

/** What the strip says, in a line: "1h · accounts". */
export function dockSummary(controls: HTMLElement, s: LensState, unitAlone = false): string {
  return dockParts(controls, s, unitAlone)
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
  const unitAlone = unitAloneOn(topicOf(report.ownerDocument));
  initSections(report, dock);
  const show = (s: LensState) => {
    // each part its own span, so a section the part doesn't reach can leave it out (initSections)
    now.replaceChildren(
      ...dockParts(panel, s, unitAlone).map(([part, w]) => {
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

// ---------- the page's sections ----------

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

/** The same, for a topic's page, which is all one section. */
export const PAGE_NOTES: Record<string, string> = {
  window: 'on this page only the window reaches: these keep their own counts.',
  unit: 'on this page only the unit reaches: these keep their own times.',
  '': 'on this page nothing up here reaches: these keep their own times and counts.',
};

/** The report's sections, top to bottom; a topic's page is one, under its header. */
export function sectionsOf(report: ParentNode, topic: Topic | null = topicOf((report as Node).ownerDocument ?? (report as Document))): Section[] {
  if (topic) {
    const el = report.querySelector<HTMLElement>('[data-section]');
    return el ? [{ el, key: topic.slug, label: topic.label, lens: new Set(topic.lens) }] : [];
  }
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

export function initSections(report: HTMLElement, dock: HTMLElement): void {
  const topic = topicOf(report.ownerDocument);
  const sections = sectionsOf(report, topic);
  const note = dock.querySelector<HTMLElement>('[data-dock-note]');
  const panel = dock.querySelector<HTMLElement>('.weather-dock__panel');
  // a page of one section (a topic's) still says what reaches it
  if (!panel || sections.length < (topic ? 1 : 2)) return;
  const win = dock.ownerDocument.defaultView ?? window;
  const parts: Record<LensPart, HTMLElement | null> = {
    window: panel.querySelector<HTMLElement>('[data-lens-window]')?.closest<HTMLElement>('.weather-seg') ?? null,
    measure: panel.querySelector<HTMLElement>('[data-lens-measure]')?.closest<HTMLElement>('.weather-seg') ?? null,
    unit: panel.querySelector<HTMLElement>('[data-lens-unit]'),
  };

  let shown: string | null = null;
  const update = () => {
    const at = currentSection(sections, win.innerHeight);
    if (at && at.key !== shown) {
      shown = at.key;
      dock.dataset.section = at.key;
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
        const notes = topic ? PAGE_NOTES : SECTION_NOTES;
        note.textContent = all ? '' : (notes[[...at.lens].sort().join(' ')] ?? notes['']!);
      }
    }
  };
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
