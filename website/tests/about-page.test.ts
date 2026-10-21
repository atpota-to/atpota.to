// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { easeOut, formatStat, initPoe, initStats, parseStat } from '../src/scripts/about.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('about page stats', () => {
  it('reads the number out of a stat, keeping what comes before and after', () => {
    expect(parseStat('65,000')).toEqual({ before: '', value: 65000, after: '' });
    expect(parseStat('$1,000')).toEqual({ before: '$', value: 1000, after: '' });
    expect(parseStat(' 110,000+ ')).toEqual({ before: '', value: 110000, after: '+' });
    expect(parseStat('lots')).toBeNull();
    expect(parseStat('0')).toBeNull();
  });

  it('writes a count the way the page does', () => {
    const stat = parseStat('$1,000')!;
    expect(formatStat(stat, 0)).toBe('$0');
    expect(formatStat(stat, 512.4)).toBe('$512');
    expect(formatStat(parseStat('110,000+')!, 110000)).toBe('110,000+');
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });

  const STATS = '<p class="moment__stat"><strong>65,000</strong> <span>visitors</span></p>';

  function fakeWindow(reduce: boolean, observed: Element[]) {
    class Observer {
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
    }
    return Object.assign(Object.create(window), {
      matchMedia: () => ({ matches: reduce }),
      IntersectionObserver: Observer,
    });
  }

  it('waits at zero for the count, with the real number kept for screen readers', () => {
    document.body.innerHTML = STATS;
    const observed: Element[] = [];
    initStats(document, fakeWindow(false, observed));
    const strong = document.querySelector('strong')!;
    expect(strong.textContent).toBe('0');
    expect(strong.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.visually-hidden')!.textContent).toBe('65,000');
    expect(observed).toEqual([strong]);
  });

  it('leaves the number alone under reduced motion', () => {
    document.body.innerHTML = STATS;
    const observed: Element[] = [];
    initStats(document, fakeWindow(true, observed));
    expect(document.querySelector('strong')!.textContent).toBe('65,000');
    expect(document.querySelector('.visually-hidden')).toBeNull();
    expect(observed).toEqual([]);
  });
});

describe('about page poe', () => {
  it('cheers the corner poe when patted', () => {
    document.body.innerHTML = '<button data-about-poe type="button"></button>';
    initPoe();
    const cheer = vi.fn();
    window.addEventListener('poe:cheer', cheer);
    document.querySelector<HTMLButtonElement>('[data-about-poe]')!.click();
    window.removeEventListener('poe:cheer', cheer);
    expect(cheer).toHaveBeenCalledOnce();
  });
});
