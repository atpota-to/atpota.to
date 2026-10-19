/**
 * The blog's pages as HTML fragments for the shell (shell.ts): what goes in <head> and
 * what goes in <main>. Every value from a record is escaped here or in blocks.ts.
 *
 * Head tags on every page: title, description, canonical, Open Graph, the Atom feed, and
 * the standard.site hints, <link rel="site.standard.publication"> (and on a post
 * <link rel="site.standard.document">), which is how Bluesky and other atproto apps
 * recognise a page as a standard.site record. Like dame.is, the backing record is also
 * named with <link rel="alternate" type="application/at-record+json"> and atproto:uri.
 */

import { BLOG_COPY, BLOG_PATH, POE_DID, POE_HANDLE, SITE_ORIGIN } from './config.js';
import {
  bodyImageCids,
  formatDate,
  renderPages,
  renderPlainText,
  type BlockContext,
  type Embeds,
  type LeafletPage,
} from './blocks.js';
import type { BlogComment, Discussion } from './discussion.js';
import { aturiUrl, escapeAttr, escapeHtml, jsonForScript } from './html.js';
import { documentPath, type BlogDocument, type Publication } from './records.js';
import { FootnoteList, renderRichText } from './richtext.js';

export const WORDS_PER_MINUTE = 200;
export const FEED_PATH = `${BLOG_PATH}/feed.xml`;
/** The blog's card (scripts/og-cards.html), for every page without a cover image of its own. */
export const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og/blog.png`;
const DEFAULT_OG_IMAGE_TAGS = [
  `<meta property="og:image:width" content="1200">`,
  `<meta property="og:image:height" content="630">`,
  `<meta property="og:image:alt" content="poe's atmosphere dispatch, a weekly newsletter by @poe.atpota.to, with a happy potato standing on a dirt mound under green rays.">`,
];

/** URLs of shell images (the build hashes them), by data-asset name. */
export type Assets = ReadonlyMap<string, string>;

export interface SiteInfo {
  name: string;
  tagline: string;
  /** Absolute publication URL, e.g. https://atpota.to/blog. */
  url: string;
  publication: Publication | null;
  /** Author handle for the byline and follow links: always Poe, whose blog this is. */
  handle: string;
  /** Handle of the repo the records live in, which can be another account's. */
  owner: string;
}

export interface Page {
  head: string;
  main: string;
}

export function siteInfo(publication: Publication | null, url: string, owner: string | null): SiteInfo {
  return {
    name: publication?.name ?? BLOG_COPY.name,
    tagline: publication?.description ?? BLOG_COPY.tagline,
    url,
    publication,
    handle: POE_HANDLE,
    owner: owner ?? POE_HANDLE,
  };
}

export function profileUrl(handle: string): string {
  return `https://bsky.app/profile/${encodeURIComponent(handle)}`;
}

function bylineName(handle: string): string {
  return handle === POE_HANDLE ? 'poe' : `@${handle}`;
}

export function docUrl(site: SiteInfo, doc: BlogDocument): string {
  return `${site.url}${documentPath(doc)}`;
}

/** Same-site link to a post (relative, so previews stay on the preview). */
export function docHref(doc: BlogDocument): string {
  return `${BLOG_PATH}${documentPath(doc)}`;
}

