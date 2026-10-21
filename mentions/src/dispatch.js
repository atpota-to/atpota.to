// dispatch.js
// Poe's weekly dispatch, the droplet's half. Phase 0: the operator's
// `announce <link>` command, which posts the announcement for an issue that was
// already published by hand, and links the issue to it.
//
// Issues are site.standard.document records in atpota.to's repo, in the
// Leaflet publication "poe's atmosphere dispatch". The announcement is a post
// in Poe's repo. Its steps are publishing steps 3 to 6 of the brief (check the
// page, post, link, confirm), so the later `approve` flow reuses them.
//
// Every step records its result before the next one starts, so a crash or a
// repeated command resumes rather than repeats. The one step that cannot be
// undone is the post, and that is guarded by its record key: a TID is stored
// before createRecord is called, so a retry after an ambiguous failure looks
// the post up under that key instead of posting a second time.

import { config, isAdmin, killSwitchEngaged, DISPATCH_PAGE_BASES } from './config.js';
import { db, nowIso } from './db.js';
import { logger } from './logger.js';
import * as atproto from './atproto.js';
import { detectLinks, detectHandles, graphemeLength, byteLength } from './richtext.js';
import { isNapping } from './nap.js';

db.exec(`
  -- One row per dispatch document the droplet has announced or seen announced.
  CREATE TABLE IF NOT EXISTS dispatch_document (
    document_uri  TEXT PRIMARY KEY,
    document_rkey TEXT NOT NULL,
    document_cid  TEXT,                 -- as last read or written
    title         TEXT,
    page_url      TEXT,                 -- what the announcement card links
    post_rkey     TEXT UNIQUE,          -- claimed before posting; never reused for another document
    post_uri      TEXT,
    post_cid      TEXT,
    post_text     TEXT,
    posted_at     TEXT,
    linked_at     TEXT,                 -- when the document's bskyPostRef pointed at the post
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  -- Operator commands, kept so a restart can finish one that was running.
  CREATE TABLE IF NOT EXISTS dispatch_command (
    message_id    TEXT PRIMARY KEY,     -- the operator's DM
    operator_did  TEXT NOT NULL,
    kind          TEXT NOT NULL,        -- announce | announce_latest | usage
    document_rkey TEXT,                 -- for announce_latest, filled in once resolved
    post_text     TEXT,                 -- the operator's lines after the link, if any
    status        TEXT NOT NULL,        -- running | done
    reply         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  -- Announcements Poe proposed in an operator DM. One is live at a time, and
  -- it posts only on the operator's yes to the DM that showed it.
  CREATE TABLE IF NOT EXISTS dispatch_proposal (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dm_message_id       TEXT NOT NULL,  -- the operator DM Poe was answering
    operator_did        TEXT NOT NULL,
    document_rkey       TEXT NOT NULL,
    title               TEXT NOT NULL,
    page_url            TEXT NOT NULL,
    text                TEXT NOT NULL,  -- exactly what the operator is shown and what posts
    status              TEXT NOT NULL,  -- proposed | attached | confirmed | declined | superseded
    decision_message_id TEXT,
    created_at          TEXT NOT NULL,
    decided_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS dispatch_proposal_dm_idx ON dispatch_proposal (dm_message_id, status);

  -- The audit log.
  CREATE TABLE IF NOT EXISTS dispatch_event (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    issue         TEXT,
    document_uri  TEXT,
    kind          TEXT NOT NULL,
    detail        TEXT,
    created_at    TEXT NOT NULL
  );
`);

export const POST_MAX_GRAPHEMES = 300;
const POST_MAX_BYTES = 3000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const THUMB_MAX_BYTES = 1000000;          // app.bsky.embed.external#external.thumb maxSize
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

export const ANNOUNCE_USAGE = [
  'usage: announce <link>, or announce latest',
  '',
  'the link can be https://poe.leaflet.pub/<rkey>, https://atpota.to/blog/<rkey>, or ' +
    `at://${config.dispatch.publisherDid}/site.standard.document/<rkey>. ` +
    '"latest" is the most recently published issue in the dispatch.',
  'post text is optional and goes on the lines after the link. without it i post the title and description.',
].join('\n');

function event(documentUri, kind, detail = null) {
  db.prepare(`INSERT INTO dispatch_event (issue, document_uri, kind, detail, created_at)
    VALUES (NULL, ?, ?, ?, ?)`).run(documentUri, kind,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), nowIso());
}

// --- parsing ---------------------------------------------------------------

