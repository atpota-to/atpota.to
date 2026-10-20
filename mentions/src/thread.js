// thread.js
// What a post carries and what was said above it, so the agent can read a
// question in context.
//
// "oh i meant the iphone lexicon" and "how was your nap?" mean nothing on their
// own, and the agent's session for a thread holds only the turns it was sent:
// nothing a gate dropped, nothing anyone else said, and none of the notes the
// poster writes by itself, like the one saying the potato needs a lie down.
// The same goes for "what does this mean?" posted over a quote, a screenshot or
// a link card: the text is the least of it. The network is the only record of
// all of that, so it is read here and handed over with the post.
//
// Read-only, through our own session. Everything in it was written by other
// people or by us, and it goes to the agent as content, the same as the post.

import { logger } from './logger.js';
import { expandLinks } from './richtext.js';

/**
 * How far above the post being replied to the read goes, so at most this many
 * plus one posts. The root is added on top when it falls outside that.
 *
 * Was 12. The conversation that prompted this was 30 posts long, and a probe
 * asking about it got "i got handed the tail of it only". 24 covers about a
 * dozen exchanges, and the agent is given the root's address to read the rest
 * itself when a question needs the whole thing.
 */
export const MAX_ANCESTORS = 24;
const MAX_TEXT = 800;             // a post is 300 graphemes; this is headroom, not a new limit
const MAX_ATTACHMENT = 300;       // per post in the thread
const MAX_POST_ATTACHMENT = 1200; // the post being answered, described in full
const MAX_IMAGES = 4;

// The appview's own thumbnails, and nothing else: these URLs go to a model
// provider to fetch, so they are never taken from anything a stranger wrote.
const IMAGE_URL = /^https:\/\/cdn\.bsky\.app\/img\/feed_thumbnail\//;

// A post labelled with any of these, by its author or by Bluesky's moderation,
// never has its pixels sent anywhere. Its alt text still goes in as words.
const WITHHELD_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore', '!hide', '!warn']);

const THREAD_VIEW = 'app.bsky.feed.defs#threadViewPost';
const TENOR = /^https:\/\/media\.tenor\.com\//;

// How long to wait for a post the appview has not indexed yet. Measured
// 2026-09-23 against 30 posts fresh off Jetstream: 29 were readable on the
// first request and all 30 within 632ms.
const RETRY_DELAYS_MS = [700, 1500];

/** Stands in for posts between the root and the nearest ones that were not read. */
const SKIPPED = { uri: null, parentUri: null, entry: { author: null, you: false, text: '', missing: 'skipped' } };

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** The handle, or the DID when the handle does not resolve. */
function handleOf(author) {
  if (!author) return null;
  return author.handle && author.handle !== 'handle.invalid' ? author.handle : (author.did ?? null);
}

function at(author) {
  const h = handleOf(author);
  return h && !h.startsWith('did:') ? `@${h}` : (h ?? 'someone');
}

/**
 * An embed view in words: images by their alt text, a link card, a quoted
 * post, a feed or list or starter pack. "what does this mean?" under a
 * screenshot is only answerable if the agent knows there was a screenshot.
 *
 * `detailed` is for the post being answered: link card descriptions, the
 * quoted post's own media, and the at:// address of anything embedded, so the
 * agent can look it up with its tools. Posts in the thread get the short form.
 */
