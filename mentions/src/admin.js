// admin.js
// The droplet's half of the admin page on atpota.to (website/server/admin.ts):
// the potato's state, its guidance, the backup log of its memory, and a nap.
// Served under /admin/ on the callback server, behind nginx's /admin/ block.
//
// Two checks, both required:
//   x-atpotato-admin-secret  ADMIN_SHARED_SECRET, held only by the website's
//                            admin proxy. Never DROPLET_SHARED_SECRET.
//   x-atpotato-admin-did     the signed-in admin the proxy verified, which must
//                            also be on ADMIN_DIDS here, or the potato itself.
// The proxy checks its own allowlist first; this one is the droplet's own say.

import { timingSafeEqual, createHash } from 'node:crypto';
import { config, isAdmin, killSwitchEngaged } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import { napStatus, applyNapCommand } from './nap.js';
import { parseNapCommand } from './nap-time.js';
import { currentDraft, previewUrl } from './dispatch-drafts.js';
import {
  GUIDANCE_ARENAS, GUIDANCE_KINDS, GuidanceError, addGuidance, editGuidance, getGuidance, listGuidance, restoreGuidance,
  retireGuidance,
} from './guidance.js';
import { loggedDocuments, memoryHistory, memoryVersion } from './memory-log.js';
import { composeDigest, lastDigest } from './memory-digest.js';
import { publishLesson, retireLesson } from './memory.js';

const MAX_BODY = 16 * 1024;

function adminSecretMatches(given) {
  const expected = config.adminSecret;
  if (!expected || expected === config.sharedSecret || typeof given !== 'string') return false;
  const digest = (v) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** The admin a request is from, or an error status. */
export function adminOf(headers) {
  if (!config.adminSecret || config.adminSecret === config.sharedSecret) return { status: 503 };
  if (!adminSecretMatches(headers['x-atpotato-admin-secret'])) return { status: 401 };
  const did = headers['x-atpotato-admin-did'];
  if (typeof did !== 'string' || !(isAdmin(did) || did === config.botDid)) return { status: 403 };
  return { did };
}

const postUrl = (uri) => {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri ?? '');
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
};

/** What the potato is up to, for the top of the admin page. */
export function adminState(nowMs = Date.now()) {
  const kill = killSwitchEngaged();
  const nap = napStatus(new Date(nowMs));
  const day = new Date(nowMs - 86400_000).toISOString();
  const week = new Date(nowMs - 7 * 86400_000).toISOString();
  const statuses = db.db.prepare('SELECT status, COUNT(*) AS n FROM queue WHERE matched_at >= ? GROUP BY status').all(day);
  const recent = db.db.prepare(`SELECT r.text AS reply, r.reply_uri, r.posted_at, q.text AS asked, q.author_handle, q.uri
    FROM replies r JOIN queue q ON q.id = r.queue_id ORDER BY r.id DESC LIMIT 12`).all();
  const draft = currentDraft();
  return {
    stage: config.stage,
    posting: config.stage >= 4 && !kill && !nap.active,
    killSwitch: kill ?? false,
    nap,
    uptimeSec: Math.round(process.uptime()),
    dms: config.dmEnabled,
    dispatch: {
      enabled: config.dispatch.enabled,
      drafts: config.dispatch.drafts.mode,
      draft: draft ? { id: draft.id, status: draft.status, version: draft.version, title: draft.title, preview: previewUrl(draft) } : null,
    },
    activity: {
      matched24h: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
      replies24h: db.db.prepare('SELECT COUNT(*) AS n FROM replies WHERE posted_at >= ?').get(day).n,
      replies7d: db.db.prepare('SELECT COUNT(*) AS n FROM replies WHERE posted_at >= ?').get(week).n,
    },
    recent: recent.map((r) => ({
      postedAt: r.posted_at, author: r.author_handle ?? null,
      asked: String(r.asked).slice(0, 300), reply: String(r.reply).slice(0, 600),
      askedUrl: postUrl(r.uri), replyUrl: postUrl(r.reply_uri),
    })),
    memory: {
      people: db.memoryDocs().length,
      documents: loggedDocuments().length,
      digest: { enabled: config.memoryDigest.enabled, day: config.memoryDigest.day, hourUtc: config.memoryDigest.hour, last: lastDigest() },
    },
    guidance: { active: listGuidance({ retired: 0 }).active.length, arenas: GUIDANCE_ARENAS, kinds: GUIDANCE_KINDS },
  };
}