/** Whether a DM is an announce command, by its first word. Cheap; no parsing. */
export function isAnnounceText(text) {
  return typeof text === 'string' && /^\s*announce(?:\s|$)/i.test(text);
}

/** The document rkey a link names, or null. Only the dispatch's own pages count. */
export function parseIssueLink(link) {
  if (typeof link !== 'string') return null;
  const atUri = new RegExp(
    `^at://${config.dispatch.publisherDid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/site\\.standard\\.document/([^/?#]+)$`
  ).exec(link);
  let rkey = atUri?.[1] ?? null;
  if (!rkey) {
    const web = link.replace(/[?#].*$/, '').replace(/\/+$/, '');
    for (const base of DISPATCH_PAGE_BASES) {
      // The Bluesky app drops the scheme when it shortens a link, so the bare
      // form is accepted too.
      for (const prefix of [`${base}/`, `${base.replace(/^https:\/\//, '')}/`]) {
        if (web.toLowerCase().startsWith(prefix)) rkey = web.slice(prefix.length);
      }
    }
  }
  if (!rkey || !RKEY.test(rkey) || rkey === '.' || rkey === '..') return null;
  return rkey;
}

/**
 * `announce <link>` on the first line, optional post text on the lines after.
 * Returns null when the first word is not "announce", { kind: 'usage' } when
 * it is but the rest does not parse, or { kind: 'announce', rkey, text }.
 */
export function parseAnnounceCommand(text) {
  if (!isAnnounceText(text)) return null;
  const [first, ...rest] = text.trim().split(/\r?\n/);
  const arg = first.trim().replace(/^announce/i, '').trim();
  const postText = rest.join('\n').trim() || null;
  // "announce latest", "announce the latest dispatch", "announce latest issue"
  if (/^(?:the\s+)?latest(?:\s+(?:dispatch|issue))?[.!]?$/i.test(arg)) {
    return { kind: 'announce', latest: true, rkey: null, text: postText };
  }
  // A link that does not parse is a mistyped command and gets the usage. Plain
  // words ("announce that one please") are not a command at all: they go to
  // Poe, who can propose the announcement instead.
  const linkish = /(?:https?:\/\/|at:\/\/|poe\.leaflet\.pub\/|atpota\.to\/blog\/)/i.test(arg);
  if (!arg || /\s/.test(arg)) return linkish ? { kind: 'usage' } : null;
  const rkey = parseIssueLink(arg);
  if (!rkey) return linkish ? { kind: 'usage' } : null;
  return { kind: 'announce', rkey, text: postText };
}

// --- text -------------------------------------------------------------------

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Cut text to fit a post, at a word boundary, with an ellipsis. */
export function fitPostText(text, maxGraphemes = POST_MAX_GRAPHEMES, maxBytes = POST_MAX_BYTES) {
  if (graphemeLength(text) <= maxGraphemes && byteLength(text) <= maxBytes) return text;
  const parts = [...graphemes.segment(text)].map((s) => s.segment);
  let n = maxGraphemes - 1;
  let cut = parts.slice(0, n).join('');
  while (byteLength(cut) > maxBytes - 3 && n > 0) cut = parts.slice(0, --n).join('');
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s,;:.!?—–-]+$/u, '')}…`;
}

/** The announcement's text when the operator gave none. */
export function defaultPostText(title, description) {
  return fitPostText(description ? `${title}\n\n${description}` : title);
}

/** Why operator text cannot be posted as is, or null. It is refused, never cut. */
export function operatorTextProblem(text) {
  const n = graphemeLength(text);
  if (n > POST_MAX_GRAPHEMES) {
    return `that post text is ${n} graphemes and a post holds ${POST_MAX_GRAPHEMES}, so i didn't post anything. ` +
      'shorten it and send the command again.';
  }
  if (byteLength(text) > POST_MAX_BYTES) {
    return `that post text is over ${POST_MAX_BYTES} bytes, so i didn't post anything. shorten it and send the command again.`;
  }
  return null;
}

// --- records ------------------------------------------------------------------

// Base32-sortable TID, as atproto record keys use: 53 bits of microseconds and
// 10 bits of clock id, in 13 characters.
const S32 = '234567abcdefghijklmnopqrstuvwxyz';
const clockId = BigInt(Math.floor(Math.random() * 1024));
let lastMicros = 0;

export function nextTid(nowMs = Date.now()) {
  let micros = nowMs * 1000;
  if (micros <= lastMicros) micros = lastMicros + 1;
  lastMicros = micros;
  let n = (BigInt(micros) << 10n) | clockId;
  let out = '';
  for (let i = 0; i < 13; i++) { out = S32[Number(n & 31n)] + out; n >>= 5n; }
  return out;
}

