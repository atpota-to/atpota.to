import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api/blog.js';
import { POE_DID } from '../server/blog/config.js';
import { resetEmbedCaches } from '../server/blog/embeds.js';
import { CACHE_MISSING, CACHE_OK, CACHE_PREVIEW, createBlogHandlers, type BlogDeps } from '../server/blog/handler.js';
import { EMAIL_RETURN_COOKIE, LEAFLET_RETURN_PATH } from '../server/blog/subscribe.js';
import { pageTitle } from '../server/routes.js';

// Handler-level tests for /api/blog. The network (plc.directory, the PDS, the public
// AppView and the deployment serving the shell) is a scripted fake fetch.

const ORIGIN = 'https://atpota.to';
const PDS = 'https://pds.test';
const PUB_URI = `at://${POE_DID}/site.standard.publication/3pub`;
const OTHER_PUB_URI = `at://${POE_DID}/site.standard.publication/3other`;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const SHELL = readFileSync(fileURLToPath(new URL('../shells/blog.html', import.meta.url)), 'utf8');
const T = 'pub.leaflet.blocks.';

interface Net {
  publications: Array<{ rkey: string; value: Record<string, unknown> }>;
  documents: Array<{ rkey: string; value: Record<string, unknown> }>;
  pdsDown?: boolean;
  plcDown?: boolean;
  shellStatus?: number;
  posts?: unknown[];
  /** The droplet's dispatch drafts, by token: what GET /dispatch/preview/<token> answers. */
  previews?: Record<string, { status: number; body?: unknown }>;
}