export function readingMinutes(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

interface HeadMeta {
  title: string;
  description: string;
  canonical: string | null;
  type: 'website' | 'article';
  image: string;
  site: SiteInfo;
  record?: { uri: string; cid: string } | null;
  document?: BlogDocument;
  robots?: string;
  jsonLd?: unknown;
}

function headHtml(m: HeadMeta): string {
  const tags: string[] = [
    `<title>${escapeHtml(m.title)}</title>`,
    `<meta name="title" content="${escapeAttr(m.title)}">`,
    `<meta name="description" content="${escapeAttr(m.description)}">`,
  ];
  if (m.robots) tags.push(`<meta name="robots" content="${escapeAttr(m.robots)}">`);
  if (m.canonical) tags.push(`<link rel="canonical" href="${escapeAttr(m.canonical)}">`);
  tags.push(
    `<link rel="alternate" type="application/atom+xml" title="${escapeAttr(m.site.name)}" href="${escapeAttr(`${SITE_ORIGIN}${FEED_PATH}`)}">`,
    `<meta property="og:type" content="${m.type}">`,
    `<meta property="og:site_name" content="atpotato">`,
    `<meta property="og:title" content="${escapeAttr(m.title)}">`,
    `<meta property="og:description" content="${escapeAttr(m.description)}">`,
    `<meta property="og:image" content="${escapeAttr(m.image)}">`,
    ...(m.image === DEFAULT_OG_IMAGE ? DEFAULT_OG_IMAGE_TAGS : []),
    `<meta name="twitter:card" content="summary_large_image">`,
  );
  if (m.canonical) tags.push(`<meta property="og:url" content="${escapeAttr(m.canonical)}">`);
  if (m.document) {
    tags.push(`<meta property="article:published_time" content="${escapeAttr(m.document.publishedAt)}">`);
    if (m.document.updatedAt) tags.push(`<meta property="article:modified_time" content="${escapeAttr(m.document.updatedAt)}">`);
    for (const tag of m.document.tags) tags.push(`<meta property="article:tag" content="${escapeAttr(tag)}">`);
    tags.push(`<link rel="site.standard.document" href="${escapeAttr(m.document.uri)}">`);
  }
  if (m.site.publication) tags.push(`<link rel="site.standard.publication" href="${escapeAttr(m.site.publication.uri)}">`);
  if (m.record) {
    tags.push(
      `<link rel="alternate" type="application/at-record+json" href="${escapeAttr(m.record.uri)}">`,
      `<meta name="atproto:uri" content="${escapeAttr(m.record.uri)}">`,
      `<meta name="atproto:cid" content="${escapeAttr(m.record.cid)}">`,
    );
  }
  if (m.jsonLd) tags.push(`<script type="application/ld+json">${jsonForScript(m.jsonLd)}</script>`);
  return tags.join('\n    ');
}

function asset(assets: Assets, name: string): string {
  return assets.get(name) ?? '';
}

function potato(assets: Assets, face: string, className: string, width: number, height: number, mascot = false): string {
  const src = asset(assets, `potato-${face}`);
  if (!src) return '';
  return `<img class="${className}"${mascot ? ` data-mascot="${face}"` : ''} src="${escapeAttr(src)}" alt="" width="${width}" height="${height}">`;
}

const ARROW =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>';
const FEED_ICON =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8"/><circle cx="6" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>';

const HEART =
  '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.2C19.5 15.4 12 20 12 20z"/></svg>';

/**
 * Reader actions that need a Bluesky sign-in (src/blog/). They stay hidden until that
 * code runs, so a page without JavaScript never shows a button that does nothing.
 */
function subscribeButton(site: SiteInfo, size = ''): string {
  if (!site.publication) return '';
  return `<button type="button" class="btn btn--primary${size}" data-blog-subscribe aria-pressed="false" hidden><span data-blog-subscribe-label>subscribe</span></button>`;
}

/** Signed-in state ("signed in as @alice · sign out"), filled in by src/blog/. */
const ACCOUNT_LINE = '<p class="blog-account" data-blog-account aria-live="polite" hidden></p>';

function followActions(site: SiteInfo, size = ''): string {
  // Subscribing is the main action; following is the quieter alternative beside it.
  return (
    `<a class="btn btn--outline${size}" href="${escapeAttr(profileUrl(site.handle))}">follow ${escapeHtml(bylineName(site.handle))} on bluesky ${ARROW}</a>` +
    `<a class="btn btn--outline${size}" href="${FEED_PATH}">${FEED_ICON} atom feed</a>`
  );
}

function tagList(tags: readonly string[], className: string): string {
  if (!tags.length) return '';
  return `<ul class="${className}" role="list" aria-label="tags">${tags.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
}

// ---------- index ----------

export function indexPage(site: SiteInfo, docs: readonly BlogDocument[], assets: Assets): Page {
  const pub = site.publication;
  const items = docs.map((doc, i) => {
    const cover = doc.coverUrl ? `<img class="blog-item__cover" src="${escapeAttr(doc.coverUrl)}" alt="" loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async">` : '';
    return (
      `<li><a class="tile tile--link blog-item${i === 0 ? ' blog-item--latest' : ''}" href="${escapeAttr(docHref(doc))}">` +
      `<span class="blog-item__text">` +
      `<span class="blog-item__meta">${i === 0 ? '<span class="blog-item__new">latest</span>' : ''}<time datetime="${escapeAttr(doc.publishedAt)}">${escapeHtml(formatDate(doc.publishedAt))}</time></span>` +
      `<h2 class="blog-item__title">${escapeHtml(doc.title)}</h2>` +
      (doc.description ? `<span class="blog-item__desc">${escapeHtml(clip(doc.description, 280))}</span>` : '') +
      `</span>${cover}</a></li>`
    );
  });
  const list = items.length
    ? `<ol class="blog-list" role="list" aria-label="posts">${items.join('')}</ol>`
    : `<section class="tile tile--dashed blog-empty" aria-labelledby="blog-empty-title">` +
      (asset(assets, 'sprout') ? `<img class="blog-empty__sprout" src="${escapeAttr(asset(assets, 'sprout'))}" alt="" width="60" height="56">` : '') +
      `<h2 class="blog-empty__title" id="blog-empty-title">${escapeHtml(BLOG_COPY.emptyTitle)}</h2>` +
      `<p class="blog-empty__text">${escapeHtml(BLOG_COPY.emptyText)}</p></section>`;

  const main =
    `<div class="blog"${pub ? ` data-blog-publication="${escapeAttr(pub.uri)}"` : ''}>` +
    `<section class="tile blog-hero" aria-labelledby="blog-title" data-mascot-trigger>` +
    `<div class="blog-hero__text">` +
    `<p class="chip blog-hero__chip">newsletter</p>` +
    `<h1 class="blog-hero__title" id="blog-title">${escapeHtml(site.name)}</h1>` +
    `<p class="blog-hero__lede">${escapeHtml(site.tagline)}</p>` +
    `<div class="blog-hero__actions">${subscribeButton(site)}${followActions(site)}</div>` +
    ACCOUNT_LINE +
    `</div>` +
    potato(assets, 'happy', 'blog-hero__potato', 260, 212, true) +
    `</section>` +
    list +
    `</div>`;

  const description = site.tagline;
  return {
    head: headHtml({
      title: site.name,
      description,
      canonical: site.url,
      type: 'website',
      image: DEFAULT_OG_IMAGE,
      site,
      record: pub ? { uri: pub.uri, cid: pub.cid } : null,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Blog',
        name: site.name,
        description,
        url: site.url,
        ...(pub ? { identifier: pub.uri } : {}),
        author: { '@type': 'Person', name: bylineName(site.handle), url: profileUrl(site.handle) },
        publisher: { '@type': 'Organization', name: 'atpotato', url: `${SITE_ORIGIN}/` },
      },
    }),
    main,
  };
}

