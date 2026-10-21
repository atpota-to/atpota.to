import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { applyPartials } from '../build/partials.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ATPOTATO_DID, parseHiddenComments, POE_DID, readBlogConfig } from '../server/blog/config.js';
import {
  CONSTELLATION,
  loadDiscussion,
  resetDiscussionCaches,
  SLINGSHOT,
  threads,
  type BlogComment,
} from '../server/blog/discussion.js';
import { resetEmbedCaches } from '../server/blog/embeds.js';
import { createBlogHandlers } from '../server/blog/handler.js';
import { commentHtml, discussionHtml, siteInfo } from '../server/blog/pages.js';
import type { BlogDocument } from '../server/blog/records.js';

// Comments and recommends under a post (server/blog/discussion.ts) and how they render.
// Constellation, Slingshot, the AppView and the owner's PDS are a scripted fake fetch.

const DOC = `at://${ATPOTATO_DID}/site.standard.document/3doc`;
const PUB = `at://${ATPOTATO_DID}/site.standard.publication/3pub`;
const OWNER = { did: ATPOTATO_DID, pds: 'https://pds.atpota.to', handle: 'atpota.to' };
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';
const SPAMMER = 'did:plc:ssssssssssssssssssssssss';
const GONE = 'did:plc:gggggggggggggggggggggggg';

const uri = (did: string, rkey: string) => `at://${did}/pub.leaflet.comment/${rkey}`;

interface FakeComment {
  did: string;
  rkey: string;
  value: Record<string, unknown>;
}

interface Net {
  comments: FakeComment[];
  profiles: Record<string, Record<string, unknown>>;
  blocks: string[];
  recommends?: number;
  constellationDown?: boolean;
  appviewDown?: boolean;
  slingshotMissing?: string[];
  hang?: boolean;
  pageSize?: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(net: Net, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.href);
    if (net.hang) return new Promise<Response>(() => undefined);
    if (url.origin === CONSTELLATION) {
      if (net.constellationDown) return new Response('down', { status: 502 });
      if (url.pathname === '/links/count/distinct-dids') {
        expect(url.searchParams.get('collection')).toBe('site.standard.graph.recommend');
        expect(url.searchParams.get('path')).toBe('.document');
        return json({ total: net.recommends ?? 0 });
      }
      expect(url.pathname).toBe('/links');
      expect(url.searchParams.get('target')).toBe(DOC);
      expect(url.searchParams.get('collection')).toBe('pub.leaflet.comment');
      expect(url.searchParams.get('path')).toBe('.subject');
      const size = net.pageSize ?? 100;
      const start = Number(url.searchParams.get('cursor') ?? '0');
      const page = net.comments.slice(start, start + size);
      const next = start + size < net.comments.length ? String(start + size) : null;
      return json({
        total: net.comments.length,
        linking_records: page.map((c) => ({ did: c.did, collection: 'pub.leaflet.comment', rkey: c.rkey })),
        cursor: next,
      });
    }
    if (url.origin === SLINGSHOT) {
      const did = url.searchParams.get('repo')!;
      const rkey = url.searchParams.get('rkey')!;
      const hit = net.comments.find((c) => c.did === did && c.rkey === rkey);
      if (!hit || net.slingshotMissing?.includes(rkey)) return json({ error: 'RecordNotFound' }, 400);
      return json({ uri: uri(did, rkey), cid: `cid-${rkey}`, value: { $type: 'pub.leaflet.comment', ...hit.value } });
    }
    if (url.origin === 'https://public.api.bsky.app') {
      if (net.appviewDown) return new Response('down', { status: 503 });
      const actors = url.searchParams.getAll('actors');
      return json({ profiles: actors.filter((a) => net.profiles[a]).map((a) => ({ did: a, ...net.profiles[a] })) });
    }
    if (url.origin === OWNER.pds && url.pathname.endsWith('/com.atproto.repo.listRecords')) {
      expect(url.searchParams.get('collection')).toBe('app.bsky.graph.block');
      return json({ records: net.blocks.map((subject, i) => ({ uri: `at://${OWNER.did}/app.bsky.graph.block/${i}`, cid: `b${i}`, value: { subject } })) });
    }
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
}

function comment(did: string, rkey: string, text: string, createdAt: string, extra: Record<string, unknown> = {}): FakeComment {
  return { did, rkey, value: { subject: DOC, plaintext: text, facets: [], createdAt, ...extra } };
}

