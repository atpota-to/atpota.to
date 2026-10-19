/**
 * The blog's page shell: shells/blog.html, built by Vite like every other page (partials,
 * hashed CSS and scripts, the theme script). The function fetches it from its own
 * deployment and fills two marked regions:
 *
 *   <!-- @blog-head --> ... <!-- /@blog-head -->   title, meta and link tags
 *   <!-- @blog-main --> ... <!-- /@blog-main -->   the page inside <main>
 *
 * The shell also lists the images the pages use, so their built URLs can be read back:
 *   <div hidden data-blog-assets><img data-asset="potato-happy" src="..."></div>
 * That list is removed from the page that is sent.
 *
 * Fetching rather than reading from disk keeps the function independent of the build
 * output layout, and the shell always matches the deployment serving the request. On
 * protected preview deployments the visitor's cookie (Vercel Authentication) or the
 * automation bypass secret goes along, so the request for the shell is let through too.
 */

import { SHELL_PATHS } from './config.js';
import type { Fetch } from './atproto.js';
import type { Assets, Page } from './pages.js';

export const SHELL_TIMEOUT_MS = 5000;

const HEAD_START = '<!-- @blog-head -->';
const HEAD_END = '<!-- /@blog-head -->';
const MAIN_START = '<!-- @blog-main -->';
const MAIN_END = '<!-- /@blog-main -->';
const ASSETS_RE = /<div hidden data-blog-assets>([\s\S]*?)<\/div>\s*/;
const ASSET_RE = /<img\b[^>]*\bdata-asset="([a-z0-9-]+)"[^>]*\bsrc="([^"]+)"|<img\b[^>]*\bsrc="([^"]+)"[^>]*\bdata-asset="([a-z0-9-]+)"/g;

export interface Shell {
  html: string;
  assets: Assets;
}

export class ShellError extends Error {
  override name = 'ShellError';
}

/** Splits a fetched shell into the template and its asset URLs; throws if markers are missing. */
export function parseShell(html: string): Shell {
  for (const marker of [HEAD_START, HEAD_END, MAIN_START, MAIN_END]) {
    if (!html.includes(marker)) throw new ShellError(`shell is missing ${marker}`);
  }
  const assets = new Map<string, string>();
  const block = ASSETS_RE.exec(html);
  if (block) {
    for (const m of block[1]!.matchAll(ASSET_RE)) {
      const name = m[1] ?? m[4];
      const src = m[2] ?? m[3];
      if (name && src) assets.set(name, src.replace(/&amp;/g, '&'));
    }
  }
  return { html: block ? html.replace(ASSETS_RE, '') : html, assets };
}

function replaceBetween(html: string, start: string, end: string, content: string): string {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  if (a === -1 || b === -1) return html;
  // Plain string slicing: no String.replace, so "$" in a post can never act as a pattern.
  return `${html.slice(0, a)}${content}${html.slice(b + end.length)}`;
}

export function fillShell(shell: Shell, page: Page): string {
  return replaceBetween(replaceBetween(shell.html, HEAD_START, HEAD_END, page.head), MAIN_START, MAIN_END, page.main);
}

export interface ShellRequest {
  /** Origin of the incoming request (the deployment serving it). */
  origin: string;
  /** The incoming Cookie header, for protected preview deployments. */
  cookie: string | null;
  bypassSecret: string | null;
}

/**
 * Protection only applies to *.vercel.app deployment URLs (atpota.to is public), so the
 * bypass secret is only ever sent there. The cookie is the visitor's own, for this origin.
 */
export async function fetchShell(doFetch: Fetch, req: ShellRequest): Promise<Shell> {
  const headers: Record<string, string> = { accept: 'text/html' };
  if (req.cookie) headers.cookie = req.cookie;
  const host = new URL(req.origin).hostname;
  if (req.bypassSecret && host.endsWith('.vercel.app')) headers['x-vercel-protection-bypass'] = req.bypassSecret;
  let lastError: unknown = null;
  for (const path of SHELL_PATHS) {
    try {
      const res = await doFetch(new URL(path, req.origin), { headers, signal: AbortSignal.timeout(SHELL_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        lastError = new ShellError(`shell ${path} answered ${res.status}`);
        continue;
      }
      return parseShell(await res.text());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new ShellError('shell unavailable');
}

/** Last resort when the shell itself cannot be loaded: a bare, unstyled page. */
export function bareDocument(page: Page): string {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    ${page.head}\n</head>\n<body>\n<main id="main">${page.main}</main>\n</body>\n</html>\n`;
}
