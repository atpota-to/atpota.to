// memory-log.js
// A backup of every version of the potato's private memory: its journals, its
// notes about the people who run it, its self notes, and (from storeMemory)
// its notes about each person. The agent keeps the primary copy in Vercel
// Blob and hands each version here as it writes it (POST /memory with
// { log: { slot, scope, content, source } }); nothing here is ever published.
//
// It gives the admin page each document's history and an undo (restoring an
// old version writes it back through the agent), and the weekly digest what
// changed. Versions older than RETAIN_DAYS are pruned, except the newest of
// each document. Forgetting someone deletes every version that names them.

import * as db from './db.js';
import { nowIso } from './db.js';

db.db.exec(`
  CREATE TABLE IF NOT EXISTS memory_versions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    slot    TEXT NOT NULL,                -- the agent's memory slot, e.g. life, operator-notes, life:archive
    scope   TEXT NOT NULL,                -- whose: a DID, or the slot's one scope (poe-life)
    content TEXT NOT NULL,                -- the whole document as stored
    source  TEXT NOT NULL,                -- poe | admin:<did> | rollup | forget | snapshot
    at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_versions_doc ON memory_versions (slot, scope, id);
  CREATE INDEX IF NOT EXISTS memory_versions_at ON memory_versions (at);
`);

export const RETAIN_DAYS = 180;
const MAX_CONTENT = 256 * 1024;
const SLOT = /^[a-z][a-z-]{0,40}(:archive)?$/;
const SOURCE = /^(poe|rollup|forget|snapshot|admin:did:[a-z]+:[A-Za-z0-9._:%-]{1,200})$/;

/** The shape a logged version must have, or a reason it doesn't. */
export function validateLog(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return { ok: false, detail: 'log must be an object' };
  const { slot, scope, content, source } = log;
  if (typeof slot !== 'string' || !SLOT.test(slot)) return { ok: false, detail: 'slot is not a memory slot' };
  if (typeof scope !== 'string' || !scope || scope.length > 300) return { ok: false, detail: 'scope must be 1 to 300 characters' };
  if (typeof content !== 'string' || content.length > MAX_CONTENT) return { ok: false, detail: 'content must be a string under 256 KB' };
  if (typeof source !== 'string' || !SOURCE.test(source)) return { ok: false, detail: 'source is not one this log knows' };
  return { ok: true, value: { slot, scope, content, source } };
}

/** Keep one version, unless it is the same as the newest one kept for that document. */
export function logMemoryVersion({ slot, scope, content, source }, at = nowIso()) {
  const latest = db.db.prepare('SELECT content FROM memory_versions WHERE slot = ? AND scope = ? ORDER BY id DESC LIMIT 1')
    .get(slot, scope);
  if (latest?.content === content) return false;
  db.db.prepare('INSERT INTO memory_versions (slot, scope, content, source, at) VALUES (?,?,?,?,?)')
    .run(slot, scope, content, source, at);
  return true;
}

/** One document's versions, newest first. */
export function memoryHistory(slot, scope, limit = 30) {
  return db.db.prepare('SELECT id, slot, scope, content, source, at FROM memory_versions WHERE slot = ? AND scope = ? ORDER BY id DESC LIMIT ?')
    .all(slot, scope, Math.min(Math.max(1, limit), 200));
}

export function memoryVersion(id) {
  return db.db.prepare('SELECT id, slot, scope, content, source, at FROM memory_versions WHERE id = ?').get(id) ?? null;
}

/** Every document the log knows, with its newest version's time and source. */
export function loggedDocuments() {
  return db.db.prepare(`SELECT slot, scope, MAX(id) AS id, COUNT(*) AS versions, MAX(at) AS at
    FROM memory_versions GROUP BY slot, scope ORDER BY at DESC`).all();
}

/** Drop versions past RETAIN_DAYS, never a document's newest. */
export function pruneMemoryVersions(now = Date.now()) {
  const cutoff = new Date(now - RETAIN_DAYS * 86400_000).toISOString();
  return db.db.prepare(`DELETE FROM memory_versions WHERE at < ? AND id NOT IN
    (SELECT MAX(id) FROM memory_versions GROUP BY slot, scope)`).run(cutoff).changes;
}

/** Forgetting someone: every version of their own notes, and every version anywhere that names them. */
export function forgetInLog(did, handle = null) {
  let removed = db.db.prepare('DELETE FROM memory_versions WHERE scope = ?').run(did).changes;
  removed += db.db.prepare('DELETE FROM memory_versions WHERE instr(lower(content), lower(?)) > 0').run(did).changes;
  const h = String(handle ?? '').toLowerCase().replace(/^@/, '');
  if (h.includes('.')) {
    removed += db.db.prepare('DELETE FROM memory_versions WHERE instr(lower(content), ?) > 0').run(h).changes;
  }
  return removed;
}

/** The notes in a fileMemory document (an archive's JSON yields its notes too). */
export function notesIn(content) {
  const text = String(content ?? '');
  if (text.startsWith('{')) {
    try {
      const archive = JSON.parse(text);
      return Object.values(archive.months ?? {}).flatMap((m) => (Array.isArray(m.notes) ? m.notes : []));
    } catch {
      return [];
    }
  }
  return text.split('\n').flatMap((line) => {
    const entry = /^\d+: (.+)$/.exec(line);
    return entry ? [entry[1]] : [];
  });
}

/**
 * What changed in each document between two times: notes added and removed,
 * comparing its newest version by `untilIso` with the last one before `sinceIso`. A note that moved
 * from a journal into its archive is neither.
 */
export function memoryChangesSince(sinceIso, untilIso = nowIso()) {
  const docs = db.db.prepare('SELECT DISTINCT slot, scope FROM memory_versions WHERE at >= ? AND at <= ?').all(sinceIso, untilIso);
  const newestBy = (slot, scope) => db.db.prepare(
    'SELECT content FROM memory_versions WHERE slot = ? AND scope = ? AND at <= ? ORDER BY id DESC LIMIT 1').get(slot, scope, untilIso);
  const byDoc = new Map();
  for (const { slot, scope } of docs) {
    const newest = newestBy(slot, scope);
    const before = db.db.prepare('SELECT content FROM memory_versions WHERE slot = ? AND scope = ? AND at < ? ORDER BY id DESC LIMIT 1')
      .get(slot, scope, sinceIso);
    const base = slot.replace(/:archive$/, '');
    const entry = byDoc.get(`${base}\u0000${scope}`) ?? { slot: base, scope, now: new Set(), then: new Set() };
    for (const note of notesIn(newest?.content)) entry.now.add(note);
    for (const note of notesIn(before?.content)) entry.then.add(note);
    byDoc.set(`${base}\u0000${scope}`, entry);
  }
  // A journal and its archive count as one document, so archiving is no change.
  for (const entry of byDoc.values()) {
    for (const slotName of [entry.slot, `${entry.slot}:archive`]) {
      if (docs.some((d) => d.slot === slotName && d.scope === entry.scope)) continue;
      for (const note of notesIn(newestBy(slotName, entry.scope)?.content)) { entry.now.add(note); entry.then.add(note); }
    }
  }
  return [...byDoc.values()].map(({ slot, scope, now, then }) => ({
    slot, scope,
    added: [...now].filter((n) => !then.has(n)),
    removed: [...then].filter((n) => !now.has(n)),
  })).filter((c) => c.added.length || c.removed.length);
}