function baseNet(): Net {
  return {
    comments: [
      comment(BOB, '3b1', 'second, a reply to alice', '2026-10-19T10:05:00.000Z', { reply: { parent: uri(ALICE, '3a1') } }),
      comment(ALICE, '3a1', 'first <b>bold</b> comment', '2026-10-19T10:00:00.000Z', {
        facets: [{ index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: 'pub.leaflet.richtext.facet#link', uri: 'https://example.com' }] }],
      }),
      comment(CAROL, '3c1', 'top level from carol', '2026-10-19T11:00:00.000Z'),
      comment(SPAMMER, '3s1', 'buy things', '2026-10-19T09:00:00.000Z'),
      comment(ALICE, '3a2', 'reply to the spam', '2026-10-19T09:30:00.000Z', { reply: { parent: uri(SPAMMER, '3s1') } }),
      comment(GONE, '3g1', 'from a deleted account', '2026-10-19T09:10:00.000Z'),
      comment(CAROL, '3c2', 'reply to a deleted comment', '2026-10-19T12:00:00.000Z', { reply: { parent: uri(CAROL, '3deleted') } }),
      { did: BOB, rkey: '3wrong', value: { subject: `at://${ATPOTATO_DID}/site.standard.document/other`, plaintext: 'elsewhere', createdAt: '2026-10-19T10:00:00.000Z' } },
      comment(BOB, '3blank', '   ', '2026-10-19T10:00:00.000Z'),
      comment(BOB, '3nodate', 'no date', 'yesterday'),
    ],
    profiles: {
      [ALICE]: { handle: 'alice.test', displayName: 'Alice', avatar: 'https://cdn.bsky.app/img/avatar/a.jpg' },
      [BOB]: { handle: 'bob.test', displayName: '', avatar: 'javascript:alert(1)' },
      [CAROL]: { handle: 'carol.test', displayName: 'Carol' },
      [SPAMMER]: { handle: 'spam.test', displayName: 'Spam' },
    },
    blocks: [SPAMMER],
    recommends: 7,
  };
}

beforeEach(() => {
  resetDiscussionCaches();
  resetEmbedCaches();
});

const load = (net: Net, hidden: Set<string> = new Set(), seen?: string[], deadlineMs?: number) =>
  loadDiscussion(fakeFetch(net, seen), { document: DOC, owner: OWNER, hidden, deadlineMs });

function shape(comments: BlogComment[]): unknown[] {
  return comments.map((c) => ({ rkey: c.rkey, replies: shape(c.replies) }));
}

