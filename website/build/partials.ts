import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * HTML partials for the page shells.
 *
 * Directives (HTML comments, replaced before Vite processes the HTML, so any
 * asset URLs inside a partial are resolved and hashed like page markup):
 *
 *   <!-- @partial header -->               -> src/partials/header.html
 *   <!-- @svg wordmark.svg class="x" -->   -> inline contents of src/assets/wordmark.svg,
 *                                             with the given attributes added to <svg>
 *                                             plus aria-hidden="true" focusable="false"
 *
 * Active navigation: links carrying data-nav="home|projects|guides|blog|about" get
 * aria-current="page" when they match the page. The page is read from
 * <body data-page="home|guide|blog|notfound">; <body data-nav-current="..."> overrides it.
 * This is the ONLY place aria-current is set for the main nav (nav.ts does not).
 */

export interface PartialsOptions {
  /** Directory holding <name>.html partials. */
  partialsDir: string;
  /** Directory that @svg paths are resolved against. */
  assetsDir: string;
}

const PARTIAL_RE = /<!--\s*@partial\s+([a-z0-9-]+)\s*-->/gi;
const SVG_RE = /<!--\s*@svg\s+([a-z0-9/_.-]+\.svg)((?:\s+[a-z-]+="[^"]*")*)\s*-->/gi;
const BODY_RE = /<body\b[^>]*>/i;

/** Which data-nav link is current for each body[data-page]. */
export const NAV_FOR_PAGE: Record<string, string> = {
  home: 'home',
  guide: 'guides',
  blog: 'blog',
};

function insideDir(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

function readAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return m?.[1];
}

export function inlineSvg(svgSource: string, attrs: string): string {
  const cleaned = svgSource
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const extra = `${attrs.trim() ? ` ${attrs.trim()}` : ''} aria-hidden="true" focusable="false"`;
  return cleaned.replace(/<svg\b/, `<svg${extra}`);
}

export function markCurrentNav(html: string): string {
  const body = BODY_RE.exec(html)?.[0];
  if (!body) return html;
  const current = readAttr(body, 'data-nav-current') ?? NAV_FOR_PAGE[readAttr(body, 'data-page') ?? ''];
  if (!current) return html;
  return html.replace(/<a\b[^>]*\sdata-nav="([a-z-]+)"[^>]*>/gi, (tag: string, nav: string) => {
    if (nav !== current || /\saria-current=/.test(tag)) return tag;
    return tag.replace(/<a\b/, '<a aria-current="page"');
  });
}

export function applyPartials(html: string, opts: PartialsOptions, onFile?: (file: string) => void): string {
  let out = html;
  // Partials may include other partials; cap the depth to avoid loops.
  for (let depth = 0; depth < 5 && PARTIAL_RE.test(out); depth++) {
    PARTIAL_RE.lastIndex = 0;
    out = out.replace(PARTIAL_RE, (_m, name: string) => {
      const file = resolve(opts.partialsDir, `${name}.html`);
      if (!insideDir(opts.partialsDir, file)) throw new Error(`[partials] bad partial name "${name}"`);
      onFile?.(file);
      try {
        return readFileSync(file, 'utf8').trim();
      } catch {
        throw new Error(`[partials] missing partial "${name}" (${file})`);
      }
    });
  }
  PARTIAL_RE.lastIndex = 0;
  out = out.replace(SVG_RE, (_m, path: string, attrs: string) => {
    const file = resolve(opts.assetsDir, path);
    if (!insideDir(opts.assetsDir, file)) throw new Error(`[partials] bad svg path "${path}"`);
    onFile?.(file);
    try {
      return inlineSvg(readFileSync(file, 'utf8'), attrs ?? '');
    } catch {
      throw new Error(`[partials] missing svg "${path}" (${file})`);
    }
  });
  return markCurrentNav(out);
}

export function partials(opts: PartialsOptions): Plugin {
  return {
    name: 'atpotato:partials',
    configureServer(s: ViteDevServer) {
      s.watcher.add([opts.partialsDir, opts.assetsDir]);
      const reload = (file: string) => {
        if (insideDir(opts.partialsDir, file) || (insideDir(opts.assetsDir, file) && file.endsWith('.svg'))) {
          s.ws.send({ type: 'full-reload', path: '*' });
        }
      };
      s.watcher.on('change', reload);
      s.watcher.on('add', reload);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return applyPartials(html, opts);
      },
    },
  };
}
