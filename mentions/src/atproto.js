// atproto.js
// The only place in the system that holds a write credential.
//
// Plain fetch against the PDS. app.bsky.* calls are proxied by the PDS to its
// appview, so listNotifications works against pds.atpota.to with the session
// token rather than needing a second host.

import { config } from './config.js';
import { logger } from './logger.js';
import { isNapping } from './nap.js';
import { killSwitchEngaged } from './config.js';

let session = null;          // { accessJwt, refreshJwt, did, handle }
let sessionPromise = null;

function xrpcUrl(nsid) {
  return `${config.pdsUrl}/xrpc/${nsid}`;
}

async function rawPost(nsid, body, token) {
  const res = await fetch(xrpcUrl(nsid), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function rawGet(nsid, params, token, signal) {
  const url = new URL(xrpcUrl(nsid));
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function createSession() {
  if (!config.appPassword) throw new Error('ATPROTO_APP_PASSWORD is not set');
  // Identify by DID, not by handle. A DID is permanent; a handle is a DNS
  // record somebody can change, and during a handle migration it can be
  // unresolvable for as long as the negative-cache window (3601s on atpota.to).
  // Authenticating by handle would make the poster fail for an hour over a
  // cosmetic rename. The DID is also what the self-gate and every match key on.
  const res = await rawPost('com.atproto.server.createSession', {
    identifier: config.botDid,
    password: config.appPassword,
  });
  if (!res.ok) {
    throw new Error(`createSession failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 200)}`);
  }
  if (res.json.did !== config.botDid) {
    // A credential for a different account than the one we gate on would make
    // every self-check meaningless.
    throw new Error(`credential is for ${res.json.did}, expected ATPOTATO_DID ${config.botDid}`);
  }
  logger.info('atproto session created', { did: res.json.did, handle: res.json.handle });
  return {
    accessJwt: res.json.accessJwt,
    refreshJwt: res.json.refreshJwt,
    did: res.json.did,
    handle: res.json.handle,
  };
}

async function refreshSession() {
  if (!session?.refreshJwt) return createSession();
  const res = await rawPost('com.atproto.server.refreshSession', {}, session.refreshJwt);
  if (!res.ok) {
    logger.warn('refreshSession failed; creating a new session', { status: res.status });
    return createSession();
  }
  logger.debug('atproto session refreshed');
  return {
    accessJwt: res.json.accessJwt,
    refreshJwt: res.json.refreshJwt,
    did: res.json.did,
    handle: res.json.handle,
  };
}

async function ensureSession() {
  if (session) return session;
  if (!sessionPromise) {
    sessionPromise = createSession()
      .then((s) => { session = s; return s; })
      .finally(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

/** Call an authenticated endpoint, refreshing once on an expired token. */
async function authed(fn) {
  await ensureSession();
  let res = await fn(session.accessJwt);
  if (res.status === 400 && /ExpiredToken|InvalidToken/i.test(res.json?.error ?? '')) {
    session = await refreshSession();
    res = await fn(session.accessJwt);
  }
  return res;
}

export function currentSession() {
  return session;
}

/** Notifications, newest first. The canonical record of who tried to reach us. */
export async function listNotifications({ limit = 50, cursor } = {}) {
  const res = await authed((t) =>
    rawGet('app.bsky.notification.listNotifications', { limit, cursor }, t)
  );
  if (!res.ok) {
    throw new Error(`listNotifications failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 200)}`);
  }
  return res.json;
}

const SEARCH_MAX_BYTES = 512 * 1024;

async function readSearchResponse(response) {
  if (Number(response.headers.get('content-length')) > SEARCH_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('search response too large');
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    size += chunk.length;
    if (size > SEARCH_MAX_BYTES) {
      await reader.cancel();
      throw new Error('search response too large');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid search response'); }
}

function retryAfterSeconds(value) {
  if (value == null) return null;
  if (/^\d+$/.test(value)) return Math.min(Number(value), 3600);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000))) : null;
}

/** The PDS proxies this authenticated appview read. No credential leaves this module. */
export async function searchPostsV2(params) {
  const url = new URL(xrpcUrl('app.bsky.feed.searchPostsV2'));
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
    else url.searchParams.append(key, String(value));
  }
  const signal = AbortSignal.timeout(8000);
  const result = await authed(async (token) => {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal });
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
      await response.body?.cancel();
      return { ok: false, status: 429, retryAfter };
    }
    if (!response.ok && response.status !== 400) {
      await response.body?.cancel();
      return { ok: false, status: response.status };
    }
    const json = await readSearchResponse(response);
    return { ok: response.ok, status: response.status, json };
  });
  if (!result.ok) return { status: result.status === 429 ? 429 : 502, retryAfter: result.retryAfter ?? null };

  const data = result.json;
  if (!data || !Array.isArray(data.posts) || data.posts.length > 25 ||
      (data.cursor != null && (typeof data.cursor !== 'string' || data.cursor.length > 2048)) ||
      (data.hitsTotal != null && (!Number.isSafeInteger(data.hitsTotal) || data.hitsTotal < 0))) {
    throw new Error('invalid search response');
  }
  const posts = data.posts.map((post) => {
    const uri = post?.uri;
    const match = typeof uri === 'string' && /^at:\/\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9._:~-]+)$/.exec(uri);
    const author = post?.author;
    const record = post?.record;
    if (!match || author?.did !== match[1] || typeof author?.handle !== 'string' ||
        !/^[a-zA-Z0-9.-]{1,253}$/.test(author.handle) ||
        typeof record?.text !== 'string' || typeof record?.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(record.createdAt))) throw new Error('invalid search post');
    const counts = {};
    for (const key of ['likeCount', 'repostCount', 'replyCount', 'quoteCount']) {
      const count = post[key] ?? 0;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid search counts');
      counts[key] = count;
    }
    return {
      uri, author: { did: author.did, handle: author.handle }, text: record.text,
      ...counts, createdAt: record.createdAt,
      link: `https://bsky.app/profile/${encodeURIComponent(author.did)}/post/${encodeURIComponent(match[2])}`,
    };
  });
  const limit = params.limit ?? 10;
  return { status: 200, body: {
    ok: true, posts: posts.slice(0, limit), cursor: data.cursor ?? null,
    hitsTotal: data.hitsTotal ?? null, searchRanked: true, truncated: posts.length > limit,
  } };
}