// ---------- post ----------

export interface PostInput {
  site: SiteInfo;
  doc: BlogDocument;
  pages: LeafletPage[];
  /** Plain text for reading time and the fallback description. */
  text: string;
  embeds: Embeds;
  /** For blob URLs. */
  did: string;
  pds: string;
  newer: BlogDocument | null;
  older: BlogDocument | null;
  others: readonly BlogDocument[];
  headingShift: number;
  assets: Assets;
  /** CID of the record's coverImage blob, to spot the same image in the body. */
  coverCid?: string | null;
  /** Comments and recommends; null when comments are switched off (BLOG_COMMENTS_DISABLED). */
  discussion?: Discussion | null;
}

/** The post body alone (blocks + footnotes), shared with the feed. */
export function postBody(input: Omit<PostInput, 'site' | 'newer' | 'older' | 'assets' | 'discussion'> & { site: SiteInfo }): string {
  const footnotes = new FootnoteList();
  const ctx: BlockContext = {
    did: input.did,
    pds: input.pds,
    embeds: input.embeds,
    footnotes,
    headingShift: input.headingShift,
    pages: new Map(),
    linkedPages: [],
    headingIds: new Set(),
    otherPosts: input.others.map((d) => ({ href: docHref(d), title: d.title, date: d.publishedAt })),
    links: { profile: profileUrl(input.site.handle), feed: FEED_PATH },
  };
  let body = input.pages.length ? renderPages(input.pages, ctx) : '';
  if (!body.trim()) body = renderPlainText(input.doc.textContent ?? '');
  if (footnotes.items.length) {
    body +=
      `\n<section class="post-footnotes" aria-labelledby="footnotes-label">` +
      `<h2 class="visually-hidden" id="footnotes-label">footnotes</h2><ol>` +
      footnotes.items
        .map((note, i) => {
          const n = i + 1;
          return `<li id="fn-${n}">${renderRichText(note.text, note.facets)} <a class="post-fn-back" href="#fnref-${n}" aria-label="back to footnote ${n} in the text">↩</a></li>`;
        })
        .join('') +
      `</ol></section>`;
  }
  return body;
}

