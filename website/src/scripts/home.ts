/**
 * Home page behaviour (spec 3.1). main.ts imports this module when
 * <body data-page="home"> and calls init() once.
 *
 * "latest" tile: one feed for everything atpotato makes. /api/latest
 * (server/latest.ts) merges the newest original posts from atpota.to, poe,
 * anisota and aturi with the newest issues of poe's dispatch. If that endpoint
 * fails (a static preview, an outage), the tile falls back to atpota.to's own
 * newest post, read from its repo: the DID document from plc.directory names
 * the PDS, and one com.atproto.repo.listRecords page of app.bsky.feed.post
 * records holds it. Only if that path fails too does it try the public
 * AppView's author feed, which needs a page of 100 (about 90 KB gzipped)
 * because atpota.to mostly reposts.
 *
 * Fetched text only ever reaches the DOM through textContent; links are either
 * built from a validated record key or checked by safeItemUrl(). States live on
 * the tile as data-state="loading" | "ready" | "error" (CSS shows the skeleton,
 * the list or the fallback line). Once the list shows, its "5 minutes ago"
 * dates keep themselves current.
 *
 * Also here: the "say hi" tile's copy button, the hero Poe (pet.ts), atmospheric
 * conditions (weather.ts) and the way into the community garden (garden-teaser.ts,
 * loaded when it comes near the screen).
 */

import { initPet } from './pet';
import { initWeather } from './weather';

export const FEED_ENDPOINT = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
export const PLC_DIRECTORY = 'https://plc.directory';
export const ACTOR_HANDLE = 'atpota.to';
export const ACTOR_DID = 'did:plc:qntsxa2i4sb24noi45fx4np2';
export const PROFILE_URL = `https://bsky.app/profile/${ACTOR_HANDLE}`;

/** listRecords page size on the PDS: only posts, so 10 is plenty. */
export const RECORDS_LIMIT = 10;
/** Fallback author feed: atpota.to mostly reposts, so one page of 10 rarely holds an original post. */
export const PAGE_LIMIT = 100;
export const MAX_PAGES = 2;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_POST_CHARS = 280;

const CACHE_KEY = 'atpotato:latest-feed';
const CACHE_TTL_MS = 10 * 60 * 1000;
const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;
const POST_URI_RE = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/;