// --- what this credential may write -------------------------------------------
// The brief said replies only: never a follow, like, block, mute or label. On
// 2026-09-24 the potato also started publishing its lessons and its notes about
// people in its own repo, so the rule is now three collections, enforced here,
// in the one module that holds the credential. Posts are never deleted.
// Likes were added on 2026-10-19 for the agent's appreciate_post proposals
// (likes.js): only of a post just replied to, after the reply posted.
export const MEMORY_COLLECTION = 'to.atpota.poe.memory';
export const LESSON_COLLECTION = 'to.atpota.poe.lesson';
const PUBLIC_ACTIONS = new Set(['app.bsky.feed.post', 'app.bsky.feed.like']);
const WRITABLE = new Set([...PUBLIC_ACTIONS, MEMORY_COLLECTION, LESSON_COLLECTION]);
const DELETABLE = new Set([MEMORY_COLLECTION, LESSON_COLLECTION]);

function assertWritable(collection, { deleting = false } = {}) {
  if (!(deleting ? DELETABLE : WRITABLE).has(collection)) {
    throw new Error(`refusing to ${deleting ? 'delete from' : 'write to'} ${collection}: not a collection this service writes`);
  }
}

async function repoWrite(nsid, body) {
  const res = await authed((t) => {
    if (PUBLIC_ACTIONS.has(body.collection) && (killSwitchEngaged() || isNapping())) {
      throw new Error('public post paused by kill switch or operator nap');
    }
    return rawPost(nsid, { repo: config.botDid, ...body }, t);
  });
  if (!res.ok) {
    const err = new Error(`${nsid} failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json;
}

/** Create or replace one record at a known key. */
export async function putRecord(collection, rkey, record) {
  assertWritable(collection);
  return repoWrite('com.atproto.repo.putRecord', { collection, rkey, record });
}

/** Create one record under a key the PDS chooses. */
export async function createRecord(collection, record) {
  assertWritable(collection);
  return repoWrite('com.atproto.repo.createRecord', { collection, record });
}

/** Delete one record. Callers decide what an already-missing record means. */
export async function deleteRecord(collection, rkey) {
  assertWritable(collection, { deleting: true });
  return repoWrite('com.atproto.repo.deleteRecord', { collection, rkey });
}

/**
 * Create an app.bsky.feed.post record in our own repo. `rkey`, when given, is
 * a key the caller stored before calling, so a retry after an ambiguous failure
 * can look the post up instead of posting it twice.
 */
export async function createPost(record, { napAcknowledgment = false, rkey } = {}) {
  const res = await authed((t) => {
    // Re-check after session creation/refresh, and on every post of a thread.
    if (killSwitchEngaged() || (isNapping() && !napAcknowledgment)) {
      throw new Error('public post paused by kill switch or operator nap');
    }
    return rawPost('com.atproto.repo.createRecord', {
      repo: config.botDid,
      collection: 'app.bsky.feed.post',
      ...(rkey ? { rkey } : {}),
      record,
    }, t);
  });
  if (!res.ok) {
    const err = new Error(`createRecord failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 300)}`);
    err.status = res.status;
    err.body = res.json ?? res.text;
    throw err;
  }
  return res.json;   // { uri, cid, commit, validationStatus }
}

/**
 * A post and the posts above it, nearest `parentHeight` of them, no replies.
 *
 * Read through our own session rather than the public appview so the appview
 * applies our viewer state: a post by someone who has blocked the potato comes
 * back as a blocked stub, not as text it should not be reading.
 */
export async function getPostThread(uri, { parentHeight = 12, timeoutMs = 5000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await authed((t) =>
      rawGet('app.bsky.feed.getPostThread', { uri, depth: 0, parentHeight }, t, ac.signal)
    );
    if (!res.ok) throw new Error(`getPostThread failed: ${res.status} ${res.json?.error ?? ''}`);
    return res.json;
  } finally {
    clearTimeout(timer);
  }
}

/** Hydrated posts by URI, for the cid a notification did not carry. */
export async function getPosts(uris) {
  if (!uris.length) return { posts: [] };
  const url = new URL(xrpcUrl('app.bsky.feed.getPosts'));
  for (const u of uris.slice(0, 25)) url.searchParams.append('uris', u);
  const res = await authed(async (t) => {
    const r = await fetch(url, { headers: { authorization: `Bearer ${t}` } });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, json, text };
  });
  if (!res.ok) throw new Error(`getPosts failed: ${res.status} ${res.json?.error ?? ''}`);
  return res.json;
}

/**
 * One record from a repo on our PDS, read without a credential. Returns
 * { uri, cid, value }, or null when the record does not exist.
 */
export async function getPublicRecord(repo, collection, rkey) {
  const res = await rawGet('com.atproto.repo.getRecord', { repo, collection, rkey }, null,
    AbortSignal.timeout(10000));
  if (res.status === 400 && /RecordNotFound/i.test(res.json?.error ?? '')) return null;
  if (res.status === 404) return null;
  if (!res.ok || typeof res.json?.cid !== 'string' || !res.json?.value) {
    throw new Error(`getRecord failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 200)}`);
  }
  return res.json;
}

/** A page of records from a repo on our PDS, read without a credential. */
export async function listPublicRecords(repo, collection, { limit = 100, cursor } = {}) {
  const res = await rawGet('com.atproto.repo.listRecords', { repo, collection, limit, cursor }, null,
    AbortSignal.timeout(10000));
  if (!res.ok || !Array.isArray(res.json?.records)) {
    throw new Error(`listRecords failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 200)}`);
  }
  return res.json;   // { records: [{ uri, cid, value }], cursor? }
}

/** Upload an image for a post's card. The blob belongs to our repo. */
export async function uploadBlob(bytes, mimeType) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mimeType)) throw new Error(`refusing to upload ${mimeType}`);
  const res = await authed(async (token) => {
    const response = await fetch(xrpcUrl('com.atproto.repo.uploadBlob'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': mimeType },
      body: bytes,
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    return { ok: response.ok, status: response.status, json, text };
  });
  if (!res.ok || !res.json?.blob) {
    throw new Error(`uploadBlob failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 200)}`);
  }
  return res.json.blob;
}

// --- the publisher credential -------------------------------------------------
// Dispatch issues are site.standard.document records in atpota.to's repo, so
// linking an issue to its announcement needs atpota.to's credential. It gets
// its own session and exactly one thing it may do: put a document in the
// dispatch publication. Nothing else in this module will use it.
let publisher = null;
let publisherPromise = null;

export function publisherConfigured() {
  return !!config.dispatch.publisherAppPassword;
}

async function publisherCreateSession() {
  const { publisherIdentifier, publisherAppPassword, publisherDid } = config.dispatch;
  if (!publisherAppPassword) throw new Error('DISPATCH_PUBLISHER_APP_PASSWORD is not set');
  const res = await rawPost('com.atproto.server.createSession', {
    identifier: publisherIdentifier,
    password: publisherAppPassword,
  });
  if (!res.ok) {
    throw new Error(`publisher createSession failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 200)}`);
  }
  if (res.json.did !== publisherDid) {
    throw new Error(`publisher credential is for ${res.json.did}, expected ${publisherDid}`);
  }
  logger.info('publisher session created', { did: res.json.did, handle: res.json.handle });
  return { accessJwt: res.json.accessJwt, refreshJwt: res.json.refreshJwt };
}

async function publisherAuthed(fn) {
  if (!publisher) {
    publisherPromise ??= publisherCreateSession()
      .then((s) => { publisher = s; return s; })
      .finally(() => { publisherPromise = null; });
    await publisherPromise;
  }
  let res = await fn(publisher.accessJwt);
  if (res.status === 400 && /ExpiredToken|InvalidToken/i.test(res.json?.error ?? '')) {
    const refreshed = await rawPost('com.atproto.server.refreshSession', {}, publisher.refreshJwt);
    publisher = refreshed.ok && refreshed.json?.did === config.dispatch.publisherDid
      ? { accessJwt: refreshed.json.accessJwt, refreshJwt: refreshed.json.refreshJwt }
      : await publisherCreateSession();
    res = await fn(publisher.accessJwt);
  }
  return res;
}

/**
 * Replace a dispatch document in atpota.to's repo. `swapRecord` is the cid the
 * caller read, so an edit made since then fails with err.error 'InvalidSwap'
 * instead of being overwritten.
 */
export async function putPublisherDocument(rkey, record, swapRecord) {
  if (record?.$type !== 'site.standard.document' || record.site !== config.dispatch.publicationUri) {
    throw new Error('refusing to write a document outside the dispatch publication');
  }
  if (typeof swapRecord !== 'string' || !swapRecord) throw new Error('putPublisherDocument needs swapRecord');
  const res = await publisherAuthed((t) => {
    if (killSwitchEngaged()) throw new Error('publishing paused by kill switch');
    return rawPost('com.atproto.repo.putRecord', {
      repo: config.dispatch.publisherDid,
      collection: 'site.standard.document',
      rkey, record, swapRecord,
    }, t);
  });
  if (!res.ok) {
    const err = new Error(`putRecord site.standard.document failed: ${res.status} ${res.json?.error ?? res.text.slice(0, 300)}`);
    err.status = res.status;
    err.error = res.json?.error;
    throw err;
  }
  return res.json;   // { uri, cid }
}

// --- handle resolution ----------------------------------------------------
// Jetstream commits carry a DID and no handle. The agent's payload contract
// includes authorHandle, and omitting it is rejected with a 400 -- so a mention
// detected on the low-latency path has to have its handle filled in before
// dispatch. The notification sweep already gets one for free.
//
// Resolved from the DID document, which is the authoritative source, with the
// appview as a fallback for DID methods plc.directory does not serve. Cached
// for the process lifetime: a handle can change, but not often enough to matter
// for the minutes between matching and dispatching.
const handleCache = new Map();

export async function resolveHandleForDid(did, { timeoutMs = 8000 } = {}) {
  if (handleCache.has(did)) return handleCache.get(did);

  const attempt = async (url, pick) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) return null;
      return pick(await res.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  let handle = null;
  if (did.startsWith('did:plc:')) {
    handle = await attempt(
      `https://plc.directory/${encodeURIComponent(did)}`,
      (doc) => {
        const aka = Array.isArray(doc?.alsoKnownAs) ? doc.alsoKnownAs : [];
        const first = aka.find((a) => typeof a === 'string' && a.startsWith('at://'));
        return first ? first.slice('at://'.length) : null;
      }
    );
  }
  if (!handle) {
    handle = await attempt(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
      (j) => (typeof j?.handle === 'string' && j.handle !== 'handle.invalid' ? j.handle : null)
    );
  }

  if (handle) handleCache.set(did, handle);
  return handle;
}

