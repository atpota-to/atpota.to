// memory-digest.js
// Once a week, a short DM to the operator saying what the potato remembered and
// forgot, from the backup log (memory-log.js) and the guidance store. Plus the
// memory chores that run on the droplet's clock, once a day each:
//
//   prune     versions past memory-log's RETAIN_DAYS
//   rollup    early each month, ask the agent to sum up the journals' last month
//   snapshot  once ever, log every private document as it stands, so the first
//             digest compares against what was there rather than nothing
//
// A digest is claimed under a deterministic id (digest-<date>) before it is
// sent, and a send that might have gone out is never sent again, like every DM
// the droplet starts (dispatch-drafts.js sendOutbox).

import { config, isAdmin, killSwitchEngaged } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import { nowIso } from './db.js';
import * as atproto from './atproto.js';
import { splitDmText } from './operator-dm.js';
import { weeklySlot } from './dispatch-drafts.js';
import { addGuidance, guidanceChangedSince } from './guidance.js';
import { logMemoryVersion, memoryChangesSince, notesIn, pruneMemoryVersions } from './memory-log.js';
import { rollUpOnAgent, snapshotFromAgent } from './agent-memory.js';

db.db.exec(`
  CREATE TABLE IF NOT EXISTS memory_digest (
    id          TEXT PRIMARY KEY,           -- digest-YYYY-MM-DD
    operator_did TEXT,
    status      TEXT NOT NULL,              -- empty | pending | sending | sent | failed
    text        TEXT,
    convo_id    TEXT,
    parts_sent  INTEGER NOT NULL DEFAULT 0,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_chores (
    chore   TEXT PRIMARY KEY,               -- prune:<date> | rollup:<date> | snapshot
    done_at TEXT NOT NULL,
    detail  TEXT
  );
`);

const DAY_MS = 86400_000;
const ATTEMPTS = 5;
const ADMIN_PAGE = 'https://atpota.to/admin';

const LABELS = {
  life: 'my journal',
  'operator-dm-life': 'my DM journal',
  self: 'things about me',
  'dispatch-notes': 'dispatch notes',
};

const short = (text, n = 140) => {
  const clean = String(text).replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The digest for the week before `nowMs`, for this operator, or null when nothing changed. */
export function composeDigest(nowMs, operatorDid) {
  const since = new Date(nowMs - 7 * DAY_MS).toISOString();
  const until = new Date(nowMs).toISOString();
  const changes = memoryChangesSince(since, until);
  const guidance = guidanceChangedSince(since, until);
  const lines = [];

  const people = changes.filter((c) => c.slot === 'person');
  for (const c of changes.filter((c) => c.slot !== 'person')) {
    const label = c.slot === 'operator-notes'
      ? (c.scope === operatorDid ? 'notes about you' : `notes about ${c.scope}`)
      : LABELS[c.slot] ?? c.slot;
    const counts = [c.added.length && `${c.added.length} new`, c.removed.length && `${c.removed.length} taken out`]
      .filter(Boolean).join(', ');
    lines.push('', `${label}: ${counts}`);
    for (const note of c.added.slice(-3)) lines.push(`- ${short(note)}`);
    if (c.added.length > 3) lines.push(`- …and ${c.added.length - 3} more`);
  }
  if (people.length) {
    const added = people.reduce((n, c) => n + c.added.length, 0);
    const removed = people.reduce((n, c) => n + c.removed.length, 0);
    lines.push('', `people: notes about ${plural(people.length, 'person')} changed (${added} new, ${removed} taken out)`);
  }
  if (guidance.added.length || guidance.retired.length) {
    lines.push('', `guidance: ${guidance.added.length} added, ${guidance.retired.length} retired`);
    for (const g of guidance.added.slice(-3)) lines.push(`- ${g.arenas.join('+')}: ${short(g.text, 120)}`);
  }
  if (!lines.length) return null;
  return [
    "here's what i remembered this week (。•̀ᴗ-)✧",
    ...lines,
    '',
    `everything, with history and undo: ${ADMIN_PAGE}`,
  ].join('\n');
}

function choreDone(chore) {
  return Boolean(db.db.prepare('SELECT 1 FROM memory_chores WHERE chore = ?').get(chore));
}
function markChore(chore, detail = null) {
  db.db.prepare('INSERT OR IGNORE INTO memory_chores (chore, done_at, detail) VALUES (?, ?, ?)').run(chore, nowIso(), detail);
}

/** Log every private document as it stands, once, so history starts from what was there. */
export async function seedMemoryLog(deps = defaultDeps) {
  if (choreDone('snapshot')) return false;
  const res = await deps.snapshot(config.adminDids);
  if (!res.ok || !Array.isArray(res.body?.docs)) {
    logger.warn('memory log: agent snapshot unavailable; will try again', { status: res.status });
    return false;
  }
  let logged = 0;
  let imported = 0;
  for (const doc of res.body.docs) {
    if (typeof doc?.slot !== 'string' || typeof doc.scope !== 'string' || typeof doc.content !== 'string') continue;
    if (logMemoryVersion({ slot: doc.slot, scope: doc.scope, content: doc.content, source: 'snapshot' })) logged++;
    // The dispatch notes memory of 2026-11-02 became guidance the same day.
    if (doc.slot === 'dispatch-notes') {
      notesIn(doc.content).forEach((note, i) => {
        const text = note.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '');
        try {
          if (addGuidance({ kind: 'rule', text, arenas: ['dispatch'], sourceUri: `legacy:dispatch-notes#${i}`, oncePerSource: true }).added) imported++;
        } catch (err) {
          logger.warn('a dispatch note was not copied into guidance', { error: err.message });
        }
      });
    }
  }
  // Person notes already sit in memory_docs.
  for (const row of db.memoryDocs()) {
    if (logMemoryVersion({ slot: 'person', scope: row.did, content: row.content, source: 'snapshot' })) logged++;
  }
  markChore('snapshot', `${logged} documents, ${imported} dispatch notes into guidance`);
  logger.info('memory log seeded', { logged, imported });
  return true;
}

