// Private DM transport. Never hands messages to the public reply pipeline.
import { config, isAdmin, killSwitchEngaged } from './config.js';
import { db, nowIso } from './db.js';
import { logger } from './logger.js';
import * as chat from './atproto.js';
import { parseNapCommand } from './nap-time.js';
import { applyNapCommand } from './nap.js';
import { byteLength, expandLinks, graphemeLength } from './richtext.js';
import {
  parseAnnounceCommand, recordCommand, runCommand,
  attachProposal, parseConfirmation, liveProposalFor, decideProposal,
} from './dispatch.js';
import {
  attachPostProposal, livePostProposalFor, decidePostProposal, publishPostProposal,
} from './operator-posts.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS style_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    author_did TEXT NOT NULL,
    source_uri TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL,
    removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS operator_dm_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    started_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operator_dm (
    message_id TEXT PRIMARY KEY,
    convo_id TEXT NOT NULL,
    operator_did TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL,
    draft_key TEXT UNIQUE,
    draft_text TEXT,
    reply_id TEXT,
    request_status TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS operator_dm_status_idx ON operator_dm(status, updated_at);
`);
try { db.exec('ALTER TABLE operator_dm ADD COLUMN request_status TEXT'); }
catch { /* already added */ }
try { db.exec('ALTER TABLE operator_dm ADD COLUMN shared_text TEXT'); }
catch { /* already added */ }

/**
 * A line for Poe naming the post (or other record) the operator attached to a
 * DM. The app sends an attached post as the message's embed, not its text, so
 * without this Poe sees "this post" and nothing else. Links only: Poe looks
 * the post up itself. Null when nothing is attached.
 */
export function describeShared(embed) {
  const record = embed?.record;
  const uri = typeof record?.uri === 'string' ? record.uri : null;
  if (!uri || !uri.startsWith('at://')) return null;
  const post = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(uri);
  if (!post) return `(attached to this message: ${uri})`;
  if (!String(record.$type ?? '').endsWith('#viewRecord')) {
    return `(attached to this message: a post that can't be seen, ${uri})`;
  }
  const who = typeof record.author?.handle === 'string' && record.author.handle !== 'handle.invalid'
    ? record.author.handle : post[1];
  return `(attached to this message: the post https://bsky.app/profile/${who}/post/${post[2]}, ${uri})`;
}

try { db.exec('ALTER TABLE operator_dm ADD COLUMN seen_reaction TEXT'); }
catch { /* already added */ }
try { db.exec('ALTER TABLE operator_dm ADD COLUMN parts_sent INTEGER NOT NULL DEFAULT 0'); }
catch { /* already added */ }

// chat.bsky.convo.defs#messageInput: text is at most 1000 graphemes and 10000
// bytes. A longer reply goes out as several messages, at most DM_MAX_PARTS.
export const DM_MAX_GRAPHEMES = 1000;
const DM_MAX_BYTES = 10000;
export const DM_MAX_PARTS = 4;

const dmGraphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const fitsDm = (text) => graphemeLength(text) <= DM_MAX_GRAPHEMES && byteLength(text) <= DM_MAX_BYTES;

/** Pieces of `text` that each fit a DM: whole units joined by `glue` where they fit, else split finer. */
function packDm(units, glue, finer) {
  const out = [];
  let current = '';
  for (const unit of units) {
    const joined = current ? `${current}${glue}${unit}` : unit;
    if (fitsDm(joined)) { current = joined; continue; }
    if (current) out.push(current);
    if (fitsDm(unit)) { current = unit; continue; }
    const pieces = finer(unit);
    current = pieces.pop() ?? '';
    out.push(...pieces);
  }
  if (current) out.push(current);
  return out;
}

function hardSplit(text) {
  const out = [];
  let current = '';
  for (const { segment } of dmGraphemes.segment(text)) {
    if (!fitsDm(current + segment)) { out.push(current); current = ''; }
    current += segment;
  }
  return current ? [...out, current] : out;
}

/**
 * A reply cut into DMs: at paragraph breaks where it can, then at sentence
 * ends, then between words, and mid-word only for a word longer than a DM.
 * At most DM_MAX_PARTS; past that the last part ends with an ellipsis.
 */
