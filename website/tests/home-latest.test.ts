// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTOR_DID,
  MAX_PAGES,
  PAGE_LIMIT,
  RECORDS_LIMIT,
  fetchLatestFromFeed,
  fetchLatestPost,
  feedUrl,
  initLatest,
  listRecordsUrl,
  loadLatest,
  pdsFromDidDoc,
  pickLatestPost,
  pickLatestRecord,
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

  it('rolls over to the next unit at the boundaries instead of "60 seconds" or "7 days"', () => {
    expect(ago(59_600)).toBe('1 minute ago');
    expect(ago(3599_000)).toBe('1 hour ago');
    expect(ago(86_000_000)).toBe('yesterday');
    expect(ago(6.6 * 86400_000)).toBe('last week');
    expect(ago(360 * 86400_000)).toBe('last year');
    // clearly inside a unit, nothing changes
    expect(ago(58_000)).toBe('58 seconds ago');
    expect(ago(6.4 * 86400_000)).toBe('6 days ago');
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

/* The shapes below are trimmed from live responses (plc.directory and pds.atpota.to, 2026-10-19). */

const DID_DOC = {
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: ACTOR_DID,
  alsoKnownAs: ['at://atpota.to'],
  service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.atpota.to' }],
};

function rec(rkey: string, value: Record<string, unknown>, did = ACTOR_DID): Record<string, unknown> {
  return {
    uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    cid: 'bafyreib',
    value: { $type: 'app.bsky.feed.post', text: '', createdAt: '2026-09-01T15:15:33.114Z', langs: ['en'], ...value },
  };
}

const replyRef = {
  root: { cid: 'bafyreic', uri: `at://${OTHER_DID}/app.bsky.feed.post/3root` },
  parent: { cid: 'bafyreic', uri: `at://${OTHER_DID}/app.bsky.feed.post/3root` },
};

const LIST_RECORDS = {
  records: [
    rec('3mushqmlan22r', { text: 'did someone say potatoes?', createdAt: '2026-09-05T21:54:16.765Z', reply: replyRef }),
    rec('3muhplxef6k2d', { embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://x.example', title: 't', description: '' } }, reply: replyRef }),
    rec('3morf2ftw6k2m', {
      text: 'potato in the machine',
      createdAt: '2026-06-21T03:02:14.522Z',
      embed: { $type: 'app.bsky.embed.record', record: { cid: 'bafyreid', uri: `at://${OTHER_DID}/app.bsky.feed.post/3quoted` } },
    }),
    rec('3mn3mpvrul22z', { text: 'wtf', createdAt: '2026-05-30T17:55:46.197Z' }),
  ],
  cursor: '3mf5lczzu2g2y',
};

type Route = (url: URL) => Response | Promise<Response>;

/** A fetch that routes by host: plc.directory, the PDS and the AppView. */
function router(routes: { plc?: Route; pds?: Route; feed?: Route }) {
  const calls: URL[] = [];
  const fail = () => jsonResponse({ error: 'not here' }, 404);
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.host === 'plc.directory') return (routes.plc ?? fail)(url);
    if (url.host === 'pds.atpota.to') return (routes.pds ?? fail)(url);
    if (url.host === 'public.api.bsky.app') return (routes.feed ?? fail)(url);
    return fail();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('pickLatestRecord (listRecords on the PDS)', () => {
  it('skips replies and returns the newest original post, noting a quote post', () => {
    expect(pickLatestRecord(LIST_RECORDS, NOW)).toEqual({
      text: 'potato in the machine',
      createdAt: '2026-06-21T03:02:14.522Z',
      rkey: '3morf2ftw6k2m',
      embed: 'with a quoted post',
    });
  });

  it('describes record-shaped embeds (images, quote with media)', () => {
    const imgs = pickLatestRecord({ records: [rec('a', { embed: { $type: 'app.bsky.embed.images', images: [{}, {}] } })] }, NOW);
    expect(imgs).toMatchObject({ text: '', embed: 'with 2 images' });
    const mixed = pickLatestRecord(
      { records: [rec('b', { text: 'hi', embed: { $type: 'app.bsky.embed.recordWithMedia', media: { $type: 'app.bsky.embed.images', images: [{}] }, record: {} } })] },
      NOW,
    );
    expect(mixed?.embed).toBe('with an image and a quoted post');
  });

  it('skips other repos, bad keys, other record types, empty posts and impossible dates', () => {
    const records = [
      null,
      { uri: 'x', value: null },
      rec('theirs', { text: 'not ours' }, OTHER_DID),
      { ...rec('x', { text: 'bad key' }), uri: `at://${ACTOR_DID}/app.bsky.feed.post/bad%2Fkey` },
      rec('like', { $type: 'app.bsky.feed.like', text: 'nope' }),
      rec('empty', { text: '   ' }),
      rec('future', { text: 'from the future', createdAt: '2099-01-01T00:00:00Z' }),
      rec('ok', { text: 'the real one' }),
    ];
    expect(pickLatestRecord({ records }, NOW)?.rkey).toBe('ok');
    expect(pickLatestRecord({ records: 'x' }, NOW)).toBeNull();
    expect(pickLatestRecord(null, NOW)).toBeNull();
  });
});

describe('pdsFromDidDoc', () => {
  it('reads the #atproto_pds service as a bare https origin', () => {
    expect(pdsFromDidDoc(DID_DOC)).toBe('https://pds.atpota.to');
    const full = { ...DID_DOC, service: [{ ...DID_DOC.service[0], id: `${ACTOR_DID}#atproto_pds`, serviceEndpoint: 'https://pds.atpota.to/' }] };
    expect(pdsFromDidDoc(full)).toBe('https://pds.atpota.to');
  });

  it('rejects other DIDs, missing services and unsafe endpoints', () => {
    expect(pdsFromDidDoc({ ...DID_DOC, id: OTHER_DID })).toBeNull();
    expect(pdsFromDidDoc({ ...DID_DOC, service: [] })).toBeNull();
    expect(pdsFromDidDoc(null)).toBeNull();
    for (const serviceEndpoint of ['http://pds.atpota.to', 'https://user:pw@pds.atpota.to', 'javascript:alert(1)', 'https://localhost', '']) {
      expect(pdsFromDidDoc({ ...DID_DOC, service: [{ ...DID_DOC.service[0], serviceEndpoint }] }), serviceEndpoint).toBeNull();
    }
  });
});

describe('fetchLatestPost', () => {
  it('resolves the PDS and reads one small listRecords page, never touching the AppView', async () => {
    const { fn, calls } = router({ plc: () => jsonResponse(DID_DOC), pds: () => jsonResponse(LIST_RECORDS) });
    const post = await fetchLatestPost(fn);
    expect(post?.rkey).toBe('3morf2ftw6k2m');
    expect(post?.embed).toBe('with a quoted post');
    expect(calls.map((u) => u.host)).toEqual(['plc.directory', 'pds.atpota.to']);
    expect(calls[0]!.pathname).toBe(`/${ACTOR_DID}`);
    expect(calls[1]!.pathname).toBe('/xrpc/com.atproto.repo.listRecords');
    expect(calls[1]!.searchParams.get('repo')).toBe(ACTOR_DID);
    expect(calls[1]!.searchParams.get('collection')).toBe('app.bsky.feed.post');
    expect(calls[1]!.searchParams.get('limit')).toBe(String(RECORDS_LIMIT));
    expect(RECORDS_LIMIT).toBeLessThanOrEqual(10);
    const init = (fn as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }).mock.calls[1]![1];
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('follows the PDS cursor once before giving up on the PDS', async () => {
    const onlyReplies = { records: [rec('r', { text: 'a reply', reply: replyRef })], cursor: 'c1' };
    const { fn, calls } = router({
      plc: () => jsonResponse(DID_DOC),
      pds: (url) => jsonResponse(url.searchParams.get('cursor') === 'c1' ? { records: [rec('older', { text: 'older original' })] } : onlyReplies),
    });
    expect((await fetchLatestPost(fn))?.rkey).toBe('older');
    expect(calls.filter((u) => u.host === 'pds.atpota.to')).toHaveLength(2);
  });

  it('falls back to the author feed when plc.directory or the PDS fails, or the repo has no original post', async () => {
    const feed = () => jsonResponse({ feed: [item({ rkey: 'from-feed' })] });
    const cases = [
      router({ plc: () => jsonResponse({ error: 'x' }, 500), feed }),
      router({ plc: () => jsonResponse({ ...DID_DOC, service: [] }), feed }),
      router({ plc: () => jsonResponse(DID_DOC), pds: () => jsonResponse({ error: 'x' }, 502), feed }),
      router({
        plc: () => jsonResponse(DID_DOC),
        pds: () => {
          throw new TypeError('Failed to fetch');
        },
        feed,
      }),
      router({ plc: () => jsonResponse(DID_DOC), pds: () => jsonResponse({ records: [] }), feed }),
    ];
    for (const { fn, calls } of cases) {
      expect((await fetchLatestPost(fn))?.rkey).toBe('from-feed');
      expect(calls[calls.length - 1]!.host).toBe('public.api.bsky.app');
    }
  });

  it('rejects when both paths fail, and times out a hanging request', async () => {
    const { fn } = router({ feed: () => jsonResponse({ error: 'x' }, 502) });
    await expect(fetchLatestPost(fn)).rejects.toThrow('feed 502');
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(fetchLatestPost(hang, 20)).rejects.toThrow();
  });
});

describe('fetchLatestFromFeed (fallback)', () => {
  it('asks for posts_no_replies with a page of 100 and follows the cursor once', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (calls.length === 1) return jsonResponse({ feed: [item({ reason: repost })], cursor: 'c1' });
      return jsonResponse({ feed: [item({ rkey: 'found' })], cursor: 'c2' });
    }) as unknown as typeof fetch;
    const post = await fetchLatestFromFeed(fetchImpl);
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
    expect(await fetchLatestFromFeed(many)).toBeNull();
    expect(many).toHaveBeenCalledTimes(MAX_PAGES);
    const one = vi.fn(async () => jsonResponse({ feed: [] })) as unknown as typeof fetch;
    expect(await fetchLatestFromFeed(one)).toBeNull();
    expect(one).toHaveBeenCalledTimes(1);
  });

  it('rejects on http errors and on timeout', async () => {
    const bad = vi.fn(async () => jsonResponse({ error: 'x' }, 502)) as unknown as typeof fetch;
    await expect(fetchLatestFromFeed(bad)).rejects.toThrow('feed 502');
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(fetchLatestFromFeed(hang, 20)).rejects.toThrow();
  });

  it('feedUrl and listRecordsUrl encode the cursor', () => {
    expect(new URL(feedUrl('a&b=c')).searchParams.get('cursor')).toBe('a&b=c');
    expect(new URL(listRecordsUrl('https://pds.atpota.to', 'a&b=c')).searchParams.get('cursor')).toBe('a&b=c');
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
    const { fn } = router({ plc: () => jsonResponse(DID_DOC), pds: () => jsonResponse({ records: [rec('cached', { text: 'from cache' })] }) });
    await loadLatest(tile, fn);
    expect(tile.dataset.state).toBe('ready');
    expect(tile.querySelector('[data-latest-text]')!.textContent).toBe('from cache');
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
