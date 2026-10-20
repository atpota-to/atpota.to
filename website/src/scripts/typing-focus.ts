/**
 * Putting the cursor in a text field from code. On a touch-first device (a phone, a
 * tablet) that pops the on-screen keyboard over the page, so nothing on the site does it
 * there: the reader taps the field when they're ready to type.
 */

export const TOUCH_FIRST_QUERY = '(hover: none) and (pointer: coarse)';

export function isTouchFirst(win: Window = window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia(TOUCH_FIRST_QUERY).matches;
}

/** Focuses `field` (and selects its text with `select`), except on a touch-first device. */
export function focusForTyping(field: HTMLInputElement | HTMLTextAreaElement | null | undefined, win: Window = window, options: { select?: boolean; preventScroll?: boolean } = {}): boolean {
  if (!field || isTouchFirst(win)) return false;
  field.focus({ preventScroll: options.preventScroll });
  if (options.select) field.select();
  return true;
}
