// memory.js
// The potato's notes about people, and its lessons, published as public
// records in its own repo:
//
//   at://<the potato>/to.atpota.poe.memory/<their DID>   one record per person
//   at://<the potato>/to.atpota.poe.lesson/<tid>         one record per lesson
//
// Public on purpose (decided 2026-09-24): the potato lives in the Atmosphere,
// and so does what it remembers. The agent keeps the primary copy of each
// person's notes in Vercel Blob and hands every saved version here; this keeps
// a copy, and publishes. The agent never holds the credential that does it.
//
// Going public turns a note from something the potato keeps into something it
// says, under its own name, where anyone can read it. So a note is published
// only if it would pass as a reply: no links, 300 graphemes at most. The rest
// stays in the private copies. And nothing is ever published about someone
// who has opted out, whose record is deleted instead.
//
// Nothing here throws into its caller. A publish that fails is recorded and
// retried by the reconcile sweep.

import { logger } from './logger.js';
import * as db from './db.js';
import { detectLinks, graphemeLength } from './richtext.js';
import { MEMORY_COLLECTION, LESSON_COLLECTION } from './atproto.js';

export { MEMORY_COLLECTION, LESSON_COLLECTION };
const NOTE_MAX_GRAPHEMES = 300;

// Record keys allow letters, digits and . - _ : ~ (atproto record-key syntax).
// Every did:plc fits, so the record key is simply the DID.
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

// eve's fileMemory document: a versioned header, then "index: text" lines.
const DOC_HEADER = /^<!-- eve-memory-file-v1 lastAllocatedIndex=(-1|0|[1-9]\d*) -->\n/;

/** The notes in an eve fileMemory document, in order, or null if it is not one. */
export function notesFrom(content) {
  const text = String(content ?? '');
  const header = DOC_HEADER.exec(text);
  if (!header) return null;
  const body = text.slice(header[0].length);
  if (!body) return [];
  const notes = [];
  for (const line of body.replace(/\n$/, '').split('\n')) {
    const entry = /^(\d+): (.+)$/.exec(line);
    if (!entry) return null;
    notes.push(entry[2]);
  }
  return notes;
}

/** Whether a note may be published: only if it would pass as a reply. */
export function publishable(note) {
  return detectLinks(note).length === 0 && graphemeLength(note) <= NOTE_MAX_GRAPHEMES;
}

/**
 * Delete a record, treating one that is already gone as deleted. The
 * potato's PDS answers 200 for a missing record (checked 2026-09-24); the
 * catch is for one that does not.
 */
async function deleteQuietly(api, collection, rkey) {
  try {
    await api.deleteRecord(collection, rkey);
  } catch (err) {
    if (!/not ?found|could not (find|locate)/i.test(String(err.message))) throw err;
  }
}

/**
 * Keep a version of someone's notes, as the agent just saved it. Returns
 * whether it still needs publishing, so the caller can answer the agent first
 * and publish after.
 */
export function storeMemory(did, content) {
  const notes = notesFrom(content);
  if (notes === null) return { ok: false, detail: 'not an eve memory document' };

  // Someone who opted out keeps nothing here, and their record is taken down.
  if (db.isDenied(did)) {
    db.deleteMemoryDoc(did);
    return { ok: true, needsPublish: true };
  }

  const existing = db.getMemoryDoc(did);
  if (existing && existing.content === content && existing.published_at) {
    return { ok: true, needsPublish: false };
  }
  const shown = notes.filter(publishable);
  db.saveMemoryDoc(did, content, shown, notes.length - shown.length, notedAt(notes, existing));
  return { ok: true, needsPublish: true };
}

/**
 * When each note was saved, by its text: the time it was first seen here,
 * which is when the agent saved it, give or take a hand-off. A note this
 * droplet kept from before dates were recorded (2026-10-21) gets the time
 * its version was stored, the closest it knows. A rewritten note is a new
 * note, with a new date.
 */
function notedAt(notes, existing) {
  const known = existing?.noted_at ? JSON.parse(existing.noted_at) : {};
  const before = existing && !existing.noted_at ? new Set(notesFrom(existing.content) ?? []) : new Set();
  const now = db.nowIso();
  return Object.fromEntries(notes.map((note) =>
    [note, known[note] ?? (before.has(note) ? existing.updated_at : now)]));
}

// One publish at a time per person. Each reads the latest stored version when
// it starts, so the last one to run always matches what is stored. Without
// this, a publish waiting on the network could land after a newer version's,
// most visibly putting notes back just after someone asked to be forgotten
// (the settings page on atpota.to hands over their emptied notes), and then
// mark that newer version settled so the sweep would never fix it.
const publishing = new Map();

