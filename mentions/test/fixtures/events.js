// Recorded Jetstream v2 payload shapes, captured from
// wss://jetstream.us-west.bsky.network on 2026-09-18. No network in the tests.

export const BOT_DID = 'did:plc:qntsxa2i4sb24noi45fx4np2';
export const BOT_HANDLE = 'atpota.to';
export const OTHER_DID = 'did:plc:someoneelse00000000000';
export const THIRD_DID = 'did:plc:thirdparty0000000000000';

/** A real v2 envelope, as it arrives on the socket. */
export function envelope(payload) {
  return { $type: 'message', payload: { $type: 'network.bsky.jetstream.subscribeEvents#commit', ...payload } };
}

let seq = 26065109699;

export function commit({
  did = OTHER_DID,
  rkey = '3mvstqsciak2c',
  cid = 'bafyreieyb6nj3mxllhkuuk7th736b5w54bluwsrvqg4jyk3yjldppexsii',
  record,
  operation = 'create',
  collection = 'app.bsky.feed.post',
} = {}) {
  return {
    cid, collection, did, operation, rkey,
    rev: '3mvstqsfwxr2g',
    seq: seq++,
    time: new Date().toISOString(),
    record,
  };
}

export function post({
  text = 'hello',
  createdAt = new Date().toISOString(),
  langs = ['en'],
  facets,
  reply,
  embed,
} = {}) {
  const r = { $type: 'app.bsky.feed.post', createdAt, text };
  if (langs) r.langs = langs;
  if (facets) r.facets = facets;
  if (reply) r.reply = reply;
  if (embed) r.embed = embed;
  return r;
}

export function mentionFacet(did, byteStart = 0, byteEnd = 10) {
  return [{
    $type: 'app.bsky.richtext.facet',
    features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
    index: { byteStart, byteEnd },
  }];
}

export function tagFacet(tag = 'joke') {
  return [{
    $type: 'app.bsky.richtext.facet',
    features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    index: { byteStart: 0, byteEnd: 5 },
  }];
}

export function strongRef(uri, cid = 'bafyreiroot000000000000000000000000000000000000000000') {
  return { uri, cid };
}