export function describeEmbed(embed, { detailed = false } = {}) {
  if (!embed || typeof embed !== 'object') return null;
  const parts = [];
  const by = (creator) => (creator ? ` by ${at(creator)}` : '');
  const addr = (uri) => (detailed && uri ? ` (${uri})` : '');
  const about = (text) => (detailed && text ? `: ${clip(text, 200)}` : '');

  const media = (m) => {
    switch (m?.$type) {
      case 'app.bsky.embed.images#view':
        for (const img of m.images ?? []) parts.push(img?.alt ? `[image: ${img.alt}]` : '[image, no alt text]');
        break;
      case 'app.bsky.embed.video#view':
        parts.push(m.alt ? `[video: ${m.alt}]` : '[video]');
        break;
      case 'app.bsky.embed.external#view': {
        const e = m.external ?? {};
        if (TENOR.test(e.uri ?? '')) {
          parts.push(`[gif: ${e.title || 'untitled'}]`);
          break;
        }
        const card = [e.title, e.uri].filter(Boolean).join(' ');
        parts.push(detailed && e.description ? `[link card: ${card}. ${clip(e.description, 200)}]` : `[link card: ${card}]`);
        break;
      }
    }
  };

  const quoted = (r) => {
    switch (r?.$type) {
      case 'app.bsky.embed.record#viewRecord': {
        const text = expandLinks(String(r.value?.text ?? ''), r.value?.facets);
        parts.push(`[quoting ${at(r.author)}${addr(r.uri)}: ${clip(text, detailed ? 500 : 200)}]`);
        if (!detailed) break;
        for (const inner of r.embeds ?? []) {
          if (inner?.$type === 'app.bsky.embed.recordWithMedia#view') media(inner.media);
          if (inner?.$type === 'app.bsky.embed.record#view' || inner?.$type === 'app.bsky.embed.recordWithMedia#view') {
            parts.push('[which itself quotes another post]');
          } else {
            media(inner);
          }
        }
        break;
      }
      case 'app.bsky.embed.record#viewNotFound': parts.push('[quoting a deleted post]'); break;
      case 'app.bsky.embed.record#viewBlocked': parts.push('[quoting a post you cannot see]'); break;
      case 'app.bsky.embed.record#viewDetached': parts.push('[quoting a post its author detached]'); break;
      case 'app.bsky.feed.defs#generatorView':
        parts.push(detailed
          ? `[feed "${r.displayName ?? 'unnamed'}"${by(r.creator)}${addr(r.uri)}${about(r.description)}]`
          : `[feed: ${r.displayName ?? 'unnamed'}]`);
        break;
      case 'app.bsky.graph.defs#listView':
        parts.push(detailed
          ? `[list "${r.name ?? 'unnamed'}"${by(r.creator)}${addr(r.uri)}${about(r.description)}]`
          : `[list: ${r.name ?? 'unnamed'}]`);
        break;
      case 'app.bsky.graph.defs#starterPackViewBasic':
        parts.push(`[starter pack "${r.record?.name ?? 'unnamed'}"${by(r.creator)}${addr(r.uri)}]`);
        break;
      case 'app.bsky.labeler.defs#labelerView':
        parts.push(`[labeler${by(r.creator)}${addr(r.uri)}]`);
        break;
      default:
        if (r) parts.push(`[embedded record${addr(r.uri)}]`);
    }
  };

  switch (embed.$type) {
    case 'app.bsky.embed.record#view': quoted(embed.record); break;
    case 'app.bsky.embed.recordWithMedia#view': media(embed.media); quoted(embed.record?.record); break;
    default: media(embed);
  }
  return parts.length ? clip(parts.join(' '), detailed ? MAX_POST_ATTACHMENT : MAX_ATTACHMENT) : null;
}

/** Image entries straight on one embed view. */
function imagesOn(view) {
  if (view?.$type === 'app.bsky.embed.images#view') return view.images ?? [];
  if (view?.$type === 'app.bsky.embed.recordWithMedia#view') return imagesOn(view.media);
  return [];
}

function quotedPost(embed) {
  const r = embed?.$type === 'app.bsky.embed.record#view' ? embed.record
    : embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? embed.record?.record
      : null;
  return r?.$type === 'app.bsky.embed.record#viewRecord' ? r : null;
}

const withheld = (labels) => Array.isArray(labels) && labels.some((l) => WITHHELD_LABELS.has(l?.val));

/**
 * The appview hands out thumbnail URLs with no format suffix, and the CDN
 * answers those with WebP (checked 2026-09-24). "@jpeg" asks for a JPEG, which
 * every vision model reads and which is what the agent says it is sending.
 */
export function asJpeg(url) {
  return typeof url === 'string' ? `${url.replace(/@[a-z]+$/i, '')}@jpeg` : url;
}

/**
 * The images a question might be about, as appview thumbnails: a post's own,
 * then those of the post it quotes, each tagged with where it came from.
 */
export function imagesIn(post, ownSource, quoteSource) {
  if (!post) return [];
  const out = [];
  const add = (img, source) => out.push({ url: asJpeg(img?.thumb), ...(img?.alt ? { alt: img.alt } : {}), source });
  if (!withheld(post.labels)) for (const img of imagesOn(post.embed)) add(img, ownSource);
  const q = quotedPost(post.embed);
  if (q && !withheld(q.labels)) for (const v of q.embeds ?? []) for (const img of imagesOn(v)) add(img, quoteSource);
  return out.filter((i) => typeof i.url === 'string' && IMAGE_URL.test(i.url));
}

/**
 * One node of a getPostThread response, or null for a shape we do not know.
 * Posts by someone on ADMIN_DIDS are marked, so direction they gave earlier in
 * a thread still reads as direction a few turns later.
 */
function entryFor(node, botDid, adminDids = []) {
  switch (node?.$type) {
    case THREAD_VIEW: {
      const p = node.post ?? {};
      const entry = {
        author: handleOf(p.author),
        ...(typeof p.author?.did === 'string' ? { authorDid: p.author.did } : {}),
        you: !!botDid && p.author?.did === botDid,
        text: clip(expandLinks(String(p.record?.text ?? ''), p.record?.facets), MAX_TEXT),
      };
      if (adminDids.includes(p.author?.did)) entry.operator = true;
      const attachment = describeEmbed(p.embed);
      if (attachment) entry.attachment = attachment;
      return { uri: p.uri ?? null, parentUri: p.record?.reply?.parent?.uri ?? null, entry };
    }
    // Neither carries a parent, so the chain stops at them.
    case 'app.bsky.feed.defs#blockedPost':
      return { uri: node.uri ?? null, parentUri: null, entry: { author: null, you: false, text: '', missing: 'blocked' } };
    case 'app.bsky.feed.defs#notFoundPost':
      return { uri: node.uri ?? null, parentUri: null, entry: { author: null, you: false, text: '', missing: 'deleted' } };
    default:
      return null;
  }
}