/**
 * Bring the repo into step with what is stored for one person. `published_at`
 * records that the repo is settled for this version, with `publish_note`
 * saying why when nothing was published; only an error leaves it unsettled
 * for the sweep to retry.
 */
export function publishMemory(did, deps) {
  return oneAtATime(did, () => publishLatest(did, deps));
}

function oneAtATime(did, work) {
  const run = (publishing.get(did) ?? Promise.resolve()).then(work);
  publishing.set(did, run);
  run.finally(() => {
    if (publishing.get(did) === run) publishing.delete(did);
  }).catch(() => {});
  return run;
}

async function publishLatest(did, { api, didResolves }) {
  try {
    if (db.isDenied(did)) {
      if (RKEY.test(did)) await deleteQuietly(api, MEMORY_COLLECTION, did);
      return false;
    }
    const doc = db.getMemoryDoc(did);
    if (!doc) return false;
    if (!RKEY.test(did)) {
      db.markMemoryPublished(did, 'not published: this DID cannot be a record key');
      return false;
    }
    // Probe and test DIDs never reach the public repo.
    if (!(await didResolves(did))) {
      db.markMemoryPublished(did, 'not published: the DID does not resolve');
      return false;
    }
    const notes = JSON.parse(doc.notes);
    if (notes.length === 0) {
      await deleteQuietly(api, MEMORY_COLLECTION, did);
      db.markMemoryPublished(did, doc.held_back ? 'every note held back, so no record' : 'no notes, so no record');
      return false;
    }
    // notedAt[i] is when notes[i] was saved. A separate list, so readers of
    // notes as plain strings (the website's garden) keep working.
    const dates = doc.noted_at ? JSON.parse(doc.noted_at) : {};
    await api.putRecord(MEMORY_COLLECTION, did, {
      $type: MEMORY_COLLECTION,
      subject: did,
      notes,
      notedAt: notes.map((note) => dates[note] ?? doc.updated_at),
      updatedAt: doc.updated_at,
    });
    db.markMemoryPublished(did, doc.held_back ? `${doc.held_back} held back by the publish rules` : null);
    return true;
  } catch (err) {
    db.markMemoryUnpublished(did, String(err.message).slice(0, 200));
    logger.warn('memory not published; the reconcile sweep will retry', { did, err: err.message });
    return false;
  }
}

/** Forget someone completely: the droplet's copy and the public record. */
export async function forgetMemory(did, { api }) {
  db.deleteMemoryDoc(did);
  if (!RKEY.test(did)) return;
  // Behind any publish already under way, so it cannot land after the delete.
  return oneAtATime(did, () => deleteForgotten(did, api));
}

async function deleteForgotten(did, api) {
  try {
    await deleteQuietly(api, MEMORY_COLLECTION, did);
    logger.warn('forget-me: public memory record deleted', { did });
  } catch (err) {
    logger.error('forget-me: could not delete the public memory record', { did, err: err.message });
  }
}

/** Publish one lesson as its own record, and remember where it went. */
export async function publishLesson(id, { api }) {
  const lesson = db.getLesson(id);
  if (!lesson || lesson.removed_at || lesson.rkey) return;
  try {
    const res = await api.createRecord(LESSON_COLLECTION, {
      $type: LESSON_COLLECTION,
      text: lesson.text,
      createdAt: lesson.added_at,
      ...(lesson.source_uri ? { source: lesson.source_uri } : {}),
    });
    db.setLessonRkey(id, String(res.uri).split('/').pop());
  } catch (err) {
    logger.warn('lesson not published; the reconcile sweep will retry', { id, err: err.message });
  }
}

/** Take a retired lesson's record down. */
export async function retireLesson(id, { api }) {
  const lesson = db.getLesson(id);
  if (!lesson?.rkey) return;
  try {
    await deleteQuietly(api, LESSON_COLLECTION, lesson.rkey);
    db.setLessonRkey(id, null);
  } catch (err) {
    logger.warn('retired lesson still in the repo; the reconcile sweep will retry', { id, err: err.message });
  }
}

/** The reconcile sweep's share: retry whatever the repo is out of step on. */
export async function reconcilePublished({ api, didResolves }) {
  for (const doc of db.unpublishedMemoryDocs()) await publishMemory(doc.did, { api, didResolves });
  const { unpublished, lingering } = db.lessonsOutOfStep();
  for (const lesson of unpublished) await publishLesson(lesson.id, { api });
  for (const lesson of lingering) await retireLesson(lesson.id, { api });
}
