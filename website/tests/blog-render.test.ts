import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyRewrites, compileRewrite, readApiRewrites } from '../build/api-middleware.js';
import { blobUrl, isPublicHost, TtlCache } from '../server/blog/atproto.js';
import {
  bodyImageCids,
  EMPTY_EMBEDS,
  embeddableUrl,
  embedTargets,
  formatDate,
  headingShiftFor,
  leafletPages,
  pagesText,
  renderBlock,
  renderPages,
  type BlockContext,
  type LeafletPage,
} from '../server/blog/blocks.js';
import { ATPOTATO_DID, DEFAULT_PUBLICATION_URI, DEFAULT_PUBLICATION_URL, POE_DID, readBlogConfig } from '../server/blog/config.js';
import { atomFeed } from '../server/blog/feed.js';
import { aturiUrl, jsonForScript, safeColor, safeHref } from '../server/blog/html.js';
import { postBody, readingMinutes, siteInfo } from '../server/blog/pages.js';
import { findDocument, normalizePath, toDocument, type BlogDocument } from '../server/blog/records.js';
import { FootnoteList, renderRichText } from '../server/blog/richtext.js';
import { fillShell, parseShell } from '../server/blog/shell.js';
import { emailAction, emailFormHtml, LEAFLET_RETURN_PATH } from '../server/blog/subscribe.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const ID = { did: POE_DID, pds: 'https://pds.test', handle: 'poe.atpota.to' };
const CID = 'bafkreiethxtad6a254thukly6tjfehwahk3l6k3grxjeox6yp2qcsdlvtu';
const blob = (cid = CID) => ({ $type: 'blob', ref: { $link: cid }, mimeType: 'image/webp', size: 100 });

/** A facet over the bytes of `needle` inside `text`. */
function facet(text: string, needle: string, ...features: Record<string, unknown>[]) {
  const enc = new TextEncoder();
  const start = enc.encode(text.slice(0, text.indexOf(needle))).length;
  return { index: { byteStart: start, byteEnd: start + enc.encode(needle).length }, features };
}

const F = 'pub.leaflet.richtext.facet#';

function ctx(over: Partial<BlockContext> = {}): BlockContext {
  return {
    did: ID.did,
    pds: ID.pds,
    embeds: { posts: new Map(), cards: new Map() },
    footnotes: new FootnoteList(),
    headingShift: 1,
    pages: new Map(),
    linkedPages: [],
    headingIds: new Set(),
    otherPosts: [],
    links: { profile: 'https://bsky.app/profile/poe.atpota.to', feed: '/blog/feed.xml', feedUrl: 'https://atpota.to/blog/feed.xml' },
    ...over,
  };
}

const B = (type: string, fields: Record<string, unknown> = {}) => ({ $type: `pub.leaflet.blocks.${type}`, ...fields });

