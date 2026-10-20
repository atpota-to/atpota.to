import { describe, expect, it, vi } from 'vitest';
import { focusForTyping, isTouchFirst, TOUCH_FIRST_QUERY } from '../src/scripts/typing-focus';

const winWith = (touch: boolean) => ({ matchMedia: (q: string) => ({ matches: touch && q === TOUCH_FIRST_QUERY }) }) as unknown as Window;
const field = () => ({ focus: vi.fn(), select: vi.fn() }) as unknown as HTMLInputElement;

describe('focusForTyping', () => {
  it('focuses and selects on a device with a mouse', () => {
    const f = field();
    expect(focusForTyping(f, winWith(false), { select: true })).toBe(true);
    expect(f.focus).toHaveBeenCalled();
    expect(f.select).toHaveBeenCalled();
  });

  it('leaves the field alone on a touch screen, so the keyboard stays down', () => {
    const f = field();
    expect(isTouchFirst(winWith(true))).toBe(true);
    expect(focusForTyping(f, winWith(true), { select: true })).toBe(false);
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
  });

  it('copes with no field and no matchMedia', () => {
    expect(focusForTyping(null, winWith(false))).toBe(false);
    expect(isTouchFirst({} as Window)).toBe(false);
  });
});
