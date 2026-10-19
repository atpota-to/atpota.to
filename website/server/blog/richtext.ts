/**
 * Rich text: plaintext plus facets, as in pub.leaflet.richtext.facet and
 * app.bsky.richtext.facet. Facet ranges count UTF-8 bytes (start inclusive, end
 * exclusive), so the text is split on byte boundaries, snapped forward to the start of a
 * character, then each piece is wrapped in the marks that cover all of it. Overlapping
 * facets are fine. Consecutive pieces under the same link share one <a>.
 *
 * Not rendered: #id facets (they would put record-chosen ids on the page) and highlight
 * colours (the site's <mark> colour stays readable in both themes).
 */

import { escapeAttr, safeHref, textWithBreaks } from './html.js';

export interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  highlight?: boolean;
  href?: string;
}

export interface Footnote {
  key: string;
  text: string;
  facets: unknown[];
}

/** Collects footnotes in reading order, so the page can number and list them. */
export class FootnoteList {
  readonly items: Footnote[] = [];
  private readonly numbers = new Map<string, number>();

  /** The note's number, and whether this is its first reference (which gets the anchor id). */
  add(note: Footnote): { n: number; first: boolean } {
    const known = this.numbers.get(note.key);
    if (known) return { n: known, first: false };
    this.items.push(note);
    this.numbers.set(note.key, this.items.length);
    return { n: this.items.length, first: true };
  }
}

interface Range {
  start: number;
  end: number;
  feature: Record<string, unknown>;
}

interface Piece {
  text: string;
  marks: Marks;
  /** Footnotes whose range ends with this piece. */
  footnotes: Footnote[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isContinuation(bytes: Uint8Array, i: number): boolean {
  return i < bytes.length && ((bytes[i] ?? 0) & 0xc0) === 0x80;
}

function snap(bytes: Uint8Array, i: number): number {
  let n = Math.min(Math.max(0, Math.trunc(i)), bytes.length);
  while (isContinuation(bytes, n)) n++;
  return n;
}

function rangesOf(bytes: Uint8Array, facets: unknown): Range[] {
  if (!Array.isArray(facets)) return [];
  const out: Range[] = [];
  for (const facet of facets.slice(0, 2000)) {
    const index = (facet as { index?: { byteStart?: unknown; byteEnd?: unknown } })?.index;
    const features = (facet as { features?: unknown })?.features;
    if (typeof index?.byteStart !== 'number' || typeof index.byteEnd !== 'number' || !Array.isArray(features)) continue;
    const start = snap(bytes, index.byteStart);
    const end = snap(bytes, index.byteEnd);
    if (end <= start) continue;
    for (const feature of features) {
      if (feature && typeof feature === 'object' && typeof (feature as { $type?: unknown }).$type === 'string') {
        out.push({ start, end, feature: feature as Record<string, unknown> });
      }
    }
  }
  return out;
}

/** Leaflet and Bluesky feature types, by the part after "#". */
function featureName(type: string): string {
  const hash = type.lastIndexOf('#');
  return hash === -1 ? type : type.slice(hash + 1);
}

function applyFeature(marks: Marks, feature: Record<string, unknown>): void {
  const type = feature.$type as string;
  const bsky = type.startsWith('app.bsky.richtext.facet');
  switch (featureName(type)) {
    case 'bold':
      marks.bold = true;
      break;
    case 'italic':
      marks.italic = true;
      break;
    case 'underline':
      marks.underline = true;
      break;
    case 'strikethrough':
      marks.strike = true;
      break;
    case 'code':
      marks.code = true;
      break;
    case 'highlight':
      // The record's colour is ignored: the site's <mark> stays readable in both themes.
      marks.highlight = true;
      break;
    case 'link': {
      const href = safeHref(feature.uri);
      if (href) marks.href = href;
      break;
    }
    case 'didMention':
    case 'mention': {
      const did = feature.did;
      if (typeof did === 'string' && /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(did)) {
        marks.href = bsky ? `https://bsky.app/profile/${did}` : `https://aturi.to/profile/${did}`;
      }
      break;
    }
    case 'atMention': {
      const href = safeHref(feature.href) ?? safeHref(feature.atURI);
      if (href) marks.href = href;
      break;
    }
    case 'tag': {
      const tag = feature.tag;
      if (bsky && typeof tag === 'string' && tag.trim()) marks.href = `https://bsky.app/hashtag/${encodeURIComponent(tag.trim().replace(/^#/, ''))}`;
      break;
    }
  }
}

function piecesOf(text: string, facets: unknown): Piece[] {
  const bytes = encoder.encode(text);
  const ranges = rangesOf(bytes, facets);
  if (ranges.length === 0) return text ? [{ text, marks: {}, footnotes: [] }] : [];
  const cuts = new Set<number>([0, bytes.length]);
  for (const r of ranges) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const marks: Marks = {};
    const footnotes: Footnote[] = [];
    for (const r of ranges) {
      if (r.start > a || r.end < b) continue;
      if (featureName(r.feature.$type as string) === 'footnote') {
        if (r.end === b && typeof r.feature.footnoteId === 'string' && typeof r.feature.contentPlaintext === 'string') {
          footnotes.push({
            key: r.feature.footnoteId,
            text: r.feature.contentPlaintext,
            facets: Array.isArray(r.feature.contentFacets) ? r.feature.contentFacets : [],
          });
        }
        continue;
      }
      applyFeature(marks, r.feature);
    }
    pieces.push({ text: decoder.decode(bytes.subarray(a, b)), marks, footnotes });
  }
  return pieces;
}

function wrap(piece: Piece): string {
  let html = textWithBreaks(piece.text);
  const m = piece.marks;
  if (m.code) html = `<code>${html}</code>`;
  if (m.bold) html = `<strong>${html}</strong>`;
  if (m.italic) html = `<em>${html}</em>`;
  if (m.underline) html = `<u>${html}</u>`;
  if (m.strike) html = `<s>${html}</s>`;
  if (m.highlight) html = `<mark>${html}</mark>`;
  return html;
}

export interface RichTextOptions {
  /** Where footnotes are collected; without one they are dropped. */
  footnotes?: FootnoteList;
}

/** Renders plaintext + facets to inline HTML. */
export function renderRichText(text: unknown, facets: unknown, opts: RichTextOptions = {}): string {
  if (typeof text !== 'string' || text === '') return '';
  const pieces = piecesOf(text, facets);
  let html = '';
  let i = 0;
  while (i < pieces.length) {
    const href = pieces[i]!.marks.href;
    let inner = '';
    let notes = '';
    // Group the run of pieces that share this link (or have none).
    while (i < pieces.length && pieces[i]!.marks.href === href) {
      const piece = pieces[i]!;
      inner += wrap(piece);
      for (const note of piece.footnotes) {
        if (!opts.footnotes) continue;
        const { n, first } = opts.footnotes.add(note);
        const ref = `<sup class="post-fn-ref"><a href="#fn-${n}"${first ? ` id="fnref-${n}"` : ''} aria-describedby="footnotes-label">${n}</a></sup>`;
        // A footnote inside a link would nest anchors; hold it until the link closes.
        if (href) notes += ref;
        else inner += ref;
      }
      i++;
    }
    html += href ? `<a href="${escapeAttr(href)}">${inner}</a>${notes}` : inner;
  }
  return html;
}

/** Plain text of a block's rich text, for reading time and descriptions. */
export function plainText(text: unknown): string {
  return typeof text === 'string' ? text : '';
}