interface Seen {
  urls: string[];
  shellHeaders: Headers[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(net: Net, seen: Seen): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    seen.urls.push(url.href);
    if (url.origin === 'https://plc.directory') {
      if (net.plcDown) return new Response('down', { status: 502 });
      return json({ id: POE_DID, alsoKnownAs: ['at://poe.atpota.to'], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    }
    if (url.origin === PDS || url.origin === 'https://pds.atpota.to') {
      if (net.pdsDown) return new Response('down', { status: 503 });
      const collection = url.searchParams.get('collection');
      const list = collection === 'site.standard.publication' ? net.publications : collection === 'site.standard.document' ? net.documents : [];
      const records = list.map((r) => ({ uri: `at://${POE_DID}/${collection}/${r.rkey}`, cid: `cid-${r.rkey}`, value: { $type: collection, ...r.value } }));
      if (url.pathname.endsWith('/com.atproto.repo.listRecords')) return json({ records });
      if (url.pathname.endsWith('/com.atproto.repo.getRecord')) {
        const hit = records.find((r) => r.uri.endsWith(`/${url.searchParams.get('rkey')}`));
        return hit ? json(hit) : json({ error: 'RecordNotFound', message: 'nope' }, 400);
      }
    }
    if (url.origin === 'https://public.api.bsky.app') return json({ posts: net.posts ?? [] });
    if (url.origin === 'https://hook.atpota.to' && url.pathname.startsWith('/dispatch/preview/')) {
      const hit = net.previews?.[decodeURIComponent(url.pathname.slice('/dispatch/preview/'.length))];
      return hit ? json(hit.body ?? {}, hit.status) : json({ error: 'NotFound' }, 404);
    }
    if (url.origin === ORIGIN && url.pathname.startsWith('/shells/blog')) {
      seen.shellHeaders.push(new Headers(init?.headers));
      return new Response(net.shellStatus && net.shellStatus !== 200 ? 'missing' : SHELL, { status: net.shellStatus ?? 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
}

const PUBLICATION = { rkey: '3pub', value: { name: 'The Weekly Spud', description: 'news from the atmosphere', url: 'https://atpota.to/blog/' } };

function doc(rkey: string, value: Record<string, unknown>) {
  return { rkey, value: { site: PUB_URI, ...value } };
}

const content = (...blocks: Record<string, unknown>[]) => ({
  $type: 'pub.leaflet.content',
  pages: [{ $type: 'pub.leaflet.pages.linearDocument', blocks: blocks.map((block) => ({ $type: 'pub.leaflet.pages.linearDocument#block', block })) }],
});

const BSKY_URI = 'at://did:plc:alice/app.bsky.feed.post/3post';

function defaultNet(): Net {
  return {
    publications: [PUBLICATION, { rkey: '3other', value: { name: 'Elsewhere', url: 'https://elsewhere.test' } }],
    documents: [
      doc('3new', {
        title: 'Issue 2: </script><script>alert(1)</script>',
        description: 'the second one',
        publishedAt: '2026-10-12T09:00:00.000Z',
        path: '/issue-2',
        tags: ['roundup'],
        bskyPostRef: { uri: 'at://did:plc:6qw63oash3jfnpykvpbwnq5z/app.bsky.feed.post/3ann', cid: 'x' },
        content: content(
          { $type: `${T}header`, level: 1, plaintext: 'This week' },
          { $type: `${T}text`, plaintext: 'hello <b>world</b>' },
          { $type: `${T}bskyPost`, postRef: { uri: BSKY_URI, cid: 'c' } },
        ),
      }),
      doc('3old', { title: 'Issue 1', publishedAt: '2026-10-05T09:00:00.000Z', textContent: 'first issue\n\nsecond paragraph' }),
      doc('3future', { title: 'Scheduled', publishedAt: '2026-11-01T09:00:00.000Z' }),
      { rkey: '3stray', value: { site: OTHER_PUB_URI, title: 'Another publication', publishedAt: '2026-10-10T00:00:00.000Z' } },
      doc('3broken', { title: '', publishedAt: '2026-10-10T00:00:00.000Z' }),
    ],
    posts: [
      {
        uri: BSKY_URI,
        author: { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice' },
        record: { text: 'a post worth reading', createdAt: '2026-10-11T00:00:00.000Z' },
      },
    ],
  };
}

// No pin: these tests find the publication in Poe's repo by its url. The default pin
// (the dispatch) is covered in blog-render.test.ts and by the Leaflet-hosted test below.
const UNPINNED = { BLOG_PUBLICATION_URI: '' };

function setup(net: Net = defaultNet(), env: Record<string, string> = UNPINNED, extra: Partial<BlogDeps> = {}) {
  const seen: Seen = { urls: [], shellHeaders: [] };
  const logs: Array<Record<string, unknown>> = [];
  const h = createBlogHandlers({ env: () => env, fetch: fakeFetch(net, seen), now: () => NOW, log: (f) => logs.push(f), ...extra });
  return { h, seen, logs, net };
}

function get(query: string, init: RequestInit = {}) {
  return new Request(`${ORIGIN}/api/blog?${query}`, init);
}

function html(text: string) {
  return new JSDOM(text).window.document;
}

beforeEach(() => resetEmbedCaches());

describe('/api/blog index', () => {
  it('lists this publication\'s posts newest first, skipping future, foreign and invalid records', async () => {
    const { h } = setup();
    const res = await h.GET(get('view=index'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    const body = await res.text();
    const d = html(body);
    expect([...d.querySelectorAll('.blog-item__title')].map((e) => e.textContent)).toEqual(['Issue 2: </script><script>alert(1)</script>', 'Issue 1']);
    expect([...d.querySelectorAll('.blog-item')].map((a) => a.getAttribute('href'))).toEqual(['/blog/issue-2', '/blog/3old']);
    expect(d.querySelector('h1')!.textContent).toBe('The Weekly Spud');
    expect(d.querySelector('link[rel="site.standard.publication"]')!.getAttribute('href')).toBe(PUB_URI);
    expect(d.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe('https://atpota.to/blog');
    expect(d.querySelector('meta[name="atproto:uri"]')!.getAttribute('content')).toBe(PUB_URI);
    expect(d.querySelector('link[type="application/atom+xml"]')!.getAttribute('href')).toBe('https://atpota.to/blog/feed.xml');
    // the shell's markers and asset list are gone, its nav and scripts are kept
    expect(body).not.toMatch(/@blog-head|@blog-main|data-blog-assets|blog-shell-note|name="robots"/);
    expect(body).toContain('<script type="module" src="/src/scripts/main.ts"></script>');
    expect(d.querySelector('img.blog-hero__potato')!.getAttribute('src')).toBe('/src/assets/mascot/potato-happy.svg');
    expect(body).not.toContain('<script>alert(1)</script>');
  });

  it('shows the placeholder name and an empty state before the publication record exists', async () => {
    const { h } = setup({ publications: [], documents: [] });
    const res = await h.GET(get('view=index'));
    expect(res.status).toBe(200);
    const d = html(await res.text());
    expect(d.querySelector('h1')!.textContent).toBe("poe's atmosphere dispatch");
    expect(d.querySelector('.blog-empty__title')!.textContent).toBe('the first issue is still in the ground.');
    expect(d.querySelector('link[rel="site.standard.publication"]')).toBeNull();
  });

  it('uses a pinned publication URI instead of matching by URL', async () => {
    const net = defaultNet();
    net.documents.push({ rkey: '3pinned', value: { site: OTHER_PUB_URI, title: 'Pinned post', publishedAt: '2026-10-01T00:00:00.000Z' } });
    const { h } = setup(net, { BLOG_PUBLICATION_URI: OTHER_PUB_URI });
    const d = html(await (await h.GET(get('view=index'))).text());
    expect(d.querySelector('h1')!.textContent).toBe('Elsewhere');
    expect([...d.querySelectorAll('.blog-item__title')].map((e) => e.textContent)).toEqual(['Another publication', 'Pinned post']);
  });

  it('caches records briefly in the instance', async () => {
    const { h, seen } = setup();
    await h.GET(get('view=index'));
    await h.GET(get('view=index'));
    expect(seen.urls.filter((u) => u.includes('site.standard.document'))).toHaveLength(1);
  });

  it('answers 503 with a friendly page when the PDS is down, and does not cache it', async () => {
    const { h, logs } = setup({ ...defaultNet(), pdsDown: true });
    const res = await h.GET(get('view=index'));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html(await res.text()).querySelector('h1')!.textContent).toBe("the blog didn't load.");
    expect(logs).toContainEqual(expect.objectContaining({ event: 'records_error', code: 'upstream' }));
  });

  it("falls back to Poe's known PDS when plc.directory is down", async () => {
    const net = defaultNet();
    net.plcDown = true;
    const { h, seen } = setup(net);
    expect((await h.GET(get('view=index'))).status).toBe(200);
    expect(seen.urls.some((u) => u.startsWith('https://pds.atpota.to/xrpc/'))).toBe(true);
  });

  it('forwards the cookie, and the bypass secret only to *.vercel.app, when fetching the shell', async () => {
    const { h, seen } = setup(defaultNet(), { VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-123' });
    await h.GET(get('view=index', { headers: { cookie: '_vercel_jwt=abc' } }));
    expect(seen.shellHeaders[0]!.get('cookie')).toBe('_vercel_jwt=abc');
    expect(seen.shellHeaders[0]!.has('x-vercel-protection-bypass')).toBe(false);

    const preview = 'https://atpota-abc123-atpotato.vercel.app';
    const net = defaultNet();
    const headers: Headers[] = [];
    const base = fakeFetch(net, { urls: [], shellHeaders: [] });
    const h2 = createBlogHandlers({
      env: () => ({ VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-123' }),
      now: () => NOW,
      log: () => undefined,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin === preview) {
          headers.push(new Headers(init?.headers));
          return new Response(SHELL, { status: 200 });
        }
        return base(input, init);
      }) as typeof fetch,
    });
    expect((await h2.GET(new Request(`${preview}/api/blog?view=index`))).status).toBe(200);
    expect(headers[0]!.get('x-vercel-protection-bypass')).toBe('bypass-123');
  });

  it('serves a bare page with 503 when the shell cannot be fetched', async () => {
    const { h, logs } = setup({ ...defaultNet(), shellStatus: 404 });
    const res = await h.GET(get('view=index'));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('<h1 class="blog-hero__title" id="blog-title">The Weekly Spud</h1>');
    expect(logs).toContainEqual(expect.objectContaining({ event: 'shell_error' }));
  });

  it('HEAD has the headers and no body', async () => {
    const { h } = setup();
    const res = await h.HEAD(get('view=index', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('/api/blog post', () => {
  it('renders the post with standard.site and at:// tags, safe JSON-LD and an askable article', async () => {
    const { h } = setup();
    const res = await h.GET(get('view=post&path=issue-2'));
    expect(res.status).toBe(200);
    const body = await res.text();
    const d = html(body);
    const docUri = `at://${POE_DID}/site.standard.document/3new`;
    expect(d.querySelector('link[rel="site.standard.document"]')!.getAttribute('href')).toBe(docUri);
    expect(d.querySelector('link[rel="site.standard.publication"]')!.getAttribute('href')).toBe(PUB_URI);
    expect(d.querySelector('link[rel="alternate"][type="application/at-record+json"]')!.getAttribute('href')).toBe(docUri);
    expect(d.querySelector('meta[name="atproto:cid"]')!.getAttribute('content')).toBe('cid-3new');
    expect(d.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe('https://atpota.to/blog/issue-2');
    expect(d.querySelector('meta[property="article:published_time"]')!.getAttribute('content')).toBe('2026-10-12T09:00:00.000Z');
    // no cover image: the issue's own card (server/og-dispatch.ts)
    expect(d.querySelector('meta[property="og:image"]')!.getAttribute('content')).toBe('https://atpota.to/og/dispatch/3new.png');
    expect(d.querySelector('meta[property="og:image:alt"]')!.getAttribute('content')).toMatch(/^Issue 2: <\/script>.* an issue of The Weekly Spud/);
    expect(d.querySelector('meta[property="og:image:width"]')!.getAttribute('content')).toBe('1200');
    expect(d.title).toBe('Issue 2: </script><script>alert(1)</script> - The Weekly Spud');
    const ld = d.querySelector('script[type="application/ld+json"]')!;
    expect(JSON.parse(ld.textContent!).headline).toBe('Issue 2: </script><script>alert(1)</script>');
    expect(d.querySelectorAll('script:not([type]), script[type="module"]').length).toBeGreaterThan(0);
    expect([...d.querySelectorAll('script')].some((s) => s.textContent === 'alert(1)')).toBe(false);

    const article = d.querySelector('main#main article.post[data-poe-askable]')!;
    expect(article.querySelector('h1')!.textContent).toBe('Issue 2: </script><script>alert(1)</script>');
    expect(article.querySelector('.post__body h2')!.textContent).toBe('This week');
    expect(article.querySelector('.post__body p')!.textContent).toBe('hello <b>world</b>');
    expect(article.querySelector('.post-bsky__text')!.textContent).toBe('a post worth reading');
    // tags stay in the head for feeds and search, not on the page
    expect(article.querySelector('[aria-label="tags"]')).toBeNull();
    expect(d.querySelector('meta[property="article:tag"]')!.getAttribute('content')).toBe('roundup');
    // reply link points at the announcement post; pager links the older post
    expect(d.querySelector('.post-end a[href^="https://bsky.app/profile/did:plc:6qw63oash3jfnpykvpbwnq5z/post/3ann"]')).not.toBeNull();
    expect(d.querySelector('.post-pager__link--older')!.getAttribute('href')).toBe('/blog/3old');
    expect(d.querySelector('.post-pager__link--newer')).toBeNull();
  });

  it('renders a document without Leaflet content from its textContent', async () => {
    const { h } = setup();
    const d = html(await (await h.GET(get('view=post&path=3old'))).text());
    expect([...d.querySelectorAll('.post__body p')].map((p) => p.textContent)).toEqual(['first issue', 'second paragraph']);
    expect(d.querySelector('.post-pager__link--newer')!.getAttribute('href')).toBe('/blog/issue-2');
  });

  it('redirects a record-key address to the path the record names', async () => {
    const { h } = setup();
    const res = await h.GET(get('view=post&path=3new'));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/blog/issue-2');
  });

  it('answers 404 (noindex, short cache) for unknown, future-dated and foreign posts', async () => {
    const { h } = setup();
    for (const path of ['nope', '3future', '3stray', '../etc']) {
      const res = await h.GET(get(`view=post&path=${encodeURIComponent(path)}`));
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control')).toBe(CACHE_MISSING);
      const d = html(await res.text());
      expect(d.querySelector('meta[name="robots"]')!.getAttribute('content')).toBe('noindex');
      expect(d.querySelector('h1')!.textContent).toBe("this post isn't here.");
    }
  });

  it('still renders when the AppView is down (the embed falls back to a link)', async () => {
    const net = defaultNet();
    net.posts = undefined;
    const { h } = setup({ ...net });
    const fetchWithDeadAppView: typeof fetch = async (input, init) => {
      if (String(input).startsWith('https://public.api.bsky.app')) throw new TypeError('fetch failed');
      return fakeFetch(net, { urls: [], shellHeaders: [] })(input, init);
    };
    const h2 = createBlogHandlers({ env: () => UNPINNED, fetch: fetchWithDeadAppView, now: () => NOW, log: () => undefined });
    const res = await h2.GET(get('view=post&path=issue-2'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('a post on bluesky');
    expect(h).toBeDefined();
  });
});

describe('/api/blog feed and well-known', () => {
  it('serves the publication at:// URI for standard.site verification', async () => {
    const { h } = setup();
    const res = await h.GET(get('view=well-known'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe(PUB_URI);
  });

  it('treats a publication hosted elsewhere as a copy: its url is canonical, and it is not claimed here', async () => {
    const net = defaultNet();
    net.publications = [{ rkey: '3pub', value: { ...PUBLICATION.value, url: 'https://poe.leaflet.pub' } }];
    const { h } = setup(net, { BLOG_PUBLICATION_URI: PUB_URI });
    const index = html(await (await h.GET(get('view=index'))).text());
    expect(index.querySelector('h1')!.textContent).toBe('The Weekly Spud');
    expect(index.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe('https://poe.leaflet.pub');
    expect([...index.querySelectorAll('.blog-item')].map((a) => a.getAttribute('href'))).toEqual(['/blog/issue-2', '/blog/3old']);
    const post = html(await (await h.GET(get('view=post&path=issue-2'))).text());
    expect(post.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe('https://poe.leaflet.pub/issue-2');
    expect((await h.GET(get('view=well-known'))).status).toBe(404);
  });

  it('404s the well-known address until the publication exists, 503 when the PDS is down', async () => {
    expect((await setup({ publications: [], documents: [] }).h.GET(get('view=well-known'))).status).toBe(404);
    expect((await setup({ ...defaultNet(), pdsDown: true }).h.GET(get('view=well-known'))).status).toBe(503);
  });

  it('serves an Atom feed of the published posts', async () => {
    const { h } = setup();
    const res = await h.GET(get('view=feed'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8');
    const xml = await res.text();
    expect(xml.match(/<entry /g)).toHaveLength(2);
    expect(xml).toContain('<link href="https://atpota.to/blog/issue-2" rel="alternate" type="text/html"/>');
    expect(xml).toContain(`<id>${PUB_URI}</id>`);
    expect(xml).not.toContain('Scheduled');
  });

  it('api/blog.ts answers other methods with 405', async () => {
    const res = await api.POST(new Request(`${ORIGIN}/api/blog`, { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('/api/blog back from Leaflet', () => {
  // What Leaflet sends a confirmed email subscriber to: its own token, which only it can read.
  const back = (cookie?: string) => get('view=email-return&token=leaflet-only', cookie ? { headers: { cookie } } : {});

  it('sends the reader on to the page they subscribed from, with the return marker', async () => {
    const { h, seen } = setup();
    const res = await h.GET(back(`other=1; ${EMAIL_RETURN_COOKIE}=${encodeURIComponent('/blog/issue-2#signup-2')}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/blog/issue-2?subscribed=email#signup-2');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBe(`${EMAIL_RETURN_COOKIE}=; Path=${LEAFLET_RETURN_PATH}; Max-Age=0; Secure; SameSite=Lax`);
    // no records needed, so a PDS outage doesn't strand anyone here
    expect(seen.urls).toEqual([]);
  });

  it("falls back to the index's form without a cookie, or with one that isn't a blog page here", async () => {
    const { h } = setup();
    expect((await h.GET(back())).headers.get('location')).toBe('/blog?subscribed=email#subscribe');
    for (const bad of ['https://evil.com/blog', '//evil.com/blog', '/\\evil.com/blog', '/settings', '/blogx', '%E0%A4%A']) {
      expect((await h.GET(back(`${EMAIL_RETURN_COOKIE}=${encodeURIComponent(bad)}`))).headers.get('location'), bad).toBe('/blog?subscribed=email#subscribe');
    }
  });
});

describe('poe page titles', () => {
  it('names the blog and its posts without reading records', () => {
    expect(pageTitle('/blog')).toBe("poe's atmosphere dispatch");
    expect(pageTitle('/blog/issue-2')).toBe("a post in poe's atmosphere dispatch");
  });
});

describe('/api/blog dispatch draft preview', () => {
  const TOKEN = 'k3Jx9QwErTyUiOpAsDfGhJkL';
  const draft = (extra: Record<string, unknown> = {}) => ({
    status: 200,
    body: {
      draft: { status: 'ready', version: 3, savedAt: '2026-10-26T13:10:00.000Z', windowStart: '2026-10-19T19:02:15.894Z', windowEnd: '2026-10-26T12:00:00.000Z', ...extra },
      record: {
        $type: 'site.standard.document',
        site: PUB_URI,
        title: 'spaces near beta',
        description: 'a quieter week',
        tags: ['atmosphere', 'dispatch'],
        textContent: 'what builders talked about\n\nspaces is close.',
        content: content(
          { $type: `${T}header`, level: 2, plaintext: 'what builders talked about' },
          { $type: `${T}text`, plaintext: 'spaces is close.', facets: [{ index: { byteStart: 0, byteEnd: 6 }, features: [{ $type: 'pub.leaflet.richtext.facet#bold' }] }] },
          { $type: `${T}bskyPost`, postRef: { uri: BSKY_URI, cid: 'c' } },
        ),
        contributors: [{ did: POE_DID }],
      },
    },
  });

  it('renders the draft as the issue will look, privately: no cache, no index, no canonical, no document link', async () => {
    const net = { ...defaultNet(), previews: { [TOKEN]: draft() } };
    const { h, seen } = setup(net);
    const res = await h.GET(get(`view=preview&token=${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_PREVIEW);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(seen.urls).toContain(`https://hook.atpota.to/dispatch/preview/${TOKEN}`);
    const d = html(await res.text());
    expect(d.querySelector('h1')!.textContent).toBe('spaces near beta');
    expect(d.querySelector('.post__subtitle')!.textContent).toBe('a quieter week');
    expect(d.querySelector('.post-preview')!.textContent).toMatch(/^draft previewversion 3, saved .* · waiting for review\. this isn't published/);
    expect(d.querySelector('.post__body strong')!.textContent).toBe('spaces');
    expect(d.querySelector('.post__body')!.textContent).toContain('a post worth reading');
    expect(d.querySelector('meta[name="robots"]')!.getAttribute('content')).toBe('noindex, nofollow');
    expect(d.querySelector('link[rel="canonical"]')).toBeNull();
    expect(d.querySelector('link[rel="site.standard.document"]')).toBeNull();
    expect(d.querySelector('meta[name="atproto:uri"]')).toBeNull();
    expect(d.querySelector('.post-end')).toBeNull();
    expect(d.title).toBe('draft: spaces near beta - The Weekly Spud');
  });

  it('an unknown or malformed token is not found, and a published draft sends you to the issue', async () => {
    const net = { ...defaultNet(), previews: { [TOKEN]: draft({ status: 'published', published: 'https://atpota.to/blog/3newissue' }) } };
    const { h, seen } = setup(net);
    const missing = await h.GET(get('view=preview&token=nopenopenopenopenopenope'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe(CACHE_PREVIEW);
    expect(missing.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const bad = await h.GET(get('view=preview&token=../../etc/passwd'));
    expect(bad.status).toBe(404);
    expect(seen.urls.some((u) => u.includes('etc'))).toBe(false);
    const out = await h.GET(get(`view=preview&token=${TOKEN}`));
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('https://atpota.to/blog/3newissue');
  });

  it('says unavailable when the droplet is down, and reads DISPATCH_PREVIEW_ORIGIN', async () => {
    const down = setup({ ...defaultNet(), previews: { [TOKEN]: { status: 502 } } });
    const res = await down.h.GET(get(`view=preview&token=${TOKEN}`));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe(CACHE_PREVIEW);
    expect(down.logs.some((l) => l.event === 'preview_error')).toBe(true);

    const other = setup(defaultNet(), { ...UNPINNED, DISPATCH_PREVIEW_ORIGIN: 'https://droplet.example' });
    await other.h.GET(get(`view=preview&token=${TOKEN}`));
    expect(other.seen.urls).toContain(`https://droplet.example/dispatch/preview/${TOKEN}`);
  });
});
