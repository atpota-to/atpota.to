// guidance.js
// Standing guidance for the potato, one store for every arena (the table is in
// db.js). Three kinds, told apart by where they came from and whether they are
// public:
//
//   lesson  an admin's "remember:" / "lesson:" post (or `npm run lessons`),
//           published as a to.atpota.poe.lesson record in the potato's repo
//   style   a "style:" DM: private voice feedback
//   rule    a DM for one arena ("dispatch: ...", "weather: ..."), a rule the
//           agent saved when the operator asked it to remember something, or
//           one added on the admin page
//
// Each item names the arenas it applies to. The agent fetches the active ones
// through POST /memory ({ guidance: "list" }) and gives each turn those for its
// arena, as instructions (bot/agent/instructions/guidance.ts).

import * as db from './db.js';
import { GUIDANCE_ARENAS, PUBLIC_ARENAS, nowIso } from './db.js';

export { GUIDANCE_ARENAS, PUBLIC_ARENAS };
export const GUIDANCE_KINDS = ['lesson', 'style', 'rule'];
const MAX_TEXT = 600;
/** Per arena, the newest this many go to a turn; the rest wait to be folded into a skill. */
export const MAX_PER_ARENA = 40;

/** DM prefixes and where what follows applies. "style:" is voice feedback for every public arena. */
const PREFIXES = {
  style: { kind: 'style', arenas: PUBLIC_ARENAS },
  dispatch: { kind: 'rule', arenas: ['dispatch'] },
  weather: { kind: 'rule', arenas: ['weather'] },
  website: { kind: 'rule', arenas: ['website'] },
  bluesky: { kind: 'rule', arenas: ['bluesky'] },
  replies: { kind: 'rule', arenas: ['bluesky'] },
};
const PREFIX = new RegExp(`^(${Object.keys(PREFIXES).join('|')})\\s*:\\s*(\\S[\\s\\S]*)$`, 'i');

/** What a DM's guidance prefix asks for, or null when the DM isn't one. */
export function parseGuidanceDm(text) {
  const match = PREFIX.exec(String(text ?? '').trim());
  if (!match) return null;
  const { kind, arenas } = PREFIXES[match[1].toLowerCase()];
  return { kind, arenas: [...arenas], text: match[2].trim().slice(0, MAX_TEXT) };
}

/** Whether a DM's text is guidance the agent should know was saved (also "remember:"). */
export function isGuidanceDm(text) {
  return /^remember\s*:\s*\S/i.test(String(text ?? '').trim()) || parseGuidanceDm(text) !== null;
}

function cleanArenas(arenas) {
  if (!Array.isArray(arenas)) return null;
  const known = [...new Set(arenas.map((a) => String(a)))];
  if (!known.length || known.some((a) => !GUIDANCE_ARENAS.includes(a))) return null;
  return GUIDANCE_ARENAS.filter((a) => known.includes(a));
}

function row(r) {
  return r && {
    id: r.id, kind: r.kind, text: r.text, arenas: r.arenas.split(',').filter(Boolean),
    authorDid: r.author_did ?? null, sourceUri: r.source_uri ?? null,
    addedAt: r.added_at, updatedAt: r.updated_at, removedAt: r.removed_at ?? null,
    published: r.kind === 'lesson' ? Boolean(r.rkey) : null,
  };
}

export function getGuidance(id) {
  return row(db.db.prepare('SELECT * FROM guidance WHERE id = ?').get(id));
}

/** Every item, active first then the newest retired, for the admin page. */
export function listGuidance({ retired = 50 } = {}) {
  const active = db.db.prepare('SELECT * FROM guidance WHERE removed_at IS NULL ORDER BY id').all();
  const gone = db.db.prepare('SELECT * FROM guidance WHERE removed_at IS NOT NULL ORDER BY removed_at DESC LIMIT ?').all(retired);
  return { active: active.map(row), retired: gone.map(row) };
}

/**
 * What the agent gets: active items, each arena's newest MAX_PER_ARENA, oldest
 * first. An item over the cap in one arena still reaches the others.
 */
export function guidanceForAgent() {
  const newestFirst = db.db.prepare('SELECT * FROM guidance WHERE removed_at IS NULL ORDER BY id DESC').all().map(row);
  const kept = new Map(GUIDANCE_ARENAS.map((arena) => [arena, new Set(
    newestFirst.filter((g) => g.arenas.includes(arena)).slice(0, MAX_PER_ARENA).map((g) => g.id))]));
  return newestFirst.reverse()
    .map((g) => ({ id: g.id, kind: g.kind, text: g.text, arenas: g.arenas.filter((a) => kept.get(a).has(g.id)) }))
    .filter((g) => g.arenas.length > 0);
}

