// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTOR_DID,
  MAX_PAGES,
  PAGE_LIMIT,
  fetchLatestPost,
  feedUrl,
  initLatest,
  loadLatest,
  pickLatestPost,
  postUrl,
  readCache,
  relativeTime,
  renderError,
  renderPost,
  truncateText,
  writeCache,
  type LatestPost,
} from '../src/scripts/home.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const OTHER_DID = 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj';

function item(opts: {
  rkey?: string;
  did?: string;
  handle?: string;
  text?: string;
  createdAt?: string;
  reason?: unknown;
  reply?: unknown;
  embed?: unknown;
  uri?: string;
  type?: string;
}): Record<string, unknown> {
  const did = opts.did ?? ACTOR_DID;
  const record: Record<string, unknown> = {
    $type: opts.type ?? 'app.bsky.feed.post',
    text: opts.text ?? 'hello from the patch',
    createdAt: opts.createdAt ?? '2026-10-18T12:00:00Z',
  };
  if (opts.reply !== undefined) record.reply = opts.reply;
  const out: Record<string, unknown> = {
    post: {
      uri: opts.uri ?? `at://${did}/app.bsky.feed.post/${opts.rkey ?? '3abc'}`,
      author: { did, handle: opts.handle ?? (did === ACTOR_DID ? 'atpota.to' : 'dame.is') },
      record,
      indexedAt: '2026-10-18T12:00:01Z',
      ...(opts.embed !== undefined ? { embed: opts.embed } : {}),
    },
  };
  if (opts.reason !== undefined) out.reason = opts.reason;
  return out;
}

const repost = { $type: 'app.bsky.feed.defs#reasonRepost', by: { did: ACTOR_DID } };

/** The markup from index.html's latest tile (kept in sync by reading the file). */
function mountTile(): HTMLElement {
  // jsdom gives import.meta.url a non-file scheme, so resolve from the test file's directory.
  const html = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
  const start = html.indexOf('<section class="tile home-latest"');
  const end = html.indexOf('</section>', start) + '</section>'.length;
  expect(start).toBeGreaterThan(0);
  document.body.innerHTML = html.slice(start, end);
  return document.querySelector<HTMLElement>('[data-latest]')!;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('pickLatestPost', () => {
  it('skips reposts and returns the first original post by atpota.to', () => {
    const feed = {
      feed: [
        item({ did: OTHER_DID, rkey: 'r1', reason: repost }),
        item({ rkey: 'pinned', reason: { $type: 'app.bsky.feed.defs#reasonPin' } }),
        item({ rkey: '3morf2ftw6k2m', text: 'potato in the machine' }),
        item({ rkey: 'older', text: 'older post' }),
      ],
    };
    expect(pickLatestPost(feed, NOW)).toEqual({
      text: 'potato in the machine',
      createdAt: '2026-10-18T12:00:00.000Z',
      rkey: '3morf2ftw6k2m',
      embed: '',
    });
  });

  it('skips replies, other authors, non-post records and malformed items', () => {
    const feed = {
      feed: [
        null,
        'nope',
        { post: null },
        { post: { uri: 'x', record: {} } },
        item({ rkey: 'reply', reply: { root: {}, parent: {} } }),
        item({ did: OTHER_DID, rkey: 'theirs' }),
        item({ handle: 'atpota.to', did: OTHER_DID, rkey: 'spoofed-handle' }),
        item({ uri: `at://${OTHER_DID}/app.bsky.feed.post/mismatch` }),
        item({ type: 'app.bsky.feed.like', rkey: 'like' }),
        item({ uri: `at://${ACTOR_DID}/app.bsky.feed.post/bad%2Fkey` }),
        item({ uri: `javascript:alert(1)` }),
        item({ rkey: 'ok', text: 'the real one' }),
      ],
    };
    expect(pickLatestPost(feed, NOW)?.rkey).toBe('ok');
  });

  it('returns null when there is no original post or the shape is wrong', () => {
    expect(pickLatestPost({ feed: [item({ reason: repost })] }, NOW)).toBeNull();
    expect(pickLatestPost({ feed: 'x' }, NOW)).toBeNull();
    expect(pickLatestPost(null, NOW)).toBeNull();
    expect(pickLatestPost([], NOW)).toBeNull();
  });

  it('describes embeds and keeps media-only posts', () => {
    const quote = pickLatestPost({ feed: [item({ embed: { $type: 'app.bsky.embed.record#view' } })] }, NOW);
    expect(quote?.embed).toBe('with a quoted post');
    const imgs = pickLatestPost({ feed: [item({ text: '', embed: { $type: 'app.bsky.embed.images#view', images: [{}, {}] } })] }, NOW);
    expect(imgs).toMatchObject({ text: '', embed: 'with 2 images' });
    const one = pickLatestPost({ feed: [item({ embed: { $type: 'app.bsky.embed.images#view', images: [{}] } })] }, NOW);
    expect(one?.embed).toBe('with an image');
    const mixed = pickLatestPost(
      { feed: [item({ embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: { $type: 'app.bsky.embed.video#view' } } })] },
      NOW,
    );
    expect(mixed?.embed).toBe('with a video and a quoted post');
    expect(pickLatestPost({ feed: [item({ embed: { $type: 'app.bsky.embed.external#view' } })] }, NOW)?.embed).toBe('with a link');
    // empty text and no embed: nothing to show, keep looking
    expect(pickLatestPost({ feed: [item({ text: '   ', rkey: 'empty' }), item({ rkey: 'next' })] }, NOW)?.rkey).toBe('next');
  });

  it('falls back to indexedAt when createdAt is in the future or invalid', () => {
    expect(pickLatestPost({ feed: [item({ createdAt: '2099-01-01T00:00:00Z' })] }, NOW)?.createdAt).toBe('2026-10-18T12:00:01.000Z');
    expect(pickLatestPost({ feed: [item({ createdAt: 'yesterday-ish' })] }, NOW)?.createdAt).toBe('2026-10-18T12:00:01.000Z');
  });
});

