// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { currentSection, hintWords, initLensDock, sectionsOf } from '../src/scripts/weather-dock.js';
import { createLens } from '../src/scripts/weather-lens.js';

// The page's map in the dock: jump to a section, see which one you're in, what the controls reach there.

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
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  window.requestAnimationFrame = (fn) => { fn(0); return 0; };
  Element.prototype.scrollIntoView = function () {};
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

  it('says what is below in words', () => {
    expect(hintWords([])).toBe('more below');
    expect(hintWords(['trends'])).toBe('more below: trends');
    expect(hintWords(['trends', 'patterns', 'where it lives'])).toBe('more below: trends, patterns and where it lives');
  });
});

describe('the dock as the page\'s map', () => {
  it('lists the sections to jump to, marks the one on screen, and leads the strip with it', () => {
    place({ sky: 0, trends: 900, patterns: 3000, hosts: 6000 });
    initLensDock(report, createLens());
    const links = [...report.querySelectorAll<HTMLAnchorElement>('[data-dock-nav] a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['the sky', '#the-sky'],
      ['trends', '#trends'],
      ['patterns', '#patterns-and-outlook'],
      ['where it lives', '#where-the-atmosphere-lives'],
    ]);
    expect(links[0]!.getAttribute('aria-current')).toBe('true');
    expect(report.querySelector('[data-dock-section]')!.textContent).toBe('the sky');
    // at the top, a hint that there's more
    const hint = report.querySelector<HTMLAnchorElement>('[data-dock-hint]')!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('more below: trends, patterns and where it lives');
    expect(hint.getAttribute('href')).toBe('#trends');
  });

  it('dims the controls a section does not follow, says so, and drops the hint once the reader scrolls', () => {
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
    // scrolled: the hint goes, and stays gone
    Object.defineProperty(window, 'scrollY', { value: 4000, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(report.querySelector<HTMLElement>('[data-dock-hint]')!.hidden).toBe(true);
    // back at the sky: every control counts again
    place({ sky: 0, trends: 900, patterns: 3000, hosts: 6000 });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(measureSeg.hasAttribute('data-inactive')).toBe(false);
    expect(note.hidden).toBe(true);
    expect(report.querySelector<HTMLElement>('[data-dock-hint]')!.hidden).toBe(true);
  });

  it('a jump closes the panel', () => {
    place({ sky: 0, trends: 900, patterns: 3000, hosts: 6000 });
    initLensDock(report, createLens());
    const strip = report.querySelector<HTMLButtonElement>('.weather-dock__strip')!;
    strip.click();
    expect(strip.getAttribute('aria-expanded')).toBe('true');
    report.querySelector<HTMLAnchorElement>('[data-dock-nav] a[href="#where-the-atmosphere-lives"]')!.click();
    expect(strip.getAttribute('aria-expanded')).toBe('false');
  });
});
