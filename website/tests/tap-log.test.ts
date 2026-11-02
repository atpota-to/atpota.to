// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLICK_WAIT_MS, describe as describeEl, initTapLog, tapLogWanted } from '../src/scripts/tap-log.js';

function pointer(type: string, target: Element, pointerType = 'touch'): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType, clientX: 10, clientY: 20 });
  target.dispatchEvent(event);
}

const panel = () => document.querySelector<HTMLElement>('[data-tap-log-panel]');

describe('tap log', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    delete document.documentElement.dataset.tapLog;
  });

  it('only with ?taplog', () => {
    expect(tapLogWanted('')).toBe(false);
    expect(tapLogWanted('?w=7d')).toBe(false);
    expect(tapLogWanted('?taplog')).toBe(true);
    expect(tapLogWanted('?w=7d&taplog=1')).toBe(true);
    initTapLog({ search: '' });
    expect(panel()).toBeNull();
  });

  it('logs a tap that ends in a click, and keeps the link from going anywhere', () => {
    document.body.innerHTML = '<nav><a href="/weather/trends" class="weather-topics__link">trends</a></nav>';
    initTapLog({ search: '?taplog' });
    expect(panel()?.getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(panel()!).pointerEvents).toBe('none');
    const link = document.querySelector('a')!;
    pointer('pointerdown', link);
    pointer('pointerup', link);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const text = panel()!.textContent!;
    expect(text).toContain("#1 a.weather-topics__link 'trends'");
    expect(text).toMatch(/pointerdown[\s\S]*pointerup[\s\S]*click ✓ a\.weather-topics__link 'trends' → \/weather\/trends/);
    expect(text).not.toContain('no click');
  });

  it('says so when no click comes', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<a href="/weather/today">today</a>';
    initTapLog({ search: '?taplog' });
    const link = document.querySelector('a')!;
    pointer('pointerdown', link);
    pointer('pointercancel', link);
    vi.advanceTimersByTime(CLICK_WAIT_MS + 1);
    const text = panel()!.textContent!;
    expect(text).toContain('pointercancel ← taken as a scroll or long press');
    expect(text).toContain('✗ no click');
  });

  it('ignores the mouse', () => {
    document.body.innerHTML = '<a href="/">home</a>';
    initTapLog({ search: '?taplog' });
    pointer('pointerdown', document.querySelector('a')!, 'mouse');
    expect(panel()!.textContent).not.toContain('#1');
  });

  it('describes an element by its tag, first class and words', () => {
    document.body.innerHTML = '<button class="poe-nudge__close x">  close  me </button>';
    expect(describeEl(document.querySelector('button'))).toBe("button.poe-nudge__close 'close me'");
    expect(describeEl(null)).toBe('nothing');
  });
});