describe('rich text facets', () => {
  it('counts UTF-8 bytes, not UTF-16 units (emoji and accents before the facet)', () => {
    const text = 'café 🥔 is bold here';
    const html = renderRichText(text, [facet(text, 'bold', { $type: `${F}bold` })]);
    expect(html).toBe('café 🥔 is <strong>bold</strong> here');
  });

  it('snaps a boundary that lands inside a character forward instead of splitting it', () => {
    const text = 'a🥔b';
    // byteStart 2 is inside the 4-byte potato; it snaps to 5 (the "b")
    const html = renderRichText(text, [{ index: { byteStart: 2, byteEnd: 6 }, features: [{ $type: `${F}italic` }] }]);
    expect(html).toBe('a🥔<em>b</em>');
  });

  it('nests overlapping marks and keeps one <a> across a link with mixed formatting', () => {
    const text = 'read the whole post';
    const html = renderRichText(text, [
      facet(text, 'the whole post', { $type: `${F}link`, uri: 'https://example.com/a' }),
      facet(text, 'whole', { $type: `${F}bold` }, { $type: `${F}italic` }),
    ]);
    expect(html).toBe('read <a href="https://example.com/a">the <em><strong>whole</strong></em> post</a>');
  });

  it('escapes text and drops links that are not http(s), mailto, #fragment or at://', () => {
    const text = '<script>alert(1)</script> click';
    const html = renderRichText(text, [facet(text, 'click', { $type: `${F}link`, uri: 'javascript:alert(1)' })]);
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt; click');
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
    expect(safeHref('mailto:hi@atpota.to')).toBe('mailto:hi@atpota.to');
    expect(safeHref('#section')).toBe('#section');
  });

  it('opens at:// mentions and DIDs through Aturi, and bsky facets on bsky.app', () => {
    const text = 'hi @poe and #atproto';
    const leaflet = renderRichText(text, [facet(text, '@poe', { $type: `${F}didMention`, did: POE_DID })]);
    expect(leaflet).toContain(`<a href="https://aturi.to/profile/${POE_DID}">@poe</a>`);
    const bsky = renderRichText(text, [
      facet(text, '@poe', { $type: 'app.bsky.richtext.facet#mention', did: POE_DID }),
      facet(text, '#atproto', { $type: 'app.bsky.richtext.facet#tag', tag: 'atproto' }),
    ]);
    expect(bsky).toContain(`<a href="https://bsky.app/profile/${POE_DID}">@poe</a>`);
    expect(bsky).toContain('<a href="https://bsky.app/hashtag/atproto">#atproto</a>');
    expect(aturiUrl(`at://${POE_DID}/site.standard.document/3abc`)).toBe(`https://aturi.to/profile/${POE_DID}/site.standard.document/3abc`);
  });

  it('numbers footnotes in reading order, once each, after the marked text (outside links)', () => {
    const text = 'one two three';
    const notes = new FootnoteList();
    const note = (id: string) => ({ $type: `${F}footnote`, footnoteId: id, contentPlaintext: `note ${id}` });
    const html = renderRichText(
      text,
      [facet(text, 'two', note('b'), { $type: `${F}link`, uri: 'https://x.test' }), facet(text, 'one', note('a')), facet(text, 'three', note('a'))],
      { footnotes: notes },
    );
    expect(notes.items.map((n) => n.key)).toEqual(['a', 'b']);
    expect(html).toContain('one<sup class="post-fn-ref"><a href="#fn-1"');
    expect(html).toContain('<a href="https://x.test/">two</a><sup class="post-fn-ref"><a href="#fn-2"');
    expect(html.match(/href="#fn-1"/g)).toHaveLength(2);
    // a second reference to the same note links to it but does not repeat the anchor id
    expect(html.match(/id="fnref-1"/g)).toHaveLength(1);
  });

  it('does not put record-chosen ids on the page', () => {
    expect(renderRichText('jump here', [facet('jump here', 'here', { $type: `${F}id`, id: 'main' })])).toBe('jump here');
  });

  it('keeps line breaks and ignores malformed facets', () => {
    const html = renderRichText('a\nb', [{ index: { byteStart: 5, byteEnd: 2 }, features: [{ $type: `${F}bold` }] }, { nope: true }]);
    expect(html).toBe('a<br>b');
  });
});

