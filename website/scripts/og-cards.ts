/**
 * Fills scripts/og-cards.html with the copy each page shows right now, so the Open Graph
 * cards follow the site: the home hero and Poe's nudge, the /guides hero and every guide
 * it lists, the blog hero (whose name and tagline come from the publication record), the
 * garden's heading and description, and the home page's Poe tile, which also makes the
 * share card for chatting with Poe, and the about page's surface.
 *
 * Runs in the card page, which fetches the pages from the dev server it is served by.
 * readCards() takes any page loader, so tests run it on the same HTML the build serves.
 * A card that can't be read is reported, not drawn, and keeps its committed image.
 */

import { drawFlower, sampleVariant, seedVariant, type FlowerKind } from '../src/scripts/flowers.js';

export type CardKind = 'home' | 'guides' | 'guide' | 'blog' | 'garden' | 'poe' | 'about';

export interface CardData {
  /** The image's name in public/og or dist/og, without ".png". */
  name: string;
  kind: CardKind;
  title: string;
  lede: string;
  /** Section chip (guides, blog). */
  chip?: string;
  /** Author handle with its @ (guide, blog, poe, about). */
  handle?: string;
  /** Poe's speech bubble (home). */
  bubble?: string;
}

export type CardResult = { name: string; card: CardData } | { name: string; error: string };

/** What the card page reports to scripts/og-images.ts, on <html data-og-status>. */
export interface CardStatus {
  name: string;
  error?: string;
  /** False when the text still overflows its tile at the smallest sizes fitCard() tries. */
  fits?: boolean;
}

export type LoadPage = (path: string) => Promise<Document>;

function text(doc: Document, path: string, selector: string): string {
  const value = doc.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  if (!value) throw new Error(`${path} has nothing at ${selector}`);
  return value;
}

function meta(doc: Document, path: string, name: string): string {
  const value = doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim();
  if (!value) throw new Error(`${path} has no <meta name="${name}">`);
  return value;
}

