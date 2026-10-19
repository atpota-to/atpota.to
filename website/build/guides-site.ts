import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { escapeHtml, renderGuide } from './guide-markdown.js';
import { documentUri, GUIDES, publicationUri } from './guides.js';

/**
 * The guides publication on the site (build/guides.ts holds the records' addresses):
 *
 *   <!-- @standard-site -->  in a guide page or guides/index.html: the standard.site and
 *                            at:// head tags for that page's record
 *   <!-- @guides-list -->    in guides/index.html: one card per guide
 *   /.well-known/site.standard.publication/guides
 *                            the publication's at:// URI (standard.site verification),
 *                            emitted into the build and served by the dev/preview servers
 */

export const WELL_KNOWN_PATH = '/.well-known/site.standard.publication/guides';
const TAGS_MARKER = /<!--\s*@standard-site\s*-->/;
const LIST_MARKER = /<!--\s*@guides-list\s*-->/;

/** Head tags naming a page's record; `document` is absent on the publication's own page. */
export function standardSiteTags(record: { document?: string; publication: string }): string {
  const own = record.document ?? record.publication;
  const tags = [
    record.document ? `<link rel="site.standard.document" href="${escapeHtml(record.document)}">` : '',
    `<link rel="site.standard.publication" href="${escapeHtml(record.publication)}">`,
    `<link rel="alternate" type="application/at-record+json" href="${escapeHtml(own)}">`,
    `<meta name="atproto:uri" content="${escapeHtml(own)}">`,
  ];
  return tags.filter(Boolean).join('\n    ');
}

const ARROW =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const BOOK =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/></svg>';

/** The /guides cards, with reading time and chapter count from each guide's markdown. */
export function guidesList(root: string): string {
  const publicDir = resolve(root, 'public');
  return GUIDES.documents
    .map((guide) => {
      const rendered = renderGuide(readFileSync(resolve(root, guide.markdown), 'utf8'), { publicDir });
      const authors = guide.contributors.map((c) => `@${c.handle}`).join(', ');
      return (
        `<li><a class="tile tile--link guides-card" href="/guides/${escapeHtml(guide.slug)}">` +
        `<span class="guides-card__chip">${BOOK} guide</span>` +
        `<h2 class="guides-card__title">${escapeHtml(guide.title)}</h2>` +
        `<span class="guides-card__desc">${escapeHtml(guide.subtitle)}</span>` +
        `<span class="guides-card__meta">${rendered.readingTime} · ${rendered.toc.length} chapters · by ${escapeHtml(authors)}</span>` +
        `<span class="guides-card__cta">read the guide ${ARROW}</span>` +
        `<span class="paper-stack guides-card__stack" aria-hidden="true">` +
        `<span class="paper-stack__sheet paper-stack__sheet--back"></span>` +
        `<span class="paper-stack__sheet paper-stack__sheet--front"><span class="paper-stack__bar paper-stack__bar--title"></span><span class="paper-stack__bar"></span><span class="paper-stack__bar paper-stack__bar--86"></span><span class="paper-stack__shot"></span><span class="paper-stack__bar paper-stack__bar--92"></span></span>` +
        `</span>` +
        `<img class="guides-card__potato" src="/src/assets/mascot/potato-wow.svg" alt="" width="170" height="138" loading="lazy">` +
        `</a></li>`
      );
    })
    .join('');
}

function serveWellKnown(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
  const path = (req.url ?? '').split('?')[0];
  if (path !== WELL_KNOWN_PATH) return next();
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(publicationUri());
}

/** Vite's dev and preview servers only find guides/index.html at "/guides/"; Vercel serves it at "/guides". */
function devGuidesIndex(req: IncomingMessage, _res: ServerResponse, next: (err?: unknown) => void): void {
  const url = req.url ?? '';
  const at = url.indexOf('?');
  if ((at === -1 ? url : url.slice(0, at)) === '/guides') req.url = `/guides/${at === -1 ? '' : url.slice(at)}`;
  next();
}

export function guidesSite(opts: { root: string }): Plugin {
  const indexFile = resolve(opts.root, 'guides/index.html');
  const guideFiles = new Map(GUIDES.documents.map((g) => [resolve(opts.root, g.html), g]));
  return {
    name: 'atpotato:guides-site',
    configureServer(server) {
      server.middlewares.use(serveWellKnown);
      server.middlewares.use(devGuidesIndex);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveWellKnown);
      server.middlewares.use(devGuidesIndex);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = resolve(ctx.filename);
        const guide = guideFiles.get(file);
        if (guide) {
          if (!TAGS_MARKER.test(html)) throw new Error(`[guides-site] ${guide.html} has no <!-- @standard-site --> marker`);
          return html.replace(TAGS_MARKER, () => standardSiteTags({ document: documentUri(guide), publication: publicationUri() }));
        }
        if (file === indexFile) {
          return html
            .replace(TAGS_MARKER, () => standardSiteTags({ publication: publicationUri() }))
            .replace(LIST_MARKER, () => guidesList(opts.root));
        }
        return html;
      },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: WELL_KNOWN_PATH.slice(1), source: publicationUri() });
    },
  };
}