export function postUrl(uri) {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(String(uri ?? ''));
  if (!m) return String(uri);
  const who = m[1] === config.botDid ? config.botHandle : m[1];
  return `https://bsky.app/profile/${who}/post/${m[2]}`;
}

/** The issue's pages: the one the card links first, then the other. */
export function pageUrls(rkey) {
  const first = `${config.dispatch.announceUrlBase}/${rkey}`;
  return [first, ...DISPATCH_PAGE_BASES.filter((b) => b !== config.dispatch.announceUrlBase).map((b) => `${b}/${rkey}`)];
}

/**
 * The announcement post. The link to the issue is its only facet: featured
 * people are not pinged, and nothing else in the text becomes clickable.
 */
export function buildAnnouncement({ text, pageUrl, alsoLinks = [], title, description, thumb = null }) {
  const linkable = new Set([pageUrl, ...alsoLinks]);
  const facets = detectLinks(text)
    .filter((l) => linkable.has(l.uri.replace(/\/+$/, '')))
    .map((l) => ({
      index: { byteStart: l.byteStart, byteEnd: l.byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: l.uri }],
    }));
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: nowIso(),
    langs: ['en'],
    embed: {
      $type: 'app.bsky.embed.external',
      external: { uri: pageUrl, title, description, ...(thumb ? { thumb } : {}) },
    },
  };
  if (facets.length) record.facets = facets;
  return record;
}

// --- pages ----------------------------------------------------------------------

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[k];
  });
}

function tagAttributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Whether a page carries <link rel="site.standard.document" href="<uri>">. */
export function pageHasDocument(html, documentUri) {
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const a = tagAttributes(m[0]);
    if ((a.rel ?? '').split(/\s+/).includes('site.standard.document') && a.href === documentUri) return true;
  }
  return false;
}

/** The content of a page's <meta property="..."> (og:image, og:title...), or null. */
export function ogContent(html, property) {
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const a = tagAttributes(m[0]);
    if (a.property === property && a.content) return a.content;
  }
  return null;
}

export function ogImageUrl(html) {
  return ogContent(html, 'og:image');
}

async function fetchCapped(url, { maxBytes, timeoutMs = 15000 }) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${url} is over ${maxBytes} bytes`);
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`${url} is over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return {
    status: response.status,
    contentType: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
    bytes: Buffer.concat(chunks),
  };
}

async function fetchPage(url) {
  const res = await fetchCapped(url, { maxBytes: PAGE_MAX_BYTES });
  return { status: res.status, html: res.bytes.toString('utf8') };
}

async function fetchImage(url) {
  const res = await fetchCapped(url, { maxBytes: THUMB_MAX_BYTES });
  if (res.status !== 200) throw new Error(`card image answered ${res.status}`);
  if (!/^image\/(png|jpeg|webp|gif)$/.test(res.contentType)) throw new Error(`card image is ${res.contentType || 'untyped'}`);
  return { bytes: res.bytes, mimeType: res.contentType };
}

/**
 * Poll the page until it answers 200 and names the document. Leaflet indexes
 * from the network, so this is the proof it has the issue.
 */
export async function waitForPage(pageUrl, documentUri, deps) {
  const { pagePollMs, pageTimeoutMs } = config.dispatch;
  const deadline = Date.now() + pageTimeoutMs;
  let last = 'no answer';
  for (;;) {
    try {
      const page = await deps.fetchPage(pageUrl);
      if (page.status === 200 && pageHasDocument(page.html, documentUri)) return { ok: true, html: page.html };
      last = page.status === 200 ? 'the page does not name the document yet' : `HTTP ${page.status}`;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() + pagePollMs > deadline) return { ok: false, last };
    await deps.sleep(pagePollMs);
  }
}

const siteOf = (host) => host.toLowerCase().split('.').slice(-2).join('.');

/** The page's Open Graph image as a blob in Poe's repo. Best effort. */
export async function cardThumb(html, pageUrl, deps) {
  const src = ogImageUrl(html);
  if (!src) return { thumb: null, note: 'the page has no og:image' };
  let url;
  try { url = new URL(src, pageUrl); } catch { return { thumb: null, note: 'the og:image is not a URL' }; }
  if (url.protocol !== 'https:' || siteOf(url.hostname) !== siteOf(new URL(pageUrl).hostname)) {
    return { thumb: null, note: `the og:image is not on ${siteOf(new URL(pageUrl).hostname)}` };
  }
  try {
    const image = await deps.fetchImage(url.href);
    return { thumb: await deps.uploadBlob(image.bytes, image.mimeType), note: null };
  } catch (err) {
    return { thumb: null, note: err.message };
  }
}