export interface LatestPost {
  /** Post text, already trimmed and truncated. May be empty for media-only posts. */
  text: string;
  /** ISO timestamp used for the relative date. */
  createdAt: string;
  /** Record key of the post. */
  rkey: string;
  /** Short note about an attachment ("with a quoted post"), or "". */
  embed: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** https://bsky.app/profile/atpota.to/post/<rkey> for a validated record key. */
export function postUrl(rkey: string): string {
  if (!RKEY_RE.test(rkey)) throw new Error('bad rkey');
  return `${PROFILE_URL}/post/${encodeURIComponent(rkey)}`;
}

function graphemes(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter('en', { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * Trim, tidy blank lines and cut to `max` characters (grapheme-safe), preferring a
 * word boundary near the end, then add an ellipsis.
 */
export function truncateText(input: string, max = MAX_POST_CHARS): string {
  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  let cut = parts.slice(0, max).join('');
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > cut.length - 40 && lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s.,;:!?-]+$/u, '')}…`;
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.34524],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

/** "just now", "5 minutes ago", "yesterday", "last week", "3 months ago", ... */
export function relativeTime(date: Date, now: Date = new Date()): string {
  let delta = (date.getTime() - now.getTime()) / 1000;
  if (!Number.isFinite(delta)) return '';
  if (delta > -45) return 'just now';
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_STEPS) {
    // Round first, so 59.6 seconds rolls over to "1 minute ago", not "60 seconds ago".
    const rounded = Math.round(delta);
    if (Math.abs(rounded) < size) return format.format(rounded, unit);
    delta /= size;
  }
  return '';
}

function embedNote(embed: unknown): string {
  if (!isObject(embed)) return '';
  const type = str(embed.$type) ?? '';
  if (type.startsWith('app.bsky.embed.recordWithMedia')) {
    const media = embedNote(embed.media);
    return media ? `${media} and a quoted post` : 'with a quoted post';
  }
  if (type.startsWith('app.bsky.embed.images')) {
    const count = Array.isArray(embed.images) ? embed.images.length : 1;
    return count > 1 ? `with ${count} images` : 'with an image';
  }
  if (type.startsWith('app.bsky.embed.video')) return 'with a video';
  if (type.startsWith('app.bsky.embed.external')) return 'with a link';
  if (type.startsWith('app.bsky.embed.record')) return 'with a quoted post';
  return '';
}

/** Identity is the DID (stable across handle and PDS changes), never the handle alone. */
function isOurs(author: unknown, uriDid: string): boolean {
  if (!isObject(author) || uriDid !== ACTOR_DID) return false;
  const did = str(author.did);
  return did === undefined || did === ACTOR_DID;
}

function pickDate(record: Json, post: Json, now: Date): string | undefined {
  const created = Date.parse(str(record.createdAt) ?? '');
  const indexed = Date.parse(str(post.indexedAt) ?? '');
  // Clients set createdAt; fall back to the AppView's indexedAt when it is missing or in the future.
  const ok = (t: number) => Number.isFinite(t) && t <= now.getTime() + 5 * 60 * 1000;
  if (ok(created)) return new Date(created).toISOString();
  if (ok(indexed)) return new Date(indexed).toISOString();
  return undefined;
}

/** The newest original post by atpota.to in a getAuthorFeed response, or null. */
export function pickLatestPost(response: unknown, now: Date = new Date()): LatestPost | null {
  if (!isObject(response) || !Array.isArray(response.feed)) return null;
  for (const item of response.feed) {
    if (!isObject(item) || item.reason !== undefined) continue; // reposts (and pins) carry a reason
    const post = item.post;
    if (!isObject(post) || !isObject(post.record)) continue;
    const record = post.record;
    if (record.$type !== undefined && record.$type !== 'app.bsky.feed.post') continue;
    if (record.reply !== undefined) continue;
    const match = POST_URI_RE.exec(str(post.uri) ?? '');
    if (!match) continue;
    const [, uriDid = '', rkey = ''] = match;
    if (!RKEY_RE.test(rkey) || !isOurs(post.author, uriDid)) continue;
    const createdAt = pickDate(record, post, now);
    if (!createdAt) continue;
    const text = truncateText(str(record.text) ?? '');
    const embed = embedNote(post.embed ?? record.embed);
    if (!text && !embed) continue;
    return { text, createdAt, rkey, embed };
  }
  return null;
}

/** The newest original post by atpota.to in a com.atproto.repo.listRecords response, or null. */
export function pickLatestRecord(response: unknown, now: Date = new Date()): LatestPost | null {
  if (!isObject(response) || !Array.isArray(response.records)) return null;
  for (const item of response.records) {
    if (!isObject(item) || !isObject(item.value)) continue;
    const record = item.value;
    if (record.$type !== 'app.bsky.feed.post' || record.reply !== undefined) continue;
    const match = POST_URI_RE.exec(str(item.uri) ?? '');
    if (!match) continue;
    const [, uriDid = '', rkey = ''] = match;
    if (uriDid !== ACTOR_DID || !RKEY_RE.test(rkey)) continue;
    const createdAt = pickDate(record, {}, now);
    if (!createdAt) continue;
    const text = truncateText(str(record.text) ?? '');
    const embed = embedNote(record.embed);
    if (!text && !embed) continue;
    return { text, createdAt, rkey, embed };
  }
  return null;
}

export function feedUrl(cursor?: string): string {
  const url = new URL(FEED_ENDPOINT);
  url.searchParams.set('actor', ACTOR_HANDLE);
  url.searchParams.set('filter', 'posts_no_replies');
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

export function listRecordsUrl(pds: string, cursor?: string): string {
  const url = new URL('/xrpc/com.atproto.repo.listRecords', pds);
  url.searchParams.set('repo', ACTOR_DID);
  url.searchParams.set('collection', 'app.bsky.feed.post');
  url.searchParams.set('limit', String(RECORDS_LIMIT));
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

/** The PDS origin from a DID document, or null when it is missing or not a plain https URL. */
export function pdsFromDidDoc(doc: unknown): string | null {
  if (!isObject(doc) || doc.id !== ACTOR_DID || !Array.isArray(doc.service)) return null;
  for (const service of doc.service) {
    if (!isObject(service) || service.type !== 'AtprotoPersonalDataServer') continue;
    const id = str(service.id) ?? '';
    if (id !== '#atproto_pds' && id !== `${ACTOR_DID}#atproto_pds`) continue;
    let url: URL;
    try {
      url = new URL(str(service.serviceEndpoint) ?? '');
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
    return url.origin;
  }
  return null;
}

async function getJson(fetchImpl: typeof fetch, url: string, signal: AbortSignal, label: string): Promise<unknown> {
  const res = await fetchImpl(url, {
    signal,
    headers: { accept: 'application/json' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!res.ok) throw new Error(`${label} ${res.status}`);
  return res.json();
}

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Walk up to MAX_PAGES of `pageUrl`, picking with `pick`. Resolves null when no original post is found. */
async function walkPages(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  label: string,
  pageUrl: (cursor?: string) => string,
  pick: (data: unknown) => LatestPost | null,
): Promise<LatestPost | null> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson(fetchImpl, pageUrl(cursor), signal, label);
    const post = pick(data);
    if (post) return post;
    cursor = isObject(data) ? str(data.cursor) : undefined;
    if (!cursor) break;
  }
  return null;
}

/** Resolve the PDS from plc.directory, then read the newest posts straight from the repo. */
export function fetchLatestFromPds(fetchImpl: typeof fetch = fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<LatestPost | null> {
  return withTimeout(timeoutMs, async (signal) => {
    const pds = pdsFromDidDoc(await getJson(fetchImpl, `${PLC_DIRECTORY}/${ACTOR_DID}`, signal, 'plc'));
    if (!pds) throw new Error('no pds');
    return walkPages(fetchImpl, signal, 'pds', (cursor) => listRecordsUrl(pds, cursor), (data) => pickLatestRecord(data));
  });
}

/** The heavier fallback: the public AppView's author feed. */
export function fetchLatestFromFeed(fetchImpl: typeof fetch = fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<LatestPost | null> {
  return withTimeout(timeoutMs, (signal) => walkPages(fetchImpl, signal, 'feed', feedUrl, (data) => pickLatestPost(data)));
}

/** The PDS path first; the author feed only when that fails or finds nothing. */
export async function fetchLatestPost(fetchImpl: typeof fetch = fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<LatestPost | null> {
  try {
    const post = await fetchLatestFromPds(fetchImpl, timeoutMs);
    if (post) return post;
  } catch {
    // fall through to the AppView
  }
  return fetchLatestFromFeed(fetchImpl, timeoutMs);
}

export type SourceId = 'atpotato' | 'poe' | 'anisota' | 'aturi' | 'dispatch';

/** One entry in the unified feed, as /api/latest sends it (server/latest.ts). */
export interface FeedItem {
  source: SourceId;
  kind: 'post' | 'article';
  text: string;
  title: string | null;
  embed: string;
  createdAt: string;
  url: string;
}

export const LATEST_ENDPOINT = '/api/latest';
export const MAX_ITEMS = 6;

/** The chip on each item: who posted it. */
export const SOURCE_LABELS: Readonly<Record<SourceId, string>> = {
  atpotato: '@atpota.to',
  poe: '@poe.atpota.to',
  anisota: '@anisota.net',
  aturi: '@aturi.to',
  dispatch: "poe's dispatch",
};

const BSKY_POST_RE = /^https:\/\/bsky\.app\/profile\/[a-z0-9.-]+\/post\/[A-Za-z0-9._:~%-]{1,512}$/;
const BLOG_PATH_RE = /^\/blog\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,500}$/;

/** Only links to a Bluesky post or a page under /blog; anything else from the API is dropped. */
export function safeItemUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return BSKY_POST_RE.test(url) || (BLOG_PATH_RE.test(url) && !url.includes('//')) ? url : null;
}

export function toFeedItem(value: unknown): FeedItem | null {
  if (!isObject(value)) return null;
  const source = str(value.source);
  if (!source || !Object.hasOwn(SOURCE_LABELS, source)) return null;
  const kind = value.kind === 'article' ? 'article' : value.kind === 'post' ? 'post' : null;
  const url = safeItemUrl(value.url);
  const createdAt = str(value.createdAt) ?? '';
  if (!kind || !url || !Number.isFinite(Date.parse(createdAt))) return null;
  const text = str(value.text) ?? '';
  const title = str(value.title) ?? null;
  const embed = str(value.embed) ?? '';
  if (text.length > MAX_POST_CHARS * 2 || (title?.length ?? 0) > 300 || embed.length > 80) return null;
  if (!text && !title && !embed) return null;
  return { source: source as SourceId, kind, text, title, embed, createdAt, url };
}

/** The valid items of an /api/latest response, newest first, or null when there are none. */
export function parseFeed(body: unknown): FeedItem[] | null {
  if (!isObject(body) || !Array.isArray(body.items)) return null;
  const items = body.items
    .map(toFeedItem)
    .filter((item): item is FeedItem => item !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_ITEMS);
  return items.length ? items : null;
}

/** atpota.to's own newest post, as a one-item feed (the fallback when /api/latest fails). */
export function postToItem(post: LatestPost): FeedItem {
  return { source: 'atpotato', kind: 'post', text: post.text, title: null, embed: post.embed, createdAt: post.createdAt, url: postUrl(post.rkey) };
}

export function fetchFeed(fetchImpl: typeof fetch = fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<FeedItem[] | null> {
  return withTimeout(timeoutMs, async (signal) => {
    const res = await fetchImpl(LATEST_ENDPOINT, { signal, headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`latest ${res.status}`);
    return parseFeed(await res.json());
  });
}

/** The unified feed first; atpota.to's newest post alone when that fails. */
export async function fetchLatestItems(fetchImpl: typeof fetch = fetch): Promise<FeedItem[] | null> {
  try {
    const items = await fetchFeed(fetchImpl);
    if (items) return items;
  } catch {
    // fall through to atpota.to's own repo
  }
  const post = await fetchLatestPost(fetchImpl);
  return post ? [postToItem(post)] : null;
}

export function readCache(now = Date.now()): FeedItem[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (!isObject(data) || typeof data.at !== 'number' || now - data.at > CACHE_TTL_MS || now < data.at) return null;
    return parseFeed({ items: data.items });
  } catch {
    return null;
  }
}

export function writeCache(items: FeedItem[], now = Date.now()): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, items }));
  } catch {
    /* storage full or blocked: not important */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderItem(item: FeedItem, now: Date): HTMLLIElement {
  const li = el('li', `home-feed__item home-feed__item--${item.source}`);
  const meta = el('p', 'home-feed__meta');
  meta.append(el('span', 'home-feed__source', SOURCE_LABELS[item.source]));
  const link = el('a', 'home-feed__link');
  link.href = item.url;
  const date = new Date(item.createdAt);
  const time = document.createElement('time');
  time.dateTime = item.createdAt;
  time.textContent = relativeTime(date, now) || date.toLocaleDateString('en', { dateStyle: 'medium' });
  time.title = date.toLocaleString('en', { dateStyle: 'long', timeStyle: 'short' });
  const where = item.kind === 'article' ? 'read it in the dispatch' : 'open the post on bluesky';
  link.append(el('span', 'visually-hidden', `${where}, posted `), time);
  meta.append(link);
  if (item.embed) meta.append(el('span', 'home-feed__embed', item.embed));
  li.append(meta);
  if (item.title) li.append(el('p', 'home-feed__title', item.title));
  if (item.text) {
    const text = el('p', 'home-feed__text', item.text);
    text.dir = 'auto';
    li.append(text);
  }
  return li;
}

/** Fill the tile with the feed. textContent only; links come from safeItemUrl(). */
export function renderItems(tile: HTMLElement, items: readonly FeedItem[], now: Date = new Date()): void {
  const list = tile.querySelector<HTMLElement>('[data-latest-list]');
  if (list) {
    list.replaceChildren(...items.map((item) => renderItem(item, now)));
    list.hidden = false;
  }
  tile.querySelector('[data-latest-post]')?.setAttribute('aria-busy', 'false');
  tile.dataset.state = 'ready';
  startClock(tile);
}

const CLOCK_MS = 30_000;
const clocks = new WeakSet<HTMLElement>();

/** Re-reads every relative date in the tile every 30 seconds while the page is visible. */
function startClock(tile: HTMLElement): void {
  if (clocks.has(tile)) return;
  clocks.add(tile);
  window.setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    for (const time of tile.querySelectorAll<HTMLTimeElement>('time[datetime]')) {
      const next = relativeTime(new Date(time.dateTime));
      if (next && next !== time.textContent) time.textContent = next;
    }
  }, CLOCK_MS);
}