/** Once a day: prune, and early in the month, the journal rollup. */
export async function dailyChores(nowMs, deps = defaultDeps) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (!choreDone(`prune:${day}`)) {
    const pruned = pruneMemoryVersions(nowMs);
    markChore(`prune:${day}`, `${pruned} versions`);
  }
  if (new Date(nowMs).getUTCDate() <= 3 && !choreDone(`rollup:${day}`)) {
    const res = await deps.rollUp();
    if (res.ok) markChore(`rollup:${day}`);
    else logger.warn('journal rollup not started; will try again', { status: res.status });
  }
}

/** Queue this week's digest if it's due and not yet claimed. Returns the row's status, or null. */
export function queueDigest(nowMs) {
  const { day, hour } = config.memoryDigest;
  const slot = weeklySlot(nowMs, { day, hour });
  if (nowMs - slot >= 20 * 3600_000) return null;
  const id = `digest-${new Date(slot).toISOString().slice(0, 10)}`;
  if (db.db.prepare('SELECT 1 FROM memory_digest WHERE id = ?').get(id)) return null;
  const operator = config.adminDids[0] ?? null;
  const text = operator ? composeDigest(slot, operator) : null;
  const status = text ? 'pending' : 'empty';
  db.db.prepare(`INSERT OR IGNORE INTO memory_digest (id, operator_did, status, text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, operator, status, text, nowIso(), nowIso());
  return status;
}

/** Send any pending digest. A send that may have gone out stays 'sending' for review, never resent. */
export async function sendDigests(deps = defaultDeps) {
  const rows = db.db.prepare(`SELECT * FROM memory_digest WHERE status = 'pending' ORDER BY created_at LIMIT 2`).all();
  for (const row of rows) {
    if (!isAdmin(row.operator_did)) {
      db.db.prepare(`UPDATE memory_digest SET status = 'failed', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
      continue;
    }
    if (!db.db.prepare(`UPDATE memory_digest SET status = 'sending', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'`).run(nowIso(), row.id).changes) continue;
    let convoId = row.convo_id;
    try {
      if (!convoId) {
        convoId = (await deps.getDmConvoForMembers([row.operator_did]))?.convo?.id;
        if (typeof convoId !== 'string' || !convoId) throw new Error('no conversation with the operator');
        db.db.prepare('UPDATE memory_digest SET convo_id = ? WHERE id = ?').run(convoId, row.id);
      }
    } catch (err) {
      const failed = row.attempts + 1 >= ATTEMPTS;
      db.db.prepare('UPDATE memory_digest SET status = ?, updated_at = ? WHERE id = ?').run(failed ? 'failed' : 'pending', nowIso(), row.id);
      logger.warn('memory digest: no conversation yet', { id: row.id, error: err.message, failed });
      continue;
    }
    const parts = splitDmText(row.text);
    let sent = row.parts_sent;
    try {
      for (; sent < parts.length; sent++) {
        await deps.sendDmMessage(convoId, null, parts[sent]);
        db.db.prepare('UPDATE memory_digest SET parts_sent = ?, updated_at = ? WHERE id = ?').run(sent + 1, nowIso(), row.id);
      }
      db.db.prepare(`UPDATE memory_digest SET status = 'sent', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
      logger.info('memory digest sent', { id: row.id, parts: parts.length });
    } catch (err) {
      logger.error('memory digest send uncertain; manual review required', { id: row.id, part: sent + 1, error: err.message });
    }
  }
}

/** One tick: the chores, then the digest. Needs stage 4 and DMs, and no kill switch. */
export async function digestTick(nowMs = Date.now(), deps = defaultDeps) {
  if (config.stage < 4 || killSwitchEngaged()) return;
  await seedMemoryLog(deps).catch((err) => logger.warn('memory log seed failed', { err: err.message }));
  await dailyChores(nowMs, deps).catch((err) => logger.warn('memory chores failed', { err: err.message }));
  if (!config.memoryDigest.enabled || !config.dmEnabled || !config.adminDids.length) return;
  queueDigest(nowMs);
  await sendDigests(deps);
}

export function lastDigest() {
  return db.db.prepare('SELECT id, status, created_at, updated_at FROM memory_digest ORDER BY id DESC LIMIT 1').get() ?? null;
}

const defaultDeps = {
  getDmConvoForMembers: (members) => atproto.getDmConvoForMembers(members),
  sendDmMessage: (convoId, messageId, text) => atproto.sendDmMessage(convoId, messageId, text),
  rollUp: () => rollUpOnAgent(),
  snapshot: (operators) => snapshotFromAgent(operators),
};

export function startMemoryDigest({ tickMs = 600000 } = {}) {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    digestTick().catch((err) => logger.error('memory digest tick failed', { err: err.message }))
      .finally(() => { running = false; });
  };
  const first = setTimeout(run, 60000);
  const timer = setInterval(run, tickMs);
  first.unref?.();
  timer.unref?.();
  return { first, timer };
}