describe('truncateText', () => {
  it('leaves short text alone and tidies whitespace', () => {
    expect(truncateText('  hi there  ')).toBe('hi there');
    expect(truncateText('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
  });

  it('cuts long text near a word boundary with an ellipsis', () => {
    const long = 'potato '.repeat(80);
    const out = truncateText(long, 280);
    expect(out.endsWith('…')).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(281);
    expect(out).not.toMatch(/\s…$/);
    expect(out.slice(0, -1).endsWith('potato')).toBe(true);
  });

  it('never splits an emoji or other grapheme cluster', () => {
    const family = '👨‍👩‍👧‍👦';
    const out = truncateText(family.repeat(300), 280);
    expect(out.endsWith('…')).toBe(true);
    const body = out.slice(0, -1);
    expect(body.length % family.length).toBe(0);
    expect(body.replaceAll(family, '')).toBe('');
  });
});

describe('relativeTime', () => {
  const ago = (ms: number) => relativeTime(new Date(NOW.getTime() - ms), NOW);
  it('reads naturally in lowercase', () => {
    expect(ago(10_000)).toBe('just now');
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
    expect(ago(3 * 3600_000)).toBe('3 hours ago');
    expect(ago(24 * 3600_000)).toBe('yesterday');
    expect(ago(3 * 86400_000)).toBe('3 days ago');
    expect(ago(8 * 86400_000)).toBe('last week');
    expect(ago(120 * 86400_000)).toBe('4 months ago');
    expect(ago(800 * 86400_000)).toBe('2 years ago');
    expect(relativeTime(new Date('nope'), NOW)).toBe('');
  });
});

describe('postUrl', () => {
  it('builds bsky.app links from valid record keys only', () => {
    expect(postUrl('3morf2ftw6k2m')).toBe('https://bsky.app/profile/atpota.to/post/3morf2ftw6k2m');
    expect(() => postUrl('../../evil')).toThrow();
    expect(() => postUrl('a b')).toThrow();
    expect(() => postUrl('')).toThrow();
  });
});

describe('fetchLatestPost', () => {
  it('asks for posts_no_replies with a page of 100 and follows the cursor once', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (calls.length === 1) return jsonResponse({ feed: [item({ reason: repost })], cursor: 'c1' });
      return jsonResponse({ feed: [item({ rkey: 'found' })], cursor: 'c2' });
    }) as unknown as typeof fetch;
    const post = await fetchLatestPost(fetchImpl);
    expect(post?.rkey).toBe('found');
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!);
    expect(first.origin + first.pathname).toBe('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
    expect(first.searchParams.get('actor')).toBe('atpota.to');
    expect(first.searchParams.get('filter')).toBe('posts_no_replies');
    expect(first.searchParams.get('limit')).toBe(String(PAGE_LIMIT));
    expect(new URL(calls[1]!).searchParams.get('cursor')).toBe('c1');
  });

  it(`stops after ${MAX_PAGES} pages and when there is no cursor`, async () => {
    const many = vi.fn(async () => jsonResponse({ feed: [item({ reason: repost })], cursor: 'more' })) as unknown as typeof fetch;
    expect(await fetchLatestPost(many)).toBeNull();
    expect(many).toHaveBeenCalledTimes(MAX_PAGES);
    const one = vi.fn(async () => jsonResponse({ feed: [] })) as unknown as typeof fetch;
    expect(await fetchLatestPost(one)).toBeNull();
    expect(one).toHaveBeenCalledTimes(1);
  });

  it('rejects on http errors and on timeout', async () => {
    const bad = vi.fn(async () => jsonResponse({ error: 'x' }, 502)) as unknown as typeof fetch;
    await expect(fetchLatestPost(bad)).rejects.toThrow('feed 502');
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(fetchLatestPost(hang, 20)).rejects.toThrow();
  });

  it('feedUrl encodes the cursor', () => {
    expect(new URL(feedUrl('a&b=c')).searchParams.get('cursor')).toBe('a&b=c');
  });
});

