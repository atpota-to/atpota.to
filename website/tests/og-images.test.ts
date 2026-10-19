import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../build/guide-markdown.js';
import { GUIDES, SITE_ORIGIN } from '../build/guides.js';
import { DEFAULT_OG_IMAGE } from '../server/blog/pages.js';

// The cards come from scripts/og-cards.html (npm run og); this catches a page pointing at
// one that was renamed, never rendered, or rendered at the wrong size.
const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = `${root}public`;
const PAGES = ['index.html', 'guides/index.html', ...GUIDES.documents.map((g) => g.html)];
const SIZE = { width: 1200, height: 630 };

/** The public/ file behind an absolute atpota.to URL. */
function publicFile(url: string): string {
  const { origin, pathname } = new URL(url);
  expect(origin).toBe(SITE_ORIGIN);
  return `${publicDir}${pathname}`;
}

describe('open graph images', () => {
  it.each(PAGES)('%s: og:image is a 1200x630 card in public/, with its size and alt text', (page) => {
    const html = readFileSync(`${root}${page}`, 'utf8');
    const og = (name: string) => html.match(new RegExp(`<meta property="og:${name}" content="([^"]*)">`))?.[1];
    expect(imageSize(publicFile(og('image') ?? ''))).toEqual(SIZE);
    expect([og('image:width'), og('image:height')]).toEqual(['1200', '630']);
    expect(og('image:alt')).toBeTruthy();
  });

  it("the blog's default card and each guide's standard.site cover", () => {
    expect(imageSize(publicFile(DEFAULT_OG_IMAGE))).toEqual(SIZE);
    for (const guide of GUIDES.documents) expect(imageSize(`${publicDir}${guide.cover}`), guide.slug).toEqual(SIZE);
  });
});
