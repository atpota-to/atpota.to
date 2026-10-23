import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { SITE, TOPICS, topicBySlug, topicPath, type Topic } from '../src/scripts/weather-topics.js';

/**
 * The weather report's pages (src/scripts/weather-topics.ts): /weather/<topic> is
 * weather/index.html with the topic's title, description, Open Graph tags and nudge, the
 * header's title and lede in its words, the pages' nav marking it, and
 * <html data-weather-topic="<slug>">, which weather.css shows only its tiles for.
 *
 *   build    weather/<slug>.html beside weather/index.html, from the built page (so its
 *            scripts and styles are the same hashed files); with cleanUrls, Vercel serves
 *            each at /weather/<slug>
 *   dev      /weather/<slug> is the source page, swapped the same way, then transformed
 *   preview  /weather/<slug> is dist/weather/<slug>.html
 *
 * A tag or a part of the page it can't find to swap is an error, so the page can't drift
 * into topic pages that unfurl as the whole report.
 */

export const PAGE = 'weather/index.html';
const TOPIC_PATH_RE = /^\/weather\/([a-z]+)\/?$/;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The topic for a path ("/weather/hosts"), or null. */
export function topicForPath(path: string): Topic | null {
  return topicBySlug(TOPIC_PATH_RE.exec(path)?.[1]);
}

/** The card for a topic, at the address its og:image names. */
export const cardUrl = (t: Topic) => `${SITE}/og/weather.png?card=${t.card}`;

/** weather/index.html, as the topic's page. */
export function withTopic(html: string, t: Topic): string {
  const url = `${SITE}${topicPath(t)}`;
  const tag = (text: string) => () => text;
  const inside = (text: string) => (_m: string, open: string, close: string) => `${open}${escapeHtml(text)}${close}`;
  // Functions as the replacements, so a "$" in the copy is only ever text.
  const swaps: Array<[string, RegExp, (...m: string[]) => string]> = [
    ['<html>', /<html lang="en">/, tag(`<html lang="en" data-weather-topic="${t.slug}">`)],
    ['<title>', /<title>[^<]*<\/title>/, tag(`<title>${escapeHtml(t.pageTitle)}</title>`)],
    ['title', /<meta name="title" content="[^"]*">/, tag(`<meta name="title" content="${escapeHtml(t.pageTitle)}">`)],
    ['description', /<meta name="description" content="[^"]*">/, tag(`<meta name="description" content="${escapeHtml(t.description)}">`)],
    ['canonical', /<link rel="canonical" href="[^"]*">/, tag(`<link rel="canonical" href="${url}">`)],
    ['og:url', /<meta property="og:url" content="[^"]*">/, tag(`<meta property="og:url" content="${url}">`)],
    ['og:title', /<meta property="og:title" content="[^"]*">/, tag(`<meta property="og:title" content="${escapeHtml(t.pageTitle)}">`)],
    ['og:description', /<meta property="og:description" content="[^"]*">/, tag(`<meta property="og:description" content="${escapeHtml(t.description)}">`)],
    ['og:image', /<meta property="og:image" content="[^"]*">/, tag(`<meta property="og:image" content="${escapeHtml(cardUrl(t))}">`)],
    ['og:image:alt', /<meta property="og:image:alt" content="[^"]*">/, tag(`<meta property="og:image:alt" content="${escapeHtml(t.alt)}">`)],
    ['nudge', /data-poe-nudge="[^"]*"/, tag(`data-poe-nudge="${escapeHtml(t.nudge)}"`)],
    ["the header's title", /(<h1 [^>]*data-topic-title[^>]*>)[^<]*(<\/h1>)/, inside(t.title)],
    ["the header's lede", /(<p [^>]*data-topic-lede[^>]*>)[^<]*(<\/p>)/, inside(t.lede)],
    // the pages' nav: the whole report is current in the page as written; here, the topic is
    ["the whole report's link", /(<a [^>]*data-topic-link="") aria-current="page"/, (_m, a) => a!],
    [`${t.slug}'s link`, new RegExp(`(<a [^>]*data-topic-link="${t.slug}")`), (_m, a) => `${a} aria-current="page"`],
  ];
  return swaps.reduce((out, [what, re, swap]) => {
    if (!re.test(out)) throw new Error(`[weather-topics] ${PAGE} has no ${what} to make ${t.slug}'s`);
    return out.replace(re, swap);
  }, html);
}

function devServe(root: string, transform: (url: string, html: string) => Promise<string>) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const url = req.url ?? '';
    const topic = topicForPath(url.split('?')[0]!);
    if (!topic || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    const html = withTopic(readFileSync(resolve(root, PAGE), 'utf8'), topic);
    transform(url, html).then(
      (out) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(req.method === 'HEAD' ? undefined : out);
      },
      (error: unknown) => next(error),
    );
  };
}

/** Vite's preview server finds weather/hosts.html only by that name; Vercel serves it at /weather/hosts. */
function previewServe(req: IncomingMessage, _res: ServerResponse, next: (err?: unknown) => void): void {
  const url = req.url ?? '';
  const at = url.indexOf('?');
  const topic = topicForPath(at === -1 ? url : url.slice(0, at));
  if (topic) req.url = `/weather/${topic.slug}.html${at === -1 ? '' : url.slice(at)}`;
  next();
}

export function weatherTopics(opts: { root: string }): Plugin {
  return {
    name: 'atpotato:weather-topics',
    configureServer(server) {
      server.middlewares.use(devServe(opts.root, (url, html) => server.transformIndexHtml(`/${PAGE}`, html, url)));
    },
    configurePreviewServer(server) {
      server.middlewares.use(previewServe);
    },
    generateBundle: {
      // after Vite has written the page itself into the bundle
      order: 'post',
      handler(_options, bundle) {
        const page = bundle[PAGE];
        if (!page || page.type !== 'asset') throw new Error(`[weather-topics] the build has no ${PAGE}`);
        const html = typeof page.source === 'string' ? page.source : new TextDecoder().decode(page.source);
        for (const t of TOPICS) this.emitFile({ type: 'asset', fileName: `weather/${t.slug}.html`, source: withTopic(html, t) });
      },
    },
  };
}