/** Everyone the potato keeps notes on, as the droplet last received them. */
export function adminPeople() {
  return db.memoryDocs().map((d) => ({
    did: d.did,
    notes: JSON.parse(d.notes ?? '[]').length,
    heldBack: d.held_back ?? 0,
    updatedAt: d.updated_at,
    published: Boolean(d.published_at) && !d.publish_note?.startsWith('not published'),
    publishNote: d.publish_note ?? null,
  }));
}

async function syncLesson(id) {
  const lesson = db.getLesson(id);
  if (!lesson) return;
  const api = await import('./atproto.js');
  if (lesson.removed_at) await retireLesson(id, { api });
  else await publishLesson(id, { api });
}

/** One guidance change from the admin page. */
export async function adminGuidance(by, body) {
  const { action } = body ?? {};
  if (action === 'add') {
    const kind = body.kind ?? 'rule';
    const { id } = addGuidance({ kind, text: body.text, arenas: body.arenas, authorDid: by });
    if (kind === 'lesson') await syncLesson(id);
    return { id, item: getGuidance(id) };
  }
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id < 1) throw new GuidanceError('id must be a guidance id');
  const before = getGuidance(id);
  if (!before) throw new GuidanceError('no such guidance');
  if (action === 'edit') {
    const result = editGuidance(id, { text: body.text, arenas: body.arenas }, by);
    if (before.kind === 'lesson') {
      await syncLesson(id);
      if (result.id !== id) await syncLesson(result.id);
    }
    return { id: result.id, item: getGuidance(result.id) };
  }
  if (action === 'retire' || action === 'restore') {
    const changed = action === 'retire' ? retireGuidance(id) : restoreGuidance(id);
    if (!changed) throw new GuidanceError(`it is already ${action === 'retire' ? 'retired' : 'active'}`);
    if (before.kind === 'lesson') await syncLesson(id);
    return { id, item: getGuidance(id) };
  }
  throw new GuidanceError('action must be add, edit, retire or restore');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function reply(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store', 'x-robots-tag': 'noindex',
  });
  res.end(payload);
}

/** Every /admin/ request. */
export async function handleAdmin(req, res) {
  const who = adminOf(req.headers);
  if (who.status) {
    if (who.status !== 503) logger.warn('admin request refused', { status: who.status, ip: req.socket.remoteAddress });
    return reply(res, who.status, { error: who.status === 503 ? 'AdminNotConfigured' : 'Unauthorized' });
  }
  const url = new URL(req.url, 'http://droplet.local');
  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      case 'GET /admin/state': return reply(res, 200, adminState());
      case 'GET /admin/guidance': return reply(res, 200, listGuidance());
      case 'POST /admin/guidance': return reply(res, 200, await adminGuidance(who.did, await readJson(req)));
      case 'GET /admin/people': return reply(res, 200, { people: adminPeople() });
      case 'GET /admin/memory/history': {
        const slot = url.searchParams.get('slot') ?? '';
        const scope = url.searchParams.get('scope') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 30);
        return reply(res, 200, { versions: memoryHistory(slot, scope, Number.isFinite(limit) ? limit : 30) });
      }
      case 'GET /admin/memory/version': {
        const version = memoryVersion(Number(url.searchParams.get('id')));
        return version ? reply(res, 200, version) : reply(res, 404, { error: 'NotFound' });
      }
      case 'GET /admin/digest': {
        const operator = config.adminDids.includes(who.did) ? who.did : config.adminDids[0];
        return reply(res, 200, { text: operator ? composeDigest(Date.now(), operator) : null });
      }
      case 'POST /admin/nap': {
        const body = await readJson(req);
        const command = parseNapCommand(String(body?.text ?? ''), new Date(), config.botHandle);
        if (!command) return reply(res, 400, { error: 'BadRequest', detail: 'say "nap: 2h", "nap: until tomorrow at 9am", "wake" or "nap status"' });
        const result = applyNapCommand(`admin:${who.did}:${Date.now()}`, command);
        return reply(res, 200, { message: result.message, nap: napStatus() });
      }
      default: return reply(res, 404, { error: 'NotFound' });
    }
  } catch (err) {
    if (err instanceof GuidanceError) return reply(res, 400, { error: 'BadRequest', detail: err.message });
    if (err?.status) return reply(res, err.status, { error: 'BadRequest' });
    logger.error('admin request failed', { route, err: err.message });
    return reply(res, 500, { error: 'Internal' });
  }
}
