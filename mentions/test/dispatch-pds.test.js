// The announce command against a fake PDS over HTTP, so the real atproto.js
// calls are exercised: both sessions and their DID checks, createRecord with a
// stored rkey, uploadBlob, and putRecord with swapRecord. Only the web page
// and its image are stubbed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import { announce, defaultDeps } from '../src/dispatch.js';
import { putPublisherDocument, getPublicRecord } from '../src/atproto.js';

const POE = 'did:plc:6qw63oash3jfnpykvpbwnq5z';
const PUBLISHER = config.dispatch.publisherDid;
const RKEY = '3myasnk4bzk22';
config.botDid = POE;
config.botHandle = 'poe.atpota.to';
config.appPassword = 'poe-app-password';

const pds = {
  records: new Map(),     // "did/collection/rkey" -> { cid, value }
  calls: [],
  publisherSessionDid: PUBLISHER,
  cid: 0,
};
const key = (repo, collection, rkey) => `${repo}/${collection}/${rkey}`;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

let server;
before(async () => {
  pds.records.set(key(PUBLISHER, 'site.standard.document', RKEY), {
    cid: 'bafyoriginal',
    value: {
      $type: 'site.standard.document', site: config.dispatch.publicationUri, path: `/${RKEY}`,
      title: 'attie sites, spaces near beta, and a brand new cow', description: 'a week in the atmosphere',
      publishedAt: '2026-10-19T19:02:15.894Z', updatedAt: '2026-10-19T19:05:14.122Z',
      tags: ['atmosphere', 'dispatch'], contributors: [{ did: POE }], textContent: 'body',
      content: { $type: 'pub.leaflet.content', pages: [] },
    },
  });
  pds.records.set(key(PUBLISHER, 'site.standard.publication', config.dispatch.publicationRkey), {
    cid: 'bafypublication',
    value: { $type: 'site.standard.publication', url: 'https://atpota.to/blog', name: "poe's atmosphere dispatch" },
  });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const nsid = url.pathname.replace('/xrpc/', '');
    const auth = req.headers.authorization ?? '';
    pds.calls.push({ nsid, auth, contentType: req.headers['content-type'], body: raw });
    if (nsid === 'com.atproto.server.createSession') {
      const { identifier, password } = JSON.parse(raw);
      if (password === 'poe-app-password' && identifier === POE) {
        return json(res, 200, { did: POE, handle: 'poe.atpota.to', accessJwt: 'poe-token', refreshJwt: 'poe-refresh' });
      }
      if (password === 'publisher-app-password') {
        return json(res, 200, { did: pds.publisherSessionDid, handle: 'atpota.to', accessJwt: 'pub-token', refreshJwt: 'pub-refresh' });
      }
      return json(res, 401, { error: 'AuthenticationRequired' });
    }
    if (nsid === 'com.atproto.repo.getRecord') {
      const r = pds.records.get(key(url.searchParams.get('repo'), url.searchParams.get('collection'), url.searchParams.get('rkey')));
      if (!r) return json(res, 400, { error: 'RecordNotFound', message: 'Could not locate record' });
      return json(res, 200, {
        uri: `at://${url.searchParams.get('repo')}/${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`, ...r,
      });
    }
    if (nsid === 'com.atproto.repo.listRecords') {
      const prefix = `${url.searchParams.get('repo')}/${url.searchParams.get('collection')}/`;
      const records = [...pds.records].filter(([k]) => k.startsWith(prefix))
        .map(([k, r]) => ({ uri: `at://${k}`, ...r }));
      return json(res, 200, { records });
    }
    if (nsid === 'com.atproto.repo.uploadBlob') {
      if (auth !== 'Bearer poe-token') return json(res, 401, { error: 'AuthenticationRequired' });
      return json(res, 200, { blob: { $type: 'blob', ref: { $link: 'bafkthumb' }, mimeType: req.headers['content-type'], size: raw.length } });
    }
    const body = JSON.parse(raw);
    const owner = { 'Bearer poe-token': POE, 'Bearer pub-token': pds.publisherSessionDid }[auth];
    if (!owner || owner !== body.repo) return json(res, 401, { error: 'AuthenticationRequired' });
    const k = key(body.repo, body.collection, body.rkey);
    if (nsid === 'com.atproto.repo.createRecord') {
      if (pds.records.has(k)) return json(res, 400, { error: 'InvalidRequest', message: 'Record already exists' });
      const cid = `bafycreated${++pds.cid}`;
      pds.records.set(k, { cid, value: body.record });
      return json(res, 200, { uri: `at://${k}`, cid });
    }
    if (nsid === 'com.atproto.repo.putRecord') {
      if (body.swapRecord && pds.records.get(k)?.cid !== body.swapRecord) return json(res, 400, { error: 'InvalidSwap' });
      const cid = `bafyput${++pds.cid}`;
      pds.records.set(k, { cid, value: body.record });
      return json(res, 200, { uri: `at://${k}`, cid });
    }
    json(res, 404, { error: 'MethodNotImplemented' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.pdsUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const web = {
  fetchPage: async (url) => ({
    status: 200,
    html: `<link rel="site.standard.document" href="at://${PUBLISHER}/site.standard.document/${url.split('/').pop()}">` +
      '<meta property="og:image" content="https://atpota.to/og/blog.png">',
  }),
  fetchImage: async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' }),
  sleep: async () => {},
};

test('listPublicRecords reads a repo collection without a credential', async () => {
  const { listPublicRecords } = await import('../src/atproto.js');
  const page = await listPublicRecords(PUBLISHER, 'site.standard.document', { limit: 100 });
  assert.deepEqual(page.records.map((r) => r.uri), [`at://${PUBLISHER}/site.standard.document/${RKEY}`]);
  assert.equal(pds.calls.at(-1).auth, '');
});

test('getPublicRecord answers null for a missing record', async () => {
  assert.equal(await getPublicRecord(PUBLISHER, 'site.standard.document', 'nothinghere'), null);
});

test('the publisher write refuses anything outside the dispatch publication', async () => {
  config.dispatch.publisherAppPassword = 'publisher-app-password';
  try {
    await assert.rejects(putPublisherDocument(RKEY, { $type: 'app.bsky.feed.post', text: 'x' }, 'bafy'),
      /outside the dispatch publication/);
    await assert.rejects(putPublisherDocument(RKEY,
      { $type: 'site.standard.document', site: `at://${PUBLISHER}/site.standard.publication/other` }, 'bafy'),
      /outside the dispatch publication/);
    await assert.rejects(putPublisherDocument(RKEY,
      { $type: 'site.standard.document', site: config.dispatch.publicationUri }), /needs swapRecord/);
  } finally { config.dispatch.publisherAppPassword = ''; }
});

test('announce over HTTP: posts under a stored key from Poe, links from atpota.to with swapRecord', async () => {
  config.dispatch.publisherAppPassword = 'publisher-app-password';
  try {
    const reply = await announce({ rkey: RKEY, text: null }, { ...defaultDeps, ...web });
    assert.match(reply, /^announced/);
  } finally { config.dispatch.publisherAppPassword = ''; }

  const create = pds.calls.find((c) => c.nsid === 'com.atproto.repo.createRecord');
  const createBody = JSON.parse(create.body);
  assert.equal(create.auth, 'Bearer poe-token');
  assert.equal(createBody.repo, POE);
  assert.equal(createBody.collection, 'app.bsky.feed.post');
  assert.match(createBody.rkey, /^[234567a-j][234567a-z]{12}$/);
  assert.equal(createBody.record.embed.external.thumb.ref.$link, 'bafkthumb');
  assert.equal(createBody.record.embed.external.uri, `https://atpota.to/blog/${RKEY}`);
  assert.deepEqual(createBody.record.embed.external.associatedRefs.map((r) => r.cid), ['bafyoriginal', 'bafypublication']);

  const upload = pds.calls.find((c) => c.nsid === 'com.atproto.repo.uploadBlob');
  assert.equal(upload.contentType, 'image/png');
  assert.equal(upload.auth, 'Bearer poe-token');

  const put = pds.calls.find((c) => c.nsid === 'com.atproto.repo.putRecord');
  const putBody = JSON.parse(put.body);
  assert.equal(put.auth, 'Bearer pub-token');
  assert.equal(putBody.repo, PUBLISHER);
  assert.equal(putBody.collection, 'site.standard.document');
  assert.equal(putBody.swapRecord, 'bafyoriginal');
  assert.equal(putBody.record.bskyPostRef.uri, `at://${POE}/app.bsky.feed.post/${createBody.rkey}`);

  const sessions = pds.calls.filter((c) => c.nsid === 'com.atproto.server.createSession')
    .map((c) => JSON.parse(c.body).identifier);
  assert.deepEqual(sessions.sort(), [POE, PUBLISHER].sort());
});

test('a publisher credential for the wrong account is refused before any write', async () => {
  const rkey = '3mywrongacct2';
  const { bskyPostRef: _linked, ...unlinked } = pds.records.get(key(PUBLISHER, 'site.standard.document', RKEY)).value;
  pds.records.set(key(PUBLISHER, 'site.standard.document', rkey), { cid: 'bafywrong', value: { ...unlinked, path: `/${rkey}` } });
  pds.publisherSessionDid = 'did:plc:somebodyelse';
  config.dispatch.publisherAppPassword = 'publisher-app-password';
  const before = pds.calls.filter((c) => c.nsid === 'com.atproto.repo.putRecord').length;
  try {
    // The earlier test left a publisher session cached. A fresh copy of the
    // module signs in again, the way a restart would.
    const fresh = await import('../src/atproto.js?fresh');
    const reply = await announce({ rkey, text: 'new issue' }, {
      ...defaultDeps, ...web, putDocument: fresh.putPublisherDocument,
    });
    assert.match(reply, /linking the issue failed \(publisher credential is for did:plc:somebodyelse/);
  } finally {
    config.dispatch.publisherAppPassword = '';
    pds.publisherSessionDid = PUBLISHER;
  }
  assert.equal(pds.calls.filter((c) => c.nsid === 'com.atproto.repo.putRecord').length, before);
});
