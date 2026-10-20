// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cellsOf, rollText, steps } from '../src/scripts/roll.js';

// Rolling numbers (src/scripts/roll.ts): reels for the eye, plain text for everything else.

let el: HTMLElement;
const digits = () => [...el.querySelectorAll<HTMLElement>('.roll__cells .roll__c:not(.is-leaving)')].map((c) => c.dataset.c).join('');

beforeEach(() => {
  document.body.innerHTML = '<p data-x>&ndash;</p>';
  el = document.querySelector<HTMLElement>('[data-x]')!;
});

describe('rolling numbers', () => {
  it('keys each character by its place, so 99.8 and 100 line up', () => {
    expect(cellsOf('1,234.5').map((c) => c.key)).toEqual(['d3', 'c3', 'd2', 'd1', 'd0', 'dot', 'f1']);
    expect(cellsOf('99.8').map((c) => c.key)).toEqual(['d1', 'd0', 'dot', 'f1']);
    const ranks = cellsOf('1,234.56').map((c) => c.rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('turns a reel the way the number went, carrying past 9 or 0', () => {
    expect(steps(9, 1, 1)).toBe(2); // 9, 0, 1
    expect(steps(1, 9, -1)).toBe(-2); // 1, 0, 9
    expect(steps(6, 5, -1)).toBe(-1);
    expect(steps(5, 1, 1)).toBe(6);
    expect(steps(3, 7, 0)).toBe(4);
  });

  it('keeps the text plain: textContent is the number, the reels add none', () => {
    rollText(el, '1 in 521 new records came from outside bluesky');
    expect(el.textContent).toBe('1 in 521 new records came from outside bluesky');
    expect(el.querySelectorAll('.roll')).toHaveLength(2);
    expect(el.querySelector('.roll__cells')!.getAttribute('aria-hidden')).toBe('true');
    rollText(el, '1 in 520 new records came from outside bluesky');
    expect(el.textContent).toBe('1 in 520 new records came from outside bluesky');
  });

  it('rolls the same cells when only the numbers change, and starts over when the words do', () => {
    rollText(el, '(99.81%)');
    const roll = el.querySelector('.roll');
    rollText(el, '(99.83%)');
    expect(el.querySelector('.roll')).toBe(roll);
    expect(digits()).toBe('99.83');
    // the hundredths turned up two, from 1 to 3, on the middle run of the reel
    expect(el.querySelector<HTMLElement>('[data-key="f2"]')!.style.getPropertyValue('--n')).toBe('13');
    rollText(el, 'every new record just now was a bluesky one');
    expect(el.querySelector('.roll')).toBeNull();
    expect(el.textContent).toBe('every new record just now was a bluesky one');
  });

  it('adds and drops digits by place', () => {
    rollText(el, '99.8');
    rollText(el, '100');
    expect(el.textContent).toBe('100');
    expect(digits()).toBe('100');
    rollText(el, '1,000');
    expect(el.textContent).toBe('1,000');
    expect(digits()).toBe('1,000');
  });

  it('starts over if something else wrote in the element', () => {
    rollText(el, '42');
    el.textContent = 'checking…';
    rollText(el, '43');
    expect(el.textContent).toBe('43');
    expect(el.querySelectorAll('.roll')).toHaveLength(1);
  });
});
