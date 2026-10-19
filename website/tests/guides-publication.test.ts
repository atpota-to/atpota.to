import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { blobCid, isTid, tidFromTime, tidTime } from '../build/atproto-ids.js';
import { renderGuide } from '../build/guide-markdown.js';
import { BASIC_THEME, documentRecord, guideRecords, publicationRecord, RECORD_BUDGET_BYTES, requestBytes } from '../build/guide-records.js';
import { documentUri, GUIDES, guideUrl, publicationUri } from '../build/guides.js';
import { guidesList, guidesSite, standardSiteTags, WELL_KNOWN_PATH } from '../build/guides-site.js';
import { decodeEntities, markdownToLeaflet, MAX_IMAGE_BYTES } from '../build/leaflet-markdown.js';
import { EMPTY_EMBEDS, leafletPages, renderPages } from '../server/blog/blocks.js';
import { FootnoteList } from '../server/blog/richtext.js';
import { pageTitle } from '../server/routes.js';
import { canonical, main as publish, sameRecord } from '../scripts/publish-guides.js';

// The guides as a standard.site publication: record keys and CIDs, the markdown ->
// Leaflet conversion, the records, the site plugin, and the publish script (against a
// fake PDS; nothing here touches the network).

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');
const guide = GUIDES.documents[0]!;
const html = (s: string) => new JSDOM(s).window.document;
const enc = new TextEncoder();
const F = 'pub.leaflet.richtext.facet#';

const convert = (md: string) =>
  markdownToLeaflet(md, { publicDir: `${root}public`, base: '/guides/', origin: 'https://atpota.to', pageUrl: 'https://atpota.to/guides/x' });
const blocksOf = (md: string) => convert(md).content.pages[0]!.blocks.map((b) => b.block);
/** The text a facet covers, by its UTF-8 byte range. */
const covered = (text: string, f: { index: { byteStart: number; byteEnd: number } }) =>
  new TextDecoder().decode(enc.encode(text).slice(f.index.byteStart, f.index.byteEnd));

describe('record keys and blob CIDs', () => {
  it('encodes TIDs that sort by time and decode back', () => {
    const a = tidFromTime(Date.parse('2025-06-11T18:17:59Z'), 1);
    const b = tidFromTime(Date.parse('2025-06-11T18:18:00Z'), 0);
    expect(isTid(a) && isTid(b)).toBe(true);
    expect(a < b).toBe(true);
    expect(new Date(tidTime(a)).toISOString()).toBe('2025-06-11T18:17:59.000Z');
    // a real Leaflet record key, written two seconds after its publishedAt (2026-09-25T19:05:46Z)
    expect(new Date(tidTime('3mwehnrqsf22g')).toISOString()).toBe('2026-09-25T19:05:48.444Z');
    expect(isTid('3MWEHNRQSF22G')).toBe(false);
  });

  it('computes the CID a PDS gives a blob (CIDv1, raw, sha2-256)', () => {
    expect(blobCid(new Uint8Array())).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  });
});