describe('leaflet blocks', () => {
  it('maps the smallest header level to h2 and gives headings unique ids', () => {
    const pages: LeafletPage[] = [{ id: null, kind: 'linear', blocks: [{ block: B('header', { level: 2, plaintext: 'Same' }), alignment: null }] }];
    const shift = headingShiftFor(pages);
    expect(shift).toBe(0);
    const c = ctx({ headingShift: shift });
    expect(renderBlock(B('header', { level: 2, plaintext: 'Same' }), null, c)).toBe('<h2 id="same">Same</h2>');
    expect(renderBlock(B('header', { level: 3, plaintext: 'Same' }), null, c)).toBe('<h3 id="same-2">Same</h3>');
    expect(renderBlock(B('header', { level: 9, plaintext: 'Deep' }), null, c)).toMatch(/^<h6 /);
    // never reuse an id the page already has (the footer is #about, footnotes are #fn-N)
    expect(renderBlock(B('header', { level: 2, plaintext: 'About' }), null, c)).toBe('<h2 id="s-about">About</h2>');
    expect(renderBlock(B('header', { level: 2, plaintext: 'fn 1' }), null, c)).toBe('<h2 id="s-fn-1">fn 1</h2>');
    expect(renderBlock(B('header', { level: 2, plaintext: 'Main' }), null, c)).toBe('<h2 id="s-main">Main</h2>');
  });

  it('renders text sizes and alignment, and skips empty paragraphs', () => {
    const c = ctx();
    expect(renderBlock(B('text', { plaintext: 'hi', textSize: 'large' }), 'pub.leaflet.pages.linearDocument#textAlignCenter', c)).toBe(
      '<p class="is-large is-center">hi</p>',
    );
    expect(renderBlock(B('text', { plaintext: '   ' }), null, c)).toBe('');
  });

  it('builds image URLs from the repo and validated CIDs, with size and escaped alt', () => {
    const html = renderBlock(B('image', { image: blob(), alt: '"quoted" <alt>', aspectRatio: { width: 1448, height: 1074 }, width: 592 }), null, ctx());
    expect(html).toContain(`src="https://pds.test/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(POE_DID)}&amp;cid=${CID}"`);
    expect(html).toContain('alt="&quot;quoted&quot; &lt;alt&gt;"');
    expect(html).toContain('width="1448" height="1074"');
    expect(html).toContain('style="max-width: 592px"');
    expect(renderBlock(B('image', { image: blob('not a cid!') }), null, ctx())).toBe('');
    expect(blobUrl('https://pds.test', POE_DID, { cid: CID })).toContain(CID);
  });

  it('nests lists, keeps ordered start, and renders checklist items as disabled checkboxes', () => {
    const list = B('orderedList', {
      startIndex: 3,
      children: [
        { content: B('text', { plaintext: 'first' }), checked: true },
        { content: B('text', { plaintext: 'second' }), unorderedListChildren: { children: [{ content: B('text', { plaintext: 'inner' }) }] } },
      ],
    });
    expect(renderBlock(list, null, ctx())).toBe(
      '<ol start="3"><li class="is-check"><input type="checkbox" disabled checked> first</li><li>second<ul><li>inner</li></ul></li></ol>',
    );
  });

  it('escapes code and math, and labels the code language', () => {
    expect(renderBlock(B('code', { plaintext: '<b>&</b>', language: 'html' }), null, ctx())).toBe(
      '<pre class="post-code" data-lang="html"><code>&lt;b&gt;&amp;&lt;/b&gt;</code></pre>',
    );
    expect(renderBlock(B('code', { plaintext: 'x', language: '"><script>' }), null, ctx())).not.toContain('data-lang');
    expect(renderBlock(B('math', { tex: 'a<b' }), null, ctx())).toContain('a&lt;b');
  });

  it('embeds iframes only from known players; anything else becomes a link card', () => {
    expect(embeddableUrl('https://www.youtube.com/embed/abc')).toBe('https://www.youtube.com/embed/abc');
    expect(embeddableUrl('http://www.youtube.com/embed/abc')).toBeNull();
    expect(embeddableUrl('https://evil.example/frame')).toBeNull();
    const yt = renderBlock(B('iframe', { url: 'https://www.youtube.com/embed/abc', aspectRatio: { width: 16, height: 9 } }), null, ctx());
    expect(yt).toContain('<iframe src="https://www.youtube.com/embed/abc"');
    expect(yt).toContain('sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"');
    const other = renderBlock(B('iframe', { url: 'https://evil.example/frame' }), null, ctx());
    expect(other).not.toContain('<iframe');
    expect(other).toContain('href="https://evil.example/frame"');
  });

  it('never renders html blocks or iframe srcdoc', () => {
    expect(renderBlock(B('html', { html: '<script>alert(1)</script>' }), null, ctx())).toBe('');
    expect(renderBlock(B('iframe', { html: '<script>alert(1)</script>' }), null, ctx())).toBe('');
  });

  it('renders website, button and standard.site blocks as links, with fallbacks', () => {
    const site = renderBlock(B('website', { src: 'https://www.example.com/post', title: 'A <post>', description: 'about' }), null, ctx());
    expect(site).toContain('<a class="post-card" href="https://www.example.com/post">');
    expect(site).toContain('A &lt;post&gt;');
    expect(site).toContain('<span class="post-card__host">example.com</span>');
    expect(renderBlock(B('website', { src: 'javascript:alert(1)' }), null, ctx())).toBe('');
    expect(renderBlock(B('button', { url: 'https://x.test', text: 'go' }), null, ctx())).toContain('<a class="btn btn--primary" href="https://x.test/">go</a>');
    const uri = 'at://did:plc:abc/site.standard.document/3xyz';
    expect(renderBlock(B('standardSitePost', { uri }), null, ctx())).toContain('href="https://aturi.to/profile/did:plc:abc/site.standard.document/3xyz"');
    const c = ctx();
    c.embeds.cards.set(uri, { href: 'https://blog.test/a', title: 'Their post', description: null, kicker: 'their blog', imageUrl: null });
    expect(renderBlock(B('standardSitePost', { uri }), null, c)).toContain('<span class="post-card__kicker">their blog</span>');
  });

  it('renders a Bluesky post from the AppView view, else links to it', () => {
    const uri = 'at://did:plc:abc/app.bsky.feed.post/3post';
    expect(renderBlock(B('bskyPost', { postRef: { uri, cid: 'x' } }), null, ctx())).toContain('a post on bluesky');
    const c = ctx();
    c.embeds.posts.set(uri, {
      uri,
      url: 'https://bsky.app/profile/alice.test/post/3post',
      authorName: 'Alice <3',
      handle: 'alice.test',
      avatar: null,
      text: 'hello world',
      facets: [],
      createdAt: '2026-10-01T12:00:00.000Z',
      images: [],
      external: null,
    });
    const html = renderBlock(B('bskyPost', { postRef: { uri, cid: 'x' } }), null, c);
    expect(html).toContain('<strong>Alice &lt;3</strong> <span>@alice.test</span>');
    expect(html).toContain('<time datetime="2026-10-01T12:00:00.000Z">oct 1, 2026</time>');
  });

  it('sanitises drawing colours and caps shapes to valid point lists', () => {
    const html = renderBlock(
      B('drawing', {
        viewBox: { x: 0, y: 0, width: 100, height: 50 },
        strokes: [
          { points: [0, 0, 10, 10], color: 'red;background:url(x)', size: 3 },
          { points: [0, 0, 20, 20], color: '#ff0000', size: 3 },
          { points: [1, 'x'], color: '#000', size: 3 },
        ],
      }),
      null,
      ctx(),
    );
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke="#ff0000"');
    expect(html.match(/<polyline/g)).toHaveLength(2);
    expect(safeColor('rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)');
    expect(safeColor('expression(alert(1))')).toBeNull();
  });

  it('renders sub-pages once, after the main page, where a page block links to them', () => {
    const content = {
      $type: 'pub.leaflet.content',
      pages: [
        { $type: 'pub.leaflet.pages.linearDocument', blocks: [{ block: B('text', { plaintext: 'main' }) }, { block: B('page', { id: 'p-2' }) }, { block: B('page', { id: 'p-2' }) }] },
        { $type: 'pub.leaflet.pages.linearDocument', id: 'p-2', blocks: [{ block: B('text', { plaintext: 'sub page text' }) }] },
        { $type: 'pub.leaflet.pages.linearDocument', id: 'orphan', blocks: [{ block: B('text', { plaintext: 'never linked' }) }] },
      ],
    };
    const pages = leafletPages(content);
    const html = renderPages(pages, ctx());
    expect(html.match(/<section class="post-subpage" id="page-p-2">/g)).toHaveLength(1);
    expect(html).toContain('<span class="post-pagelink__title">sub page text</span>');
    expect(html).not.toContain('never linked');
    expect(pagesText(pages)).toContain('sub page text');
  });

  it('reads canvas pages top to bottom, and finds embeds and body images', () => {
    const pages = leafletPages({
      $type: 'pub.leaflet.content',
      pages: [
        {
          $type: 'pub.leaflet.pages.canvas',
          blocks: [
            { block: B('text', { plaintext: 'second' }), x: 0, y: 200, width: 100 },
            { block: B('text', { plaintext: 'first' }), x: 0, y: 10, width: 100 },
            { block: B('bskyPost', { postRef: { uri: 'at://did:plc:abc/app.bsky.feed.post/3p' } }), x: 0, y: 300, width: 100 },
            { block: B('standardSitePublication', { uri: 'at://did:plc:abc/site.standard.publication/3q' }), x: 0, y: 400, width: 100 },
            { block: B('image', { image: blob() }), x: 0, y: 500, width: 100 },
          ],
        },
      ],
    });
    expect(pagesText(pages)).toBe('first\n\nsecond');
    expect(embedTargets(pages)).toEqual({ posts: ['at://did:plc:abc/app.bsky.feed.post/3p'], records: ['at://did:plc:abc/site.standard.publication/3q'] });
    expect(bodyImageCids(pages).has(CID)).toBe(true);
    expect(leafletPages({ $type: 'something.else', pages: [] })).toEqual([]);
  });

  it('formats dates in UTC, lowercase', () => {
    expect(formatDate('2026-10-19T23:30:00.000Z')).toBe('oct 19, 2026');
    expect(readingMinutes('word '.repeat(450))).toBe(2);
  });
});

describe('records', () => {
  const entry = (value: Record<string, unknown>, rkey = '3mabc') => ({ uri: `at://${POE_DID}/site.standard.document/${rkey}`, cid: 'bafycid', value });

  it('requires a title and a valid publishedAt, and cleans tags and paths', () => {
    expect(toDocument(entry({ title: '', publishedAt: '2026-01-01T00:00:00Z' }), ID)).toBeNull();
    expect(toDocument(entry({ title: 'x', publishedAt: 'yesterday' }), ID)).toBeNull();
    const doc = toDocument(entry({ title: ' Hi ', publishedAt: '2026-01-01T00:00:00Z', tags: ['#atproto', 3, ' bluesky '], path: 'weekly-1/', coverImage: blob() }), ID)!;
    expect(doc.title).toBe('Hi');
    expect(doc.tags).toEqual(['atproto', 'bluesky']);
    expect(doc.path).toBe('/weekly-1');
    expect(doc.coverCid).toBe(CID);
    expect(doc.rkey).toBe('3mabc');
  });

  it('normalises paths and refuses traversal or odd characters', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
    expect(normalizePath('../etc')).toBeNull();
    expect(normalizePath('/a/../b')).toBeNull();
    expect(normalizePath('/a b')).toBeNull();
    expect(normalizePath('/a"><script>')).toBeNull();
  });

  it('finds a document by its path first, then by record key', () => {
    const a = toDocument(entry({ title: 'A', publishedAt: '2026-01-01T00:00:00Z', path: '/hello' }, '3aaa'), ID)!;
    const b = toDocument(entry({ title: 'B', publishedAt: '2026-01-02T00:00:00Z' }, '3bbb'), ID)!;
    const docs: BlogDocument[] = [b, a];
    expect(findDocument(docs, 'hello')).toBe(a);
    expect(findDocument(docs, '3aaa')).toBe(a);
    expect(findDocument(docs, '3bbb/')).toBe(b);
    expect(findDocument(docs, 'nope')).toBeNull();
    expect(findDocument(docs, '')).toBeNull();
  });
});

