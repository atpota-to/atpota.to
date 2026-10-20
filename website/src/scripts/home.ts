/**
 * Home page behaviour (spec 3.1). main.ts imports this module when
 * <body data-page="home"> and calls init() once.
 *
 * "latest on bluesky" tile: shows atpota.to's newest original post (replies,
 * reposts and other authors are skipped). It reads the account's own repo:
 * the DID document from plc.directory names the PDS, and one
 * com.atproto.repo.listRecords page of app.bsky.feed.post records (newest
 * first) holds the post, a few KB in all. Reposts live in another collection,
 * so they never get in the way. Only if that path fails does it fall back to
 * the public AppView's author feed, which needs a page of 100 (about 90 KB
 * gzipped) because atpota.to mostly reposts.
 *
 * Fetched text only ever reaches the DOM through textContent; links are built
 * from a validated record key. States live on the tile as
 * data-state="loading" | "ready" | "error" (CSS shows the skeleton, the post or
 * the fallback line). Once a post shows, its "5 minutes ago" keeps itself current.
 *
 * Also here: the "say hi" tile's copy button, and the hero Poe (pet.ts).
 */

import { MASCOT_URLS } from './mascot';
import { initPet } from './pet';

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

const CACHE_KEY = 'atpotato:latest-post';
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

function isLatestPost(value: unknown): value is LatestPost {
  return (
    isObject(value) &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_POST_CHARS * 8 &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.rkey === 'string' &&
    RKEY_RE.test(value.rkey) &&
    typeof value.embed === 'string' &&
    value.embed.length <= 80
  );
}

export function readCache(now = Date.now()): LatestPost | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (!isObject(data) || typeof data.at !== 'number' || now - data.at > CACHE_TTL_MS || now < data.at) return null;
    return isLatestPost(data.post) ? data.post : null;
  } catch {
    return null;
  }
}

export function writeCache(post: LatestPost, now = Date.now()): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, post }));
  } catch {
    /* storage full or blocked: not important */
  }
}

/** Fill the tile with a post. textContent only; the link comes from postUrl(). */
export function renderPost(tile: HTMLElement, post: LatestPost, now: Date = new Date()): void {
  const text = tile.querySelector<HTMLElement>('[data-latest-text]');
  const embed = tile.querySelector<HTMLElement>('[data-latest-embed]');
  const embedWrap = tile.querySelector<HTMLElement>('[data-latest-embed-wrap]');
  const meta = tile.querySelector<HTMLElement>('[data-latest-meta]');
  const link = tile.querySelector<HTMLAnchorElement>('[data-latest-link]');
  const time = tile.querySelector<HTMLTimeElement>('[data-latest-time]');
  const article = tile.querySelector<HTMLElement>('[data-latest-post]');

  if (text) {
    text.textContent = post.text;
    text.hidden = post.text === '';
  }
  if (embed) embed.textContent = post.embed;
  if (embedWrap) embedWrap.hidden = post.embed === '';
  if (link) link.href = postUrl(post.rkey);
  if (time) {
    const date = new Date(post.createdAt);
    time.dateTime = post.createdAt;
    time.textContent = relativeTime(date, now) || date.toLocaleDateString('en', { dateStyle: 'medium' });
    time.title = date.toLocaleString('en', { dateStyle: 'long', timeStyle: 'short' });
  }
  if (meta) meta.hidden = false;
  article?.setAttribute('aria-busy', 'false');
  tile.dataset.state = 'ready';
  if (time) startClock(time);
}

const CLOCK_MS = 30_000;
const clocks = new WeakSet<HTMLTimeElement>();

/** Re-reads the relative date every 30 seconds while the page is visible. */
function startClock(time: HTMLTimeElement): void {
  if (clocks.has(time)) return;
  clocks.add(time);
  window.setInterval(() => {
    if (document.visibilityState === 'hidden' || !time.isConnected) return;
    const date = new Date(time.dateTime);
    const next = relativeTime(date);
    if (next && next !== time.textContent) time.textContent = next;
  }, CLOCK_MS);
}

export function renderError(tile: HTMLElement): void {
  const fallback = tile.querySelector<HTMLElement>('[data-latest-fallback]');
  if (fallback) fallback.textContent = "couldn't dig up the latest post just now. it's waiting for you on bluesky.";
  const avatar = tile.querySelector<HTMLImageElement>('[data-latest-avatar]');
  if (avatar) avatar.src = MASCOT_URLS.sleepy;
  tile.querySelector('[data-latest-post]')?.setAttribute('aria-busy', 'false');
  tile.dataset.state = 'error';
}

export async function loadLatest(tile: HTMLElement, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const post = await fetchLatestPost(fetchImpl);
    if (!post) {
      renderError(tile);
      return;
    }
    writeCache(post);
    renderPost(tile, post);
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

export function initLatest(root: ParentNode = document, fetchImpl: typeof fetch = fetch): void {
  const tile = root.querySelector<HTMLElement>('[data-latest]');
  if (!tile || tile.dataset.latestBound === 'true') return;
  tile.dataset.latestBound = 'true';
  // aria-busy is only set from JS: without JS the fallback line is the content.
  tile.querySelector('[data-latest-post]')?.setAttribute('aria-busy', 'true');
  const cached = readCache();
  if (cached) {
    renderPost(tile, cached);
    return;
  }
  whenNear(tile, () => void loadLatest(tile, fetchImpl));
}

const COPIED_MS = 1800;

/** "copy address" in the say hi tile: the wink potato hops and says so. */
export function initCopyEmail(root: ParentNode = document): void {
  const button = root.querySelector<HTMLButtonElement>('[data-copy-email]');
  if (!button || button.dataset.copyBound === 'true') return;
  button.dataset.copyBound = 'true';
  const tile = button.closest<HTMLElement>('.tile') ?? document.body;
  const bubble = tile.querySelector<HTMLElement>('[data-copy-bubble]');
  const status = tile.querySelector<HTMLElement>('[data-copy-status]');
  const potato = tile.querySelector<HTMLElement>('[data-copy-potato]');
  const mail = tile.querySelector<HTMLElement>('.home-hi__mail');
  const address = button.dataset.copyEmail ?? '';
  let hideTimer: number | undefined;

  const show = (bubbleText: string, statusText: string) => {
    if (bubble) {
      bubble.textContent = bubbleText;
      bubble.classList.add('is-showing');
    }
    if (status) status.textContent = statusText;
    if (potato) {
      potato.classList.remove('is-hopping');
      void potato.offsetWidth;
      potato.classList.add('is-hopping');
    }
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      bubble?.classList.remove('is-showing');
      potato?.classList.remove('is-hopping');
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

export function init(): void {
  initLatest();
  initCopyEmail();
  initPet();
}
