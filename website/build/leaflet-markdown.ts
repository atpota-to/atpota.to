import { readFileSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { Marked, type Token, type Tokens } from 'marked';
import { blobCid } from './atproto-ids.js';
import { imageSize, normaliseUrl } from './guide-markdown.js';

/**
 * Markdown -> Leaflet blocks (pub.leaflet.content), for publishing a guide as a
 * site.standard.document. Same markdown, same image resolution as the page build
 * (build/guide-markdown.ts), so the record and the page say the same thing.
 *
 *   headings     -> pub.leaflet.blocks.header (level = number of #)
 *   paragraphs   -> pub.leaflet.blocks.text, with facets for bold, italic, strikethrough,
 *                   inline code and links (UTF-8 byte ranges); hard breaks become "\n"
 *   image-only paragraphs -> one pub.leaflet.blocks.image per image, as a blob reference
 *                   whose CID is computed from the file (the publish script uploads it)
 *   lists        -> unorderedList / orderedList, nested, task items as checklists
 *   blockquote, fenced code, rules -> blockquote, code, horizontalRule
 *   raw HTML     -> plain text (never markup)
 *
 * Relative links become absolute (https://atpota.to/...), and in-page #anchors point at
 * the guide's own page, so they still work wherever the record is read.
 */

const F = 'pub.leaflet.richtext.facet';
const B = 'pub.leaflet.blocks.';

export interface BlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface LocalBlob {
  ref: BlobRef;
  /** Absolute path of the file to upload. */
  file: string;
  width?: number;
  height?: number;
}

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Record<string, unknown>[];
}

export interface LeafletContent {
  $type: 'pub.leaflet.content';
  pages: { $type: 'pub.leaflet.pages.linearDocument'; blocks: { $type: string; block: Record<string, unknown> }[] }[];
}

export interface ConvertOptions {
  /** Public dir that root-relative image URLs map to. */
  publicDir: string;
  /** Base for relative URLs in the markdown, e.g. "/guides/". */
  base: string;
  /** Site origin for making links absolute, e.g. "https://atpota.to". */
  origin: string;
  /** The page the markdown is shown on, for #anchor links. */
  pageUrl: string;
}