/** A getPostThread response as a list, oldest first. Pure, for testing. */
export function chainFromView(view, botDid, adminDids = []) {
  const chain = [];
  for (let node = view?.thread; node; node = node.parent) {
    const c = entryFor(node, botDid, adminDids);
    if (!c) break;
    chain.unshift(c);
  }
  return chain;
}

/**
 * When a chain stops short of the root -- the appview returned only so many
 * ancestors, or a deleted or blocked post cut it off -- put the root on top,
 * since it is usually what the thread is about, and mark the gap.
 */
async function completeToRoot(chain, row, { botDid, adminDids = [], api }) {
  const top = chain[0];
  if (!top || !row.root_uri || top.uri === row.root_uri) return chain;
  let root = null;
  try {
    root = (await api.getPosts([row.root_uri]))?.posts?.[0] ?? null;
  } catch { /* the nearest posts alone are still worth sending */ }
  if (!(root && top.parentUri === row.root_uri)) chain.unshift(SKIPPED);
  if (root) chain.unshift(entryFor({ $type: THREAD_VIEW, post: root }, botDid, adminDids));
  return chain;
}

/**
 * The thread above a queued post, read from what the post replies to, as the
 * list the agent is given, or null. The fallback for when the post itself
 * cannot be read. Never throws.
 *
 * `api` is { getPostThread, getPosts }, injected so this is testable offline.
 */
export async function fetchThreadContext(row, { botDid, adminDids = [], api }) {
  if (!row?.upstream_uri) return null;           // it starts a thread: nothing above it

  let chain;
  try {
    chain = chainFromView(
      await api.getPostThread(row.upstream_uri, { parentHeight: MAX_ANCESTORS }), botDid, adminDids);
  } catch (err) {
    logger.warn('could not read the thread above a post; sending it without', {
      queueId: row.id, upstream: row.upstream_uri, err: err.message,
    });
    return null;
  }
  if (!chain.length) return null;
  return (await completeToRoot(chain, row, { botDid, adminDids, api })).map((c) => c.entry);
}

/**
 * Everything the agent should know about a post beyond its stored text, read
 * from the post itself as the appview renders it for us:
 *
 *   text        its text with shortened links written out, when that differs
 *   attachment  its embed in words: quote, images, link card, feed, list...
 *   images      thumbnails from it, the post it quotes, and the post it replies
 *               to, for the agent to have described; at most MAX_IMAGES
 *   thread      the posts above it, oldest first
 *
 * One request normally covers all of it. If the post cannot be read even after
 * waiting for the appview, the thread is read from what it replies to instead,
 * and the rest is left out. Returns {} when there is nothing to add, and null
 * only when nothing could be read. Never throws.
 */
export async function readPostContext(row, { botDid, adminDids = [], api, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let view = null;
  for (let attempt = 0; ; attempt++) {
    try {
      view = await api.getPostThread(row.uri, { parentHeight: MAX_ANCESTORS + 1 });
      break;
    } catch (err) {
      // Only "not indexed yet" is worth waiting on.
      if (!/NotFound/i.test(err?.message ?? '') || attempt >= RETRY_DELAYS_MS.length) {
        logger.warn('could not read the post itself; reading the thread above it instead', {
          queueId: row.id, uri: row.uri, err: err?.message,
        });
        break;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  const anchor = view?.thread?.$type === THREAD_VIEW ? view.thread : null;
  if (!anchor) {
    const thread = await fetchThreadContext(row, { botDid, adminDids, api });
    return thread ? { thread } : null;
  }

  const post = anchor.post ?? {};
  const ctx = {};
  const raw = String(post.record?.text ?? '');
  const expanded = expandLinks(raw, post.record?.facets);
  if (expanded !== raw) ctx.text = expanded;

  const attachment = describeEmbed(post.embed, { detailed: true });
  if (attachment) ctx.attachment = attachment;

  const parent = anchor.parent?.$type === THREAD_VIEW ? anchor.parent.post : null;
  const images = [
    ...imagesIn(post, 'their post', 'the post they quoted'),
    ...imagesIn(parent, 'the post they replied to', 'the post that one quotes'),
  ].slice(0, MAX_IMAGES);
  if (images.length) ctx.images = images;

  if (anchor.parent) {
    const chain = chainFromView({ thread: anchor.parent }, botDid, adminDids);
    if (chain.length) ctx.thread = (await completeToRoot(chain, row, { botDid, adminDids, api })).map((c) => c.entry);
  }
  return ctx;
}

/** A stored context. The first version stored only the thread, as an array. */
export function parseContext(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) return { thread: v };
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
