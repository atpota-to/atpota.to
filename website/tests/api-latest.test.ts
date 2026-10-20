import { describe, expect, it } from 'vitest';
import * as api from '../api/latest.js';
import { ATPOTATO_DID, DEFAULT_PUBLICATION_URI, POE_DID } from '../server/blog/config.js';
import { ACCOUNTS, CACHE_OK, clip, createLatestHandlers, MAX_ITEMS, MAX_PER_SOURCE, mergeItems, postItems, type LatestItem } from '../server/latest.js';

// Handler-level tests for /api/latest. plc.directory and every PDS are a scripted fake fetch.

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const ANISOTA = ACCOUNTS.find((a) => a.id === 'anisota')!;
const PDS = 'https://pds.test';
const PUB_RKEY = DEFAULT_PUBLICATION_URI.split('/').pop()!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function post(did: string, rkey: string, value: Record<string, unknown>) {
  return { uri: `at://${did}/app.bsky.feed.post/${rkey}`, cid: 'bafy', value: { $type: 'app.bsky.feed.post', text: 'hi', createdAt: '2026-10-01T00:00:00Z', ...value } };
}

interface Net {
  posts: Record<string, unknown[]>;
  down?: Set<string>;
  docs?: unknown[];
}

function fakeFetch(net: Net): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin === 'https://plc.directory') {
      const did = decodeURIComponent(url.pathname.slice(1));
      return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    }
    if (url.origin !== PDS) return json({ error: 'nope' }, 404);
    const repo = url.searchParams.get('repo')!;
    if (net.down?.has(repo)) return new Response('down', { status: 503 });
    const collection = url.searchParams.get('collection');
    if (url.pathname.endsWith('getRecord')) {
      return json({ uri: `at://${repo}/site.standard.publication/${PUB_RKEY}`, cid: 'c', value: { name: 'dispatch', url: 'https://poe.leaflet.pub' } });
    }
    if (collection === 'app.bsky.feed.post') return json({ records: net.posts[repo] ?? [] });
    if (collection === 'site.standard.document') return json({ records: net.docs ?? [] });
    return json({ records: [] });
  }) as typeof fetch;
}

function handlers(net: Net) {
  return createLatestHandlers({ env: () => ({}), fetch: fakeFetch(net), now: () => NOW, log: () => undefined });
}

const DOC = {
  uri: `at://${ATPOTATO_DID}/site.standard.document/3issue`,
  cid: 'c',
  value: { site: DEFAULT_PUBLICATION_URI, title: 'a brand new cow', description: 'the week in the atmosphere', publishedAt: '2026-10-19T09:00:00Z', path: '/cow' },
};

describe('/api/latest', () => {
  it('merges posts from every account with the dispatch, newest first, skipping replies', async () => {
    const res = await handlers({
      posts: {
        [ATPOTATO_DID]: [post(ATPOTATO_DID, '3a', { text: 'from atpotato', createdAt: '2026-10-10T00:00:00Z' })],
        [POE_DID]: [post(POE_DID, '3p', { text: 'a reply', reply: { root: {}, parent: {} }, createdAt: '2026-10-18T00:00:00Z' })],
        [ANISOTA.did]: [post(ANISOTA.did, '3m', { text: 'moths', createdAt: '2026-10-15T00:00:00Z', embed: { $type: 'app.bsky.embed.images', images: [{}, {}] } })],
      },
      docs: [DOC],
    }).GET(new Request('https://atpota.to/api/latest'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    const { items } = (await res.json()) as { items: LatestItem[] };
    expect(items.map((i) => i.source)).toEqual(['dispatch', 'anisota', 'atpotato']);
    expect(items[0]).toMatchObject({ kind: 'article', title: 'a brand new cow', text: 'the week in the atmosphere', url: '/blog/cow' });
    expect(items[1]).toMatchObject({ embed: 'with 2 images', url: 'https://bsky.app/profile/anisota.net/post/3m' });
  });

  it('leaves out a source that fails, and answers 503 only when all of them do', async () => {
    const some = await handlers({ posts: { [ANISOTA.did]: [post(ANISOTA.did, '3m', {})] }, down: new Set([ATPOTATO_DID, POE_DID]) }).GET(new Request('https://atpota.to/api/latest'));
    expect(some.status).toBe(200);
    expect(((await some.json()) as { items: LatestItem[] }).items.map((i) => i.source)).toEqual(['anisota']);

    const all = new Set([ATPOTATO_DID, POE_DID, ...ACCOUNTS.map((a) => a.did)]);
    const none = await handlers({ posts: {}, down: all }).GET(new Request('https://atpota.to/api/latest'));
    expect(none.status).toBe(503);
    expect(none.headers.get('cache-control')).toBe('no-store');
  });

  it('exports GET and HEAD, and 405s other methods', async () => {
    expect(typeof api.GET).toBe('function');
    const res = await api.POST(new Request('https://atpota.to/api/latest', { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('postItems and mergeItems', () => {
  it('drops other repos, future posts and empty posts', () => {
    const items = postItems(
      ANISOTA,
      [
        post('did:plc:someoneelse', '3x', {}),
        post(ANISOTA.did, '3future', { createdAt: '2027-01-01T00:00:00Z' }),
        post(ANISOTA.did, '3empty', { text: '  ' }),
        post(ANISOTA.did, '3ok', { text: 'ok' }),
      ],
      NOW,
    );
    expect(items.map((i) => i.url)).toEqual(['https://bsky.app/profile/anisota.net/post/3ok']);
  });

  it(`keeps at most ${MAX_PER_SOURCE} per source and ${MAX_ITEMS} in all`, () => {
    const make = (source: LatestItem['source'], n: number) =>
      Array.from({ length: n }, (_, i): LatestItem => ({ source, kind: 'post', text: 't', title: null, embed: '', createdAt: new Date(NOW - i * 1000).toISOString(), url: 'u' }));
    const merged = mergeItems([make('anisota', 5), make('aturi', 5), make('poe', 5), make('atpotato', 5)]);
    expect(merged).toHaveLength(MAX_ITEMS);
    expect(merged.filter((i) => i.source === 'anisota').length).toBeLessThanOrEqual(MAX_PER_SOURCE);
  });

  it('clips long text at a word boundary', () => {
    const out = clip('word '.repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
  });
});