export function splitDmText(text) {
  const words = (s) => packDm(s.split(/(?<=\S)\s+(?=\S)/u), ' ', hardSplit);
  const sentences = (s) => packDm(s.split(/(?<=[.!?…)])\s+/u), ' ', words);
  const parts = packDm(text.trim().split(/\n\s*\n/u), '\n\n', (p) => packDm(p.split('\n'), '\n', sentences))
    .map((p) => p.trim()).filter(Boolean);
  if (parts.length <= DM_MAX_PARTS) return parts;
  const kept = parts.slice(0, DM_MAX_PARTS);
  let last = kept[DM_MAX_PARTS - 1];
  while (!fitsDm(`${last}…`)) last = [...dmGraphemes.segment(last)].slice(0, -1).map((s) => s.segment).join('');
  kept[DM_MAX_PARTS - 1] = `${last.trimEnd()}…`;
  return kept;
}

// Put on a DM as soon as it is picked up and taken off once the reply is sent,
// so the operator can tell "seen, working on it" from "not seen yet".
export const SEEN_REACTION = '👀';

/** React to a DM Poe has picked up. Best effort: a reply never waits on it. */
async function markSeen(api, convoId, messageId) {
  if (!api.addDmReaction) return;
  try {
    await api.addDmReaction(convoId, messageId, SEEN_REACTION);
    db.prepare('UPDATE operator_dm SET seen_reaction = ? WHERE message_id = ?').run(SEEN_REACTION, messageId);
  } catch (err) {
    logger.warn('operator DM seen reaction failed', { messageId, error: err.message });
  }
}

async function clearSeen(api, row) {
  if (!row.seen_reaction || !api.removeDmReaction) return;
  try {
    await api.removeDmReaction(row.convo_id, row.message_id, row.seen_reaction);
    db.prepare('UPDATE operator_dm SET seen_reaction = NULL WHERE message_id = ?').run(row.message_id);
  } catch (err) {
    logger.warn('operator DM seen reaction not removed', { messageId: row.message_id, error: err.message });
  }
}

export function baseline() {
  // First enablement deliberately ignores old inbox messages, even across restarts.
  db.prepare('INSERT OR IGNORE INTO operator_dm_state(id, started_at) VALUES (1, ?)').run(nowIso());
  return db.prepare('SELECT started_at FROM operator_dm_state WHERE id = 1').get().started_at;
}