describe('guides config and pages agree', () => {
  it('uses valid record keys and dates', () => {
    expect(isTid(GUIDES.publication.rkey)).toBe(true);
    for (const g of GUIDES.documents) {
      expect(isTid(g.rkey)).toBe(true);
      expect(new Date(g.publishedAt).toISOString()).toBe(g.publishedAt);
    }
    expect(publicationUri()).toBe('at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3lrdzen52y223');
    expect(guideUrl(guide)).toBe('https://atpota.to/guides/bluesky-for-brands');
  });

  it("the guide page's head and record link match the document", () => {
    const d = html(read(guide.html));
    expect(d.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe(guideUrl(guide));
    expect(d.querySelector('meta[name="description"]')!.getAttribute('content')).toBe(guide.description);
    expect(d.querySelector('h1')!.textContent).toBe(guide.title);
    expect(d.querySelector('.guide__subtitle')!.textContent).toBe(guide.subtitle);
    expect(d.querySelector('.guide-end__links a')!.getAttribute('href')).toBe(`https://aturi.to/profile/${GUIDES.did}/site.standard.document/${guide.rkey}`);
    expect(read(guide.html)).toContain('<!-- @standard-site -->');
  });

  it('the /guides page names the publication', () => {
    const d = html(read('guides/index.html'));
    expect(d.title).toBe(GUIDES.publication.name);
    expect(d.querySelector('h1')!.textContent).toBe(GUIDES.publication.name);
    expect(d.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe(GUIDES.publication.url);
    expect(d.querySelector('meta[name="description"]')!.getAttribute('content')).toBe(GUIDES.publication.description);
    expect(d.body.dataset.page).toBe('guides');
  });

  it('gives Poe a title for /guides', () => {
    expect(pageTitle('/guides')).toBe('atpotato guides');
  });
});

describe('markdown -> Leaflet blocks', () => {
  it('turns headings, paragraphs and marks into blocks with UTF-8 byte facets', () => {
    const [h, p] = blocksOf('### A *nice* heading\n\nCafé 🥔 — **bold [link](https://example.com/a)** and `code` &amp; more\nsoft break');
    expect(h).toMatchObject({ $type: 'pub.leaflet.blocks.header', level: 3, plaintext: 'A nice heading' });
    expect(p!.plaintext).toBe('Café 🥔 — bold link and code & more soft break');
    const facets = p!.facets as { index: { byteStart: number; byteEnd: number }; features: { $type: string; uri?: string }[] }[];
    const by = (type: string) => facets.filter((f) => f.features[0]!.$type === `${F}${type}`).map((f) => covered(p!.plaintext as string, f));
    expect(by('bold')).toEqual(['bold link']);
    expect(by('link')).toEqual(['link']);
    expect(by('code')).toEqual(['code']);
    expect(facets.find((f) => f.features[0]!.$type === `${F}link`)!.features[0]!.uri).toBe('https://example.com/a');
  });

  it('makes links absolute and points #anchors at the guide page; drops unsafe links', () => {
    const [p] = blocksOf('[home](/blog) [section](#section-2) [shot](screenshots/a.png) [bad](javascript:alert(1))');
    const uris = (p!.facets as { features: { uri: string }[] }[]).map((f) => f.features[0]!.uri);
    expect(uris).toEqual(['https://atpota.to/blog', 'https://atpota.to/guides/x#section-2', 'https://atpota.to/guides/screenshots/a.png']);
    expect(p!.plaintext).toBe('home section shot bad');
  });

  it('turns image-only paragraphs into image blocks with local blob refs', () => {
    const out = convert('![the change handle screen](/guides/screenshots/change-handle.png)');
    const [img] = out.content.pages[0]!.blocks.map((b) => b.block);
    const bytes = readFileSync(`${root}public/guides/screenshots/change-handle.png`);
    expect(img).toEqual({
      $type: 'pub.leaflet.blocks.image',
      image: { $type: 'blob', ref: { $link: blobCid(bytes) }, mimeType: 'image/png', size: bytes.length },
      alt: 'the change handle screen',
      aspectRatio: { width: 1274, height: 1222 },
    });
    expect(out.blobs).toHaveLength(1);
    expect(() => convert('![x](/guides/../../package.json)')).toThrow(/outside public|unsupported/);
  });

  it('keeps list nesting, ordered starts and task items', () => {
    const [list] = blocksOf('3. first\n   - inner **b**\n4. [x] done\n');
    expect(list).toMatchObject({ $type: 'pub.leaflet.blocks.orderedList', startIndex: 3 });
    const items = list!.children as Record<string, unknown>[];
    expect((items[0]!.content as { plaintext: string }).plaintext).toBe('first');
    expect(items[0]!.unorderedListChildren).toMatchObject({ $type: 'pub.leaflet.blocks.unorderedList' });
    expect(items[1]!.checked).toBe(true);
  });

  it('keeps hard breaks, code blocks, quotes and rules, and never passes HTML through as markup', () => {
    const blocks = blocksOf('`a`  \n`b`\n\n```ts\nconst x = 1;\n```\n\n> quoted\n>\n> twice\n\n---\n\n<div onclick="x">hi</div>\n');
    expect(blocks.map((b) => String(b.$type).split('.').pop())).toEqual(['text', 'code', 'blockquote', 'horizontalRule', 'text']);
    expect(blocks[0]!.plaintext).toBe('a\nb');
    expect(blocks[1]).toEqual({ $type: 'pub.leaflet.blocks.code', plaintext: 'const x = 1;', language: 'ts' });
    expect(blocks[2]!.plaintext).toBe('quoted\n\ntwice');
    expect(blocks[4]!.plaintext).toBe('<div onclick="x">hi</div>');
    expect(decodeEntities('&lt;&#39;&#x1F954;&amp;')).toBe("<'🥔&");
  });

  it('says the same thing as the page: the real guide round-trips through the Leaflet renderer', () => {
    const md = read(guide.markdown);
    const out = convert(md);
    const ctx = {
      did: 'did:plc:x',
      pds: 'https://pds.test',
      embeds: EMPTY_EMBEDS,
      footnotes: new FootnoteList(),
      headingShift: 0,
      pages: new Map(),
      linkedPages: [],
      headingIds: new Set<string>(),
      otherPosts: [],
      links: { profile: '', feed: '' },
    };
    const fromRecord = html(`<body>${renderPages(leafletPages(out.content), ctx)}</body>`).body;
    const fromPage = html(`<body>${renderGuide(md, { publicDir: `${root}public` }).html}</body>`).body;
    const squash = (s: string | null) => (s ?? '').replace(/\s+/g, '');
    expect(squash(fromRecord.textContent)).toBe(squash(fromPage.textContent));
    for (const sel of ['strong', 'em', 'code', 'a', 'img', 'li', 'h2', 'h3', 'h4', 'h5']) {
      const texts = (el: Element) => [...el.querySelectorAll(sel)].map((e) => squash(e.textContent) + (e.getAttribute('alt') ?? ''));
      expect(texts(fromRecord), sel).toEqual(texts(fromPage));
    }
  });
});

describe('the records', () => {
  it('publication: name, url, icon, the site theme, and discoverable', () => {
    const pub = publicationRecord(root);
    expect(pub.uri).toBe(publicationUri());
    expect(pub.record).toMatchObject({
      $type: 'site.standard.publication',
      name: 'atpotato guides',
      url: 'https://atpota.to/guides',
      basicTheme: BASIC_THEME,
      preferences: { showInDiscover: true },
    });
    expect((pub.record.icon as { mimeType: string }).mimeType).toBe('image/png');
    expect(BASIC_THEME.background).toEqual({ $type: 'site.standard.theme.color#rgb', r: 0xf4, g: 0xee, b: 0xdf });
  });

  it('document: in the publication at /bluesky-for-brands, with its author, cover and every image uploaded', () => {
    const doc = documentRecord(root, guide);
    expect(doc.uri).toBe(documentUri(guide));
    expect(doc.record).toMatchObject({
      $type: 'site.standard.document',
      site: publicationUri(),
      path: '/bluesky-for-brands',
      title: guide.title,
      publishedAt: '2025-06-11T18:17:59.000Z',
      contributors: [{ did: 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj', displayName: 'dame', role: 'author' }],
    });
    expect((doc.record.content as { $type: string }).$type).toBe('pub.leaflet.content');
    const blobCids = new Set(doc.blobs.map((b) => b.ref.ref.$link));
    const used = JSON.stringify(doc.record).match(/"\$link":"(b[a-z2-7]+)"/g)!.map((m) => m.slice(9, -1));
    for (const cid of used) expect(blobCids.has(cid), cid).toBe(true);
    expect(blobCids.size).toBe(13); // 12 screenshots + the cover
    for (const b of doc.blobs) expect(b.ref.size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  });

  it('fits one putRecord request, keeping the plain-text copy while it fits', () => {
    for (const r of guideRecords(root)) expect(requestBytes(r)).toBeLessThanOrEqual(RECORD_BUDGET_BYTES);
    const doc = documentRecord(root, guide);
    if (typeof doc.record.textContent === 'string') expect(doc.record.textContent.length).toBeGreaterThan(40_000);
  });
});

describe('site plugin', () => {
  it('writes the head tags for a document and for the publication page', () => {
    const doc = html(`<head>${standardSiteTags({ document: documentUri(guide), publication: publicationUri() })}</head>`);
    expect(doc.querySelector('link[rel="site.standard.document"]')!.getAttribute('href')).toBe(documentUri(guide));
    expect(doc.querySelector('link[rel="site.standard.publication"]')!.getAttribute('href')).toBe(publicationUri());
    expect(doc.querySelector('meta[name="atproto:uri"]')!.getAttribute('content')).toBe(documentUri(guide));
    const pub = html(`<head>${standardSiteTags({ publication: publicationUri() })}</head>`);
    expect(pub.querySelector('link[rel="site.standard.document"]')).toBeNull();
    expect(pub.querySelector('link[type="application/at-record+json"]')!.getAttribute('href')).toBe(publicationUri());
  });

  it('fills the markers, lists the guides, and emits the well-known file', () => {
    const plugin = guidesSite({ root });
    const transform = (plugin.transformIndexHtml as { handler: (h: string, c: { filename: string }) => string }).handler;
    const page = transform(read(guide.html), { filename: `${root}${guide.html}` });
    expect(page).not.toContain('@standard-site');
    expect(page).toContain(`<link rel="site.standard.document" href="${documentUri(guide)}">`);
    const index = transform(read('guides/index.html'), { filename: `${root}guides/index.html` });
    expect(index).not.toMatch(/@standard-site|@guides-list/);
    const card = html(index).querySelector('a.guides-card')!;
    expect(card.getAttribute('href')).toBe('/guides/bluesky-for-brands');
    expect(card.querySelector('.guides-card__meta')!.textContent).toBe('55 min read · 7 chapters · by @dame.is');
    expect(guidesList(root)).toContain('read the guide');
    expect(() => transform('<html></html>', { filename: `${root}${guide.html}` })).toThrow(/marker/);

    const emitted: { fileName: string; source: string }[] = [];
    (plugin.generateBundle as (this: unknown) => void).call({ emitFile: (f: { fileName: string; source: string }) => emitted.push(f) });
    expect(emitted).toEqual([{ type: 'asset', fileName: WELL_KNOWN_PATH.slice(1), source: publicationUri() }]);
  });

  it('vercel.json serves the well-known file as text', () => {
    const config = JSON.parse(read('vercel.json')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
    const rule = config.headers.find((h) => h.source === WELL_KNOWN_PATH)!;
    expect(rule.headers).toContainEqual({ key: 'Content-Type', value: 'text/plain; charset=utf-8' });
  });
});

describe('npm run publish:guides', () => {
  const PDS = 'https://pds.test';
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  /** A fake PDS holding records in memory; uploadBlob answers with the real CID of the body. */
  function fakePds(opts: { did?: string; existing?: Map<string, Record<string, unknown>> } = {}) {
    const records = opts.existing ?? new Map<string, Record<string, unknown>>();
    const calls: string[] = [];
    const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.origin === 'https://plc.directory') return json({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] });
      switch (url.pathname) {
        case '/xrpc/com.atproto.server.createSession':
          return json({ accessJwt: 'jwt', did: opts.did ?? GUIDES.did });
        case '/xrpc/com.atproto.repo.getRecord': {
          const value = records.get(`${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`);
          return value ? json({ value }) : json({ error: 'RecordNotFound' }, 400);
        }
        case '/xrpc/com.atproto.repo.uploadBlob': {
          const body = new Uint8Array(init!.body as Buffer);
          const digest = createHash('sha256').update(body).digest('hex');
          expect(digest).toHaveLength(64);
          return json({ blob: { ref: { $link: blobCid(body) } } });
        }
        case '/xrpc/com.atproto.repo.putRecord': {
          const { collection, rkey, record } = JSON.parse(String(init!.body)) as { collection: string; rkey: string; record: Record<string, unknown> };
          records.set(`${collection}/${rkey}`, record);
          return json({ uri: `at://${GUIDES.did}/${collection}/${rkey}` });
        }
      }
      return json({ error: 'nope' }, 404);
    }) as typeof fetch;
    return { doFetch, records, calls };
  }

  const run = (args: string[], env: Record<string, string>, f: ReturnType<typeof fakePds>, now = '2026-10-19T12:00:00.000Z') => {
    const lines: string[] = [];
    return publish(args, { env, fetch: f.doFetch, log: (l) => lines.push(l), root, now: () => new Date(now) }).then((code) => ({ code, lines }));
  };

  it('is wired as an npm script', () => {
    expect(pkg.scripts['publish:guides']).toBe('node scripts/run.mjs scripts/publish-guides.ts');
  });

  it('--dry-run touches nothing; without an app password it refuses', async () => {
    const f = fakePds();
    expect((await run(['--dry-run'], {}, f)).code).toBe(0);
    const refused = await run([], {}, f);
    expect(refused.code).toBe(1);
    expect(refused.lines.at(-1)).toMatch(/ATP_APP_PASSWORD/);
    expect(f.calls).toEqual([]);
  });

  it('uploads images, creates both records, then leaves them alone on a second run', async () => {
    const f = fakePds();
    const first = await run([], { ATP_APP_PASSWORD: 'app-pass' }, f);
    expect(first.code).toBe(0);
    expect(f.calls.filter((c) => c.endsWith('uploadBlob'))).toHaveLength(14); // icon + 12 screenshots + cover
    expect(f.calls.filter((c) => c.endsWith('putRecord'))).toHaveLength(2);
    const stored = f.records.get(`site.standard.document/${guide.rkey}`)!;
    expect(stored.updatedAt).toBeUndefined();
    expect(sameRecord(stored, documentRecord(root, guide).record)).toBe(true);

    f.calls.length = 0;
    const second = await run([], { ATP_APP_PASSWORD: 'app-pass' }, f);
    expect(second.code).toBe(0);
    expect(second.lines.filter((l) => l.startsWith('unchanged'))).toHaveLength(2);
    expect(f.calls.some((c) => c.endsWith('uploadBlob') || c.endsWith('putRecord'))).toBe(false);
  });

  it('stamps updatedAt when a published document changes', async () => {
    const existing = new Map<string, Record<string, unknown>>([
      [`site.standard.publication/${GUIDES.publication.rkey}`, publicationRecord(root).record],
      [`site.standard.document/${guide.rkey}`, { ...documentRecord(root, guide).record, title: 'an older title' }],
    ]);
    const f = fakePds({ existing });
    const { code, lines } = await run([], { ATP_APP_PASSWORD: 'app-pass' }, f);
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith('updated') && l.includes(guide.rkey))).toBe(true);
    expect(existing.get(`site.standard.document/${guide.rkey}`)!.updatedAt).toBe('2026-10-19T12:00:00.000Z');
  });

  it('writes nothing when the app password belongs to another account', async () => {
    const f = fakePds({ did: 'did:plc:someoneelse' });
    const { code, lines } = await run([], { ATP_APP_PASSWORD: 'app-pass' }, f);
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatch(/nothing written/);
    expect(f.calls.some((c) => c.endsWith('putRecord') || c.endsWith('uploadBlob'))).toBe(false);
  });

  it('compares records by content, not key order', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(sameRecord({ a: 1, updatedAt: 'x' }, { a: 1 })).toBe(true);
  });
});