describe('rendering', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders text with textContent only, so markup in a post stays text', () => {
    const tile = mountTile();
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> & <b>bold</b>';
    renderPost(tile, { text: evil, createdAt: '2026-10-18T12:00:00.000Z', rkey: '3abc', embed: '<i>x</i>' }, NOW);
    const text = tile.querySelector('[data-latest-text]')!;
    expect(text.textContent).toBe(evil);
    expect(text.children).toHaveLength(0);
    expect(tile.querySelector('[data-latest-embed]')!.textContent).toBe('<i>x</i>');
    expect(tile.querySelectorAll('img:not([data-latest-avatar]), script, b, i')).toHaveLength(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(tile.dataset.state).toBe('ready');
    expect(tile.querySelector<HTMLAnchorElement>('[data-latest-link]')!.href).toBe('https://bsky.app/profile/atpota.to/post/3abc');
    const time = tile.querySelector<HTMLTimeElement>('[data-latest-time]')!;
    expect(time.dateTime).toBe('2026-10-18T12:00:00.000Z');
    expect(time.textContent).toBe('yesterday');
    expect(tile.querySelector<HTMLElement>('[data-latest-meta]')!.hidden).toBe(false);
    expect(tile.querySelector('[data-latest-post]')!.getAttribute('aria-busy')).toBe('false');
  });

  it('hides empty text and the embed note when there is none', () => {
    const tile = mountTile();
    renderPost(tile, { text: '', createdAt: '2026-10-18T12:00:00.000Z', rkey: '3abc', embed: 'with an image' }, NOW);
    expect(tile.querySelector<HTMLElement>('[data-latest-text]')!.hidden).toBe(true);
    expect(tile.querySelector<HTMLElement>('[data-latest-embed-wrap]')!.hidden).toBe(false);
    renderPost(tile, { text: 'hi', createdAt: '2026-10-18T12:00:00.000Z', rkey: '3abc', embed: '' }, NOW);
    expect(tile.querySelector<HTMLElement>('[data-latest-embed-wrap]')!.hidden).toBe(true);
  });

  it('error state keeps a friendly fallback and the follow button', () => {
    const tile = mountTile();
    renderError(tile);
    expect(tile.dataset.state).toBe('error');
    expect(tile.querySelector('[data-latest-fallback]')!.textContent).toMatch(/bluesky/);
    expect(tile.querySelector<HTMLAnchorElement>('.home-latest__follow')!.href).toBe('https://bsky.app/profile/atpota.to');
  });

  it('loadLatest shows the fallback when the network fails or nothing is found', async () => {
    let tile = mountTile();
    await loadLatest(tile, (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    expect(tile.dataset.state).toBe('error');

    tile = mountTile();
    await loadLatest(tile, (async () => jsonResponse({ feed: [] })) as unknown as typeof fetch);
    expect(tile.dataset.state).toBe('error');
  });

  it('loadLatest caches a found post and initLatest renders from the cache without fetching', async () => {
    let tile = mountTile();
    await loadLatest(tile, (async () => jsonResponse({ feed: [item({ rkey: 'cached', text: 'from cache' })] })) as unknown as typeof fetch);
    expect(tile.dataset.state).toBe('ready');
    expect(readCache()?.rkey).toBe('cached');

    tile = mountTile();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    initLatest(document, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tile.dataset.state).toBe('ready');
    expect(tile.querySelector('[data-latest-text]')!.textContent).toBe('from cache');
  });
});

describe('cache', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const post: LatestPost = { text: 'hi', createdAt: '2026-10-18T12:00:00.000Z', rkey: '3abc', embed: '' };

  it('expires after ten minutes and ignores tampered entries', () => {
    writeCache(post, 1_000_000);
    expect(readCache(1_000_000 + 60_000)).toEqual(post);
    expect(readCache(1_000_000 + 11 * 60_000)).toBeNull();
    sessionStorage.setItem('atpotato:latest-post', JSON.stringify({ at: 1_000_000, post: { ...post, rkey: '../x' } }));
    expect(readCache(1_000_001)).toBeNull();
    sessionStorage.setItem('atpotato:latest-post', '{not json');
    expect(readCache(1_000_001)).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeCache(post)).not.toThrow();
    expect(readCache()).toBeNull();
  });
});
