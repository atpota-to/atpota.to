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

const SECTION_HEADINGS = 'h2, h3, h4, h5';
const SECTION_SKIP = 'script, style, .poe, [data-poe-ignore]';

function headingRank(el: Element): number {
  return /^H([1-6])$/.exec(el.tagName) ? Number(el.tagName.charAt(1)) : 0;
}

/**
 * The part of the guide being read, for "summarize this section". Only 2000
 * characters fit in a request (client, proxy and bot all cap the selection), and
 * some h2 sections run to 20k, so this anchors on the nearest heading of any level
 * (h2..h5) whose top is at or above `line` (viewport px), falling back to the first.
 * The text starts with the path of headings above it ("Understanding Bluesky ›
 * How Bluesky is different from Twitter › 3. Labelers + content filters") so Poe
 * knows where the excerpt sits, then that heading's section: its following siblings
 * up to the next heading of the same or a higher level. Cut at a word, with "…",
 * when it does not fit. `title` (the bubble's caption) is the nearest heading.
 * Null when the root has no headings.
 */
export function currentSection(root: Element, line: number, maxChars = 2000): { title: string; text: string } | null {
  const headings = Array.from(root.querySelectorAll<HTMLElement>(SECTION_HEADINGS));
  if (headings.length === 0) return null;
  let index = 0;
  for (let i = 0; i < headings.length; i++) {
    if ((headings[i] as HTMLElement).getBoundingClientRect().top <= line) index = i;
    else break;
  }
  const current = headings[index] as HTMLElement;
  const rank = headingRank(current);
  const title = collapseWhitespace(current.textContent ?? '');

  // The headings this one sits under, nearest last.
  const path = [title];
  let above = rank;
  for (let i = index - 1; i >= 0 && above > 2; i--) {
    const h = headings[i] as HTMLElement;
    const r = headingRank(h);
    if (r < above) {
      path.unshift(collapseWhitespace(h.textContent ?? ''));
      above = r;
    }
  }

  const parts = [path.join(' › ')];
  let length = parts[0]!.length;
  for (let el = current.nextElementSibling; el; el = el.nextElementSibling) {
    const r = headingRank(el);
    if (r > 0 && r <= rank) break;
    if (el.matches(SECTION_SKIP)) continue;
    const text = collapseWhitespace(el.textContent ?? '');
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
    if (length > maxChars) break;
  }
  let text = parts.join(' ');
  if (text.length > maxChars) {
    let cut = text.slice(0, Math.max(0, maxChars - 1));
    const space = cut.lastIndexOf(' ');
    if (space > maxChars * 0.8) cut = cut.slice(0, space);
    text = `${cut.trimEnd()}…`;
  }
  return { title, text };
}
