import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config, isAdmin, killSwitchEngaged } from './config.js';
import { db, nowIso } from './db.js';
import { isNapping } from './nap.js';
import { logger } from './logger.js';
import * as atproto from './atproto.js';

export const APPROVAL_ADMIN_DID = 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj'; // @dame.is
const TTL_MS = 30 * 60_000;
const BOT_TTL_MS = 24 * 60 * 60_000;
const POST_URI = /^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._:~-]+$/;
const activePosts = new Map();
const activeForwards = new Set();

const getRequest = db.prepare('SELECT * FROM scan_approvals WHERE session_id = ? AND request_id = ?');
const getEscalation = db.prepare('SELECT * FROM scan_approvals WHERE escalation_uri = ?');
const getId = db.prepare('SELECT * FROM scan_approvals WHERE id = ?');

export function validateApprovalRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  for (const field of ['sessionId', 'requestId', 'turnId']) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 500) {
      return `${field} must be a non-empty string of at most 500 characters`;
    }
  }
  if (typeof body.postUri !== 'string' || !POST_URI.test(body.postUri)) return 'postUri must be a post URI';
  if (!Number.isSafeInteger(body.attempt) || body.attempt < 1) return 'attempt must be a positive integer';
  if (!Number.isSafeInteger(body.expiresAt)) return 'expiresAt must be an epoch-millisecond integer';
  if (typeof body.approvalToken !== 'string' || !/^[a-fA-F0-9]{64}$/.test(body.approvalToken)) {
    return 'approvalToken must be 64 hex characters';
  }
  if (!config.sharedSecret) return 'shared secret is not configured';
  const expected = createHmac('sha256', config.sharedSecret)
    .update(JSON.stringify(['scan-approval-v1', body.sessionId, body.requestId, body.turnId,
      body.postUri, body.attempt, body.expiresAt])).digest();
  if (!timingSafeEqual(Buffer.from(body.approvalToken, 'hex'), expected)) return 'invalid approvalToken';
  return null;
}

function paused() {
  return config.stage < 4 || config.dryRun || killSwitchEngaged() || isNapping();
}

export function approvalPost(row) {
  const mention = '@dame.is';
  const text = `🥔 ${mention} Poe wants permission to scan for this request. Reply directly to this post with approve or deny. This approval expires in 30 minutes.`;
  const byteStart = Buffer.byteLength(text.slice(0, text.indexOf(mention)));
  return {
    $type: 'app.bsky.feed.post', text, createdAt: row.created_at,
    facets: [{ index: { byteStart, byteEnd: byteStart + Buffer.byteLength(mention) },
      features: [{ $type: 'app.bsky.richtext.facet#mention', did: APPROVAL_ADMIN_DID }] }],
    reply: {
      root: { uri: row.root_uri, cid: row.root_cid },
      parent: { uri: row.uri, cid: row.cid },
    },
  };
}