export function acceptMessage(convo, message, cutoff) {
  if (!convo || !message || typeof message.text !== 'string' ||
      (!message.text.trim() && !describeShared(message.embed)) ||
      typeof message.id !== 'string' || !message.id || !Number.isFinite(Date.parse(message.sentAt)) ||
      Date.parse(message.sentAt) <= Date.parse(cutoff) || !isAdmin(message.sender?.did) ||
      !Array.isArray(convo.members) || convo.members.length !== 2 ||
      !convo.members.some((m) => m.did === config.botDid) ||
      !convo.members.some((m) => m.did === message.sender.did) ||
      typeof convo.id !== 'string' || !convo.id) return false;
  const inserted = db.prepare(`INSERT OR IGNORE INTO operator_dm
    (message_id, convo_id, operator_did, received_at, status, request_status, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run(
      message.id, convo.id, message.sender.did, message.sentAt, convo.status === 'request' ? 'request' : null, nowIso(),
    ).changes > 0;
  if (inserted) {
    const match = /^style:\s*(\S[\s\S]*)$/i.exec(message.text.trim());
    if (match) db.prepare(`INSERT INTO style_feedback (text, author_did, source_uri, added_at)
      VALUES (?, ?, ?, ?)`).run(match[1].slice(0, 600), message.sender.did,
        `dm:${message.id}`, nowIso());
  }
  return inserted;
}

export function receiveDraft(body) {
  if (!body || typeof body !== 'object' || typeof body.key !== 'string' ||
      !body.key || body.key.length > 500 || typeof body.dmId !== 'string' ||
      typeof body.operatorDid !== 'string' || typeof body.text !== 'string') return 'invalid';
  const row = db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(body.dmId);
  if (!row || row.operator_did !== body.operatorDid || !isAdmin(row.operator_did) ||
      row.status !== 'dispatched') return 'ignored';
  // Kept whole: deliverDm splits it into as many DMs as it needs.
  const text = body.text.trim() || 'oopsie, my words got lost on the way here (╥﹏╥) please try me again?';
  const accepted = db.prepare(`UPDATE operator_dm SET status = 'drafted', draft_key = ?, draft_text = ?, updated_at = ?
    WHERE message_id = ? AND status = 'dispatched'`).run(body.key, text, nowIso(), body.dmId).changes > 0;
  if (accepted) {
    // An announcement or a post Poe proposed in this turn goes under its reply,
    // verbatim. One per reply, so a yes always means one thing.
    const withProposal = (config.dispatch.enabled ? attachProposal(body.dmId, text) : null) ??
      attachPostProposal(body.dmId, text);
    if (withProposal) {
      db.prepare(`UPDATE operator_dm SET draft_text = ? WHERE message_id = ? AND status = 'drafted'`)
        .run(withProposal, body.dmId);
    }
  }
  return accepted ? 'accepted' : 'ignored';
}

export async function deliverDm(row, api = chat) {
  if (config.stage < 4 || killSwitchEngaged() || !config.dmEnabled || !isAdmin(row.operator_did)) return;
  // An ambiguous network failure must NOT resend: chat sendMessage has no
  // idempotency key. Leave `sending` for manual review rather than duplicate.
  if (!db.prepare(`UPDATE operator_dm SET status = 'sending', updated_at = ?
    WHERE message_id = ? AND status = 'drafted'`).run(nowIso(), row.message_id).changes) return;
  const parts = splitDmText(row.draft_text ?? '');
  let sent = row.parts_sent ?? 0;
  try {
    if (row.request_status === 'request' && sent === 0) await api.acceptDmConvo(row.convo_id);
    // The first part answers the operator's message; the rest follow it.
    for (; sent < parts.length; sent++) {
      const reply = await api.sendDmMessage(row.convo_id, sent === 0 ? row.message_id : null, parts[sent]);
      db.prepare(`UPDATE operator_dm SET parts_sent = ?, reply_id = COALESCE(reply_id, ?), updated_at = ?
        WHERE message_id = ?`).run(sent + 1, reply.id, nowIso(), row.message_id);
    }
    db.prepare(`UPDATE operator_dm SET status = 'sent', updated_at = ? WHERE message_id = ?`)
      .run(nowIso(), row.message_id);
    logger.info('operator DM delivered', { messageId: row.message_id, parts: parts.length });
    await clearSeen(api, db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(row.message_id));
  } catch (err) {
    logger.error('operator DM send uncertain; manual review required', {
      messageId: row.message_id, error: err.message, part: sent + 1, parts: parts.length,
    });
  }
}

// Dispatch commands run beside the poll rather than inside it: the page check
// can wait up to ten minutes, and other DMs should not wait behind it. The
// command is stored first, so a restart picks it up again from the
// operator_dm row left in 'command'.
const commandJobs = new Map();

function startCommand(messageId, api, dispatchDeps) {
  if (commandJobs.has(messageId)) return commandJobs.get(messageId);
  const job = runCommand(messageId, dispatchDeps)
    .then(async (reply) => {
      if (reply == null) return;
      db.prepare(`UPDATE operator_dm SET status = 'drafted', draft_text = ?, updated_at = ?
        WHERE message_id = ? AND status = 'command'`).run(reply, nowIso(), messageId);
      const row = db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(messageId);
      if (row?.status === 'drafted') await deliverDm(row, api);
    })
    .catch((err) => logger.error('dispatch command failed', { messageId, error: err.message }))
    .finally(() => commandJobs.delete(messageId));
  commandJobs.set(messageId, job);
  return job;
}

/** Wait for every running dispatch command. For tests and shutdown. */
export function settleCommands() {
  return Promise.all(commandJobs.values());
}

async function dispatchDm(row, fetcher = fetch) {
  if (config.stage < 4 || killSwitchEngaged() || !config.dmEnabled) return;
  // A retried dispatch may launch another agent turn; only the first accepted
  // draft wins. Avoid automatic re-dispatch after a successful 202.
  db.prepare(`UPDATE operator_dm SET status = 'dispatched', updated_at = ?
    WHERE message_id = ? AND status = 'queued'`).run(nowIso(), row.message_id);
  const ac = AbortSignal.timeout(15000);
  const response = await fetcher(`${config.agentUrl}/operator/dm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atpotato-secret': config.sharedSecret },
    body: JSON.stringify({
      dmId: row.message_id, operatorDid: row.operator_did,
      text: [row.text, row.shared_text].filter((t) => t?.trim()).join('\n\n'),
      guidance: /^(?:remember|style):\s*\S/i.test(row.text),
    }),
    signal: ac,
  });
  if (!response.ok) throw new Error(`operator DM dispatch failed: ${response.status}`);
}

