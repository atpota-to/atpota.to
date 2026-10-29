// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { currentSection, initLensDock, sectionsOf } from '../src/scripts/weather-dock.js';
import { createLens } from '../src/scripts/weather-lens.js';

// The page's sections in the dock: what the controls reach in the one you're in.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);

let report: HTMLElement;
/** Puts each section's top where a test wants it (jsdom lays nothing out). */
function place(tops: Record<string, number>) {
  for (const el of report.querySelectorAll<HTMLElement>('[data-section]')) {
    const top = tops[el.dataset.section!] ?? 5000;
    el.getBoundingClientRect = () => ({ top, bottom: top + 500, left: 0, right: 0, width: 0, height: 500, x: 0, y: top, toJSON() {} }) as DOMRect;
  }
}

beforeEach(() => {
  document.body.innerHTML = MAIN;
  report = document.querySelector<HTMLElement>('[data-weather-report]')!;
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  window.requestAnimationFrame = (fn) => { fn(0); return 0; };
});

describe('the page\'s sections', () => {
  it('are the sky, trends, patterns and where it lives, top to bottom, each with an id to link to', () => {
    const s = sectionsOf(report);
    expect(s.map((x) => [x.key, x.label, x.el.id])).toEqual([
      ['sky', 'the sky', 'the-sky'],
      ['trends', 'trends', 'trends'],
      ['patterns', 'patterns', 'patterns-and-outlook'],
      ['hosts', 'where it lives', 'where-the-atmosphere-lives'],
    ]);
    expect([...s[2]!.lens]).toEqual(['unit']);
    expect([...s[3]!.lens]).toEqual(['window']);
  });

  it('the one on screen is the last whose top has passed the upper third', () => {
    place({ sky: -900, trends: -100, patterns: 700, hosts: 2000 });
    expect(currentSection(sectionsOf(report), 800)!.key).toBe('trends');
    place({ sky: 0, trends: 900 });
    expect(currentSection(sectionsOf(report), 800)!.key).toBe('sky');
  });
});

describe('the dock and the page\'s sections', () => {
  const visible = () => [...report.querySelectorAll<HTMLElement>('[data-dock-now] [data-part]')].filter((s) => !s.hidden).map((s) => s.textContent).join('');

  it('says only what the controls are set to: no section name, no hint, no sections to jump to', () => {
    place({ sky: 0, trends: 900, patterns: 3000, hosts: 6000 });
    initLensDock(report, createLens());
    expect(report.querySelector('[data-weather-dock]')!.textContent!.replace(/\s+/g, ' ').trim()).not.toMatch(/the sky|more below/);
    expect(report.querySelector('[data-weather-dock] a')).toBeNull();
    expect(visible()).toBe('1h · accounts');
  });

  it('dims the controls a section does not follow, and says so', () => {
    place({ sky: -5000, trends: -4000, patterns: -3000, hosts: 100 });
    initLensDock(report, createLens());
    const dock = report.querySelector<HTMLElement>('[data-weather-dock]')!;
    expect(dock.dataset.section).toBe('hosts');
    const windowSeg = report.querySelector('[data-lens-window]')!.closest<HTMLElement>('.weather-seg')!;
    const measureSeg = report.querySelector('[data-lens-measure]')!.closest<HTMLElement>('.weather-seg')!;
    expect(windowSeg.hasAttribute('data-inactive')).toBe(false);
    expect(measureSeg.hasAttribute('data-inactive')).toBe(true);
    expect(report.querySelector<HTMLElement>('[data-lens-unit]')!.hasAttribute('data-inactive')).toBe(true);
    const note = report.querySelector<HTMLElement>('[data-dock-note]')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/only the window reaches/);
    expect(visible()).toBe('1h');
    // back at the sky: every control counts again
    place({ sky: 0, trends: 900, patterns: 3000, hosts: 6000 });
    window.dispatchEvent(new Event('scroll'));
    expect(measureSeg.hasAttribute('data-inactive')).toBe(false);
    expect(note.hidden).toBe(true);
    expect(visible()).toBe('1h · accounts');
  });

  it('says it all rather than nothing where none of what the strip shows reaches (patterns, by accounts)', () => {
    place({ sky: -5000, trends: -4000, patterns: 100, hosts: 6000 });
    initLensDock(report, createLens());
    const dock = report.querySelector<HTMLElement>('[data-weather-dock]')!;
    expect(dock.dataset.section).toBe('patterns');
    expect(dock.dataset.lensOff).toBe('window measure');
    expect(visible()).toBe('1h · accounts');
  });
});