describe('config', () => {
  it("defaults to the dispatch in atpota.to's repo, shown at https://atpota.to/blog", () => {
    expect(DEFAULT_PUBLICATION_URI).toBe('at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n');
    expect(readBlogConfig({})).toEqual({
      did: ATPOTATO_DID,
      publicationUri: DEFAULT_PUBLICATION_URI,
      publicationUrl: DEFAULT_PUBLICATION_URL,
      commentsEnabled: true,
      emailEnabled: true,
      hiddenComments: new Set(),
    });
    expect(readBlogConfig({ BLOG_EMAIL_DISABLED: '1' }).emailEnabled).toBe(false);
  });

  it('credits poe as the author and names the repo owner separately', () => {
    const site = siteInfo(null, DEFAULT_PUBLICATION_URL, 'atpota.to');
    expect(site.handle).toBe('poe.atpota.to');
    expect(site.owner).toBe('atpota.to');
  });

  it("an empty pin turns pinning off: the publication is found by url in BLOG_DID's repo, else Poe's", () => {
    expect(readBlogConfig({ BLOG_PUBLICATION_URI: '' })).toMatchObject({ did: POE_DID, publicationUri: null, publicationUrl: DEFAULT_PUBLICATION_URL });
    expect(readBlogConfig({ BLOG_PUBLICATION_URI: ' ', BLOG_DID: 'did:plc:abcdefghijklmnopqrstuvwx' }).did).toBe('did:plc:abcdefghijklmnopqrstuvwx');
  });

  it('accepts a pinned publication (its repo becomes the DID) and ignores junk', () => {
    const uri = 'at://did:plc:abcdefghijklmnopqrstuvwx/site.standard.publication/3lpq72oeo3c2y';
    expect(readBlogConfig({ BLOG_PUBLICATION_URI: uri })).toMatchObject({ did: 'did:plc:abcdefghijklmnopqrstuvwx', publicationUri: uri });
    expect(readBlogConfig({ BLOG_DID: 'not-a-did', BLOG_PUBLICATION_URI: 'https://x', BLOG_PUBLICATION_URL: 'http://insecure.test/blog' })).toEqual(
      readBlogConfig({}),
    );
    expect(readBlogConfig({ BLOG_PUBLICATION_URL: 'https://example.com/news/' }).publicationUrl).toBe('https://example.com/news');
  });
});