export async function pollOperatorDms({ api = chat, fetcher = fetch, dispatchDeps, postDeps } = {}) {
  if (!config.dmEnabled || config.stage < 4 || !config.adminDids.length || killSwitchEngaged()) return;
  const cutoff = baseline();
  let cursor;
  // Bounded scan; if the admin conversation is buried beyond 1000 convos,
  // stop and alert rather than falsely treating another sender as an admin.
  for (const source of ['accepted', 'requests']) {
    cursor = undefined;
    for (let page = 0; page < 10; page++) {
    const result = source === 'accepted' ? await api.listDmConvos(cursor)
      : await (api.listDmRequests ?? (async () => ({ requests: [] })))(cursor);
    for (const convo of source === 'accepted' ? (result.convos ?? []) : (result.requests ?? [])) {
      if (!Array.isArray(convo.members) || convo.members.length !== 2 ||
          !convo.members.some((m) => m.did === config.botDid) ||
          !convo.members.some((m) => isAdmin(m.did))) continue;
      let msgCursor;
      for (let messagesPage = 0; messagesPage < 3; messagesPage++) {
        const messages = await api.getDmMessages(convo.id, msgCursor);
        let older = false;
        for (const message of messages.messages ?? []) {
          if (typeof message.sentAt === 'string' && Date.parse(message.sentAt) <= Date.parse(cutoff)) older = true;
          if (!older && acceptMessage(source === 'requests' ? { ...convo, status: 'request' } : convo, message, cutoff)) {
            // Keep the text locally only until the agent accepts dispatch.
            // Links are kept whole: the app shortens a link's text and leaves
            // the full URL only in the facet.
            db.prepare('UPDATE operator_dm SET draft_text = ?, shared_text = ? WHERE message_id = ?')
              .run(expandLinks(message.text, message.facets), describeShared(message.embed), message.id);
            // A request convo isn't accepted until the reply goes out, and
            // reacting in one would accept it early.
            if (source !== 'requests') await markSeen(api, convo.id, message.id);
          }
        }
        msgCursor = messages.cursor;
        if (older || !msgCursor) break;
      }
    }
    cursor = result.cursor;
    if (!cursor) break;
    if (page === 9) logger.warn('operator DM scan hit conversation page limit', { source });
    }
  }
  const drafts = db.prepare(`SELECT * FROM operator_dm WHERE status = 'drafted' LIMIT 10`).all();
  for (const row of drafts) await deliverDm(row, api);
  if (config.dispatch.enabled) {
    // Finish any command a restart interrupted.
    for (const row of db.prepare(`SELECT message_id FROM operator_dm WHERE status = 'command'`).all()) {
      startCommand(row.message_id, api, dispatchDeps);
    }
  }
  const queued = db.prepare(`SELECT *, draft_text AS text FROM operator_dm
    WHERE status = 'queued' ORDER BY received_at LIMIT 10`).all();
  for (const row of queued) {
    try {
      // Dispatch commands are handled here and never forwarded to the agent.
      const dispatchCommand = config.dispatch.enabled && isAdmin(row.operator_did)
        ? parseAnnounceCommand(row.text) : null;
      if (dispatchCommand) {
        recordCommand(row.message_id, row.operator_did, dispatchCommand);
        db.prepare(`UPDATE operator_dm SET status = 'command', draft_text = NULL, shared_text = NULL, updated_at = ?
          WHERE message_id = ? AND status = 'queued'`).run(nowIso(), row.message_id);
        startCommand(row.message_id, api, dispatchDeps);
        continue;
      }
      // A plain yes or no straight back to Poe's proposed announcement.
      const answer = config.dispatch.enabled && isAdmin(row.operator_did) ? parseConfirmation(row.text) : null;
      const proposal = answer ? liveProposalFor(row) : null;
      if (proposal && decideProposal(proposal.id, answer, row.message_id)) {
        if (answer === 'yes') {
          recordCommand(row.message_id, row.operator_did,
            { kind: 'announce', rkey: proposal.document_rkey, text: proposal.text });
          db.prepare(`UPDATE operator_dm SET status = 'command', draft_text = NULL, shared_text = NULL, updated_at = ?
            WHERE message_id = ? AND status = 'queued'`).run(nowIso(), row.message_id);
          startCommand(row.message_id, api, dispatchDeps);
        } else {
          db.prepare(`UPDATE operator_dm SET status = 'drafted', draft_text = ?, shared_text = NULL, updated_at = ?
            WHERE message_id = ? AND status = 'queued'`).run("ok, i won't post it.", nowIso(), row.message_id);
          await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(row.message_id), api);
        }
        continue;
      }
      // A plain yes or no straight back to a post Poe proposed (operator-posts.js).
      // Posting takes seconds, so it runs here; 'publishing' keeps a restart from
      // handing the yes to Poe as a new message, and the post's own key from posting twice.
      const postAnswer = isAdmin(row.operator_did) ? parseConfirmation(row.text) : null;
      const postProposal = postAnswer ? livePostProposalFor(row) : null;
      if (postProposal && decidePostProposal(postProposal.id, postAnswer, row.message_id)) {
        db.prepare(`UPDATE operator_dm SET status = 'publishing', updated_at = ? WHERE message_id = ? AND status = 'queued'`)
          .run(nowIso(), row.message_id);
        const reply = postAnswer === 'yes'
          ? (await publishPostProposal(postProposal.id, postDeps)) ?? "that post already went out, or was dropped."
          : "ok, i won't post it.";
        db.prepare(`UPDATE operator_dm SET status = 'drafted', draft_text = ?, shared_text = NULL, updated_at = ?
          WHERE message_id = ? AND status = 'publishing'`).run(reply, nowIso(), row.message_id);
        await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(row.message_id), api);
        continue;
      }
      const command = parseNapCommand(row.text, new Date(), config.botHandle);
      if (command) {
        const result = applyNapCommand(`dm:${row.message_id}`, command);
        if (command.kind === 'wake' && !result.duplicate && !config.dryRun) {
          import('./reconcile.js').then(({ requestNapCatchup }) => requestNapCatchup())
            .catch((err) => logger.error('wake catch-up failed to start', { error: err.message }));
        }
        db.prepare(`UPDATE operator_dm SET status = 'drafted', draft_text = ?, shared_text = NULL, updated_at = ?
          WHERE message_id = ? AND status = 'queued'`).run(result.message, nowIso(), row.message_id);
        await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(row.message_id), api);
        continue;
      }
      await dispatchDm(row, fetcher);
      db.prepare('UPDATE operator_dm SET draft_text = NULL, shared_text = NULL WHERE message_id = ? AND status = ?')
        .run(row.message_id, 'dispatched');
    } catch (err) {
      logger.error('operator DM dispatch failed', { messageId: row.message_id, error: err.message });
    }
  }
}

export function startOperatorDmPoll() {
  if (!config.dmEnabled) return null;
  if (!config.adminDids.length || !config.appPassword || config.stage < 4) {
    logger.warn('operator DM disabled: requires stage 4, admin DID and app password');
    return null;
  }
  baseline();
  let polling = false;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try { await pollOperatorDms(); }
    catch (err) { logger.error('operator DM poll failed', { error: err.message }); }
    finally { polling = false; }
  };
  const first = setTimeout(tick, 15000);
  first.unref?.();
  const timer = setInterval(tick, Math.max(config.dmPollMs, 30000));
  timer.unref?.();
  return timer;
}