// --- state ----------------------------------------------------------------------

const getDocumentRow = (uri) => db.prepare('SELECT * FROM dispatch_document WHERE document_uri = ?').get(uri);

function recordPost(documentUri, uri, cid) {
  db.prepare(`UPDATE dispatch_document SET post_uri = ?, post_cid = ?, posted_at = ?, updated_at = ?
    WHERE document_uri = ?`).run(uri, cid, nowIso(), nowIso(), documentUri);
}

function markLinked(documentUri, documentCid) {
  db.prepare(`UPDATE dispatch_document SET linked_at = COALESCE(linked_at, ?),
    document_cid = COALESCE(?, document_cid), updated_at = ? WHERE document_uri = ?`)
    .run(nowIso(), documentCid ?? null, nowIso(), documentUri);
}

/** Every document in atpota.to's repo, up to 500, from any publication. */
async function listDocuments() {
  const out = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const res = await atproto.listPublicRecords(config.dispatch.publisherDid, 'site.standard.document',
      { limit: 100, cursor });
    out.push(...res.records);
    if (!res.cursor || res.records.length < 100) break;
    cursor = res.cursor;
  }
  return out;
}

/**
 * The dispatch's most recently published document, by publishedAt. The repo
 * also holds documents from other publications, which never count.
 */
export async function latestDocument(deps) {
  const own = new RegExp(`^at://${config.dispatch.publisherDid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/site\\.standard\\.document/([^/]+)$`);
  const docs = (await deps.listDocuments()).filter((r) =>
    own.test(String(r?.uri)) && RKEY.test(own.exec(r.uri)[1]) &&
    r.value?.$type === 'site.standard.document' && r.value.site === config.dispatch.publicationUri &&
    Number.isFinite(Date.parse(r.value.publishedAt)));
  if (!docs.length) return null;
  docs.sort((a, b) => Date.parse(b.value.publishedAt) - Date.parse(a.value.publishedAt));
  return { rkey: own.exec(docs[0].uri)[1], title: String(docs[0].value.title ?? '') };
}

export const defaultDeps = {
  listDocuments,
  getDocument: (rkey) => atproto.getPublicRecord(config.dispatch.publisherDid, 'site.standard.document', rkey),
  getOwnPost: (rkey) => atproto.getPublicRecord(config.botDid, 'app.bsky.feed.post', rkey),
  createPost: (record, rkey) => atproto.createPost(record, { rkey }),
  uploadBlob: (bytes, mimeType) => atproto.uploadBlob(bytes, mimeType),
  putDocument: (rkey, record, swapRecord) => atproto.putPublisherDocument(rkey, record, swapRecord),
  publisherConfigured: () => atproto.publisherConfigured(),
  fetchPage,
  fetchImage,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// --- the steps ------------------------------------------------------------------

/**
 * Point the document's bskyPostRef at the post, every other field unchanged,
 * guarded by swapRecord. Never throws: the post is already up, and the reply
 * must still carry its link. Returns the line to add to that reply.
 */
async function linkDocument(documentUri, rkey, doc, post, deps) {
  if (!deps.publisherConfigured()) {
    event(documentUri, 'link_manual');
    return "the atpota.to credential isn't set up here, so link the issue to the post by hand:\n" +
      `npm run publish:dispatch -- <issue file> --rkey ${rkey} --bsky-post ${postUrl(post.uri)}`;
  }
  let current = doc;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const value = current.value;
      if (value?.$type !== 'site.standard.document' || value.site !== config.dispatch.publicationUri) {
        event(documentUri, 'link_refused', 'document left the publication');
        return 'the document is no longer in the dispatch publication, so i left it alone.';
      }
      if (value.bskyPostRef?.uri === post.uri) {
        markLinked(documentUri, current.cid);
        return 'the issue links to it.';
      }
      if (value.bskyPostRef?.uri) {
        event(documentUri, 'link_refused', { other: value.bskyPostRef.uri });
        return `the issue already links a different post (${postUrl(value.bskyPostRef.uri)}), so i left it alone.`;
      }
      const record = { ...value, bskyPostRef: { uri: post.uri, cid: post.cid }, updatedAt: nowIso() };
      try {
        const res = await deps.putDocument(rkey, record, current.cid);
        markLinked(documentUri, res?.cid);
        event(documentUri, 'linked', { cid: res?.cid ?? null });
        return 'the issue links to it now.';
      } catch (err) {
        if (err.error !== 'InvalidSwap' || attempt > 0) throw err;
        // Edited since we read it: read it again and try once more on top of that edit.
        event(documentUri, 'link_swap_retry');
        current = await deps.getDocument(rkey);
        if (!current) return 'the issue disappeared before i could link it.';
      }
    }
    return 'the issue kept changing while i tried to link it. send the command again to retry the link.';
  } catch (err) {
    logger.error('dispatch link failed', { documentUri, error: err.message });
    event(documentUri, 'link_failed', err.message);
    return `linking the issue failed (${err.message}). send the command again to retry the link; it won't post again.`;
  }
}