describe('loadDiscussion', () => {
  it('threads the comments oldest first and drops hidden, foreign and malformed ones', async () => {
    const d = await load(baseNet());
    expect(d.status).toBe('ok');
    // spammer (blocked by the owner) and the reply under it, the deleted account, the
    // other post's comment, the blank and undated ones are all gone; carol's reply to a
    // deleted comment moves to the top level.
    expect(shape(d.comments)).toEqual([
      { rkey: '3a1', replies: [{ rkey: '3b1', replies: [] }] },
      { rkey: '3c1', replies: [] },
      { rkey: '3c2', replies: [] },
    ]);
    expect(d.count).toBe(4);
    expect(d.recommends).toBe(7);
    const alice = d.comments[0]!;
    expect(alice.author).toEqual({ did: ALICE, handle: 'alice.test', name: 'Alice', avatar: 'https://cdn.bsky.app/img/avatar/a.jpg' });
    expect(alice.uri).toBe(uri(ALICE, '3a1'));
    expect(alice.parent).toBeNull();
    // no display name: the handle stands in; a non-https avatar is dropped
    expect(alice.replies[0]!.author).toMatchObject({ name: '@bob.test', avatar: null });
  });

  it('hides accounts with moderation labels or the no-unauthenticated self-label', async () => {
    const net = baseNet();
    net.profiles[CAROL] = { handle: 'carol.test', labels: [{ val: '!no-unauthenticated', src: CAROL }] };
    net.profiles[BOB] = { handle: 'bob.test', labels: [{ val: 'spam', src: 'did:plc:mod' }] };
    const d = await load(net);
    expect(shape(d.comments)).toEqual([{ rkey: '3a1', replies: [] }]);
  });

  it('ignores a negated label', async () => {
    const net = baseNet();
    net.profiles[CAROL] = { handle: 'carol.test', labels: [{ val: '!hide', neg: true }] };
    expect((await load(net)).count).toBe(4);
  });

  it('hides comments and accounts named in BLOG_HIDDEN_COMMENTS', async () => {
    const d = await load(baseNet(), new Set([uri(ALICE, '3a1'), CAROL]));
    // alice's comment goes, and bob's reply under it with it; carol is hidden entirely
    expect(d.comments).toEqual([]);
    expect(d.count).toBe(0);
    expect(d.status).toBe('ok');
  });

  it('reads every page of backlinks and skips records Slingshot cannot find', async () => {
    const net = baseNet();
    net.pageSize = 3;
    net.slingshotMissing = ['3c1'];
    const d = await load(net);
    expect(shape(d.comments)).toEqual([{ rkey: '3a1', replies: [{ rkey: '3b1', replies: [] }] }, { rkey: '3c2', replies: [] }]);
  });

  it('says "unavailable" when the comment index or the AppView is down, and retries next time', async () => {
    const seen: string[] = [];
    const down = { ...baseNet(), constellationDown: true };
    expect((await load(down, new Set(), seen)).status).toBe('unavailable');
    expect((await load(down, new Set(), seen)).status).toBe('unavailable');
    expect(seen.filter((u) => u.startsWith(`${CONSTELLATION}/links?`))).toHaveLength(2);
    expect((await load({ ...baseNet(), appviewDown: true })).status).toBe('unavailable');
  });

  it('gives up at the deadline instead of holding the page', async () => {
    const d = await load({ ...baseNet(), hang: true }, new Set(), undefined, 20);
    expect(d).toMatchObject({ status: 'unavailable', comments: [], recommends: null });
  });

  it('keeps going without a count when only the recommend count fails, and without blocks when they fail', async () => {
    const net = baseNet();
    const base = fakeFetch(net);
    const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/links/count/') || url.startsWith(OWNER.pds)) return new Response('nope', { status: 500 });
      return base(input, init);
    }) as typeof fetch;
    const d = await loadDiscussion(doFetch, { document: DOC, owner: OWNER, hidden: new Set() });
    expect(d.status).toBe('ok');
    expect(d.recommends).toBeNull();
    // the spammer is no longer blocked, so their comment and alice's reply show
    expect(d.comments.map((c) => c.rkey)).toContain('3s1');
  });

  it('caches a good answer for the post', async () => {
    const seen: string[] = [];
    await load(baseNet(), new Set(), seen);
    const before = seen.length;
    await load(baseNet(), new Set(), seen);
    expect(seen.length).toBe(before);
  });
});

describe('threads', () => {
  const author = { did: ALICE, handle: 'alice.test', name: 'Alice', avatar: null };
  const raw = (rkey: string, createdAt: string, parent: string | null) => ({
    uri: uri(ALICE, rkey),
    cid: 'c',
    did: ALICE,
    rkey,
    text: rkey,
    facets: [],
    createdAt,
    parent,
    author,
  });

  it('cannot loop: a reply only attaches to a parent placed before it', () => {
    const a = raw('a', '2026-01-01T00:00:00.000Z', uri(ALICE, 'b'));
    const b = raw('b', '2026-01-02T00:00:00.000Z', uri(ALICE, 'a'));
    expect(shape(threads([b, a], new Set()))).toEqual([{ rkey: 'a', replies: [{ rkey: 'b', replies: [] }] }]);
  });

  it('drops a whole branch under a hidden comment', () => {
    const top = raw('top', '2026-01-01T00:00:00.000Z', uri(ALICE, 'hidden'));
    const deeper = raw('deeper', '2026-01-02T00:00:00.000Z', uri(ALICE, 'top'));
    expect(threads([top, deeper], new Set([uri(ALICE, 'hidden')]))).toEqual([]);
  });
});

describe('config', () => {
  it('reads the hide list and the kill switch', () => {
    expect([...parseHiddenComments(`${uri(ALICE, '3a1')}, ${BOB}\n not-a-thing at://${ALICE}/app.bsky.feed.post/1`)]).toEqual([uri(ALICE, '3a1'), BOB]);
    expect(readBlogConfig({}).commentsEnabled).toBe(true);
    expect(readBlogConfig({ BLOG_COMMENTS_DISABLED: '1' }).commentsEnabled).toBe(false);
  });
});