describe('shell', () => {
  const html =
    '<head><!-- @blog-head --><title>x</title><!-- /@blog-head --></head><body>' +
    '<div hidden data-blog-assets>\n<img data-asset="potato-happy" src="/assets/happy-abc.svg" alt="">\n<img src="data:image/svg+xml,a&amp;b" data-asset="sprout" alt="">\n</div>\n' +
    '<main><!-- @blog-main -->placeholder<!-- /@blog-main --></main></body>';

  it('reads asset URLs (either attribute order) and removes the list', () => {
    const shell = parseShell(html);
    expect(shell.assets.get('potato-happy')).toBe('/assets/happy-abc.svg');
    expect(shell.assets.get('sprout')).toBe('data:image/svg+xml,a&b');
    expect(shell.html).not.toContain('data-blog-assets');
  });

  it('fills both regions without treating "$" in content as a replacement pattern', () => {
    const out = fillShell(parseShell(html), { head: '<title>$& $1 $$</title>', main: 'costs $5' });
    expect(out).toContain('<title>$& $1 $$</title>');
    expect(out).toContain('<main>costs $5</main>');
    expect(out).not.toContain('@blog-');
  });

  it('refuses a page without the markers', () => {
    expect(() => parseShell('<html></html>')).toThrow(/missing/);
  });

  it('the real shell has the markers, the assets the pages use, and blog nav state', () => {
    const real = readFileSync(`${root}shells/blog.html`, 'utf8');
    const shell = parseShell(real);
    for (const name of ['potato-happy', 'potato-wink', 'potato-dead', 'potato-sleepy', 'sprout']) expect(shell.assets.has(name)).toBe(true);
    expect(real).toContain('<body data-page="blog"');
    expect(real).toContain('<script type="module" src="/src/scripts/main.ts"></script>');
    expect(real).toContain('/src/styles/blog.css');
  });
});