function handleFrom(doc: Document, path: string, selector: string): string {
  const href = doc.querySelector(selector)?.getAttribute('href') ?? '';
  const handle = /^https:\/\/bsky\.app\/profile\/([^/?#]+)/.exec(href)?.[1];
  if (!handle) throw new Error(`${path} has no bluesky profile link at ${selector}`);
  return `@${decodeURIComponent(handle)}`;
}

async function attempt(name: string, read: () => Promise<CardData>): Promise<CardResult> {
  try {
    return { name, card: await read() };
  } catch (err) {
    return { name, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function readCards(load: LoadPage): Promise<CardResult[]> {
  const home = attempt('home', async () => {
    const doc = await load('/');
    const bubble = doc.body.dataset.poeNudge?.trim();
    return {
      name: 'home',
      kind: 'home',
      title: text(doc, '/', '#home-title'),
      lede: text(doc, '/', '.home-hero__lede'),
      ...(bubble ? { bubble } : {}),
    };
  });

  // /guides gives its own card and the list of guides, each with a card of its own.
  let guidesDoc: Document | null = null;
  let guidesError = '';
  try {
    guidesDoc = await load('/guides');
  } catch (err) {
    guidesError = err instanceof Error ? err.message : String(err);
  }
  const guides = attempt('guides', async () => {
    if (!guidesDoc) throw new Error(guidesError);
    return {
      name: 'guides',
      kind: 'guides',
      title: text(guidesDoc, '/guides', '.guides-hero__title'),
      lede: text(guidesDoc, '/guides', '.guides-hero__lede'),
      chip: text(guidesDoc, '/guides', '.guides-hero__chip'),
    };
  });
  const slugs = guidesDoc
    ? [...guidesDoc.querySelectorAll<HTMLAnchorElement>('a.guides-card[href^="/guides/"]')]
        .map((a) => a.getAttribute('href')!.slice('/guides/'.length))
        .filter((slug) => /^[a-z0-9-]+$/.test(slug))
    : [];
  const guidePages = slugs.map((slug) =>
    attempt(slug, async () => {
      const path = `/guides/${slug}`;
      const doc = await load(path);
      return {
        name: slug,
        kind: 'guide',
        title: text(doc, path, '.guide__title'),
        lede: text(doc, path, '.guide__subtitle'),
        handle: text(doc, path, '.guide__author a'),
      };
    }),
  );

  const blog = attempt('blog', async () => {
    const doc = await load('/blog');
    return {
      name: 'blog',
      kind: 'blog',
      title: text(doc, '/blog', '.blog-hero__title'),
      lede: text(doc, '/blog', '.blog-hero__lede'),
      chip: text(doc, '/blog', '.blog-hero__chip'),
      handle: handleFrom(doc, '/blog', '.blog-hero .blog-alt a[href^="https://bsky.app/profile/"]'),
    };
  });

  const garden = attempt('garden', async () => {
    const doc = await load('/garden');
    return {
      name: 'garden',
      kind: 'garden',
      title: text(doc, '/garden', '#garden-title'),
      lede: meta(doc, '/garden', 'description'),
    };
  });

  // Poe has no page of its own; its tile on the home page is the one place it says hi.
  const poe = attempt('poe', async () => {
    const doc = await load('/');
    return {
      name: 'poe',
      kind: 'poe',
      title: text(doc, '/', '#home-poe-title'),
      lede: text(doc, '/', '.home-poe__text.only-touch'),
      handle: handleFrom(doc, '/', 'a.home-poe__handle'),
    };
  });

  const about = attempt('about', async () => {
    const doc = await load('/about');
    return {
      name: 'about',
      kind: 'about',
      title: text(doc, '/about', '#about-title'),
      lede: meta(doc, '/about', 'description'),
      handle: handleFrom(doc, '/about', '.about-surface__words a[href^="https://bsky.app/profile/"]'),
    };
  });

  return Promise.all([home, guides, ...guidePages, blog, garden, poe, about]);
}

/** One <section data-og> per card, from the page's <template data-og-kind> for its kind. */
export function renderCards(root: HTMLElement, cards: readonly CardData[]): HTMLElement[] {
  return cards.map((card) => {
    const template = root.ownerDocument.querySelector<HTMLTemplateElement>(`template[data-og-kind="${card.kind}"]`);
    const section = template?.content.firstElementChild?.cloneNode(true);
    if (!(section instanceof HTMLElement)) throw new Error(`no <template data-og-kind="${card.kind}">`);
    section.dataset.og = card.name;
    for (const slot of section.querySelectorAll<HTMLElement>('[data-slot]')) {
      const value = card[slot.dataset.slot as keyof CardData];
      if (value) slot.textContent = value;
      else slot.remove();
    }
    root.append(section);
    return section;
  });
}

/**
 * The garden card's patch, row by row: a few of everything, the weather's own flowers
 * among them, a couple of sprouts and seeds still coming up, and empty plots.
 */
export const PATCH: readonly (readonly (FlowerKind | 'sprout' | 'seed' | null)[])[] = [
  ['sunflower', null, 'storm-lily', 'tulip'],
  ['sprout', 'prism-aster', 'cosmos', null],
  ['poppy', 'lotus', 'seed', 'hydrangea'],
  [null, 'daisy', 'strawberry', 'sprout'],
  ['violet', 'marigold', 'sprout', null],
];

/** Fills each [data-og-patch] with PATCH's plots, drawn the way the garden draws them. */
export function plantPatches(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const patch of root.querySelectorAll<HTMLElement>('[data-og-patch]')) {
    PATCH.forEach((row, y) =>
      row.forEach((plant, x) => {
        const plot = doc.createElement('span');
        plot.className = 'og-plot';
        if (plant === 'sprout' || plant === 'seed') {
          plot.append(drawFlower(doc, 'daisy', plant === 'sprout' ? 'sprout' : 'bud', seedVariant(x * 7 + y)));
        } else if (plant) {
          plot.append(drawFlower(doc, plant, 'bloom', sampleVariant(plant)));
        } else {
          plot.classList.add('og-plot--empty');
        }
        patch.append(plot);
      }),
    );
  }
}

const MIN_TITLE_PX = 44;
const MIN_LEDE_PX = 21;

/** Shrinks a card's title, then its lede, until the text fits its tile. True if it does. */
export function fitCard(card: HTMLElement): boolean {
  const tile = card.querySelector<HTMLElement>('.og-text');
  const body = card.querySelector<HTMLElement>('.og-body');
  const title = card.querySelector<HTMLElement>('.og-title');
  const lede = card.querySelector<HTMLElement>('.og-lede');
  if (!tile || !body || !title) return false;
  const view = card.ownerDocument.defaultView!;
  // The text block against the tile's padding edge, not scrollHeight: the guide card's
  // potato hangs off the bottom of the same tile on purpose.
  const floor = () => tile.getBoundingClientRect().bottom - parseFloat(view.getComputedStyle(tile).paddingBottom);
  const overflows = () => body.getBoundingClientRect().bottom > floor() + 1 || title.scrollWidth > title.clientWidth + 1;
  const shrink = (el: HTMLElement, min: number, step: number) => {
    let size = parseFloat(view.getComputedStyle(el).fontSize);
    while (overflows() && size - step >= min) {
      size -= step;
      el.style.fontSize = `${size}px`;
    }
  };
  shrink(title, MIN_TITLE_PX, 2);
  if (lede) shrink(lede, MIN_LEDE_PX, 1);
  return !overflows();
}

/** Narrows a wrapped box to its widest line (a balanced bubble otherwise keeps its max-width). */
export function shrinkWrap(el: HTMLElement): void {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const widest = Math.max(0, ...[...range.getClientRects()].map((r) => r.width));
  const style = el.ownerDocument.defaultView!.getComputedStyle(el);
  if (widest) el.style.width = `${Math.ceil(widest + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight))}px`;
}

async function loadFromServer(path: string): Promise<Document> {
  const res = await fetch(path, { headers: { accept: 'text/html' } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), 'text/html');
}

async function imagesLoaded(root: HTMLElement): Promise<void> {
  await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)));
}

/** The card page's entry point: draw every card, fit it, and report on <html>. */
export async function main(doc: Document = document): Promise<void> {
  const root = doc.querySelector<HTMLElement>('[data-og-root]');
  if (!root) return;
  const results = await readCards(loadFromServer);
  const status: CardStatus[] = [];
  for (const result of results) {
    if ('error' in result) status.push({ name: result.name, error: result.error });
  }
  const drawn = results.flatMap((r) => ('card' in r ? [r.card] : []));
  const sections = renderCards(root, drawn);
  plantPatches(root);
  await doc.fonts.ready;
  await imagesLoaded(root);
  root.querySelectorAll<HTMLElement>('.og-bubble').forEach(shrinkWrap);
  sections.forEach((section, i) => status.push({ name: drawn[i]!.name, fits: fitCard(section) }));
  doc.documentElement.dataset.ogStatus = JSON.stringify(status);
}

if (typeof document !== 'undefined' && document.querySelector('[data-og-root]')) {
  void main().catch((err: unknown) => {
    document.documentElement.dataset.ogStatus = JSON.stringify([{ name: '*', error: String(err) }]);
  });
}