export interface Converted {
  content: LeafletContent;
  /** Plain text of the whole document (the record's textContent). */
  text: string;
  /** Every blob the content references, deduplicated by CID. */
  blobs: LocalBlob[];
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Leaflet caps image blobs at 1 MB (pub.leaflet.blocks.image, site.standard.document). */
export const MAX_IMAGE_BYTES = 1_000_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** marked keeps entities as written in text tokens; plaintext wants the characters. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

function insideDir(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

/** Reads a public image into a blob reference (CID computed locally). */
export function localBlob(src: string, publicDir: string, maxBytes = MAX_IMAGE_BYTES): LocalBlob {
  const path = decodeURI(src.split(/[?#]/)[0] ?? src);
  const file = resolve(publicDir, `.${path}`);
  if (!src.startsWith('/') || !insideDir(publicDir, file)) throw new Error(`[leaflet] image outside public/: ${src}`);
  const mimeType = MIME[extname(file).toLowerCase()];
  if (!mimeType) throw new Error(`[leaflet] unsupported image type: ${src}`);
  const bytes = readFileSync(file);
  if (bytes.length > maxBytes) throw new Error(`[leaflet] ${src} is ${bytes.length} bytes; Leaflet images must be under ${maxBytes}`);
  const size = imageSize(file);
  return {
    ref: { $type: 'blob', ref: { $link: blobCid(bytes) }, mimeType, size: bytes.length },
    file,
    ...(size ? { width: size.width, height: size.height } : {}),
  };
}

const encoder = new TextEncoder();

/** Builds plaintext + facets from inline tokens. */
class RichText {
  text = '';
  private readonly runs: { start: number; end: number; features: Record<string, unknown>[] }[] = [];

  constructor(private readonly link: (href: string) => string | null) {}

  private append(value: string, features: Record<string, unknown>[]): void {
    if (!value) return;
    const start = encoder.encode(this.text).length;
    this.text += value;
    if (features.length) this.runs.push({ start, end: start + encoder.encode(value).length, features });
  }

  add(tokens: readonly Token[] | undefined, features: Record<string, unknown>[] = []): void {
    for (const token of tokens ?? []) {
      switch (token.type) {
        case 'text': {
          const t = token as Tokens.Text;
          // Soft line breaks inside a paragraph are spaces.
          if (t.tokens?.length) this.add(t.tokens, features);
          else this.append(decodeEntities(t.text).replace(/\s*\n\s*/g, ' '), features);
          break;
        }
        case 'escape':
          this.append((token as Tokens.Escape).text, features);
          break;
        case 'strong':
          this.add((token as Tokens.Strong).tokens, [...features, { $type: `${F}#bold` }]);
          break;
        case 'em':
          this.add((token as Tokens.Em).tokens, [...features, { $type: `${F}#italic` }]);
          break;
        case 'del':
          this.add((token as Tokens.Del).tokens, [...features, { $type: `${F}#strikethrough` }]);
          break;
        case 'codespan':
          this.append(decodeEntities((token as Tokens.Codespan).text), [...features, { $type: `${F}#code` }]);
          break;
        case 'link': {
          const l = token as Tokens.Link;
          const uri = this.link(l.href);
          this.add(l.tokens, uri ? [...features, { $type: `${F}#link`, uri }] : features);
          break;
        }
        case 'br':
          this.append('\n', features);
          break;
        case 'image':
          this.append((token as Tokens.Image).text, features);
          break;
        case 'html':
        case 'tag':
          this.append((token as Tokens.HTML).text, features);
          break;
        default:
          if ('text' in token && typeof token.text === 'string') this.append(decodeEntities(token.text), features);
      }
    }
  }

  /**
   * Plaintext (trimmed) and facets: one facet per feature over each run of text it covers,
   * so a link with a bold word inside stays a single link facet.
   */
  result(): { plaintext: string; facets: Facet[] } {
    const lead = this.text.length - this.text.trimStart().length;
    const plaintext = this.text.trim();
    const shift = encoder.encode(this.text.slice(0, lead)).length;
    const limit = encoder.encode(plaintext).length;
    const byFeature = new Map<string, { feature: Record<string, unknown>; ranges: [number, number][] }>();
    for (const run of this.runs) {
      for (const feature of run.features) {
        const key = JSON.stringify(feature);
        const entry = byFeature.get(key) ?? { feature, ranges: [] };
        const last = entry.ranges[entry.ranges.length - 1];
        if (last && last[1] === run.start) last[1] = run.end;
        else entry.ranges.push([run.start, run.end]);
        byFeature.set(key, entry);
      }
    }
    const facets: Facet[] = [];
    for (const { feature, ranges } of byFeature.values()) {
      for (const [a, b] of ranges) {
        const byteStart = Math.max(0, a - shift);
        const byteEnd = Math.min(limit, b - shift);
        if (byteEnd > byteStart) facets.push({ index: { byteStart, byteEnd }, features: [feature] });
      }
    }
    facets.sort((x, y) => x.index.byteStart - y.index.byteStart || x.index.byteEnd - y.index.byteEnd);
    return { plaintext, facets };
  }
}

function withFacets(block: Record<string, unknown>, rich: { plaintext: string; facets: Facet[] }): Record<string, unknown> {
  return rich.facets.length ? { ...block, plaintext: rich.plaintext, facets: rich.facets } : { ...block, plaintext: rich.plaintext };
}

export function markdownToLeaflet(markdown: string, opts: ConvertOptions): Converted {
  const blobs = new Map<string, LocalBlob>();
  const textParts: string[] = [];

  const absolute = (href: string): string | null => {
    const url = normaliseUrl(href, opts.base);
    if (url.startsWith('#')) return `${opts.pageUrl}${url}`;
    if (url.startsWith('/') && !url.startsWith('//')) return `${opts.origin}${url}`;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:' ? parsed.href : null;
    } catch {
      return null;
    }
  };

  const rich = (tokens: readonly Token[] | undefined) => {
    const r = new RichText(absolute);
    r.add(tokens);
    return r.result();
  };

  const image = (token: Tokens.Image): Record<string, unknown> => {
    const src = normaliseUrl(token.href, opts.base);
    const blob = localBlob(src, opts.publicDir);
    blobs.set(blob.ref.ref.$link, blob);
    return {
      $type: `${B}image`,
      image: blob.ref,
      alt: decodeEntities(token.text),
      aspectRatio: { width: blob.width ?? 1, height: blob.height ?? 1 },
    };
  };

  const listItemContent = (item: Tokens.ListItem): Record<string, unknown> => {
    const first = item.tokens.find((t) => t.type === 'text' || t.type === 'paragraph') as Tokens.Text | Tokens.Paragraph | undefined;
    const r = rich(first?.tokens ?? (first ? [{ type: 'text', raw: first.text, text: first.text } as Tokens.Text] : []));
    if (r.plaintext) textParts.push(r.plaintext);
    return withFacets({ $type: `${B}text` }, r);
  };

  const list = (token: Tokens.List): Record<string, unknown> => {
    const type = token.ordered ? 'orderedList' : 'unorderedList';
    const children = token.items.map((item) => {
      const out: Record<string, unknown> = { $type: `${B}${type}#listItem`, content: listItemContent(item) };
      if (item.task) out.checked = Boolean(item.checked);
      const nested = item.tokens.find((t) => t.type === 'list') as Tokens.List | undefined;
      if (nested) {
        const sub = list(nested);
        if (nested.ordered === token.ordered) out.children = sub.children;
        else out[nested.ordered ? 'orderedListChildren' : 'unorderedListChildren'] = sub;
      }
      return out;
    });
    const block: Record<string, unknown> = { $type: `${B}${type}`, children };
    if (token.ordered && typeof token.start === 'number' && token.start !== 1) block.startIndex = token.start;
    return block;
  };

  const blocks: Record<string, unknown>[] = [];
  const walk = (tokens: readonly Token[]): void => {
    for (const token of tokens) {
      switch (token.type) {
        case 'heading': {
          const h = token as Tokens.Heading;
          const r = rich(h.tokens);
          textParts.push(r.plaintext);
          blocks.push(withFacets({ $type: `${B}header`, level: h.depth }, r));
          break;
        }
        case 'paragraph': {
          const p = token as Tokens.Paragraph;
          const parts = p.tokens.filter((t) => !(t.type === 'text' && /^\s*$/.test(t.raw)) && t.type !== 'br');
          if (parts.length && parts.every((t) => t.type === 'image')) {
            for (const img of parts) blocks.push(image(img as Tokens.Image));
            break;
          }
          const r = rich(p.tokens);
          if (!r.plaintext) break;
          textParts.push(r.plaintext);
          blocks.push(withFacets({ $type: `${B}text` }, r));
          break;
        }
        case 'list':
          blocks.push(list(token as Tokens.List));
          break;
        case 'blockquote': {
          // One block; paragraphs inside are separated by a blank line.
          const r = new RichText(absolute);
          for (const t of (token as Tokens.Blockquote).tokens) {
            if (!('tokens' in t) || !Array.isArray(t.tokens)) continue;
            if (r.text) r.add([{ type: 'br', raw: '\n' } as Tokens.Br, { type: 'br', raw: '\n' } as Tokens.Br]);
            r.add(t.tokens as Token[]);
          }
          const out = r.result();
          if (!out.plaintext) break;
          textParts.push(out.plaintext);
          blocks.push(withFacets({ $type: `${B}blockquote` }, out));
          break;
        }
        case 'code': {
          const c = token as Tokens.Code;
          textParts.push(c.text);
          blocks.push({ $type: `${B}code`, plaintext: c.text, ...(c.lang ? { language: c.lang.split(/\s/)[0] } : {}) });
          break;
        }
        case 'hr':
          blocks.push({ $type: `${B}horizontalRule` });
          break;
        case 'html': {
          const text = (token as Tokens.HTML).text.trim();
          if (text) {
            textParts.push(text);
            blocks.push({ $type: `${B}text`, plaintext: text });
          }
          break;
        }
        case 'table': {
          // Leaflet has no table block: keep the rows readable as text.
          const t = token as Tokens.Table;
          const rows = [t.header.map((c) => c.text).join(' | '), ...t.rows.map((r) => r.map((c) => c.text).join(' | '))];
          const text = decodeEntities(rows.join('\n'));
          textParts.push(text);
          blocks.push({ $type: `${B}text`, plaintext: text });
          break;
        }
        default:
          break;
      }
    }
  };

  walk(new Marked({ gfm: true, breaks: false }).lexer(markdown));

  return {
    content: {
      $type: 'pub.leaflet.content',
      pages: [
        {
          $type: 'pub.leaflet.pages.linearDocument',
          blocks: blocks.map((block) => ({ $type: 'pub.leaflet.pages.linearDocument#block', block })),
        },
      ],
    },
    text: textParts.join('\n\n'),
    blobs: [...blobs.values()],
  };
}