describe('helpers', () => {
  it('jsonForScript cannot close the script element', () => {
    expect(jsonForScript({ a: '</script><script>alert(1)</script>' })).not.toMatch(/<\/script/i);
  });

  it('only treats public host names as a PDS', () => {
    for (const host of ['pds.atpota.to', 'chanterelle.us-west.host.bsky.network']) expect(isPublicHost(host), host).toBe(true);
    for (const host of ['localhost', '127.0.0.1', '169.254.169.254', '[::1]', 'printer.local', 'db.internal', 'intranet']) expect(isPublicHost(host), host).toBe(false);
  });

  it('TtlCache expires entries', () => {
    let now = 0;
    const cache = new TtlCache<number>(100, () => now);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    now = 100;
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('atom feed', () => {
  it('is well-formed XML with escaped content and the publication as its id', async () => {
    const { JSDOM } = await import('jsdom');
    const doc = toDocument(
      { uri: `at://${POE_DID}/site.standard.document/3mabc`, cid: 'c', value: { title: 'Fish & <chips>', publishedAt: '2026-10-01T00:00:00Z', description: 'a\u0001b', tags: ['x'] } },
      ID,
    )!;
    const site = siteInfo(null, DEFAULT_PUBLICATION_URL, 'poe.atpota.to');
    const xml = atomFeed(site, [{ doc, html: '<p>hi &amp; bye</p>' }], '2026-10-19T00:00:00.000Z');
    const parsed = new JSDOM(xml, { contentType: 'application/xml' }).window.document;
    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.querySelector('entry > title')!.textContent).toBe('Fish & <chips>');
    expect(parsed.querySelector('entry > content')!.textContent).toBe('<p>hi &amp; bye</p>');
    expect(parsed.querySelector('entry > link')!.getAttribute('href')).toBe('https://atpota.to/blog/3mabc');
    expect(parsed.querySelector('feed > author > name')!.textContent).toBe('poe');
    expect(xml).not.toContain('\u0001');
  });
});

describe('dev rewrites mirror vercel.json', () => {
  it('compiles :name, :name* and :name+ sources', () => {
    const rules = [compileRewrite({ source: '/blog/:path*', destination: '/api/blog?view=post&path=:path*' })];
    expect(applyRewrites(rules, '/blog/a/b', '?x=1')).toBe('/api/blog?view=post&path=a%2Fb&x=1');
    expect(applyRewrites(rules, '/blog', '')).toBe('/api/blog?view=post&path=');
    expect(applyRewrites(rules, '/blogs', '')).toBeNull();
    const plus = [compileRewrite({ source: '/x/:id+', destination: '/api/x?id=:id' })];
    expect(applyRewrites(plus, '/x', '')).toBeNull();
    expect(() => compileRewrite({ source: '/a/(.*)', destination: '/api/a' })).toThrow(/unsupported/);
  });

  it('routes the blog addresses in vercel.json to api/blog', () => {
    const rules = readApiRewrites(`${root}vercel.json`);
    const route = (path: string) => {
      const out = applyRewrites(rules, path, '');
      return out ? Object.fromEntries(new URL(out, 'http://x').searchParams) : null;
    };
    expect(route('/blog')).toEqual({ view: 'index' });
    expect(route('/blog/feed.xml')).toEqual({ view: 'feed' });
    expect(route('/blog/3mabc')).toEqual({ view: 'post', path: '3mabc' });
    expect(route('/.well-known/site.standard.publication/blog')).toEqual({ view: 'well-known' });
    expect(route(LEAFLET_RETURN_PATH)).toEqual({ view: 'email-return' });
    expect(route('/shells/blog')).toBeNull();
    expect(route('/guides/bluesky-for-brands')).toBeNull();
  });
});

describe('email subscribe form', () => {
  // The `action` value in the dispatch's "Embeddable Subscribe Form" snippet on Leaflet.
  const SNIPPET_ACTION =
    '%7B%22action%22%3A%22subscribe%22%2C%22publication%22%3A%22at%3A%2F%2Fdid%3Aplc%3Aqntsxa2i4sb24noi45fx4np2%2Fsite.standard.publication%2F3myar4h4pls2n%22%2C%22source%22%3A%7B%22placement%22%3A%22embed%22%7D%7D';
  const PUBLICATION = { uri: DEFAULT_PUBLICATION_URI, cid: 'p', rkey: '3myar4h4pls2n', name: 'Dispatch', description: null, url: 'https://poe.leaflet.pub', iconUrl: null };

  it("is Leaflet's embeddable form for the dispatch, coming back to atpota.to", async () => {
    expect(emailAction(DEFAULT_PUBLICATION_URI)).toBe(SNIPPET_ACTION);
    const { JSDOM } = await import('jsdom');
    const d = new JSDOM(`<body>${emailFormHtml({ publication: DEFAULT_PUBLICATION_URI, redirect: 'https://atpota.to/blog' }, 'subscribe')}</body>`).window;
    const form = d.document.querySelector('form')!;
    // On the button, so Safari doesn't take the form for a sign-in (see subscribe.ts).
    expect(form.hasAttribute('action')).toBe(false);
    expect(form.querySelector('button[type="submit"]')!.getAttribute('formaction')).toBe('https://leaflet.pub/api/auth/email-login');
    expect(form.getAttribute('method')).toBe('get');
    expect(form.id).toBe('subscribe');
    expect(form.querySelector<HTMLInputElement>('input[name="action"]')!.value).toBe(SNIPPET_ACTION);
    // No return marker: Leaflet's "back" link goes here before anything is confirmed.
    expect(form.querySelector<HTMLInputElement>('input[name="redirect"]')!.value).toBe('https://atpota.to/blog#subscribe');
    const email = form.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(email.type).toBe('email');
    expect(email.required).toBe(true);
    expect(email.closest('label')!.textContent).toBe('your email');
    // What the browser sends: the same fields as Leaflet's snippet.
    expect([...new d.FormData(form).keys()]).toEqual(['action', 'redirect', 'email']);
  });

  it('turns signup blocks into the email form and bluesky button on a post, and links elsewhere', () => {
    const c = ctx({ signup: { publication: DEFAULT_PUBLICATION_URI, redirect: 'https://atpota.to/blog/3doc' } });
    const first = renderBlock(B('signup'), null, c);
    expect(first).toContain('id="signup"');
    expect(first).toContain('value="https://atpota.to/blog/3doc#signup"');
    expect(first).toContain('<button type="button" class="blog-alt__link" data-blog-subscribe aria-pressed="false" hidden>');
    expect(renderBlock(B('signup'), null, c)).toContain('id="signup-2"');
    const plain = renderBlock(B('signup'), null, ctx());
    expect(plain).not.toContain('<form');
    expect(plain).toContain('href="https://bsky.app/profile/poe.atpota.to"');
  });

  it('keeps forms out of the feed', () => {
    const site = siteInfo(PUBLICATION, 'https://poe.leaflet.pub', 'atpota.to', true);
    const doc = toDocument({ uri: `at://${ATPOTATO_DID}/site.standard.document/3doc`, cid: 'c', value: { title: 'T', publishedAt: '2026-10-01T00:00:00Z' } }, ID)!;
    const input = { site, doc, pages: [{ id: null, kind: 'linear' as const, blocks: [{ block: B('signup'), alignment: null }] }], text: '', embeds: EMPTY_EMBEDS, did: ID.did, pds: ID.pds, others: [], headingShift: 1 };
    expect(postBody(input)).not.toContain('<form');
    expect(postBody({ ...input, signupReturn: 'https://atpota.to/blog/3doc' })).toContain('<form class="blog-email" id="signup"');
    expect(postBody({ ...input, site: siteInfo(PUBLICATION, 'https://poe.leaflet.pub', 'atpota.to', false), signupReturn: 'https://atpota.to/blog/3doc' })).not.toContain('<form');
  });
});
