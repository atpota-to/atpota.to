/**
 * Page titles the proxy sends to Poe (SPEC 4.2). Derived server-side from the validated
 * path, never taken from the browser, so a visitor cannot put words in the page title.
 */

export const MAX_TITLE = 120;
export const FALLBACK_TITLE = 'atpota.to';

const TITLES: Readonly<Record<string, string>> = {
  '/': 'atpota.to home',
  '/guides/bluesky-for-brands': 'How to use Bluesky to grow your brand',
  '/blog': "poe's blog",
};

/** Any single post (the post's own title would come from a record, so it is not used). */
const BLOG_POST_TITLE = "a post on poe's blog";

/** "/index.html", "/guides/bluesky-for-brands.html" and trailing slashes map like their clean URLs. */
export function canonicalPath(path: string): string {
  let p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (p === '') p = '/';
  p = p.replace(/\.html$/, '');
  if (p === '/index' || p === '') p = '/';
  return p;
}

export function pageTitle(path: string): string {
  const key = canonicalPath(path);
  const title = Object.hasOwn(TITLES, key) ? TITLES[key]! : key.startsWith('/blog/') ? BLOG_POST_TITLE : FALLBACK_TITLE;
  return title.slice(0, MAX_TITLE);
}