export async function requestScanApproval(body, { api = atproto } = {}) {
  const error = validateApprovalRequest(body);
  if (error) return { status: 400, body: { error: 'BadRequest', detail: error } };
  if (!isAdmin(APPROVAL_ADMIN_DID)) return { status: 503, body: { error: 'ApprovalAdminNotConfigured' } };
  const { sessionId, requestId, turnId, postUri, attempt, expiresAt, approvalToken } = body;
  let row = getRequest.get(sessionId, requestId);
  if (row && (row.turn_id !== turnId || row.post_uri !== postUri || row.attempt !== attempt ||
      row.bot_expires_at !== expiresAt || row.approval_token !== approvalToken)) {
    return { status: 409, body: { error: 'ApprovalRequestConflict' } };
  }
  if (!row) {
    if (expiresAt <= Date.now() || expiresAt > Date.now() + BOT_TTL_MS) {
      return { status: 400, body: { error: 'BadRequest', detail: 'expiresAt must be within the next 24 hours' } };
    }
    if (paused()) return { status: 503, body: { error: 'PostingPaused' } };
    const queue = db.prepare(`SELECT * FROM queue WHERE uri = ? AND attempts = ? AND status = 'sent_to_agent'`)
      .get(postUri, attempt);
    if (!queue) return { status: 409, body: { error: 'NoMatchingTurn' } };
    const created = nowIso();
    const rkey = `scan-${createHash('sha256').update(JSON.stringify([sessionId, requestId])).digest('hex').slice(0, 40)}`;
    const uri = `at://${config.botDid}/app.bsky.feed.post/${rkey}`;
    db.prepare(`INSERT OR IGNORE INTO scan_approvals
      (session_id, request_id, turn_id, post_uri, attempt, queue_id, escalation_uri,
       post_text, created_at, expires_at, bot_expires_at, approval_token, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posting', ?)`).run(
      sessionId, requestId, turnId, postUri, attempt, queue.id, uri,
      approvalPost({ ...queue, created_at: created }).text,
      created, new Date(Math.min(Date.parse(created) + TTL_MS, expiresAt)).toISOString(),
      expiresAt, approvalToken, created);
    row = getRequest.get(sessionId, requestId);
    if (row.turn_id !== turnId || row.post_uri !== postUri || row.attempt !== attempt ||
        row.bot_expires_at !== expiresAt || row.approval_token !== approvalToken) {
      return { status: 409, body: { error: 'ApprovalRequestConflict' } };
    }
  }
  if (row.status === 'expired' || Date.parse(row.expires_at) <= Date.now()) {
    return { status: 410, body: { error: 'ApprovalExpired' } };
  }
  if (row.status === 'rejected') return { status: 409, body: { error: 'ApprovalRejected' } };
  if (row.status !== 'posting') return { status: 200, body: { ok: true, escalationUri: row.escalation_uri, escalationCid: row.escalation_cid, expiresAt: row.expires_at } };
  if (paused()) return { status: 503, body: { error: 'PostingPaused' } };
  if (!activePosts.has(row.id)) {
    activePosts.set(row.id, (async () => {
      const queue = db.prepare('SELECT * FROM queue WHERE id = ?').get(row.queue_id);
      if (!queue || queue.uri !== row.post_uri || queue.attempts !== row.attempt || queue.status !== 'sent_to_agent') {
        throw new Error('approval turn is no longer pending');
      }
      const post = approvalPost({ ...queue, created_at: row.created_at });
      post.text = row.post_text;
      const result = await api.putRecord('app.bsky.feed.post', row.escalation_uri.split('/').at(-1), post);
      db.prepare(`UPDATE scan_approvals SET status = 'awaiting', escalation_cid = ?, updated_at = ?
        WHERE id = ? AND status = 'posting'`).run(result.cid, nowIso(), row.id);
    })().finally(() => activePosts.delete(row.id)));
  }
  try { await activePosts.get(row.id); }
  catch (err) {
    logger.error('scan approval escalation failed', { id: row.id, error: err.message });
    return { status: 503, body: { error: 'EscalationFailed' } };
  }
  row = getId.get(row.id);
  return { status: 200, body: { ok: true, escalationUri: row.escalation_uri, escalationCid: row.escalation_cid, expiresAt: row.expires_at } };
}

function stopForwarding(row, status, reason) {
  db.prepare(`UPDATE scan_approvals SET status = ?, failure_reason = ?, updated_at = ?
    WHERE id = ? AND status = 'responding'`).run(status, reason, nowIso(), row.id);
  logger.warn('scan approval forwarding stopped', { id: row.id, status, reason });
}