export function renderError(tile: HTMLElement): void {
  const fallback = tile.querySelector<HTMLElement>('[data-latest-fallback]');
  if (fallback) fallback.textContent = "couldn't dig up the latest just now. it's all waiting for you on bluesky.";
  tile.querySelector('[data-latest-post]')?.setAttribute('aria-busy', 'false');
  tile.dataset.state = 'error';
}

export async function loadLatest(tile: HTMLElement, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const items = await fetchLatestItems(fetchImpl);
    if (!items) {
      renderError(tile);
      return;
    }
    writeCache(items);
    renderItems(tile, items);
  } catch {
    renderError(tile);
  }
}

/** Start loading when the tile is close to the viewport, so it never competes with the hero. */
function whenNear(el: Element, run: () => void): void {
  if (!('IntersectionObserver' in window)) {
    run();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        run();
      }
    },
    { rootMargin: '600px 0px' },
  );
  observer.observe(el);
}

/** What the feed says while it loads; one is picked per page load. */
export const LOADING_LINES: readonly string[] = [
  'digging up the latest…',
  'peeling back the soil…',
  'asking the other potatoes…',
  'fishing in the firehose…',
  'checking under the leaves…',
  'mashing the timeline…',
];

export function initLatest(root: ParentNode = document, fetchImpl: typeof fetch = fetch, random: () => number = Math.random): void {
  const tile = root.querySelector<HTMLElement>('[data-latest]');
  if (!tile || tile.dataset.latestBound === 'true') return;
  tile.dataset.latestBound = 'true';
  // aria-busy is only set from JS: without JS the fallback line is the content.
  tile.querySelector('[data-latest-post]')?.setAttribute('aria-busy', 'true');
  const loading = tile.querySelector<HTMLElement>('[data-latest-loading]');
  if (loading) loading.textContent = LOADING_LINES[Math.floor(random() * LOADING_LINES.length)] ?? LOADING_LINES[0]!;
  const cached = readCache();
  if (cached) {
    renderItems(tile, cached);
    return;
  }
  whenNear(tile, () => void loadLatest(tile, fetchImpl));
}

