import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { Marked, type Tokens } from 'marked';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Build-time guide rendering (spec section 1, "guide markdown").
 *
 * For each configured page shell, replaces:
 *   <!-- @guide-content -->  with the rendered markdown article
 *   <!-- @guide-toc -->      with <ol class="toc-list"> of the h2 links (every occurrence)
 *   <!-- @reading-time -->   with "N min read" (200 wpm over the article text; every occurrence)
 *   <!-- @chapter-count -->  with "N chapters" (the h2 sections; every occurrence)
 *
 * Renderer rules:
 *   - h2 ids are section-1 .. section-N in document order (kept for old deep links)
 *   - h1, h3, h4, h5, h6 get unique slug ids (never colliding with section-N)
 *   - images get loading="lazy" decoding="async" and width/height read from the file in public/
 *   - relative "screenshots/x.png" (or "./screenshots/x.png") becomes "/guides/screenshots/x.png"
 *   - links keep opening in the same tab; only http(s), mailto, root-relative and #hash hrefs
 *     become links, anything else renders as plain text
 *   - raw HTML in the markdown is escaped, never passed through
 *   - image-only, bold-only and code-only paragraphs get a class (see paragraphKind)
 */

export interface GuidePage {
  /** Page shell path relative to the Vite root, e.g. "guides/bluesky-for-brands.html". */
  html: string;
  /** Markdown source path relative to the Vite root. */
  markdown: string;
  /** Base URL path that relative image/link URLs resolve against, e.g. "/guides/". */
  base: string;
}

export interface GuideMarkdownOptions {
  root: string;
  publicDir: string;
  pages: GuidePage[];
}

export interface TocEntry {
  id: string;
  text: string;
}

export interface RenderedGuide {
  html: string;
  toc: TocEntry[];
  tocHtml: string;
  words: number;
  minutes: number;
  readingTime: string;
}

export interface RenderOptions {
  /** Directory that root-relative image URLs map to (Vite's public dir). */
  publicDir?: string;
  /** Base URL path for relative URLs. Default "/guides/". */
  base?: string;
  wordsPerMinute?: number;
}

const CONTENT_MARKER = /<!--\s*@guide-content\s*-->/g;
const TOC_MARKER = /<!--\s*@guide-toc\s*-->/g;
const READING_MARKER = /<!--\s*@reading-time\s*-->/g;
const CHAPTER_MARKER = /<!--\s*@chapter-count\s*-->/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Visible text of an HTML fragment (tags removed, entities decoded, whitespace collapsed). */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** Width/height of a PNG, JPEG, GIF or WebP file, or undefined. Reads at most 256 KB. */
export function imageSize(file: string): { width: number; height: number } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const len = readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, len);
    // PNG: IHDR width/height at 16..24
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // GIF
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    // WebP (VP8X / VP8 / VP8L)
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG: walk segments to the first SOFn marker
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1]!;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const size = b.readUInt16BE(i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + size;
      }
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** Normalise an image/link URL from the markdown. Relative paths resolve against `base`. */
export function normaliseUrl(href: string, base: string): string {
  const trimmed = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('/') || trimmed.startsWith('#')) {
    return trimmed;
  }
  const rel = trimmed.replace(/^\.\//, '');
  return `${base.endsWith('/') ? base : `${base}/`}${rel}`;
}

