/**
 * Leaflet blocks (pub.leaflet.content -> pages -> blocks) rendered to static HTML.
 *
 * Supported: text, header, blockquote, image, imageGallery, unorderedList, orderedList
 * (nested, with checkboxes), code, math (as TeX source), horizontalRule, website, button,
 * bskyPost, standardSitePost, standardSitePublication, iframe (known video/audio hosts
 * only), page and embeddedCanvas (sub-pages, rendered after the main page), drawing,
 * postsList (this blog's own list) and signup (the email form and Bluesky subscribe button
 * from subscribe.ts on a post page; follow and feed links where forms don't belong).
 *
 * Left out on purpose: html blocks and iframe srcdoc (arbitrary markup on atpota.to, in
 * posts a language model writes), and the blocks that only work inside Leaflet's app
 * (poll, questions, reply, recommendedPubs, membersOnlyDelimiter, postHeader).
 */

import { blobCid, blobUrl } from './atproto.js';
import { aturiUrl, displayHost, escapeAttr, escapeHtml, httpUrl, safeColor, textWithBreaks } from './html.js';
import { FootnoteList, renderRichText } from './richtext.js';
import { altLinksHtml, blueskySubscribeHtml, emailFormHtml, feedLinkHtml, type EmailSignup } from './subscribe.js';

const T = 'pub.leaflet.blocks.';

export interface LinkCard {
  href: string;
  title: string;
  description: string | null;
  /** Small line above the title, e.g. the publication name. */
  kicker: string | null;
  imageUrl: string | null;
}

export interface BskyPost {
  uri: string;
  url: string;
  authorName: string;
  handle: string;
  avatar: string | null;
  text: string;
  facets: unknown;
  createdAt: string | null;
  images: { thumb: string; alt: string }[];
  external: { href: string; title: string } | null;
}

export interface Embeds {
  posts: Map<string, BskyPost>;
  /** standardSitePost and standardSitePublication targets, keyed by at:// URI. */
  cards: Map<string, LinkCard>;
}

export interface PostListItem {
  href: string;
  title: string;
  date: string;
}

export interface BlockContext {
  /** The document's repo, for blob URLs. */
  did: string;
  pds: string;
  embeds: Embeds;
  footnotes: FootnoteList;
  /** Added to a header block's level (Leaflet h1 -> h2: the post title is the page's h1). */
  headingShift: number;
  /** Sub-pages by id, and the ids a page/embeddedCanvas block pointed at. */
  pages: Map<string, LeafletPage>;
  linkedPages: string[];
  headingIds: Set<string>;
  /** Other posts, for postsList blocks. */
  otherPosts: PostListItem[];
  links: { profile: string; feed: string; feedUrl: string };
  /** The email form for signup blocks; null in the feed, or with BLOG_EMAIL_DISABLED. */
  signup?: EmailSignup | null;
}

export interface LeafletPage {
  id: string | null;
  kind: 'linear' | 'canvas';
  blocks: { block: Record<string, unknown>; alignment: string | null }[];
}

export const EMPTY_EMBEDS: Embeds = { posts: new Map(), cards: new Map() };

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function typeOf(block: Record<string, unknown>): string {
  return typeof block.$type === 'string' ? block.$type : '';
}