/** Post under a key stored first, or find the post an earlier run made under it. */
async function postOnce(documentUri, text, page, pageUrl, alsoLinks, doc, deps) {
  const claimed = db.prepare(`UPDATE dispatch_document SET post_rkey = ?, updated_at = ?
    WHERE document_uri = ? AND post_rkey IS NULL`).run(nextTid(), nowIso(), documentUri).changes > 0;
  const row = getDocumentRow(documentUri);
  if (!claimed) {
    const earlier = await deps.getOwnPost(row.post_rkey);
    if (earlier) {
      recordPost(documentUri, earlier.uri, earlier.cid);
      event(documentUri, 'post_found', { uri: earlier.uri });
      return { uri: earlier.uri, cid: earlier.cid, thumbNote: null };
    }
  }
  db.prepare('UPDATE dispatch_document SET post_text = ?, page_url = ?, updated_at = ? WHERE document_uri = ?')
    .run(text, pageUrl, nowIso(), documentUri);
  const { thumb, note } = await cardThumb(page.html, pageUrl, deps);
  const record = buildAnnouncement({
    text, pageUrl, alsoLinks,
    title: String(doc.value.title ?? ''),
    description: String(doc.value.description ?? ''),
    thumb,
  });
  const res = await deps.createPost(record, row.post_rkey);
  recordPost(documentUri, res.uri, res.cid);   // before anything else
  event(documentUri, 'posted', { uri: res.uri, thumb: !!thumb });
  logger.info('dispatch announcement posted', { documentUri, uri: res.uri });
  return { uri: res.uri, cid: res.cid, thumbNote: note };
}

/**
 * Announce an issue that is already published. Returns the reply for the
 * operator. Throws only on a failure before anything was posted.
 */
export async function announce({ rkey, text = null }, deps = defaultDeps) {
  if (text != null) {
    const problem = operatorTextProblem(text);
    if (problem) return problem;
  }
  const documentUri = `at://${config.dispatch.publisherDid}/site.standard.document/${rkey}`;
  const doc = await deps.getDocument(rkey);
  if (!doc) return `i couldn't find ${documentUri}. is the link right?`;
  if (doc.value?.$type !== 'site.standard.document' || doc.value.site !== config.dispatch.publicationUri) {
    event(documentUri, 'refused', 'not in the dispatch publication');
    return "that document isn't in poe's atmosphere dispatch, so i won't announce it.";
  }

  db.prepare(`INSERT OR IGNORE INTO dispatch_document (document_uri, document_rkey, document_cid, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(documentUri, rkey, doc.cid, String(doc.value.title ?? ''), nowIso(), nowIso());
  const row = getDocumentRow(documentUri);

  // A repeated command must never post twice.
  const ref = doc.value.bskyPostRef;
  if (typeof ref?.uri === 'string') {
    if (!row.post_uri) recordPost(documentUri, ref.uri, ref.cid ?? null);
    if (!row.post_uri || row.post_uri === ref.uri) markLinked(documentUri, doc.cid);
    event(documentUri, 'already_announced', { uri: ref.uri });
    return `already announced: ${postUrl(ref.uri)}`;
  }
  if (row.post_uri) {
    // Posted on an earlier run that did not finish linking. Finish that.
    const note = await linkDocument(documentUri, rkey, doc, { uri: row.post_uri, cid: row.post_cid }, deps);
    return `already announced: ${postUrl(row.post_uri)}\n\n${note}`;
  }

  if (config.stage < 4) return `stage is ${config.stage}, so i won't post.`;
  if (killSwitchEngaged()) return 'the kill switch is on, so i didn\'t post.';
  if (isNapping()) return "i'm napping, so i didn't post. wake me and send the command again.";

  const [pageUrl, ...alsoLinks] = pageUrls(rkey);
  const page = await waitForPage(pageUrl, documentUri, deps);
  if (!page.ok) {
    event(documentUri, 'page_timeout', page.last);
    const minutes = Math.round(config.dispatch.pageTimeoutMs / 60000);
    return `${pageUrl} didn't show the issue within ${minutes} minutes (${page.last}), so i didn't post. ` +
      'send the command again to retry.';
  }
  event(documentUri, 'page_ok', pageUrl);

  const postText = text ?? defaultPostText(String(doc.value.title ?? ''), String(doc.value.description ?? ''));
  const post = await postOnce(documentUri, postText, page, pageUrl, alsoLinks, doc, deps);
  const note = await linkDocument(documentUri, rkey, doc, post, deps);
  return [
    `announced ⸜(｡˃ ᵕ ˂ )⸝ ${postUrl(post.uri)}`,
    note,
    ...(post.thumbNote ? [`the card has no image: ${post.thumbNote}.`] : []),
  ].join('\n\n');
}

// --- commands ---------------------------------------------------------------------

/** Store a parsed command against its DM so a restart can finish it. */
export function recordCommand(messageId, operatorDid, command) {
  db.prepare(`INSERT OR IGNORE INTO dispatch_command
    (message_id, operator_did, kind, document_rkey, post_text, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`).run(messageId, operatorDid,
    command.latest ? 'announce_latest' : command.kind, command.rkey ?? null, command.text ?? null, nowIso(), nowIso());
}

// One document at a time, so two commands for the same issue cannot interleave.
const chains = new Map();
function serial(key, fn) {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, next);
  const clear = () => { if (chains.get(key) === next) chains.delete(key); };
  next.then(clear, clear);
  return next;
}