function isSafeLink(href: string): boolean {
  if (href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'))) return true;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function insideDir(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

/**
 * Paragraph classes for the guide's styling hooks (CSS cannot tell these apart):
 *   guide-media  a paragraph holding only images (each screenshot sits in its own paragraph)
 *   guide-step   a paragraph that is one bold run, e.g. "**1. Create your account.**"
 *   guide-codes  a paragraph of inline code spans only, e.g. the stacked PDS hostnames
 */
export function paragraphKind(tokens: readonly Tokens.Generic[]): string | undefined {
  const parts = tokens.filter((t) => !(t.type === 'text' && /^\s*$/.test(t.raw)) && t.type !== 'br');
  if (parts.length === 0) return undefined;
  if (parts.every((t) => t.type === 'image')) return 'guide-media';
  if (parts.length === 1 && parts[0]!.type === 'strong') return 'guide-step';
  if (parts.length > 1 && parts.every((t) => t.type === 'codespan')) return 'guide-codes';
  return undefined;
}

export function renderGuide(markdown: string, options: RenderOptions = {}): RenderedGuide {
  const base = options.base ?? '/guides/';
  const wpm = options.wordsPerMinute ?? 200;
  const toc: TocEntry[] = [];
  const usedIds = new Set<string>();
  let h2Count = 0;

  const uniqueSlug = (text: string): string => {
    const slug = slugify(text);
    let id = slug;
    for (let n = 2; usedIds.has(id) || /^section-\d+$/.test(id); n++) id = `${slug}-${n}`;
    usedIds.add(id);
    return id;
  };

  const marked = new Marked({
    gfm: true,
    breaks: false,
    async: false,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading): string {
        const inner = this.parser.parseInline(tokens);
        const text = htmlToText(inner);
        let id: string;
        if (depth === 2) {
          h2Count += 1;
          id = `section-${h2Count}`;
          usedIds.add(id);
          toc.push({ id, text });
        } else {
          id = uniqueSlug(text);
        }
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      image({ href, title, text }: Tokens.Image): string {
        const src = normaliseUrl(href, base);
        if (!isSafeLink(src)) return escapeHtml(text);
        let dims = '';
        if (options.publicDir && src.startsWith('/') && !src.startsWith('//')) {
          let path = src.split(/[?#]/)[0] ?? src;
          try {
            path = decodeURI(path);
          } catch {
            // keep the raw path
          }
          const file = resolve(options.publicDir, `.${path}`);
          const size = insideDir(options.publicDir, file) ? imageSize(file) : undefined;
          if (size) dims = ` width="${size.width}" height="${size.height}"`;
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${dims} loading="lazy" decoding="async"${titleAttr}>`;
      },
      paragraph({ tokens }: Tokens.Paragraph): string {
        const inner = this.parser.parseInline(tokens);
        const kind = paragraphKind(tokens);
        return kind ? `<p class="${kind}">${inner}</p>\n` : `<p>${inner}</p>\n`;
      },
      link({ href, title, tokens }: Tokens.Link): string {
        const inner = this.parser.parseInline(tokens);
        const url = normaliseUrl(href, base);
        if (!isSafeLink(url)) return inner;
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(url)}"${titleAttr}>${inner}</a>`;
      },
      html(token: Tokens.HTML | Tokens.Tag): string {
        // No raw HTML passthrough: show it as text.
        const escaped = escapeHtml(token.text);
        return 'block' in token && token.block ? `<p>${escaped.trim()}</p>\n` : escaped;
      },
    },
  });

  const html = marked.parse(markdown, { async: false });
  const words = htmlToText(html).split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / wpm));
  const tocHtml =
    `<ol class="toc-list">` +
    toc.map((e) => `<li class="toc-item"><a class="toc-link" href="#${e.id}">${escapeHtml(e.text)}</a></li>`).join('') +
    `</ol>`;
  return { html, toc, tocHtml, words, minutes, readingTime: `${minutes} min read` };
}

export function applyGuide(shell: string, guide: RenderedGuide): string {
  return shell
    .replace(CONTENT_MARKER, () => guide.html)
    .replace(TOC_MARKER, () => guide.tocHtml)
    .replace(READING_MARKER, () => guide.readingTime)
    .replace(CHAPTER_MARKER, () => `${guide.toc.length} chapters`);
}

export function guideMarkdown(opts: GuideMarkdownOptions): Plugin {
  const pages = opts.pages.map((p) => ({
    ...p,
    htmlFile: resolve(opts.root, p.html),
    mdFile: resolve(opts.root, p.markdown),
  }));
  return {
    name: 'atpotato:guide-markdown',
    configureServer(server: ViteDevServer) {
      const files = pages.map((p) => p.mdFile);
      server.watcher.add(files);
      server.watcher.on('change', (file) => {
        if (files.includes(resolve(file))) server.ws.send({ type: 'full-reload', path: '*' });
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const page = pages.find((p) => resolve(ctx.filename) === p.htmlFile);
        if (!page) return html;
        if (!/<!--\s*@guide-content\s*-->/.test(html)) {
          throw new Error(`[guide-markdown] ${page.html} has no <!-- @guide-content --> marker`);
        }
        const markdown = readFileSync(page.mdFile, 'utf8');
        return applyGuide(html, renderGuide(markdown, { publicDir: opts.publicDir, base: page.base }));
      },
    },
  };
}
