// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../build/guide-markdown.js';
import { GUIDES, SITE_ORIGIN } from '../build/guides.js';
import { guidesList } from '../build/guides-site.js';
import { PATCH, plantPatches, readCards, renderCards, type CardData, type CardResult, type LoadPage } from '../scripts/og-cards.js';
import { BLOG_COPY } from '../server/blog/config.js';
import { indexPage, siteInfo, unavailablePage } from '../server/blog/pages.js';

// The cards read the pages the dev server serves; these are the same pages, from the
// same sources and renderers, so a renamed hero class fails here and not on Vercel.
// jsdom's URL resolves relative to an http origin, so go through the path instead.
const root = `${resolve(dirname(fileURLToPath(import.meta.url)), '..')}/`;
const read = (file: string) => readFileSync(`${root}${file}`, 'utf8');
const blogIndex = indexPage(siteInfo(null, `${SITE_ORIGIN}/blog`, null), [], new Map()).main;

const PAGES: Record<string, () => string> = {
  '/': () => read('index.html'),
  '/guides': () => read('guides/index.html').replace('<!-- @guides-list -->', guidesList(root)),
  ...Object.fromEntries(GUIDES.documents.map((g) => [`/guides/${g.slug}`, () => read(g.html)])),
  '/blog': () => `<body>${blogIndex}</body>`,
  '/garden': () => read('garden/index.html'),
  '/about': () => read('about/index.html'),
};

function loader(pages: Record<string, () => string> = PAGES): LoadPage {
  return async (path) => {
    const page = pages[path];
    if (!page) throw new Error(`${path} answered 404`);
    return new DOMParser().parseFromString(page(), 'text/html');
  };
}

function cardsOf(results: CardResult[]): Record<string, CardData> {
  return Object.fromEntries(results.flatMap((r) => ('card' in r ? [[r.name, r.card]] : [])));
}

describe('og cards: readCards', () => {
  it('reads every card from the copy its page shows', async () => {
    const results = await readCards(loader());
    expect(results.map((r) => r.name)).toEqual(['home', 'guides', ...GUIDES.documents.map((g) => g.slug), 'blog', 'garden', 'poe', 'about']);
    expect(results.filter((r) => 'error' in r)).toEqual([]);
    const cards = cardsOf(results);

    const home = new DOMParser().parseFromString(read('index.html'), 'text/html');
    expect(cards.home).toMatchObject({
      kind: 'home',
      title: home.querySelector('#home-title')!.textContent,
      lede: home.querySelector('.home-hero__lede')!.textContent,
      bubble: home.body.dataset.poeNudge,
    });

    expect(cards.guides).toMatchObject({ kind: 'guides', chip: 'guides', title: 'atpotato guides' });
    for (const guide of GUIDES.documents) {
      const author = guide.contributors.find((c) => c.role === 'author')!;
      expect(cards[guide.slug], guide.slug).toEqual({
        name: guide.slug,
        kind: 'guide',
        title: guide.title,
        lede: guide.subtitle,
        handle: `@${author.handle}`,
      });
    }

    expect(cards.blog).toEqual({
      name: 'blog',
      kind: 'blog',
      chip: 'newsletter',
      title: BLOG_COPY.name,
      lede: BLOG_COPY.tagline,
      handle: '@poe.atpota.to',
    });

    const garden = new DOMParser().parseFromString(read('garden/index.html'), 'text/html');
    expect(cards.garden).toEqual({
      name: 'garden',
      kind: 'garden',
      title: garden.querySelector('#garden-title')!.textContent,
      lede: garden.querySelector('meta[name="description"]')!.getAttribute('content'),
    });

    expect(cards.poe).toEqual({
      name: 'poe',
      kind: 'poe',
      title: home.querySelector('#home-poe-title')!.textContent,
      lede: home.querySelector('.home-poe__text.only-touch')!.textContent!.replace(/\s+/g, ' ').trim(),
      handle: '@poe.atpota.to',
    });

    const about = new DOMParser().parseFromString(read('about/index.html'), 'text/html');
    expect(cards.about).toEqual({
      name: 'about',
      kind: 'about',
      title: about.querySelector('#about-title')!.textContent,
      lede: about.querySelector('meta[name="description"]')!.getAttribute('content'),
      handle: '@dame.is',
    });
  });

  it('a page that fails costs only its own card', async () => {
    const down = await readCards(loader({ ...PAGES, '/blog': () => `<body>${unavailablePage(new Map()).main}</body>` }));
    expect(down.find((r) => r.name === 'blog')).toEqual({ name: 'blog', error: '/blog has nothing at .blog-hero__title' });
    expect(Object.keys(cardsOf(down))).toEqual(['home', 'guides', ...GUIDES.documents.map((g) => g.slug), 'garden', 'poe', 'about']);

    const { '/guides': _gone, ...noGuides } = PAGES;
    const missing = await readCards(loader(noGuides));
    expect(missing.map((r) => r.name)).toEqual(['home', 'guides', 'blog', 'garden', 'poe', 'about']);
    expect(missing[1]).toEqual({ name: 'guides', error: '/guides answered 404' });
  });

  it('has a committed 1200x630 copy of every card, for builds that cannot render', async () => {
    for (const { name } of await readCards(loader())) {
      expect(imageSize(`${root}public/og/${name}.png`), name).toEqual({ width: 1200, height: 630 });
    }
  });
});

describe('og cards: renderCards', () => {
  const page = () => new DOMParser().parseFromString(read('scripts/og-cards.html'), 'text/html');

  it('fills each kind of card from its template', async () => {
    const doc = page();
    const target = doc.querySelector<HTMLElement>('[data-og-root]')!;
    const cards = Object.values(cardsOf(await readCards(loader())));
    const sections = renderCards(target, cards);

    expect(sections.map((s) => s.dataset.og)).toEqual(cards.map((c) => c.name));
    for (const [i, card] of cards.entries()) {
      expect(sections[i]!.querySelector('.og-title')!.textContent).toBe(card.title);
      expect(sections[i]!.querySelector('.og-lede')!.textContent).toBe(card.lede);
    }
    const guides = target.querySelector('[data-og="guides"] .chip')!;
    expect(guides.textContent).toBe('guides');
    expect(guides.querySelector('img')).not.toBeNull();
    expect(target.querySelector('[data-og="blog"] .og-pill')!.textContent).toBe('by @poe.atpota.to');
    expect(target.querySelector('[data-og="poe"] .og-pill')!.textContent).toBe('on bluesky too: @poe.atpota.to');
  });

  it('plants the garden card with a flower, sprout or empty plot for every spot in PATCH', () => {
    const doc = page();
    const target = doc.querySelector<HTMLElement>('[data-og-root]')!;
    renderCards(target, [{ name: 'garden', kind: 'garden', title: 't', lede: 'l' }]);
    plantPatches(target);
    const plots = [...target.querySelectorAll('[data-og-patch] .og-plot')];
    const spots = PATCH.flat();
    expect(plots).toHaveLength(spots.length);
    spots.forEach((plant, i) => {
      expect(plots[i]!.querySelector('svg.home-flower') !== null, String(i)).toBe(plant !== null);
      expect(plots[i]!.classList.contains('og-plot--empty'), String(i)).toBe(plant === null);
    });
  });

  it('drops a slot the card has no value for', () => {
    const doc = page();
    const [home] = renderCards(doc.querySelector<HTMLElement>('[data-og-root]')!, [{ name: 'home', kind: 'home', title: 't', lede: 'l' }]);
    expect(home!.querySelector('.og-bubble')).toBeNull();
  });
});
