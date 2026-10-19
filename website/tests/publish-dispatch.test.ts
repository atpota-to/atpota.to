import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { isTid, tidTime } from '../build/atproto-ids.js';
import { EMPTY_EMBEDS, leafletPages, renderPages } from '../server/blog/blocks.js';
import { ATPOTATO_DID, DEFAULT_PUBLICATION_URI, POE_DID } from '../server/blog/config.js';
import { FootnoteList } from '../server/blog/richtext.js';
import { dispatchRecord, main as publish, parseIssue } from '../scripts/publish-dispatch.js';

// Publishing an issue of the dispatch: the markdown -> the document record -> what /blog
// renders, and the publish script against a fake PDS (nothing here touches the network).

const root = fileURLToPath(new URL('..', import.meta.url));
const ISSUE = [
  '# attie sites and a new cow',
  '',
  '*bluesky widened attie, and pds moover shipped oauth.*',
  '',
  'the big thing this week was attie (◕ᗜ◕)',
  '',
  '## what builders talked about',
  '',
  '**attie.** [paul frazee](https://bsky.app/profile/pfrazee.com) [said it is still in beta](https://bsky.app/profile/pfrazee.com/post/3mxwojfdnx22e).',
  '',
  '## growing and shrinking',
  '',
  '- [`so.sprk.feed.post`](https://aturi.to/explore/lexicons/so.sprk.feed.post): about 39 → about 4,700 accounts.',
  '',
].join('\n');

function issueFile(text = ISSUE): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-'));
  const file = join(dir, 'final.md');
  writeFileSync(file, text);
  return file;
}

describe('parseIssue', () => {
  it('reads the title, the italic description and the body', () => {
    const issue = parseIssue(ISSUE);
    expect(issue.title).toBe('attie sites and a new cow');
    expect(issue.description).toBe('bluesky widened attie, and pds moover shipped oauth.');
    expect(issue.body.startsWith('the big thing this week')).toBe(true);
  });

  it('refuses a file without the title or description lines', () => {
    expect(() => parseIssue('no title here')).toThrow(/title/);
    expect(() => parseIssue('# title\n\nno italics\n\nbody')).toThrow(/description/);
    expect(() => parseIssue('# title\n\n*description*\n')).toThrow(/body/);
  });
});