/** The pages of a pub.leaflet.content value; [] for any other content type. */
export function leafletPages(content: unknown): LeafletPage[] {
  const c = obj(content);
  if (!c || c.$type !== 'pub.leaflet.content' || !Array.isArray(c.pages)) return [];
  const pages: LeafletPage[] = [];
  for (const raw of c.pages.slice(0, 50)) {
    const page = obj(raw);
    if (!page || !Array.isArray(page.blocks)) continue;
    const canvas = page.$type === 'pub.leaflet.pages.canvas';
    const entries = page.blocks
      .slice(0, 2000)
      .map((entry) => obj(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null && obj(entry.block) !== null)
      .map((entry) => ({
        block: entry.block as Record<string, unknown>,
        alignment: typeof entry.alignment === 'string' ? entry.alignment : null,
        x: typeof entry.x === 'number' ? entry.x : 0,
        y: typeof entry.y === 'number' ? entry.y : 0,
      }));
    // A canvas places blocks freely; read it top to bottom, left to right.
    if (canvas) entries.sort((a, b) => a.y - b.y || a.x - b.x);
    pages.push({
      id: typeof page.id === 'string' ? page.id : null,
      kind: canvas ? 'canvas' : 'linear',
      blocks: entries.map(({ block, alignment }) => ({ block, alignment })),
    });
  }
  return pages;
}

/** Every block, including list item contents, for text extraction and embed lookups. */
export function* allBlocks(pages: readonly LeafletPage[]): Generator<Record<string, unknown>> {
  function* fromList(items: unknown): Generator<Record<string, unknown>> {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const item = obj(raw);
      if (!item) continue;
      const content = obj(item.content);
      if (content) yield content;
      yield* fromList(item.children);
      yield* fromList(obj(item.orderedListChildren)?.children);
      yield* fromList(obj(item.unorderedListChildren)?.children);
    }
  }
  for (const page of pages) {
    for (const { block } of page.blocks) {
      yield block;
      if (typeOf(block) === `${T}unorderedList` || typeOf(block) === `${T}orderedList`) yield* fromList(block.children);
    }
  }
}

/** Plain text of the document, one block per paragraph. */
export function pagesText(pages: readonly LeafletPage[]): string {
  const parts: string[] = [];
  for (const block of allBlocks(pages)) {
    if (typeof block.plaintext === 'string' && block.plaintext.trim() && typeOf(block) !== `${T}code`) parts.push(block.plaintext.trim());
  }
  return parts.join('\n\n');
}

/** at:// URIs the blocks embed: Bluesky posts, and standard.site documents/publications. */
export function embedTargets(pages: readonly LeafletPage[]): { posts: string[]; records: string[] } {
  const posts = new Set<string>();
  const records = new Set<string>();
  for (const block of allBlocks(pages)) {
    const type = typeOf(block);
    if (type === `${T}bskyPost`) {
      const uri = obj(block.postRef)?.uri;
      if (typeof uri === 'string' && /^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._:~-]+$/.test(uri)) posts.add(uri);
    } else if (type === `${T}standardSitePost` || type === `${T}standardSitePublication`) {
      if (typeof block.uri === 'string' && block.uri.startsWith('at://')) records.add(block.uri);
    }
  }
  return { posts: [...posts].slice(0, 50), records: [...records].slice(0, 20) };
}

/** CIDs of every image blob in the body (image blocks, galleries, list items). */
export function bodyImageCids(pages: readonly LeafletPage[]): Set<string> {
  const out = new Set<string>();
  for (const block of allBlocks(pages)) {
    const type = typeOf(block);
    if (type === `${T}image`) {
      const cid = blobCid(block.image);
      if (cid) out.add(cid);
    } else if (type === `${T}imageGallery` && Array.isArray(block.images)) {
      for (const img of block.images) {
        const cid = blobCid(obj(img)?.image);
        if (cid) out.add(cid);
      }
    }
  }
  return out;
}

/** The smallest header level used, so the shift can make it an h2. */
export function headingShiftFor(pages: readonly LeafletPage[]): number {
  let min = 6;
  for (const page of pages) {
    for (const { block } of page.blocks) {
      if (typeOf(block) !== `${T}header`) continue;
      const level = typeof block.level === 'number' ? Math.trunc(block.level) : 1;
      min = Math.min(min, Math.max(1, Math.min(6, level)));
    }
  }
  return 2 - min;
}

const ALIGN: Record<string, string> = {
  'pub.leaflet.pages.linearDocument#textAlignCenter': 'is-center',
  'pub.leaflet.pages.linearDocument#textAlignRight': 'is-right',
  'pub.leaflet.pages.linearDocument#textAlignJustify': 'is-justify',
  '#textAlignCenter': 'is-center',
  '#textAlignRight': 'is-right',
  '#textAlignJustify': 'is-justify',
};

function cls(...names: (string | null | undefined | false)[]): string {
  const list = names.filter(Boolean);
  return list.length ? ` class="${list.join(' ')}"` : '';
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'section'
  );
}

/** Ids the page already uses (header, footer, Poe, the post template), and their families. */
const RESERVED_IDS = new Set(['main', 'about', 'site-menu', 'blog-title', 'post-title', 'footnotes-label', 'subscribe']);
const RESERVED_PREFIX = /^(?:poe|fn|fnref|page|footer)-/;