export function postPage(input: PostInput): Page {
  const { site, doc } = input;
  const minutes = readingMinutes(input.text || doc.textContent || '');
  const description = doc.description ?? clip(input.text || doc.textContent || site.tagline, 200);
  const body = postBody(input);
  const record = aturiUrl(doc.uri);
  // Leaflet uses coverImage as the thumbnail and usually repeats it in the body; show it
  // on the page only when no image block already carries the same blob.
  const cover =
    doc.coverUrl && !(input.coverCid && bodyImageCids(input.pages).has(input.coverCid))
      ? `<figure class="post__cover"><img src="${escapeAttr(doc.coverUrl)}" alt="" decoding="async" fetchpriority="high"></figure>`
      : '';
  const reply = doc.bskyPostUri ? aturiToBsky(doc.bskyPostUri) : null;
  const nav =
    input.newer || input.older
      ? `<nav class="post-pager" aria-label="more posts">` +
        (input.older
          ? `<a class="tile tile--link post-pager__link post-pager__link--older" href="${escapeAttr(docHref(input.older))}"><span class="post-pager__label">older</span><span class="post-pager__title">${escapeHtml(input.older.title)}</span></a>`
          : '') +
        (input.newer
          ? `<a class="tile tile--link post-pager__link post-pager__link--newer" href="${escapeAttr(docHref(input.newer))}"><span class="post-pager__label">newer</span><span class="post-pager__title">${escapeHtml(input.newer.title)}</span></a>`
          : '') +
        `</nav>`
      : '';

  const discussion = input.discussion ?? null;
  const main =
    `<div class="post-layout"${site.publication ? ` data-blog-publication="${escapeAttr(site.publication.uri)}"` : ''} data-blog-document="${escapeAttr(doc.uri)}">` +
    `<article class="post" data-poe-askable aria-labelledby="post-title">` +
    `<header class="post__header">` +
    `<nav class="post__crumbs" aria-label="breadcrumb"><ol class="post__crumbs-list" role="list"><li><a href="${BLOG_PATH}">${escapeHtml(site.name)}</a></li><li aria-current="page"><time datetime="${escapeAttr(doc.publishedAt)}">${escapeHtml(formatDate(doc.publishedAt))}</time></li></ol></nav>` +
    `<h1 class="post__title" id="post-title">${escapeHtml(doc.title)}</h1>` +
    (doc.description ? `<p class="post__subtitle">${escapeHtml(doc.description)}</p>` : '') +
    `<p class="post__meta"><span>${minutes} min read</span><span aria-hidden="true">·</span><span>by <a href="${escapeAttr(profileUrl(site.handle))}">${escapeHtml(bylineName(site.handle))}</a></span>` +
    (doc.updatedAt && doc.updatedAt.slice(0, 10) !== doc.publishedAt.slice(0, 10)
      ? `<span aria-hidden="true">·</span><span>updated <time datetime="${escapeAttr(doc.updatedAt)}">${escapeHtml(formatDate(doc.updatedAt))}</time></span>`
      : '') +
    `</p>` +
    tagList(doc.tags, 'post__tags') +
    `</header>` +
    cover +
    `<div class="post__body">${body}</div>` +
    `</article>` +
    `<aside class="post-end" aria-label="after the post">` +
    `<div class="tile post-end__card" data-mascot-trigger>` +
    potato(input.assets, 'wink', 'post-end__potato', 150, 122, true) +
    `<p class="post-end__title">${reply ? 'thoughts? talk about it on bluesky.' : 'want the next one?'}</p>` +
    `<div class="post-end__actions">` +
    subscribeButton(site, ' btn--sm') +
    recommendButton(discussion) +
    (reply ? `<a class="btn btn--outline btn--sm" href="${escapeAttr(reply)}">reply on bluesky ${ARROW}</a>` : '') +
    `<a class="btn btn--outline btn--sm" href="${escapeAttr(profileUrl(site.handle))}">follow ${escapeHtml(bylineName(site.handle))}</a>` +
    `<a class="btn btn--outline btn--sm" href="${FEED_PATH}">${FEED_ICON} feed</a>` +
    `</div>` +
    ACCOUNT_LINE +
    `</div>` +
    (discussion ? discussionHtml(site, doc, discussion) : '') +
    nav +
    (record
      ? `<p class="post-end__record">this post is a <code>site.standard.document</code> record on ${escapeHtml(bylineName(site.owner))}'s pds. <a href="${escapeAttr(record)}">open the record</a></p>`
      : '') +
    `</aside>` +
    `</div>`;

  const canonical = docUrl(site, doc);
  return {
    head: headHtml({
      title: `${doc.title} - ${site.name}`,
      description,
      canonical,
      type: 'article',
      image: doc.coverUrl ?? DEFAULT_OG_IMAGE,
      site,
      document: doc,
      record: { uri: doc.uri, cid: doc.cid },
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: doc.title,
        description,
        url: canonical,
        identifier: doc.uri,
        datePublished: doc.publishedAt,
        dateModified: doc.updatedAt ?? doc.publishedAt,
        ...(doc.coverUrl ? { image: doc.coverUrl } : {}),
        ...(doc.tags.length ? { keywords: doc.tags.join(', ') } : {}),
        isPartOf: { '@type': 'Blog', name: site.name, url: site.url },
        author: { '@type': 'Person', name: bylineName(site.handle), url: profileUrl(site.handle) },
      },
    }),
    main,
  };
}