export async function forwardApproval(id, { fetcher = fetch } = {}) {
  if (activeForwards.has(id)) return;
  const row = getId.get(id);
  if (!row || row.status !== 'responding' || !row.approval_token || !row.bot_expires_at) return;
  if (Date.parse(row.expires_at) <= Date.now() || row.bot_expires_at <= Date.now()) {
    stopForwarding(row, 'expired', 'approval expired before forwarding');
    return;
  }
  const queue = db.prepare('SELECT status, attempts, gate FROM queue WHERE id = ?').get(row.queue_id);
  if (!queue || queue.attempts !== row.attempt ||
      (queue.status !== 'sent_to_agent' && !(queue.status === 'paused' && queue.gate === 'nap'))) {
    stopForwarding(row, 'rejected', 'original turn is no longer pending');
    return;
  }
  if (paused()) return;
  activeForwards.add(id);
  try {
    const response = await fetcher(`${config.agentUrl}/api/scan-approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atpotato-secret': config.sharedSecret },
      body: JSON.stringify({ sessionId: row.session_id, requestId: row.request_id, turnId: row.turn_id,
        postUri: row.post_uri, attempt: row.attempt, expiresAt: row.bot_expires_at,
        approvalToken: row.approval_token, optionId: row.option_id, adminDid: row.admin_did }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
        const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 300) : '';
        const reason = `bot responded ${response.status}${detail ? `: ${detail}` : ''}`;
        const expired = response.status === 409 && (/expir/i.test(detail) ||
          Date.parse(row.expires_at) <= Date.now() || row.bot_expires_at <= Date.now());
        stopForwarding(row, expired ? 'expired' : 'rejected', reason);
        return;
      }
      throw new Error(`bot responded ${response.status}`);
    }
    db.prepare("UPDATE scan_approvals SET status = 'forwarded', updated_at = ? WHERE id = ? AND status = 'responding'")
      .run(nowIso(), id);
  } catch (err) {
    logger.error('scan approval forwarding failed; will retry', { id, error: err.message });
  } finally { activeForwards.delete(id); }
}

export async function interceptApprovalReply(match, { fetcher = fetch } = {}) {
  if (match.reason !== 'reply' || typeof match.upstreamUri !== 'string') return false;
  const row = getEscalation.get(match.upstreamUri);
  if (!row) return false;
  // Never dispatch replies to an escalation as ordinary conversations.
  if (row.status !== 'awaiting' || !row.approval_token || !row.bot_expires_at ||
      match.upstreamCid !== row.escalation_cid ||
      Date.parse(row.expires_at) <= Date.now() ||
      !isAdmin(match.authorDid) || match.did !== match.authorDid || match.authorDid !== APPROVAL_ADMIN_DID ||
      !['approve', 'deny'].includes(match.text.trim().toLowerCase())) return true;
  const queue = db.prepare('SELECT attempts, status, gate FROM queue WHERE id = ?').get(row.queue_id);
  if (!queue || queue.attempts !== row.attempt ||
      (queue.status !== 'sent_to_agent' && !(queue.status === 'paused' && queue.gate === 'nap'))) return true;
  const option = match.text.trim().toLowerCase();
  const claimed = db.prepare(`UPDATE scan_approvals SET status = 'responding', admin_reply_uri = ?,
    admin_did = ?, option_id = ?, updated_at = ? WHERE id = ? AND status = 'awaiting' AND expires_at > ?`)
    .run(match.uri, match.authorDid, option, nowIso(), row.id, nowIso()).changes;
  if (claimed) await forwardApproval(row.id, { fetcher });
  return true;
}

export async function retryApprovalResponses({ fetcher = fetch, now = new Date() } = {}) {
  const expired = db.prepare(`SELECT id FROM scan_approvals
    WHERE status IN ('posting', 'awaiting', 'responding') AND expires_at <= ?`).all(now.toISOString());
  for (const row of expired) {
    db.prepare(`UPDATE scan_approvals SET status = 'expired', failure_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('posting', 'awaiting', 'responding')`)
      .run('approval window expired', nowIso(), row.id);
    logger.info('scan approval expired', { id: row.id });
  }
  if (paused()) return;
  for (const row of db.prepare("SELECT id FROM scan_approvals WHERE status = 'responding' LIMIT 20").all()) {
    await forwardApproval(row.id, { fetcher });
  }
}
