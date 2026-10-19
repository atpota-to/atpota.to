/**
 * Highlight-to-ask rules (SPEC 4.6): a selection of 2..300 characters inside one
 * [data-poe-askable] element offers the "ask poe about this" pill. Selections in
 * form fields, editable regions or the widget itself never do.
 */

import { collapseWhitespace } from './client';

export const ASKABLE_SELECTOR = '[data-poe-askable]';
export const MIN_SELECTION = 2;
export const MAX_ASK_SELECTION = 300;

export function normalizeSelection(text: string | null | undefined): string {
  return typeof text === 'string' ? collapseWhitespace(text) : '';
}

export function isAskableLength(text: string): boolean {
  return text.length >= MIN_SELECTION && text.length <= MAX_ASK_SELECTION;
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** The askable root that contains `node`, or null. */
export function findAskableRoot(node: Node | null): Element | null {
  return elementOf(node)?.closest(ASKABLE_SELECTOR) ?? null;
}

const EXCLUDED = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .poe, [data-poe-ignore]';

export interface AskableSelection {
  text: string;
  root: Element;
  range: Range;
}

/** Applies every rule to the current selection; returns what the pill should ask about, or null. */
export function getAskableSelection(selection: Selection | null): AskableSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const root = findAskableRoot(range.commonAncestorContainer);
  if (!root) return null;
  // Both ends must sit in the same askable root (commonAncestor already implies it).
  if (findAskableRoot(selection.anchorNode) !== root || findAskableRoot(selection.focusNode) !== root) return null;
  const startEl = elementOf(range.startContainer);
  const endEl = elementOf(range.endContainer);
  if (startEl?.closest(EXCLUDED) || endEl?.closest(EXCLUDED)) return null;
  const text = normalizeSelection(selection.toString());
  if (!isAskableLength(text)) return null;
  return { text, root, range };
}

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

/**
 * Where to put the pill (viewport coordinates of its top-left corner). Above the
 * first line of the selection, centred on it; below the last line when there is
 * no room above or on touch screens (the OS selection menu sits above).
 */
export function pillPosition(
  first: Rect,
  last: Rect,
  pill: { width: number; height: number },
  viewport: { width: number; height: number },
  preferBelow: boolean,
  gap = 10,
  margin = 8,
): { left: number; top: number; placement: 'above' | 'below' } {
  const fitsAbove = first.top - gap - pill.height >= margin;
  const below = preferBelow || !fitsAbove;
  const anchor = below ? last : first;
  const centre = anchor.left + anchor.width / 2;
  const maxLeft = Math.max(margin, viewport.width - pill.width - margin);
  const left = Math.min(Math.max(centre - pill.width / 2, margin), maxLeft);
  let top = below ? anchor.bottom + gap : anchor.top - gap - pill.height;
  top = Math.min(Math.max(top, margin), Math.max(margin, viewport.height - pill.height - margin));
  return { left: Math.round(left), top: Math.round(top), placement: below ? 'below' : 'above' };
}

/**
 * The text of the guide section currently being read, for "summarize this
 * section": the last h2 in `root` whose top is above `line` (viewport px), plus
 * its following siblings up to the next h2. Null when the root has no h2.
 */
export function currentSection(root: Element, line: number, maxChars = 2000): { title: string; text: string } | null {
  const headings = Array.from(root.querySelectorAll('h2'));
  if (headings.length === 0) return null;
  let current = headings[0] as HTMLElement;
  for (const h of headings) {
    const top = (h as HTMLElement).getBoundingClientRect().top;
    if (top <= line) current = h as HTMLElement;
    else break;
  }
  const parts: string[] = [];
  const title = collapseWhitespace(current.textContent ?? '');
  parts.push(title);
  for (let el = current.nextElementSibling; el && el.tagName !== 'H2'; el = el.nextElementSibling) {
    if (el.matches('script, style, .poe, [data-poe-ignore]')) continue;
    parts.push(el.textContent ?? '');
    if (parts.join(' ').length > maxChars) break;
  }
  return { title, text: collapseWhitespace(parts.join(' ')).slice(0, maxChars) };
}