describe('rendering', () => {
  const site = siteInfo(
    { uri: PUB, cid: 'p', rkey: '3pub', name: 'Dispatch', description: null, url: 'https://poe.leaflet.pub', iconUrl: null },
    'https://poe.leaflet.pub',
    'atpota.to',
  );
  const doc = { uri: DOC, cid: 'd', rkey: '3doc', title: 'T', path: '/3doc' } as BlogDocument;
  const dom = (html: string) => new JSDOM(`<body>${html}</body>`).window.document;

  it('escapes comment text, marks links as user content, and labels the record', async () => {
    const d = await load(baseNet());
    const page = dom(discussionHtml(site, doc, d));
    const first = page.querySelector('li.comment')!;
    expect(first.getAttribute('data-comment')).toBe(uri(ALICE, '3a1'));
    expect(first.getAttribute('data-comment-author')).toBe(ALICE);
    expect(first.querySelector('.comment__body')!.textContent).toBe('first <b>bold</b> comment');
    expect(first.querySelector('.comment__body b')).toBeNull();
    const link = first.querySelector('.comment__body a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/');
    expect(link.getAttribute('rel')).toBe('ugc nofollow');
    expect(first.querySelector('.comment__time')!.getAttribute('href')).toBe(`https://aturi.to/profile/${ALICE}/pub.leaflet.comment/3a1`);
    expect(first.querySelector('.comment__handle')!.textContent).toBe('@alice.test');
    expect(first.querySelector('ol.comment-list--replies li .comment__name')!.textContent).toBe('@bob.test');
    expect(page.querySelector('[data-comment-count]')!.textContent).toBe('4 comments');
    expect(page.querySelector('[data-comment-compose]')!.hasAttribute('hidden')).toBe(true);
    expect(page.querySelector('[data-comment-empty]')).toBeNull();
  });

  it('shows an empty state, and an honest note when comments did not load', () => {
    const empty = dom(discussionHtml(site, doc, { status: 'ok', comments: [], count: 0, recommends: 0 }));
    expect(empty.querySelector('[data-comment-empty]')!.textContent).toBe('no comments yet.');
    expect(empty.querySelector('[data-comment-list]')!.hasAttribute('hidden')).toBe(true);
    const down = dom(discussionHtml(site, doc, { status: 'unavailable', comments: [], count: 0, recommends: null }));
    expect(down.querySelector('[data-blog-comments]')!.hasAttribute('data-comments-unavailable')).toBe(true);
    expect(down.querySelector('[data-comment-note] a')!.getAttribute('href')).toBe('https://poe.leaflet.pub/3doc');
    expect(down.querySelector('[data-comment-empty]')).toBeNull();
  });

  it('nests four levels deep, then lists deeper replies in order at the fourth', () => {
    const author = { did: POE_DID, handle: 'poe.atpota.to', name: 'poe', avatar: null };
    const make = (rkey: string, replies: BlogComment[] = []): BlogComment => ({
      uri: uri(POE_DID, rkey),
      cid: 'c',
      did: POE_DID,
      rkey,
      text: rkey,
      facets: [],
      createdAt: '2026-10-19T00:00:00.000Z',
      parent: null,
      author,
      replies,
    });
    const tree = make('l1', [make('l2', [make('l3', [make('l4', [make('l5', [make('l6')])])])])]);
    const page = dom(commentHtml(tree));
    const depths = [...page.querySelectorAll('li.comment')].map((li) => [li.querySelector('.comment__body')!.textContent, li.getAttribute('data-comment-depth')]);
    expect(depths).toEqual([
      ['l1', '1'],
      ['l2', '2'],
      ['l3', '3'],
      ['l4', '4'],
      ['l5', '4'],
      ['l6', '4'],
    ]);
    expect(page.querySelectorAll('li[data-comment-depth="4"] ol.comment-list--replies')).toHaveLength(1);
    expect(page.querySelector('.comment__badge')!.textContent).toBe('author');
  });
});

