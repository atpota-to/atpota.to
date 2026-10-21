// callback.js
// Receives drafts from the agent.
//
// Two properties this endpoint has to hold:
//
//   Return 2xx only once the draft is durable. The agent drops the draft if we
//   do not answer 2xx -- it logs and moves on rather than failing the turn --
//   so answering before the write would turn a crash into a lost answer with no
//   record of it. The draft is committed first, the response second, and the
//   posting happens after the response.
//
//   Collapse duplicates by `key`. eve's channel event handlers are
//   at-least-once, so the same draft can arrive twice. `key` is claimed under a
//   UNIQUE constraint before anything is posted, so the second delivery is a
//   no-op that still answers 200.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config, killSwitchEngaged } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import { postReply } from './poster.js';
import { storeMemory, publishMemory } from './memory.js';
import { receiveDraft, deliverDm } from './operator-dm.js';
import { napStatus } from './nap.js';
import { requestScanApproval } from './scan-approval.js';
import { searchPostsV2 } from './atproto.js';
import { handleAnnounceProposal } from './dispatch.js';
import { receiveLikeProposal } from './likes.js';
import { receiveWeatherDraft, handleWeatherDraft } from './weather-posts.js';
import { handlePostProposal } from './operator-posts.js';

const MAX_BODY_BYTES = 64 * 1024;

function secretMatches(given) {
  if (typeof given !== 'string' || !config.sharedSecret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.sharedSecret);
  if (a.length !== b.length) return false;     // length is not secret here
  return timingSafeEqual(a, b);
}

function send(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Validate the callback payload. Returns { ok, value } or { ok:false, detail }. */
export function validateCallback(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, detail: 'body must be a JSON object' };
  const { key, threadRoot, postUri, attempt, text, links } = body;
  if (typeof key !== 'string' || !key.trim()) return { ok: false, detail: 'key must be a non-empty string' };
  if (typeof threadRoot !== 'string' || !threadRoot.startsWith('at://')) {
    return { ok: false, detail: 'threadRoot must be an at:// URI' };
  }
  if (typeof postUri !== 'string' || !/^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._:~-]+$/.test(postUri)) {
    return { ok: false, detail: 'postUri must identify the incoming post' };
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    return { ok: false, detail: 'attempt must be a positive integer' };
  }
  if (typeof text !== 'string') return { ok: false, detail: 'text must be a string' };
  // `links` is an optional extension: when the agent sends the URLs its tools
  // returned this turn, the outbound link gate can enforce the brief's exact
  // rule instead of falling back to a host allowlist.
  let allowedLinks = null;
  if (links != null) {
    if (!Array.isArray(links) || links.some((l) => typeof l !== 'string')) {
      return { ok: false, detail: 'links, if present, must be an array of strings' };
    }
    allowedLinks = new Set(links.map((l) => l.trim()).filter(Boolean));
  }
  return { ok: true, value: { key: key.trim(), threadRoot, postUri, attempt, text, allowedLinks } };
}

function validateBudgetSession(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  if (typeof body.sessionId !== 'string' || !body.sessionId.trim() || body.sessionId.length > 500) {
    return 'sessionId must be a non-empty string of at most 500 characters';
  }
  return null;
}

/** Validate a memory hand-off from the agent. */
export function validateScanBudgetClaim(body) {
  const detail = validateBudgetSession(body);
  if (detail) return detail;
  if (typeof body.postUri !== 'string' ||
      !/^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._:~-]+$/.test(body.postUri)) {
    return 'postUri must identify a post';
  }
  if (!Number.isSafeInteger(body.attempt) || body.attempt < 1) return 'attempt must be a positive integer';
  return null;
}

export function validateListRecordsBudgetClaim(body) {
  const detail = validateBudgetSession(body);
  if (detail) return detail;
  if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100) {
    return 'limit must be an integer from 1 to 100';
  }
  // Supplying either field selects the post-bound path; incomplete or invalid
  // post references must never fall back to the unbound session budget.
  if (Object.hasOwn(body, 'postUri') || Object.hasOwn(body, 'attempt')) {
    return validateScanBudgetClaim(body);
  }
  return null;
}