describe('the document record', () => {
  const record = dispatchRecord(parseIssue(ISSUE), { root, rkey: '3my7qymad2222', publishedAt: '2026-10-19T09:00:00.000Z' });

  it('is shaped like a Leaflet document in the dispatch publication, crediting Poe', () => {
    expect(record).toMatchObject({
      $type: 'site.standard.document',
      site: DEFAULT_PUBLICATION_URI,
      path: '/3my7qymad2222',
      title: 'attie sites and a new cow',
      description: 'bluesky widened attie, and pds moover shipped oauth.',
      publishedAt: '2026-10-19T09:00:00.000Z',
      tags: ['atmosphere', 'dispatch'],
      contributors: [{ did: POE_DID }],
    });
    expect((record.content as { $type: string }).$type).toBe('pub.leaflet.content');
    expect(record.textContent).toContain('so.sprk.feed.post: about 39 → about 4,700 accounts.');
    expect('bskyPostRef' in record).toBe(false);
  });

  it('renders on /blog with its headings, links and code intact', () => {
    const ctx = {
      did: ATPOTATO_DID, pds: 'https://pds.test', embeds: EMPTY_EMBEDS, footnotes: new FootnoteList(), headingShift: 0,
      pages: new Map(), linkedPages: [], headingIds: new Set<string>(), otherPosts: [], links: { profile: '', feed: '' },
    };
    const body = new JSDOM(`<body>${renderPages(leafletPages(record.content), ctx)}</body>`).window.document.body;
    expect([...body.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['what builders talked about', 'growing and shrinking']);
    const hrefs = [...body.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://bsky.app/profile/pfrazee.com/post/3mxwojfdnx22e');
    expect(hrefs).toContain('https://aturi.to/explore/lexicons/so.sprk.feed.post');
    expect(body.querySelector('li code')?.textContent).toBe('so.sprk.feed.post');
    expect(body.querySelector('strong')?.textContent).toBe('attie.');
  });

  it('refuses images, which the dispatch does not upload', () => {
    const withImage = parseIssue(`${ISSUE}\n![a potato](/atpotato-logo.png)\n`);
    expect(() => dispatchRecord(withImage, { root, rkey: '3my7qymad2222', publishedAt: '2026-10-19T09:00:00.000Z' })).toThrow(/images/);
  });
});

/** A fake PDS and AppView that records what was written. */
function fakeNetwork(opts: { did?: string; existing?: { uri: string; value: Record<string, unknown> }[]; current?: Record<string, unknown> } = {}) {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://plc.directory/')) {
      return json(200, { service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.test' }] });
    }
    if (url.includes('com.atproto.repo.listRecords')) return json(200, { records: opts.existing ?? [] });
    if (url.includes('com.atproto.server.createSession')) return json(200, { accessJwt: 'jwt', did: opts.did ?? ATPOTATO_DID });
    if (url.includes('com.atproto.repo.getRecord')) return opts.current ? json(200, { value: opts.current }) : json(400, { error: 'RecordNotFound' });
    if (url.includes('com.atproto.identity.resolveHandle')) return json(200, { did: POE_DID });
    if (url.includes('app.bsky.feed.getPosts')) {
      return json(200, { posts: [{ uri: decodeURIComponent(url.split('uris=')[1]!), cid: 'bafyreipost' }] });
    }
    if (url.includes('com.atproto.repo.putRecord')) {
      writes.push({ url, body: JSON.parse(String(init?.body)) });
      return json(200, { uri: 'ok' });
    }
    return json(404, { error: 'unexpected', url });
  };
  return { fetch: fetch as typeof globalThis.fetch, writes };
}

const run = (args: string[], net: ReturnType<typeof fakeNetwork>, env: Record<string, string> = { ATP_APP_PASSWORD: 'app-pass' }) => {
  const lines: string[] = [];
  return publish(args, { env, fetch: net.fetch, log: (l) => lines.push(l), root, now: () => new Date('2026-10-19T09:00:00.000Z') })
    .then((code) => ({ code, lines }));
};

describe('publish:dispatch', () => {
  it('dry run writes nothing and can save the record', async () => {
    const net = fakeNetwork();
    const out = join(mkdtempSync(join(tmpdir(), 'dispatch-out-')), 'record.json');
    const { code, lines } = await run([issueFile(), '--dry-run', '--out', out], net);
    expect(code).toBe(0);
    expect(net.writes).toHaveLength(0);
    expect(lines[0]).toMatch(/^dry run: "attie sites and a new cow"/);
    const saved = JSON.parse(readFileSync(out, 'utf8'));
    expect(saved.uri).toMatch(new RegExp(`^at://${ATPOTATO_DID}/site\\.standard\\.document/`));
  });

  it('publishes a new issue under a key made from its publish time', async () => {
    const net = fakeNetwork();
    const { code } = await run([issueFile()], net);
    expect(code).toBe(0);
    expect(net.writes).toHaveLength(1);
    const { repo, collection, rkey, record } = net.writes[0]!.body as { repo: string; collection: string; rkey: string; record: Record<string, unknown> };
    expect(repo).toBe(ATPOTATO_DID);
    expect(collection).toBe('site.standard.document');
    expect(isTid(rkey)).toBe(true);
    expect(new Date(tidTime(rkey)).toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(record.path).toBe(`/${rkey}`);
  });

  it('refuses to publish the same title twice without --rkey', async () => {
    const twin = { uri: `at://${ATPOTATO_DID}/site.standard.document/3my7qymad2222`, value: { site: DEFAULT_PUBLICATION_URI, title: 'attie sites and a new cow' } };
    const net = fakeNetwork({ existing: [twin] });
    const { code, lines } = await run([issueFile()], net);
    expect(code).toBe(1);
    expect(net.writes).toHaveLength(0);
    expect(lines.join('\n')).toContain('--rkey 3my7qymad2222');
  });

  it('updates with --rkey, keeping the first publishedAt, and links the announcement', async () => {
    const net = fakeNetwork({ current: { title: 'old', publishedAt: '2026-10-19T08:00:00.000Z' } });
    const { code } = await run([issueFile(), '--rkey', '3my7qymad2222', '--bsky-post', 'https://bsky.app/profile/poe.atpota.to/post/3mzzz'], net);
    expect(code).toBe(0);
    const { rkey, record } = net.writes[0]!.body as { rkey: string; record: Record<string, unknown> };
    expect(rkey).toBe('3my7qymad2222');
    expect(record.publishedAt).toBe('2026-10-19T08:00:00.000Z');
    expect(record.updatedAt).toBe('2026-10-19T09:00:00.000Z');
    expect(record.bskyPostRef).toEqual({ uri: `at://${POE_DID}/app.bsky.feed.post/3mzzz`, cid: 'bafyreipost' });
  });

  it('writes nothing when signed in to the wrong account or without a password', async () => {
    const wrong = fakeNetwork({ did: POE_DID });
    expect((await run([issueFile()], wrong)).code).toBe(1);
    expect(wrong.writes).toHaveLength(0);
    const none = fakeNetwork();
    expect((await run([issueFile()], none, {})).code).toBe(1);
    expect(none.writes).toHaveLength(0);
  });
});