function uniqueId(slugText: string, used: Set<string>): string {
  const base = RESERVED_IDS.has(slugText) || RESERVED_PREFIX.test(slugText) ? `s-${slugText}` : slugText;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function intAttr(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : null;
}

function imageHtml(block: Record<string, unknown>, ctx: BlockContext, extraClass?: string): string {
  const src = blobUrl(ctx.pds, ctx.did, block.image);
  if (!src) return '';
  const ratio = obj(block.aspectRatio);
  const w = intAttr(ratio?.width, 1, 100_000);
  const h = intAttr(ratio?.height, 1, 100_000);
  const size = w && h ? ` width="${w}" height="${h}"` : '';
  const alt = typeof block.alt === 'string' ? block.alt : '';
  const display = intAttr(block.width, 16, 4000);
  const style = display && !block.fullBleed ? ` style="max-width: ${display}px"` : '';
  return `<img${cls(extraClass)} src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${size}${style} loading="lazy" decoding="async">`;
}

function cardHtml(card: LinkCard, extraClass?: string): string {
  const image = card.imageUrl ? `<img class="post-card__image" src="${escapeAttr(card.imageUrl)}" alt="" loading="lazy" decoding="async">` : '';
  return (
    `<a${cls('post-card', extraClass)} href="${escapeAttr(card.href)}">` +
    `<span class="post-card__body">` +
    (card.kicker ? `<span class="post-card__kicker">${escapeHtml(card.kicker)}</span>` : '') +
    `<span class="post-card__title">${escapeHtml(card.title)}</span>` +
    (card.description ? `<span class="post-card__desc">${escapeHtml(card.description)}</span>` : '') +
    `<span class="post-card__host">${escapeHtml(displayHost(card.href))}</span>` +
    `</span>${image}</a>`
  );
}

/** Hosts whose players may be embedded as iframes; any other URL becomes a link card. */
const EMBED_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'open.spotify.com',
  'w.soundcloud.com',
  'bandcamp.com',
  'codepen.io',
  'www.loom.com',
]);

export function embeddableUrl(value: unknown): string | null {
  const href = httpUrl(value);
  if (!href) return null;
  const url = new URL(href);
  return url.protocol === 'https:' && EMBED_HOSTS.has(url.hostname) ? url.href : null;
}