/** Run a stored command to the end. Returns the operator's reply. */
export async function runCommand(messageId, deps = defaultDeps) {
  const cmd = db.prepare('SELECT * FROM dispatch_command WHERE message_id = ?').get(messageId);
  if (!cmd) return null;
  if (cmd.status === 'done') return cmd.reply;
  let reply;
  if (cmd.kind !== 'announce' && cmd.kind !== 'announce_latest') reply = ANNOUNCE_USAGE;
  else {
    let rkey = cmd.document_rkey;
    let documentUri = null;
    try {
      if (!rkey) {
        // Resolved once and stored, so a restart announces the same issue.
        const latest = await latestDocument(deps);
        if (!latest) {
          reply = "i couldn't find any published issues in poe's atmosphere dispatch.";
        } else {
          rkey = latest.rkey;
          db.prepare('UPDATE dispatch_command SET document_rkey = ?, updated_at = ? WHERE message_id = ?')
            .run(rkey, nowIso(), messageId);
        }
      }
      if (rkey) {
        documentUri = `at://${config.dispatch.publisherDid}/site.standard.document/${rkey}`;
        reply = await serial(documentUri, () => announce({ rkey, text: cmd.post_text }, deps));
        if (cmd.kind === 'announce_latest') {
          const title = getDocumentRow(documentUri)?.title;
          if (title) reply = `the latest issue is "${title}".\n\n${reply}`;
        }
      }
    } catch (err) {
      logger.error('announce failed', { messageId, documentUri, error: err.message });
      event(documentUri, 'announce_failed', err.message);
      reply = `announce failed: ${err.message}\n\nsend the command again to retry. it won't post twice.`;
    }
  }
  db.prepare(`UPDATE dispatch_command SET status = 'done', reply = ?, updated_at = ? WHERE message_id = ?`)
    .run(reply, nowIso(), messageId);
  return reply;
}

// --- proposals --------------------------------------------------------------------
// Natural language, without giving the model a way to post. In an operator DM,
// Poe may call POST /dispatch/announce-proposal with the issue and the post it
// would write. This checks both and stores the proposal against the DM Poe is
// answering. When Poe's reply comes back through /dm-draft, the exact post is
// added under it with a yes/no question. Only the operator's plain "yes",
// sent straight back to that message, runs announce() with that exact text.
//
// The proposal call itself writes nothing outside this database. A prompt
// injection that takes over the agent can, at worst, put a proposal in front
// of the operator, for an issue already in the dispatch publication, with text
// that passed the checks below.

const PROPOSAL_TTL_MS = 6 * 3600 * 1000;
const PROPOSAL_CALLS_PER_DM = 10;
const EXCERPT_GRAPHEMES = 1200;
const proposalCalls = new Map();

const YES = new Set(['yes', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay', 'sure', 'do it', 'post it',
  'go', 'go ahead', 'ship it', 'send it', 'lgtm', 'yes post it', 'yes please', 'ok post it', '👍']);
const NO = new Set(['no', 'n', 'nope', 'nah', 'cancel', "don't", 'dont', "don't post it",
  'dont post it', 'never mind', 'nevermind', 'not yet', 'no thanks']);

