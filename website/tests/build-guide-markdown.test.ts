import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyGuide, imageSize, normaliseUrl, renderGuide, slugify } from '../build/guide-markdown.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const markdown = readFileSync(new URL('../public/guides/how-to-use-bluesky-to-grow-your-brand.md', import.meta.url), 'utf8');

// Dimensions from the site inventory (understand-site.md, image assets table).
const EXPECTED_SIZES: Record<string, [number, number]> = {
  'change-handle.png': [1274, 1222],
  'jack-tweet.png': [1190, 548],
  'fungi-friends-feed.png': [1100, 528],
  'blacksky-moderation-labeler.png': [1094, 792],
  'taylor-swift-eras-labeler.png': [1196, 830],
  'paul-verification.png': [2160, 1200],
  'starter-pack.png': [1194, 1056],
  'feed-preferences.png': [1196, 768],
  'bikesky-labeler.png': [1194, 808],
  'graze-editor.jpg': [1548, 1538],
  'boston-starter-pack.png': [1196, 1120],
  'post-interaction-settings.png': [1110, 988],
};

describe('renderGuide on the real guide', () => {
  const guide = renderGuide(markdown, { publicDir, base: '/guides/' });

  it('numbers the seven h2s section-1..7 in order', () => {
    const ids = [...guide.html.matchAll(/<h2 id="([^"]+)">/g)].map((m) => m[1]);
    expect(ids).toEqual(['section-1', 'section-2', 'section-3', 'section-4', 'section-5', 'section-6', 'section-7']);
    expect(guide.toc.map((t) => t.text)).toEqual([
      'Introduction',
      'Quick Start Guide',
      'Understanding Bluesky',
      'Achieving Growth and Engagement',
      'Analyzing and Measuring success',
      'Risk Mitigation',
      'Next Steps',
    ]);
  });

  it('gives every h3-h5 a unique slug id', () => {
    const ids = [...guide.html.matchAll(/<h[3-5] id="([^"]+)">/g)].map((m) => m[1]!);
    expect(ids.length).toBe(18 + 40 + 6);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(ids).toContain('1-custom-feeds-algorithms');
  });

  it('renders the 12 screenshots lazily, with absolute paths and real dimensions', () => {
    const imgs = [...guide.html.matchAll(/<img ([^>]*)>/g)].map((m) => m[1]!);
    expect(imgs).toHaveLength(12);
    for (const attrs of imgs) {
      const src = /src="([^"]+)"/.exec(attrs)![1]!;
      expect(src).toMatch(/^\/guides\/screenshots\/[a-z0-9-]+\.(png|jpg)$/);
      expect(attrs).toContain('loading="lazy"');
      expect(attrs).toContain('decoding="async"');
      expect(attrs).toMatch(/alt="[^"]+"/);
      const name = src.split('/').pop()!;
      const [w, h] = EXPECTED_SIZES[name]!;
      expect(attrs).toContain(`width="${w}" height="${h}"`);
    }
  });

  it('keeps links in the same tab', () => {
    const links = [...guide.html.matchAll(/<a ([^>]*)>/g)].map((m) => m[1]!);
    expect(links.length).toBe(46);
    for (const attrs of links) {
      expect(attrs).not.toContain('target=');
      expect(attrs).toMatch(/^href="https:\/\//);
    }
  });

  it('computes reading time at 200 wpm and builds the toc list', () => {
    expect(guide.words).toBeGreaterThan(7000);
    expect(guide.minutes).toBe(Math.ceil(guide.words / 200));
    expect(guide.readingTime).toBe(`${guide.minutes} min read`);
    expect(guide.tocHtml.startsWith('<ol class="toc-list">')).toBe(true);
    expect(guide.tocHtml.match(/<li class="toc-item"><a class="toc-link" href="#section-\d">/g)).toHaveLength(7);
  });
});

describe('renderGuide safety and normalisation', () => {
  it('escapes raw HTML instead of passing it through', () => {
    const { html } = renderGuide('hi <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n<div onclick="x">block</div>\n');
    expect(html).not.toMatch(/<script|<div|<img/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<p>&lt;div onclick=&quot;x&quot;&gt;block&lt;/div&gt;</p>');
  });

  it('drops unsafe link and image protocols', () => {
    const { html } = renderGuide('[a](javascript:alert(1)) [b](data:text/html,x) ![c](javascript:x) [d](mailto:hi@example.com)');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:');
    expect(html).toContain('<a href="mailto:hi@example.com">d</a>');
    expect(html).toContain('a b c');
  });

  it('normalises relative screenshot paths', () => {
    expect(normaliseUrl('screenshots/x.png', '/guides/')).toBe('/guides/screenshots/x.png');
    expect(normaliseUrl('./screenshots/x.png', '/guides/')).toBe('/guides/screenshots/x.png');
    expect(normaliseUrl('/guides/screenshots/x.png', '/guides/')).toBe('/guides/screenshots/x.png');
    expect(normaliseUrl('https://example.com/a.png', '/guides/')).toBe('https://example.com/a.png');
  });

  it('never reuses section-N ids for lower headings and de-duplicates slugs', () => {
    const { html } = renderGuide('## One\n\n### section-1\n\n### Same\n\n### Same\n\n#### Café & Co.\n');
    expect(html).toContain('<h2 id="section-1">One</h2>');
    expect(html).toContain('<h3 id="section-1-2">section-1</h3>');
    expect(html).toContain('<h3 id="same">Same</h3>');
    expect(html).toContain('<h3 id="same-2">Same</h3>');
    expect(html).toContain('<h4 id="cafe-and-co">Café &amp; Co.</h4>');
    expect(slugify('!!!')).toBe('section');
  });

  it('replaces every marker in a shell', () => {
    const guide = renderGuide('## A\n\nword '.repeat(3));
    const out = applyGuide('<!-- @reading-time --><!-- @guide-toc --><div><!-- @guide-content --></div><!-- @guide-toc --><!-- @reading-time -->', guide);
    expect(out).not.toContain('@guide');
    expect(out).not.toContain('@reading-time');
    expect(out.match(/1 min read/g)).toHaveLength(2);
    expect(out.match(/<ol class="toc-list">/g)).toHaveLength(2);
  });

  it('reads PNG and JPEG dimensions', () => {
    expect(imageSize(`${publicDir}/guides/screenshots/graze-editor.jpg`)).toEqual({ width: 1548, height: 1538 });
    expect(imageSize(`${publicDir}/favicon.png`)).toEqual({ width: 674, height: 674 });
    expect(imageSize(`${publicDir}/does-not-exist.png`)).toBeUndefined();
  });
});