// Chat is a separate service; the PDS signs/proxies these requests with the
// service DID. The app password remains on the droplet, never in the agent.
async function chatRequest(nsid, { params, body } = {}) {
  const url = new URL(xrpcUrl(nsid));
  for (const [key, value] of Object.entries(params ?? {})) {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
    else if (value != null) url.searchParams.set(key, String(value));
  }
  const res = await authed(async (token) => {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: response.ok, status: response.status, json, text };
  });
  if (!res.ok) throw new Error(`${nsid} failed: ${res.status} ${res.json?.error ?? ''}`);
  return res.json;
}

export const listDmConvos = (cursor) => chatRequest('chat.bsky.convo.listConvos', {
  params: { limit: 100, cursor, kind: 'direct' },
});
export const listDmRequests = (cursor) => chatRequest('chat.bsky.convo.listConvoRequests', {
  params: { limit: 100, cursor },
});
export const acceptDmConvo = (convoId) => chatRequest('chat.bsky.convo.acceptConvo', {
  body: { convoId },
});
export const getDmMessages = (convoId, cursor) => chatRequest('chat.bsky.convo.getMessages', {
  params: { convoId, cursor, limit: 100 },
});
/** A messageId makes it a reply to that message; null sends it plain. */
export const sendDmMessage = (convoId, messageId, text) => chatRequest('chat.bsky.convo.sendMessage', {
  body: { convoId, message: { text, ...(messageId ? { replyTo: { messageId } } : {}) } },
});
export const addDmReaction = (convoId, messageId, value) => chatRequest('chat.bsky.convo.addReaction', {
  body: { convoId, messageId, value },
});
export const removeDmReaction = (convoId, messageId, value) => chatRequest('chat.bsky.convo.removeReaction', {
  body: { convoId, messageId, value },
});