const SEARCH_ARRAY_FIELDS = new Set(['authors', 'mentions', 'domains', 'urls', 'embeddedAtUris',
  'hashtags', 'excludeAuthors', 'excludeMentions', 'excludeDomains', 'excludeUrls',
  'excludeEmbeddedAtUris', 'excludeHashtags', 'languages', 'excludeLanguages']);
const SEARCH_BOOL_FIELDS = new Set(['allTime', 'hasMedia', 'hasVideo', 'excludeReplies',
  'repliesOnly', 'following']);
const SEARCH_STRING_FIELDS = new Set(['query', 'sort', 'since', 'until', 'replyParentUri',
  'threadRootUri', 'queryLanguage', 'cursor']);
const SEARCH_FIELDS = new Set([...SEARCH_ARRAY_FIELDS, ...SEARCH_BOOL_FIELDS,
  ...SEARCH_STRING_FIELDS, 'limit']);
const POST_URI = /^at:\/\/did:[a-z0-9]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._:~-]+$/;
const AT_URI = /^at:\/\/(?:did:[a-z0-9]+:[a-zA-Z0-9._:%-]+|[a-zA-Z0-9.-]+)\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9._:~-]+$/;
const ISO_DATE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-](\d\d):(\d\d))$/;
function validIsoDate(value) {
  if (/^\d{4}-\d\d-\d\d$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  const parts = ISO_DATE.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, tzHour, tzMinute] = parts;
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  return date.getUTCFullYear() === +year && date.getUTCMonth() === +month - 1 &&
    date.getUTCDate() === +day && +hour < 24 && +minute < 60 && +second < 60 &&
    (!tzHour || (+tzHour <= 23 && +tzMinute < 60)) && Number.isFinite(Date.parse(value));
}

/** Return a detail string on failure, otherwise the allowlisted XRPC parameters. */
export function validateBlueskySearch(body) {
  const detail = validateBudgetSession(body);
  if (detail) return { detail };
  for (const key of Object.keys(body)) {
    if (key !== 'sessionId' && key !== 'postUri' && key !== 'attempt' && !SEARCH_FIELDS.has(key)) {
      return { detail: `unknown field: ${key}` };
    }
  }
  if (Object.hasOwn(body, 'postUri') || Object.hasOwn(body, 'attempt')) {
    if (typeof body.postUri !== 'string' || !POST_URI.test(body.postUri) || body.postUri.length > 2048 ||
        !Number.isSafeInteger(body.attempt) || body.attempt < 1) {
      return { detail: 'postUri and positive attempt are required together' };
    }
  }
  const params = {};
  for (const key of SEARCH_FIELDS) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (SEARCH_ARRAY_FIELDS.has(key)) {
      if (!Array.isArray(value) || value.length > 5 || !value.length ||
          value.some((item) => typeof item !== 'string' || !item.trim() || item !== item.trim() ||
            item.length > (key.toLowerCase().includes('url') || key.includes('AtUris') ? 2048 :
                          (key === 'hashtags' || key === 'excludeHashtags' ? 640 : 253)))) {
        return { detail: `${key} must contain 1 to 5 non-empty strings` };
      }
      if (key.includes('AtUris') && value.some((item) => !AT_URI.test(item))) return { detail: `${key} must contain at:// URIs` };
      if ((key === 'authors' || key === 'mentions' || key === 'excludeAuthors' || key === 'excludeMentions') &&
          value.some((item) => !/^(?:did:[a-z0-9]+:[a-zA-Z0-9._:%-]+|[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+)$/.test(item))) {
        return { detail: `${key} must contain handles or DIDs` };
      }
      if ((key === 'domains' || key === 'excludeDomains') &&
          value.some((item) => !/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+$/.test(item))) {
        return { detail: `${key} must contain domains` };
      }
      if ((key === 'hashtags' || key === 'excludeHashtags') &&
          value.some((item) => item.startsWith('#') ||
                      [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(item)].length > 64)) {
        return { detail: `${key} must contain hashtags without #` };
      }
      if ((key === 'languages' || key === 'excludeLanguages') &&
          value.some((item) => !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(item))) {
        return { detail: `${key} must contain language tags` };
      }
      if (key.toLowerCase().includes('url') && !key.includes('AtUris') &&
          value.some((item) => { try { const u = new URL(item); return !['http:', 'https:'].includes(u.protocol) || !!u.username || !!u.password; } catch { return true; } })) {
        return { detail: `${key} must contain HTTP URLs` };
      }
    } else if (SEARCH_BOOL_FIELDS.has(key)) {
      if (typeof value !== 'boolean') return { detail: `${key} must be a boolean` };
    } else if (key === 'limit') {
      if (!Number.isInteger(value) || value < 1 || value > 25) return { detail: 'limit must be an integer from 1 to 25' };
    } else if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
        value.length > (key === 'cursor' || key.endsWith('Uri') ? 2048 : 500)) {
      return { detail: `${key} must be a non-empty bounded string` };
    } else if ((key === 'since' || key === 'until') &&
        !validIsoDate(value)) {
      return { detail: `${key} must be an ISO date or timestamp` };
    } else if ((key === 'replyParentUri' || key === 'threadRootUri') && !POST_URI.test(value)) {
      return { detail: `${key} must identify a post` };
    }
    params[key] = value;
  }
  if (params.sort && !['recent', 'top'].includes(params.sort)) return { detail: 'sort must be recent or top' };
  if (params.queryLanguage && !['ja', 'zh', 'ko', 'th', 'ar'].includes(params.queryLanguage)) {
    return { detail: 'invalid queryLanguage' };
  }
  if (params.excludeReplies && params.repliesOnly) return { detail: 'excludeReplies and repliesOnly conflict' };
  if (params.since && params.until && Date.parse(params.since) > Date.parse(params.until)) {
    return { detail: 'since must not be after until' };
  }
  if (!params.query && !['authors', 'mentions', 'domains', 'urls', 'embeddedAtUris', 'hashtags',
    'replyParentUri', 'threadRootUri', 'hasMedia', 'hasVideo', 'following', 'repliesOnly']
    .some((key) => Array.isArray(params[key]) ? params[key].length : params[key] === true || typeof params[key] === 'string')) {
    return { detail: 'query or a substantive filter is required' };
  }
  return { params };
}