const COPIED_MS = 1800;

/** "copy address" in the say hi tile: a little "copied!" bubble pops out beside it. */
export function initCopyEmail(root: ParentNode = document): void {
  const button = root.querySelector<HTMLButtonElement>('[data-copy-email]');
  if (!button || button.dataset.copyBound === 'true') return;
  button.dataset.copyBound = 'true';
  const tile = button.closest<HTMLElement>('.tile') ?? document.body;
  const bubble = tile.querySelector<HTMLElement>('[data-copy-bubble]');
  const status = tile.querySelector<HTMLElement>('[data-copy-status]');
  const mail = tile.querySelector<HTMLElement>('.home-hi__mail');
  const address = button.dataset.copyEmail ?? '';
  let hideTimer: number | undefined;

  const show = (bubbleText: string, statusText: string) => {
    if (bubble) {
      bubble.textContent = bubbleText;
      bubble.classList.add('is-showing');
    }
    if (status) status.textContent = statusText;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      bubble?.classList.remove('is-showing');
    }, COPIED_MS);
  };

  // Clipboard refused (older browsers, some in-app views): select it for a manual copy.
  const selectInstead = () => {
    const selection = window.getSelection();
    if (mail && selection) {
      const range = document.createRange();
      range.selectNodeContents(mail);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    show('selected it for you', 'address selected, ready to copy');
  };

  button.addEventListener('click', () => {
    try {
      navigator.clipboard.writeText(address).then(() => show('copied! (◕‿◕)', 'address copied'), selectInstead);
    } catch {
      selectInstead();
    }
  });
}

/** The garden tile (garden-teaser.ts) fills in its count and map once it's close. */
export function initGardenTeaserWhenNear(root: ParentNode = document): void {
  const tile = root.querySelector<HTMLElement>('[data-garden-teaser]');
  if (!tile) return;
  whenNear(tile, () => void import('./garden-teaser').then((m) => m.initGardenTeaser(tile)).catch(() => undefined));
}

export function init(): void {
  initLatest();
  initCopyEmail();
  initPet();
  initWeather();
  initGardenTeaserWhenNear();
}