function iframeHtml(block: Record<string, unknown>): string {
  const src = embeddableUrl(block.url);
  if (!src) {
    const href = httpUrl(block.url);
    return href ? cardHtml({ href, title: displayHost(href), description: null, kicker: 'embedded page', imageUrl: null }) : '';
  }
  const ratio = obj(block.aspectRatio);
  const w = intAttr(ratio?.width, 1, 10_000);
  const h = intAttr(ratio?.height, 1, 10_000);
  const height = intAttr(block.height, 16, 1600);
  const style = w && h ? `aspect-ratio: ${w} / ${h}` : height ? `height: ${height}px` : 'aspect-ratio: 16 / 9';
  return (
    `<div class="post-embed" style="${style}">` +
    `<iframe src="${escapeAttr(src)}" title="embedded from ${escapeAttr(displayHost(src))}" loading="lazy" ` +
    `sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" ` +
    `allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen ` +
    `referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
  );
}

function bskyHtml(block: Record<string, unknown>, ctx: BlockContext): string {
  const uri = obj(block.postRef)?.uri;
  if (typeof uri !== 'string') return '';
  const post = ctx.embeds.posts.get(uri);
  if (!post) {
    const href = aturiUrl(uri);
    return href ? cardHtml({ href, title: 'a post on bluesky', description: null, kicker: 'bluesky', imageUrl: null }) : '';
  }
  const avatar = post.avatar
    ? `<img class="post-bsky__avatar" src="${escapeAttr(post.avatar)}" alt="" width="40" height="40" loading="lazy" decoding="async">`
    : `<span class="post-bsky__avatar" aria-hidden="true"></span>`;
  const when = post.createdAt ? `<time datetime="${escapeAttr(post.createdAt)}">${escapeHtml(formatDate(post.createdAt))}</time>` : 'view post';
  const images = post.images.length
    ? `<div class="post-bsky__images" data-count="${Math.min(post.images.length, 4)}">${post.images
        .slice(0, 4)
        .map((img) => `<img src="${escapeAttr(img.thumb)}" alt="${escapeAttr(img.alt)}" loading="lazy" decoding="async">`)
        .join('')}</div>`
    : '';
  const external = post.external
    ? `<a class="post-bsky__external" href="${escapeAttr(post.external.href)}">${escapeHtml(post.external.title || displayHost(post.external.href))}<span>${escapeHtml(displayHost(post.external.href))}</span></a>`
    : '';
  return (
    `<figure class="post-bsky">` +
    `<figcaption class="post-bsky__head">${avatar}<span class="post-bsky__who"><strong>${escapeHtml(post.authorName)}</strong> <span>@${escapeHtml(post.handle)}</span></span></figcaption>` +
    `<blockquote class="post-bsky__text" cite="${escapeAttr(post.url)}">${renderRichText(post.text, post.facets)}</blockquote>` +
    images +
    external +
    `<a class="post-bsky__link" href="${escapeAttr(post.url)}">${when}<span class="visually-hidden"> on bluesky</span></a>` +
    `</figure>`
  );
}

function standardSiteHtml(block: Record<string, unknown>, ctx: BlockContext, kind: 'post' | 'publication'): string {
  if (typeof block.uri !== 'string') return '';
  const card = ctx.embeds.cards.get(block.uri);
  if (card) return cardHtml(card, block.size === 'small' ? 'is-small' : undefined);
  const href = aturiUrl(block.uri);
  if (!href) return '';
  return cardHtml({ href, title: kind === 'post' ? 'a post on the atmosphere' : 'a publication on the atmosphere', description: null, kicker: 'standard.site', imageUrl: null });
}

function drawingHtml(block: Record<string, unknown>): string {
  const box = obj(block.viewBox);
  const x = intAttr(box?.x, -1_000_000, 1_000_000) ?? 0;
  const y = intAttr(box?.y, -1_000_000, 1_000_000) ?? 0;
  const w = intAttr(box?.width, 1, 1_000_000);
  const h = intAttr(box?.height, 1, 1_000_000);
  if (!w || !h) return '';
  let budget = 50_000;
  const points = (raw: unknown): string | null => {
    if (!Array.isArray(raw) || raw.length < 4 || raw.length > budget) return null;
    if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    budget -= raw.length;
    const pairs: string[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) pairs.push(`${Math.round(raw[i] as number)},${Math.round(raw[i + 1] as number)}`);
    return pairs.join(' ');
  };
  let shapes = '';
  for (const fill of Array.isArray(block.fills) ? block.fills : []) {
    const f = obj(fill);
    const p = points(f?.points);
    if (p) shapes += `<polygon points="${p}" fill="${escapeAttr(safeColor(f?.color) ?? 'currentColor')}"/>`;
  }
  for (const stroke of Array.isArray(block.strokes) ? block.strokes : []) {
    const s = obj(stroke);
    const p = points(s?.points);
    const size = intAttr(s?.size, 1, 500) ?? 4;
    if (p) shapes += `<polyline points="${p}" fill="none" stroke="${escapeAttr(safeColor(s?.color) ?? 'currentColor')}" stroke-width="${size}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (!shapes) return '';
  return `<figure class="post-drawing"><svg viewBox="${x} ${y} ${w} ${h}" role="img" aria-label="a drawing">${shapes}</svg></figure>`;
}

function listHtml(block: Record<string, unknown>, ctx: BlockContext, ordered: boolean, depth = 0): string {
  if (!Array.isArray(block.children) || depth > 8) return '';
  const items = block.children
    .map((raw) => {
      const item = obj(raw);
      if (!item) return '';
      const content = obj(item.content);
      let body = '';
      if (content) {
        const type = typeOf(content);
        if (type === `${T}image`) body = imageHtml(content, ctx);
        else if (type === `${T}header`) body = `<strong class="post-li-heading">${renderRichText(content.plaintext, content.facets, { footnotes: ctx.footnotes })}</strong>`;
        else body = renderRichText(content.plaintext, content.facets, { footnotes: ctx.footnotes });
      }
      const check =
        typeof item.checked === 'boolean' ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> ` : '';
      let nested = '';
      if (Array.isArray(item.children) && item.children.length) nested = listHtml(item, ctx, ordered, depth + 1);
      else if (obj(item.orderedListChildren)) nested = listHtml(obj(item.orderedListChildren)!, ctx, true, depth + 1);
      else if (obj(item.unorderedListChildren)) nested = listHtml(obj(item.unorderedListChildren)!, ctx, false, depth + 1);
      return `<li${cls(check && 'is-check')}>${check}${body}${nested}</li>`;
    })
    .join('');
  const start = ordered ? intAttr(block.startIndex, 0, 1_000_000) : null;
  return ordered ? `<ol${start !== null && start !== 1 ? ` start="${start}"` : ''}>${items}</ol>` : `<ul>${items}</ul>`;
}

function pageLinkHtml(block: Record<string, unknown>, ctx: BlockContext): string {
  const id = typeof block.id === 'string' ? block.id : null;
  const page = id ? ctx.pages.get(id) : undefined;
  if (!id || !page) return '';
  if (!ctx.linkedPages.includes(id)) ctx.linkedPages.push(id);
  const first = page.blocks.map(({ block: b }) => (typeof b.plaintext === 'string' ? b.plaintext.trim() : '')).find(Boolean) ?? 'keep reading';
  return (
    `<a class="post-pagelink" href="#page-${escapeAttr(pageAnchor(id))}">` +
    `<span class="post-pagelink__label">keep reading</span>` +
    `<span class="post-pagelink__title">${escapeHtml(first.slice(0, 140))}</span></a>`
  );
}

export function pageAnchor(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'page';
}

function postsListHtml(block: Record<string, unknown>, ctx: BlockContext): string {
  const limit = intAttr(block.limit, 1, 50) ?? 5;
  const posts = ctx.otherPosts.slice(0, limit);
  if (!posts.length) return '';
  return `<ul class="post-related">${posts
    .map((p) => `<li><a href="${escapeAttr(p.href)}">${escapeHtml(p.title)}</a> <time datetime="${escapeAttr(p.date)}">${escapeHtml(formatDate(p.date))}</time></li>`)
    .join('')}</ul>`;
}

function signupHtml(ctx: BlockContext): string {
  if (ctx.signup) {
    return (
      `<aside class="post-signup">` +
      `<p class="post-signup__title">get the next issue</p>` +
      emailFormHtml(ctx.signup, uniqueId('signup', ctx.headingIds)) +
      altLinksHtml([blueskySubscribeHtml('blog-alt__link'), feedLinkHtml(ctx.links.feed, ctx.links.feedUrl)]) +
      `</aside>`
    );
  }
  return (
    `<aside class="post-signup">` +
    `<p class="post-signup__title">get the next issue</p>` +
    `<p class="post-signup__actions"><a class="btn btn--primary btn--sm" href="${escapeAttr(ctx.links.profile)}">follow on bluesky</a></p>` +
    altLinksHtml([feedLinkHtml(ctx.links.feed, ctx.links.feedUrl)], false) +
    `</aside>`
  );
}

/** One block to HTML ("" when it has nothing to show). */
export function renderBlock(block: Record<string, unknown>, alignment: string | null, ctx: BlockContext): string {
  const align = alignment ? ALIGN[alignment] : undefined;
  const rich = () => renderRichText(block.plaintext, block.facets, { footnotes: ctx.footnotes });
  switch (typeOf(block)) {
    case `${T}text`: {
      if (typeof block.plaintext !== 'string' || !block.plaintext.trim()) return '';
      const size = block.textSize === 'small' ? 'is-small' : block.textSize === 'large' ? 'is-large' : null;
      return `<p${cls(size, align)}>${rich()}</p>`;
    }
    case `${T}header`: {
      if (typeof block.plaintext !== 'string' || !block.plaintext.trim()) return '';
      const level = typeof block.level === 'number' ? Math.trunc(block.level) : 1;
      const tag = `h${Math.max(2, Math.min(6, level + ctx.headingShift))}`;
      const id = uniqueId(slug(block.plaintext), ctx.headingIds);
      return `<${tag} id="${escapeAttr(id)}"${cls(align)}>${rich()}</${tag}>`;
    }
    case `${T}blockquote`:
      return typeof block.plaintext === 'string' && block.plaintext.trim() ? `<blockquote${cls(align)}><p>${rich()}</p></blockquote>` : '';
    case `${T}image`: {
      const img = imageHtml(block, ctx);
      return img ? `<figure${cls('post-image', block.fullBleed === true && 'is-full', align)}>${img}</figure>` : '';
    }
    case `${T}imageGallery`: {
      const images = (Array.isArray(block.images) ? block.images : []).map((i) => obj(i)).filter(Boolean).map((i) => imageHtml(i!, ctx)).filter(Boolean);
      return images.length ? `<div class="post-gallery" data-count="${Math.min(images.length, 4)}">${images.join('')}</div>` : '';
    }
    case `${T}unorderedList`:
      return listHtml(block, ctx, false);
    case `${T}orderedList`:
      return listHtml(block, ctx, true);
    case `${T}code`: {
      if (typeof block.plaintext !== 'string') return '';
      const lang = typeof block.language === 'string' && /^[A-Za-z0-9+#._-]{1,32}$/.test(block.language) ? block.language : null;
      return `<pre class="post-code"${lang ? ` data-lang="${escapeAttr(lang)}"` : ''}><code>${escapeHtml(block.plaintext)}</code></pre>`;
    }
    case `${T}math`:
      return typeof block.tex === 'string' && block.tex.trim()
        ? `<pre class="post-math" aria-label="math, written in TeX"><code>${escapeHtml(block.tex)}</code></pre>`
        : '';
    case `${T}horizontalRule`:
      return '<hr>';
    case `${T}website`: {
      const href = httpUrl(block.src);
      if (!href) return '';
      const title = typeof block.title === 'string' && block.title.trim() ? block.title.trim() : displayHost(href);
      const description = typeof block.description === 'string' && block.description.trim() ? block.description.trim().slice(0, 300) : null;
      return cardHtml({ href, title, description, kicker: null, imageUrl: blobUrl(ctx.pds, ctx.did, block.previewImage) });
    }
    case `${T}button`: {
      const href = httpUrl(block.url);
      const text = typeof block.text === 'string' ? block.text.trim() : '';
      return href && text ? `<p${cls('post-button', align)}><a class="btn btn--primary" href="${escapeAttr(href)}">${escapeHtml(text)}</a></p>` : '';
    }
    case `${T}bskyPost`:
      return bskyHtml(block, ctx);
    case `${T}standardSitePost`:
      return standardSiteHtml(block, ctx, 'post');
    case `${T}standardSitePublication`:
      return standardSiteHtml(block, ctx, 'publication');
    case `${T}iframe`:
      return iframeHtml(block);
    case `${T}page`:
    case `${T}embeddedCanvas`:
      return pageLinkHtml(block, ctx);
    case `${T}drawing`:
      return drawingHtml(block);
    case `${T}postsList`:
      return postsListHtml(block, ctx);
    case `${T}signup`:
      return signupHtml(ctx);
    default:
      return '';
  }
}

export function renderPage(page: LeafletPage, ctx: BlockContext): string {
  return page.blocks
    .map(({ block, alignment }) => renderBlock(block, alignment, ctx))
    .filter(Boolean)
    .join('\n');
}

/**
 * The main page, then each sub-page a block linked to (in the order they were linked,
 * including links found inside sub-pages), each once.
 */
export function renderPages(pages: readonly LeafletPage[], ctx: BlockContext): string {
  const [main, ...rest] = pages;
  if (!main) return '';
  for (const page of rest) if (page.id) ctx.pages.set(page.id, page);
  let html = renderPage(main, ctx);
  for (let i = 0; i < ctx.linkedPages.length && i < 50; i++) {
    const id = ctx.linkedPages[i]!;
    const page = ctx.pages.get(id);
    if (!page || page === main) continue;
    html += `\n<section class="post-subpage" id="page-${escapeAttr(pageAnchor(id))}">${renderPage(page, ctx)}</section>`;
  }
  return html;
}

/** Paragraphs from a plain-text body (documents without Leaflet content). */
export function renderPlainText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${textWithBreaks(p)}</p>`)
    .join('\n');
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "oct 19, 2026" (UTC, so the server and every reader agree on the day). */
export function formatDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_FORMAT.format(t).toLowerCase() : '';
}