export function validateMemory(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, detail: 'body must be a JSON object' };
  const { did, content } = body;
  if (typeof did !== 'string' || !/^did:[a-z]+:\S+$/.test(did) || did.length > 300) {
    return { ok: false, detail: 'did must be a DID' };
  }
  if (typeof content !== 'string') return { ok: false, detail: 'content must be a string' };
  return { ok: true, value: { did, content } };
}

/**
 * POST /memory: the agent saved a new version of someone's notes. Kept first,
 * answered second, published after, the same order as a draft: the agent's
 * save has already succeeded against its own copy and must not wait on the
 * repo. The DID is the one eve locked the memory slot to for that turn, which
 * the droplet had asserted from the signed record; the model cannot pick it.
 */
async function handleMemory(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, err.tooLarge ? 413 : 400, { error: 'BadRequest' });
  }
  const v = validateMemory(parsed);
  if (!v.ok) return send(res, 400, { error: 'BadRequest', detail: v.detail });

  const kept = storeMemory(v.value.did, v.value.content);
  if (!kept.ok) return send(res, 400, { error: 'BadRequest', detail: kept.detail });
  send(res, 202, { ok: true });

  if (kept.needsPublish) {
    const api = await import('./atproto.js');
    publishMemory(v.value.did, { api, didResolves: async (did) => !!(await api.resolveHandleForDid(did)) })
      .catch((err) => logger.error('memory publish threw', { did: v.value.did, err }));
  }
}