export class GuidanceError extends Error {}

/**
 * Add an item. An identical active one (same kind, text and arenas) is not
 * added twice; its id comes back instead.
 */
export function addGuidance({ kind, text, arenas, authorDid = null, sourceUri = null, oncePerSource = false }) {
  if (!GUIDANCE_KINDS.includes(kind)) throw new GuidanceError('unknown kind');
  const clean = String(text ?? '').trim().replaceAll(/\s+/g, ' ');
  if (!clean || clean.length > MAX_TEXT) throw new GuidanceError(`text must be 1 to ${MAX_TEXT} characters`);
  const where = cleanArenas(arenas ?? PUBLIC_ARENAS);
  if (!where) throw new GuidanceError(`arenas must be some of ${GUIDANCE_ARENAS.join(', ')}`);
  const existing = db.db.prepare(
    'SELECT id FROM guidance WHERE kind = ? AND text = ? AND arenas = ? AND removed_at IS NULL',
  ).get(kind, clean, where.join(','));
  if (existing) return { id: existing.id, added: false };
  if (sourceUri && oncePerSource) {
    const same = db.db.prepare('SELECT id FROM guidance WHERE source_uri = ? AND removed_at IS NULL').get(sourceUri);
    if (same) return { id: same.id, added: false };
  }
  const now = nowIso();
  const res = db.db.prepare(`INSERT INTO guidance (kind, text, arenas, author_did, source_uri, added_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(kind, clean, where.join(','), authorDid, sourceUri, now, now);
  return { id: Number(res.lastInsertRowid), added: true };
}

/**
 * Change an item's text or arenas. A lesson's text is published, so changing
 * it retires the old one (the sweep takes its record down) and adds the new
 * text as a new lesson (the sweep publishes it); the new id comes back.
 */
export function editGuidance(id, { text, arenas } = {}, editorDid = null) {
  const current = getGuidance(id);
  if (!current || current.removedAt) throw new GuidanceError('no such active guidance');
  const where = arenas === undefined ? current.arenas : cleanArenas(arenas);
  if (!where) throw new GuidanceError(`arenas must be some of ${GUIDANCE_ARENAS.join(', ')}`);
  const clean = text === undefined ? current.text : String(text).trim().replaceAll(/\s+/g, ' ');
  if (!clean || clean.length > MAX_TEXT) throw new GuidanceError(`text must be 1 to ${MAX_TEXT} characters`);
  if (current.kind === 'lesson' && clean !== current.text) {
    db.db.exec('BEGIN IMMEDIATE');
    try {
      retireGuidance(id);
      const now = nowIso();
      const res = db.db.prepare(`INSERT INTO guidance (kind, text, arenas, author_did, source_uri, added_at, updated_at)
        VALUES ('lesson',?,?,?,?,?,?)`).run(clean, where.join(','), editorDid ?? current.authorDid, current.sourceUri, now, now);
      db.db.exec('COMMIT');
      return { id: Number(res.lastInsertRowid) };
    } catch (err) {
      db.db.exec('ROLLBACK');
      throw err;
    }
  }
  db.db.prepare('UPDATE guidance SET text = ?, arenas = ?, updated_at = ? WHERE id = ?')
    .run(clean, where.join(','), nowIso(), id);
  return { id };
}

/** Retire an item. It stays in the table; a lesson's record is taken down by the sweep. */
export function retireGuidance(id) {
  const now = nowIso();
  return db.db.prepare('UPDATE guidance SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL')
    .run(now, now, id).changes > 0;
}

/** Bring a retired item back. A lesson is published again by the sweep. */
export function restoreGuidance(id) {
  return db.db.prepare('UPDATE guidance SET removed_at = NULL, updated_at = ? WHERE id = ? AND removed_at IS NOT NULL')
    .run(nowIso(), id).changes > 0;
}

/** Guidance changed since a time, for the weekly digest. */
export function guidanceChangedSince(sinceIso, untilIso = nowIso()) {
  const added = db.db.prepare('SELECT * FROM guidance WHERE added_at >= ? AND added_at <= ? ORDER BY id').all(sinceIso, untilIso).map(row);
  const retired = db.db.prepare('SELECT * FROM guidance WHERE removed_at >= ? AND removed_at <= ? ORDER BY id').all(sinceIso, untilIso).map(row);
  return { added, retired };
}