describe('/api/blog with reader actions', () => {
  // The shell as Vite builds it: partials (header, sign-in dialog, footer) filled in.
  const SHELL = applyPartials(readFileSync(fileURLToPath(new URL('../shells/blog.html', import.meta.url)), 'utf8'), {
    partialsDir: fileURLToPath(new URL('../src/partials', import.meta.url)),
    assetsDir: fileURLToPath(new URL('../src/assets', import.meta.url)),
  });
  const PDS = 'https://pds.atpota.to';

  function handlerFetch(net: Net): typeof fetch {
    const social = fakeFetch(net);
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'https://plc.directory') return new Response('down', { status: 502 });
      if (url.origin === PDS && url.searchParams.get('collection')?.startsWith('site.standard.')) {
        const collection = url.searchParams.get('collection');
        if (collection === 'site.standard.publication') {
          return json({ uri: PUB, cid: 'p', value: { $type: collection, name: 'Dispatch', url: 'https://poe.leaflet.pub' } });
        }
        return json({
          records: [{ uri: DOC, cid: 'd', value: { $type: 'site.standard.document', site: PUB, title: 'Issue', path: '/3doc', publishedAt: '2026-10-19T00:00:00.000Z', textContent: 'hi' } }],
        });
      }
      if (url.pathname.startsWith('/shells/blog')) return new Response(SHELL, { status: 200 });
      return social(input, init);
    }) as typeof fetch;
  }

  const h = (env: Record<string, string> = {}, net: Net = baseNet()) =>
    createBlogHandlers({ env: () => ({ BLOG_PUBLICATION_URI: PUB, ...env }), fetch: handlerFetch(net), now: () => Date.parse('2026-10-20T00:00:00.000Z'), log: () => undefined });

  async function page(handlers: ReturnType<typeof h>, query: string) {
    const res = await handlers.GET(new Request(`https://atpota.to/api/blog?${query}`));
    expect(res.status).toBe(200);
    return new JSDOM(await res.text()).window.document;
  }

  it('renders comments, a hidden recommend button with its count, and the record URIs for the browser', async () => {
    const d = await page(h(), 'view=post&path=3doc');
    const layout = d.querySelector('.post-layout')!;
    expect(layout.getAttribute('data-blog-document')).toBe(DOC);
    expect(layout.getAttribute('data-blog-publication')).toBe(PUB);
    expect(d.querySelectorAll('.post-talk li.comment')).toHaveLength(4);
    const recommend = d.querySelector('button[data-blog-recommend]')!;
    expect(recommend.hasAttribute('hidden')).toBe(true);
    expect(recommend.getAttribute('data-recommend-count')).toBe('7');
    expect(d.querySelector('button[data-blog-subscribe]')!.hasAttribute('hidden')).toBe(true);
    expect(d.querySelector('dialog[data-blog-signin] input[name="handle"]')).not.toBeNull();
    expect(d.body.getAttribute('data-page')).toBe('blog');
  });

  it('leaves the comments section out when BLOG_COMMENTS_DISABLED is set', async () => {
    const d = await page(h({ BLOG_COMMENTS_DISABLED: '1' }), 'view=post&path=3doc');
    expect(d.querySelector('[data-blog-comments]')).toBeNull();
    expect(d.querySelector('button[data-blog-recommend]')!.hasAttribute('data-recommend-count')).toBe(false);
  });

  it('applies BLOG_HIDDEN_COMMENTS', async () => {
    const d = await page(h({ BLOG_HIDDEN_COMMENTS: CAROL }), 'view=post&path=3doc');
    expect([...d.querySelectorAll('.post-talk li.comment')].map((li) => li.getAttribute('data-comment-author'))).toEqual([ALICE, BOB]);
  });

  it('offers email (to Leaflet) and bluesky subscribing on the index and after a post, unless BLOG_EMAIL_DISABLED', async () => {
    const index = await page(h(), 'view=index');
    const hero = index.querySelector<HTMLFormElement>('.blog-hero form[data-blog-email]')!;
    expect(hero.id).toBe('subscribe');
    expect(hero.querySelector<HTMLInputElement>('input[name="redirect"]')!.value).toBe('https://atpota.to/blog#subscribe');
    expect(JSON.parse(decodeURIComponent(hero.querySelector<HTMLInputElement>('input[name="action"]')!.value))).toEqual({ action: 'subscribe', publication: PUB, source: { placement: 'embed' } });
    expect(index.querySelector('.blog-hero .blog-alt [data-blog-subscribe-label]')!.textContent).toBe('subscribe with bluesky');

    const post = await page(h(), 'view=post&path=3doc');
    expect(post.querySelector<HTMLInputElement>('.post-end form[data-blog-email] input[name="redirect"]')!.value).toBe('https://atpota.to/blog/3doc#subscribe');
    expect(post.querySelectorAll('#subscribe')).toHaveLength(1);
    expect(post.querySelector('.post-end__title')!.textContent).toBe('want the next one?');

    const off = h({ BLOG_EMAIL_DISABLED: '1' });
    expect((await page(off, 'view=index')).querySelector('form[data-blog-email]')).toBeNull();
    expect((await page(off, 'view=post&path=3doc')).querySelector('form[data-blog-email]')).toBeNull();
  });

  it('puts a subscribe button and a notice line on the index', async () => {
    const d = await page(h(), 'view=index');
    expect(d.querySelector('.blog')!.getAttribute('data-blog-publication')).toBe(PUB);
    expect(d.querySelector('.blog-hero .blog-alt button[data-blog-subscribe]')).not.toBeNull();
    expect(d.querySelector('.blog-hero [data-blog-notice]')!.hasAttribute('hidden')).toBe(true);
  });
});