/** 'yes', 'no', or null: a whole message that is only an answer, nothing more. */
export function parseConfirmation(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase().replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '')
    .replace(/[.!\s]+$/u, '').replace(/^please\s+/, '').replace(/,?\s+please$/, '').trim();
  if (YES.has(t)) return 'yes';
  if (NO.has(t)) return 'no';
  return null;
}

/** Why Poe's announcement text cannot go out as is, or null. */
export function proposalTextProblem(text, rkey) {
  if (!text.trim()) return 'the post text is empty';
  const n = graphemeLength(text);
  if (n > POST_MAX_GRAPHEMES) return `the post is ${n} graphemes and a post holds ${POST_MAX_GRAPHEMES}`;
  if (byteLength(text) > POST_MAX_BYTES) return `the post is over ${POST_MAX_BYTES} bytes`;
  if (detectHandles(text).length) return 'the post @-mentions someone; name people without the @, nobody is pinged by an announcement';
  const allowed = new Set(pageUrls(rkey));
  const stray = detectLinks(text).map((l) => l.uri.replace(/\/+$/, '')).filter((u) => !allowed.has(u));
  if (stray.length) return `the post links ${stray[0]}; the only link allowed is the issue's own page, and the card already links it`;
  if (/\*\*|__|\[[^\]]+\]\([^)]+\)|^#{1,6}\s/m.test(text)) return 'the post uses markdown, which Bluesky shows literally';
  return null;
}

function excerptOf(textContent) {
  const text = String(textContent ?? '').trim();
  return text ? fitPostText(text, EXCERPT_GRAPHEMES, 12000) : '';
}

/**
 * Look up an issue for Poe and, given text, propose announcing it. Answers
 * { status, body }; a check that failed is a 200 with accepted: false and the
 * reason, so the model can fix the text and call again in the same turn.
 */
