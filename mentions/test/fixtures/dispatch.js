// Fakes for the dispatch tests: an in-memory PDS and web standing in for every
// network call announce() and the proposal endpoint make.
import assert from "node:assert/strict";
import { config } from "../../src/config.js";

export const POE = "did:plc:6qw63oash3jfnpykvpbwnq5z";
const PUBLISHER = config.dispatch.publisherDid;
const PUBLICATION = config.dispatch.publicationUri;

export const docUri = (rkey) => `at://${PUBLISHER}/site.standard.document/${rkey}`;
export const pageFor = (rkey, { image = 'https://atpota.to/og/blog.png' } = {}) =>
  `<html><head><link rel="alternate" href="${docUri(rkey)}"/>` +
  `<link rel="site.standard.document" href="${docUri(rkey)}"/>` +
  `<meta property="og:image:type" content="image/png"/>` +
  (image ? `<meta property="og:image" content="${image}"/>` : '') + '</head></html>';

export function documentValue(rkey, extra = {}) {
  return {
    $type: 'site.standard.document',
    site: PUBLICATION,
    path: `/${rkey}`,
    title: 'attie sites, spaces near beta, and a brand new cow',
    description: 'bluesky widened attie into a site builder and the atmosphere argued about it.',
    publishedAt: '2026-10-19T19:02:15.894Z',
    updatedAt: '2026-10-19T19:05:14.122Z',
    tags: ['atmosphere', 'dispatch'],
    contributors: [{ did: POE }],
    textContent: 'the big thing this week was attie.',
    content: { $type: 'pub.leaflet.content', pages: [{ $type: 'pub.leaflet.pages.linearDocument', blocks: [] }] },
    ...extra,
  };
}

export const publicationRecord = (url = 'https://atpota.to/blog') => ({
  uri: PUBLICATION, cid: 'bafypublication',
  value: { $type: 'site.standard.publication', url, name: "poe's atmosphere dispatch" },
});

let seq = 0;
/**
 * An in-memory PDS and web, standing in for every network call announce makes.
 * `publication` is the dispatch's publication record: null when it is missing,
 * a function to make reading it throw.
 */
export function network(rkey, { value = documentValue(rkey), page, publisher = true, publication = publicationRecord() } = {}) {
  const s = {
    docs: new Map([[rkey, { uri: docUri(rkey), cid: `bafydoc${++seq}`, value }]]),
    posts: new Map(), created: [], puts: [], uploads: [], images: [], pageUrls: [],
    publisher, failCreateAfterWrite: false, failPut: null, beforePut: null,
  };
  const clone = (x) => (x ? structuredClone(x) : null);
  const deps = {
    listDocuments: async () => [...s.docs.values()].map(clone),
    getDocument: async (k) => clone(s.docs.get(k)),
    getPublication: async () => (typeof publication === 'function' ? publication() : clone(publication)),
    getOwnPost: async (k) => clone(s.posts.get(k)),
    createPost: async (record, k) => {
      assert.ok(k, 'posts under a stored key');
      if (s.posts.has(k)) throw new Error('record already exists');
      const post = { uri: `at://${POE}/app.bsky.feed.post/${k}`, cid: `bafypost${++seq}`, value: record };
      s.posts.set(k, post);
      s.created.push({ record, rkey: k });
      if (s.failCreateAfterWrite) { s.failCreateAfterWrite = false; throw new Error('socket hang up'); }
      return { uri: post.uri, cid: post.cid };
    },
    uploadBlob: async (bytes, mimeType) => {
      s.uploads.push(mimeType);
      return { $type: 'blob', ref: { $link: 'bafkthumb' }, mimeType, size: bytes.length };
    },
    putDocument: async (k, record, swapRecord) => {
      s.beforePut?.(s);
      s.puts.push({ rkey: k, record: structuredClone(record), swapRecord });
      if (s.failPut) { const err = s.failPut; s.failPut = null; throw err; }
      const current = s.docs.get(k);
      if (current.cid !== swapRecord) { const err = new Error('InvalidSwap'); err.error = 'InvalidSwap'; throw err; }
      const next = { uri: current.uri, cid: `bafydoc${++seq}`, value: structuredClone(record) };
      s.docs.set(k, next);
      return { uri: next.uri, cid: next.cid };
    },
    publisherConfigured: () => s.publisher,
    fetchPage: async (url) => {
      s.pageUrls.push(url);
      return page ? page(s.pageUrls.length) : { status: 200, html: pageFor(rkey) };
    },
    fetchImage: async (url) => { s.images.push(url); return { bytes: Buffer.from('png!'), mimeType: 'image/png' }; },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return { s, deps };
}