function aturiToBsky(uri: string): string | null {
  const m = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]+)$/.exec(uri);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
}

// ---------- comments and recommends ----------

/** Replies nest this deep; anything deeper is listed at the last level, in order. */
export const MAX_COMMENT_DEPTH = 4;

function recommendButton(discussion: Discussion | null): string {
  const n = discussion?.recommends ?? null;
  return (
    `<button type="button" class="btn btn--outline btn--sm post-end__recommend" data-blog-recommend${n !== null ? ` data-recommend-count="${n}"` : ''} aria-pressed="false" hidden>` +
    `${HEART}<span data-blog-recommend-label>recommend</span><span class="post-end__count" data-blog-recommend-count>${n ? n : ''}</span></button>`
  );
}

function descendants(c: BlogComment): BlogComment[] {
  return c.replies.flatMap((r) => [r, ...descendants(r)]);
}

/** One comment and its replies. The browser adds reply and delete buttons (src/blog/). */
export function commentHtml(c: BlogComment, depth = 1): string {
  const author = c.author;
  const profile = profileUrl(author.handle);
  const avatar = author.avatar
    ? `<img class="comment__avatar" src="${escapeAttr(author.avatar)}" alt="" width="36" height="36" loading="lazy" decoding="async">`
    : `<span class="comment__avatar comment__avatar--blank" aria-hidden="true"></span>`;
  const handle = author.handle !== author.did ? `<span class="comment__handle">@${escapeHtml(author.handle)}</span>` : '';
  const badge = c.did === POE_DID ? `<span class="comment__badge">author</span>` : '';
  const record = aturiUrl(c.uri);
  const time = `<time datetime="${escapeAttr(c.createdAt)}">${escapeHtml(formatDate(c.createdAt))}</time>`;
  // Anchors come only from renderRichText (record text is escaped), so this marks every link.
  const text = renderRichText(c.text, c.facets).replace(/<a href=/g, '<a rel="ugc nofollow" href=');
  const children = depth >= MAX_COMMENT_DEPTH ? descendants(c) : c.replies;
  const replies = children.length
    ? `<ol class="comment-list comment-list--replies" role="list">${children.map((r) => (depth >= MAX_COMMENT_DEPTH ? commentHtml({ ...r, replies: [] }, depth) : commentHtml(r, depth + 1))).join('')}</ol>`
    : '';
  return (
    `<li class="comment" data-comment="${escapeAttr(c.uri)}" data-comment-author="${escapeAttr(c.did)}" data-comment-depth="${depth}">` +
    `<div class="comment__head">${avatar}<span class="comment__who"><a class="comment__name" href="${escapeAttr(profile)}">${escapeHtml(author.name)}</a>${handle}${badge}</span>` +
    (record ? `<a class="comment__time" href="${escapeAttr(record)}">${time}</a>` : `<span class="comment__time">${time}</span>`) +
    `</div>` +
    `<div class="comment__body">${text}</div>` +
    `<div class="comment__actions" data-comment-actions></div>` +
    replies +
    `</li>`
  );
}