export async function handleAnnounceProposal(body, deps = defaultDeps) {
  if (!config.dispatch.enabled) return { status: 503, body: { error: 'DispatchDisabled' } };
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.dmId !== 'string' || !body.dmId || body.dmId.length > 300 ||
      typeof body.operatorDid !== 'string' || !/^did:(plc|web):[^\s]{1,290}$/.test(body.operatorDid) ||
      typeof body.issue !== 'string' || !body.issue.trim() || body.issue.length > 600 ||
      (body.text != null && (typeof body.text !== 'string' || body.text.length > 6000))) {
    return { status: 400, body: { error: 'BadRequest' } };
  }
  // Only while Poe is answering that operator's DM: the agent has been handed
  // it and has not replied yet.
  const dm = db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(body.dmId);
  if (!dm || dm.operator_did !== body.operatorDid || !isAdmin(dm.operator_did) || dm.status !== 'dispatched') {
    return { status: 409, body: { error: 'NotAnsweringThatDm' } };
  }
  const calls = (proposalCalls.get(body.dmId) ?? 0) + 1;
  proposalCalls.set(body.dmId, calls);
  if (proposalCalls.size > 500) proposalCalls.delete(proposalCalls.keys().next().value);
  if (calls > PROPOSAL_CALLS_PER_DM) return { status: 429, body: { error: 'TooManyProposals' } };

  const target = body.issue.trim();
  let rkey;
  if (/^(?:the\s+)?(?:latest|newest|this week'?s?)(?:\s+(?:dispatch|issue))?$/i.test(target)) {
    const latest = await latestDocument(deps);
    if (!latest) return { status: 200, body: { accepted: false, reason: 'the dispatch has no published issues' } };
    rkey = latest.rkey;
  } else {
    rkey = parseIssueLink(target) ?? (RKEY.test(target) && target !== '.' && target !== '..' ? target : null);
    if (!rkey) {
      return { status: 200, body: { accepted: false, reason: 'that is not a dispatch issue; use "latest", or the issue\'s poe.leaflet.pub or atpota.to/blog link' } };
    }
  }
  const doc = await deps.getDocument(rkey);
  if (!doc || doc.value?.$type !== 'site.standard.document' || doc.value.site !== config.dispatch.publicationUri) {
    return { status: 200, body: { accepted: false, reason: 'there is no such issue in poe\'s atmosphere dispatch' } };
  }
  const issue = {
    title: String(doc.value.title ?? ''),
    description: String(doc.value.description ?? ''),
    url: pageUrls(rkey)[0],
    publishedAt: doc.value.publishedAt ?? null,
    excerpt: excerptOf(doc.value.textContent),
  };
  const documentUri = `at://${config.dispatch.publisherDid}/site.standard.document/${rkey}`;
  const announced = doc.value.bskyPostRef?.uri ?? getDocumentRow(documentUri)?.post_uri;
  if (announced) {
    return { status: 200, body: { accepted: false, reason: 'that issue is already announced', post: postUrl(announced), issue } };
  }
  if (body.text == null || !body.text.trim()) {
    return { status: 200, body: { accepted: false, reason: 'nothing proposed yet: write the post and call again with text', issue } };
  }
  const text = body.text.trim();
  const problem = proposalTextProblem(text, rkey);
  if (problem) return { status: 200, body: { accepted: false, reason: problem, issue } };

  db.exec('BEGIN IMMEDIATE');
  try {
    // One live proposal at a time: this one replaces every earlier one.
    db.prepare(`UPDATE dispatch_proposal SET status = 'superseded', decided_at = ?
      WHERE status IN ('proposed', 'attached')`).run(nowIso());
    db.prepare(`INSERT INTO dispatch_proposal (dm_message_id, operator_did, document_rkey, title, page_url, text, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`).run(body.dmId, body.operatorDid, rkey, issue.title, issue.url, text, nowIso());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  event(documentUri, 'proposed', { dmId: body.dmId });
  return { status: 200, body: {
    accepted: true, issue, text,
    note: 'proposed, not posted. the operator sees this exact post under your reply and it goes out only if they answer yes.',
  } };
}

/** The block added under Poe's reply. */
export function confirmationBlock(proposal) {
  return [
    `here's the post, with a card for "${proposal.title}" (${proposal.page_url}):`,
    '',
    proposal.text,
    '',
    'reply "yes" to post it from poe, or "no" to drop it.',
  ].join('\n');
}

/**
 * Called when Poe's reply to a DM arrives. If Poe proposed an announcement in
 * that turn, returns the reply with the proposal under it, else null. The
 * reply is cut to make room; the proposal never is.
 */
export function attachProposal(dmId, reply, maxGraphemes = 999) {
  const proposal = db.prepare(`SELECT * FROM dispatch_proposal WHERE dm_message_id = ? AND status = 'proposed'
    ORDER BY id DESC LIMIT 1`).get(dmId);
  if (!proposal) return null;
  db.prepare(`UPDATE dispatch_proposal SET status = 'attached' WHERE id = ? AND status = 'proposed'`).run(proposal.id);
  const block = confirmationBlock(proposal);
  const room = maxGraphemes - graphemeLength(block) - 2;
  const head = reply.trim() && room > 20 ? fitPostText(reply.trim(), room, 9000) : '';
  return head ? `${head}\n\n${block}` : block;
}

/**
 * The proposal an operator's message can answer, or null. It must be the
 * newest proposal, shown in Poe's reply to the operator's previous message,
 * sent, and recent. Anything said in between means "yes" is about something
 * else, and it goes to Poe like any other message.
 */
export function liveProposalFor(row) {
  const proposal = db.prepare(`SELECT * FROM dispatch_proposal WHERE status = 'attached' ORDER BY id DESC LIMIT 1`).get();
  if (!proposal || proposal.operator_did !== row.operator_did) return null;
  const shownIn = db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(proposal.dm_message_id);
  if (!shownIn || shownIn.status !== 'sent' || shownIn.convo_id !== row.convo_id) return null;
  const at = Date.parse(row.received_at);
  const sent = Date.parse(shownIn.updated_at);
  if (!(at >= sent - 5000) || at - sent > PROPOSAL_TTL_MS) return null;
  const between = db.prepare(`SELECT COUNT(*) AS n FROM operator_dm WHERE convo_id = ?
    AND received_at > ? AND received_at < ? AND message_id NOT IN (?, ?)`)
    .get(row.convo_id, shownIn.received_at, row.received_at, shownIn.message_id, row.message_id).n;
  return between ? null : proposal;
}

/** Settle a proposal with the operator's answer. False if it was no longer live. */
export function decideProposal(id, decision, messageId) {
  const status = decision === 'yes' ? 'confirmed' : 'declined';
  const changed = db.prepare(`UPDATE dispatch_proposal SET status = ?, decision_message_id = ?, decided_at = ?
    WHERE id = ? AND status = 'attached'`).run(status, messageId, nowIso(), id).changes > 0;
  if (changed) {
    const p = db.prepare('SELECT document_rkey FROM dispatch_proposal WHERE id = ?').get(id);
    event(`at://${config.dispatch.publisherDid}/site.standard.document/${p.document_rkey}`, `proposal_${status}`, { messageId });
  }
  return changed;
}