export function startCallbackServer({ stats }) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      // Reports the live kill-switch state, not a startup snapshot: this is
      // what somebody checks during an incident to confirm the potato has
      // actually gone quiet.
      const kill = killSwitchEngaged();
      const nap = napStatus();
      return send(res, 200, {
        ok: true,
        stage: config.stage,
        posting: config.stage >= 4 && !kill && !nap.active,
        killSwitch: kill ?? false,
        nap: nap.active ? { active: true, until: nap.until } : { active: false },
        uptimeSec: Math.round(process.uptime()),
      });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'MethodNotAllowed' });

    if (!secretMatches(req.headers['x-atpotato-secret'])) {
      stats.callbackUnauthorized++;
      logger.warn('callback rejected: bad or missing secret', { ip: req.socket.remoteAddress, url: req.url });
      return send(res, 401, { error: 'Unauthorized' });
    }

    if (req.url === '/memory') return handleMemory(req, res);
    if (req.url === '/internal/bluesky-search') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (err) { return send(res, err.tooLarge ? 413 : 400, { error: 'BadRequest' }); }
      const { detail, params } = validateBlueskySearch(body);
      if (detail) return send(res, 400, { error: 'BadRequest', detail });
      try {
        const claimed = Object.hasOwn(body, 'postUri')
          ? db.claimBlueskySearchBudget(body.sessionId, body.postUri, body.attempt)
          : db.claimBlueskySearchSessionBudget(body.sessionId);
        if (!claimed) return send(res, 409, { error: 'BlueskySearchBudgetUnavailable' });
      } catch (err) {
        logger.error('search budget claim failed', { error: err.message });
        return send(res, 500, { error: 'InternalError' });
      }
      try {
        const result = await searchPostsV2(params);
        if (result.status === 429) return send(res, 429, { error: 'UpstreamRateLimited', retryAfter: result.retryAfter });
        if (result.status !== 200) return send(res, 502, { error: 'UpstreamUnavailable' });
        return send(res, 200, result.body);
      } catch (err) {
        logger.warn('Bluesky search failed', { error: err.name === 'TimeoutError' ? 'timeout' : 'upstream error' });
        return send(res, err.name === 'TimeoutError' ? 504 : 502, { error: 'UpstreamUnavailable' });
      }
    }
    if (req.url === '/internal/scan-budget/claim') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (err) { return send(res, err.tooLarge ? 413 : 400, { error: 'BadRequest' }); }
      const detail = validateScanBudgetClaim(body);
      if (detail) return send(res, 400, { error: 'BadRequest', detail });
      try {
        const claimed = db.claimScanBudget(body.sessionId, body.postUri, body.attempt);
        return send(res, claimed ? 200 : 409, claimed ? { ok: true } : { error: 'ScanBudgetUnavailable' });
      } catch (err) {
        logger.error('scan budget claim failed', { error: err.message });
        return send(res, 500, { error: 'InternalError' });
      }
    }
    if (req.url === '/internal/list-records-budget/claim') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (err) { return send(res, err.tooLarge ? 413 : 400, { error: 'BadRequest' }); }
      const detail = validateListRecordsBudgetClaim(body);
      if (detail) return send(res, 400, { error: 'BadRequest', detail });
      try {
        const remaining = Object.hasOwn(body, 'postUri')
          ? db.claimListRecordsBudget(body.sessionId, body.postUri, body.attempt, body.limit)
          : db.claimListRecordsSessionBudget(body.sessionId, body.limit);
        return send(res, remaining ? 200 : 409,
          remaining ? { ok: true, ...remaining } : { error: 'ListRecordsBudgetUnavailable' });
      } catch (err) {
        logger.error('list records budget claim failed', { error: err.message });
        return send(res, 500, { error: 'InternalError' });
      }
    }
    if (req.url === '/internal/scan-approval/request') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (err) { return send(res, err.tooLarge ? 413 : 400, { error: 'BadRequest' }); }
      try {
        const result = await requestScanApproval(body);
        return send(res, result.status, result.body);
      } catch (err) {
        logger.error('scan approval request failed', { error: err.message });
        return send(res, 500, { error: 'InternalError' });
      }
    }
    if (req.url === '/like-proposal') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return send(res, 400, { error: 'BadRequest' }); }
      try {
        const result = receiveLikeProposal(body);
        return send(res, result.status, result.body);
      } catch (err) {
        logger.error('like proposal failed', { error: err.message });
        return send(res, 500, { error: 'InternalError' });
      }
    }
    if (req.url === '/dispatch/announce-proposal') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return send(res, 400, { error: 'BadRequest' }); }
      try {
        const result = await handleAnnounceProposal(body);
        return send(res, result.status, result.body);
      } catch (err) {
        logger.error('announce proposal failed', { error: err.message });
        return send(res, 502, { error: 'UpstreamError' });
      }
    }
    if (req.url === '/dm-draft') {
      let draft;
      try { draft = JSON.parse(await readBody(req)); }
      catch { return send(res, 400, { error: 'BadRequest' }); }
      let result;
      try { result = receiveDraft(draft); }
      catch (err) {
        logger.error('DM draft persistence failed', { error: err.message });
        return send(res, 500, { error: 'InternalError' });
      }
      if (result === 'invalid') return send(res, 400, { error: 'BadRequest' });
      send(res, 200, { ok: true, accepted: result === 'accepted' });
      if (result === 'accepted') {
        const row = db.db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(draft.dmId);
        deliverDm(row).catch((err) =>
          logger.error('DM delivery failed', { messageId: draft.dmId, error: err.message }));
      }
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(res, err.tooLarge ? 413 : 400, { error: 'BadRequest', detail: err.message });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'BadRequest', detail: 'body is not valid JSON' });
    }

    // A weather post (weather-posts.js) comes back on this same URL, so it needs
    // nothing new in front of the service; its momentId tells it from a reply.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'momentId')) {
      let result;
      try { result = receiveWeatherDraft(parsed); }
      catch (err) {
        logger.error('weather draft persistence failed', { error: err.message });
        return send(res, 500, { error: 'InternalError' });
      }
      // Durable first, then the answer, then the gates and the post.
      send(res, result.status, result.body);
      if (result.id) {
        handleWeatherDraft(result.id).catch((err) =>
          logger.error('weather draft handling failed', { id: result.id, error: err.message }));
      }
      return;
    }

    // A post Poe proposes in an operator DM (operator-posts.js) also comes on this
    // URL, told apart by its proposal; it is only stored and shown, never posted here.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'proposal')) {
      let result;
      try { result = handlePostProposal(parsed); }
      catch (err) {
        logger.error('post proposal failed', { error: err.message });
        return send(res, 500, { error: 'InternalError' });
      }
      return send(res, result.status, result.body);
    }

    const v = validateCallback(parsed);
    if (!v.ok) {
      stats.callbackInvalid++;
      logger.warn('callback rejected: invalid payload', { detail: v.detail });
      return send(res, 400, { error: 'BadRequest', detail: v.detail });
    }

    const { key, threadRoot, postUri, attempt, text, allowedLinks } = v.value;

    // Already handled? Answer 200 so the agent stops retrying, and do nothing.
    const existing = db.findByDraftKey(key);
    if (existing) {
      stats.callbackDuplicates++;
      logger.info('callback duplicate ignored', { key, queueId: existing.id, status: existing.status });
      return send(res, 200, { ok: true, duplicate: true });
    }

    const row = db.findPendingByPostUri(postUri, threadRoot, attempt);
    if (!row) {
      // Nothing to hang a reply off: no parent ref, no root ref, no post. Log it
      // loudly and accept, because a retry would not find one either.
      stats.callbackOrphans++;
      logger.error('callback for a non-pending post or attempt; dropping draft', {
        key, threadRoot, postUri, attempt,
      });
      return send(res, 200, { ok: true, dropped: 'no matching queued turn' });
    }

    if (!db.claimDraftKey(row.id, key)) {
      stats.callbackDuplicates++;
      logger.info('callback lost the key race; ignoring', { key, queueId: row.id });
      return send(res, 200, { ok: true, duplicate: true });
    }

    db.setStatus(row.id, 'drafted', {
      draft_text: text,
      draft_links: allowedLinks ? JSON.stringify([...allowedLinks]) : null,
      drafted_at: db.nowIso(),
    });
    stats.drafts++;
    logger.info('draft received', {
      queueId: row.id, key, threadRoot, postUri, attempt, chars: text.length,
      author: row.author_handle ?? row.author_did, draft: text,
      // The turn's tool-result URLs, logged because they are what the link gate
      // judges against -- a rejection is unreadable without them.
      links: allowedLinks ? [...allowedLinks] : null,
    });

    // Durable. Answer now; post after.
    send(res, 200, { ok: true });

    const fresh = db.getQueueRow(row.id);
    postReply(fresh, text, { allowedLinks }).catch((err) => {
      logger.error('postReply threw', { queueId: row.id, err });
    });
  });

  server.listen(config.callbackPort, config.callbackHost, () => {
    logger.info('callback server listening', {
      host: config.callbackHost, port: config.callbackPort,
      publicUrl: config.callbackUrl || '(DROPLET_CALLBACK_URL unset)',
    });
  });

  return server;
}