export function commentCountLabel(n: number): string {
  return n === 1 ? '1 comment' : `${n} comments`;
}

/** The comments section under a post. */
export function discussionHtml(site: SiteInfo, doc: BlogDocument, d: Discussion): string {
  const ok = d.status === 'ok';
  const elsewhere = docUrl(site, doc);
  const leaflet = !elsewhere.startsWith(`${SITE_ORIGIN}/`) ? elsewhere : null;
  let note = '';
  if (!ok) {
    note =
      `<p class="post-talk__note" data-comment-note>comments didn't load just now.` +
      (leaflet ? ` <a href="${escapeAttr(leaflet)}">read them on ${escapeHtml(new URL(leaflet).hostname)}</a>, or try again in a minute.` : ' try again in a minute.') +
      `</p>`;
  } else if (d.count === 0) {
    note = `<p class="post-talk__note" data-comment-empty>no comments yet.</p>`;
  }
  return (
    `<section class="tile post-talk" id="comments" aria-labelledby="comments-title" data-blog-comments${ok ? '' : ' data-comments-unavailable'}>` +
    `<div class="post-talk__head"><h2 class="post-talk__title" id="comments-title">comments</h2>` +
    `<span class="post-talk__count" data-comment-count="${d.count}"${d.count ? '' : ' hidden'}>${escapeHtml(commentCountLabel(d.count))}</span></div>` +
    `<div class="post-talk__compose" data-comment-compose hidden></div>` +
    `<ol class="comment-list" role="list" data-comment-list${d.comments.length ? '' : ' hidden'}>${d.comments.map((c) => commentHtml(c)).join('')}</ol>` +
    note +
    `<p class="post-talk__fine">each comment is a <code>pub.leaflet.comment</code> record in its writer's own repo, so leaflet can show it too.</p>` +
    `</section>`
  );
}

// ---------- not found / unavailable ----------

export function notFoundPage(site: SiteInfo, assets: Assets): Page {
  return {
    head: headHtml({
      title: `not found - ${site.name}`,
      description: site.tagline,
      canonical: null,
      type: 'website',
      image: DEFAULT_OG_IMAGE,
      site,
      robots: 'noindex',
    }),
    main:
      `<div class="blog"><section class="tile blog-missing" aria-labelledby="blog-missing-title" data-mascot-trigger>` +
      potato(assets, 'dead', 'blog-missing__potato', 200, 163, true) +
      `<div class="blog-missing__text">` +
      `<p class="eyebrow">404</p>` +
      `<h1 class="blog-missing__title" id="blog-missing-title">this post isn't here.</h1>` +
      `<p class="blog-missing__lede">it may have moved, or it was never planted.</p>` +
      `<a class="btn btn--primary" href="${BLOG_PATH}">see all posts</a>` +
      `</div></section></div>`,
  };
}

export function unavailablePage(assets: Assets): Page {
  const site = siteInfo(null, `${SITE_ORIGIN}${BLOG_PATH}`, null);
  return {
    head: headHtml({
      title: site.name,
      description: site.tagline,
      canonical: null,
      type: 'website',
      image: DEFAULT_OG_IMAGE,
      site,
      robots: 'noindex',
    }),
    main:
      `<div class="blog"><section class="tile blog-missing" aria-labelledby="blog-missing-title" data-mascot-trigger>` +
      potato(assets, 'sleepy', 'blog-missing__potato', 200, 163, true) +
      `<div class="blog-missing__text">` +
      `<h1 class="blog-missing__title" id="blog-missing-title">the blog didn't load.</h1>` +
      `<p class="blog-missing__lede">poe's posts live on poe's own server, and it didn't answer just now. try again in a minute.</p>` +
      `<a class="btn btn--primary" href="${BLOG_PATH}">try again</a>` +
      `</div></section></div>`,
  };
}

