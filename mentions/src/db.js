// db.js
// SQLite via node:sqlite (Node 22 built-in — no native module to compile, which
// matters on a 1 GB droplet). Synchronous by design: every write here is a
// single small row, the volume is a few hundred rows a day, and synchronous
// calls mean the cursor watermark and the row it describes cannot interleave.
//
// WAL so a reader (`npm run review`) never blocks the consumer.

import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { logger } from './logger.js';

export const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  -- Last processed Jetstream position. One row, id = the host it belongs to,
  -- because two hosts do not share a sequence space.
  CREATE TABLE IF NOT EXISTS cursor (
    host       TEXT PRIMARY KEY,
    seq        INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Dedup. Jetstream is at-least-once and a reconnect redelivers; the
  -- notification sweep re-offers the same posts on every poll.
  CREATE TABLE IF NOT EXISTS seen (
    did        TEXT NOT NULL,
    rkey       TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    source     TEXT NOT NULL,
    PRIMARY KEY (did, rkey)
  );

  -- Matched posts and their progress through the pipeline.
  CREATE TABLE IF NOT EXISTS queue (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    did            TEXT NOT NULL,
    rkey           TEXT NOT NULL,
    uri            TEXT NOT NULL,
    cid            TEXT NOT NULL,
    author_did     TEXT NOT NULL,
    author_handle  TEXT,
    text           TEXT NOT NULL,
    reason         TEXT NOT NULL,          -- mention | reply
    langs          TEXT,                   -- JSON array as posted
    record_created TEXT,                   -- record.createdAt, verbatim
    thread_root    TEXT NOT NULL,          -- session address for the agent
    root_uri       TEXT NOT NULL,          -- strong ref for reply.root
    root_cid       TEXT NOT NULL,
    parent_uri     TEXT NOT NULL,          -- strong ref for reply.parent
    parent_cid     TEXT NOT NULL,
    upstream_uri   TEXT,                   -- what the matched post replies to
    thread_context TEXT,                   -- JSON: the thread as the agent was shown it
    status         TEXT NOT NULL,          -- matched|gated_out|sent_to_agent|drafted|posted|rejected|declined|failed
    gate           TEXT,                   -- which gate stopped it, if any
    gate_detail    TEXT,
    draft_key      TEXT UNIQUE,            -- the agent's idempotency key
    draft_text     TEXT,
    draft_links    TEXT,                   -- JSON array of the turn's tool-result URLs
    source         TEXT NOT NULL,          -- jetstream | notification
    attempts       INTEGER NOT NULL DEFAULT 0,
    matched_at     TEXT NOT NULL,
    sent_at        TEXT,
    drafted_at     TEXT,
    settled_at     TEXT,
    UNIQUE (did, rkey)
  );
  CREATE INDEX IF NOT EXISTS queue_status_idx ON queue (status, matched_at);
  CREATE INDEX IF NOT EXISTS queue_author_idx ON queue (author_did, matched_at);
  CREATE INDEX IF NOT EXISTS queue_thread_idx ON queue (thread_root);

  -- What actually got posted.
  CREATE TABLE IF NOT EXISTS replies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id    INTEGER NOT NULL REFERENCES queue(id),
    author_did  TEXT NOT NULL,             -- who we replied TO
    in_reply_to TEXT NOT NULL,
    reply_uri   TEXT NOT NULL,
    reply_cid   TEXT NOT NULL,
    text        TEXT NOT NULL,
    post_count  INTEGER NOT NULL DEFAULT 1,
    posted_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS replies_author_idx ON replies (author_did, posted_at);
  CREATE INDEX IF NOT EXISTS replies_posted_idx ON replies (posted_at);

  -- Every draft a gate refused, with the gate that refused it. This is the eval
  -- corpus for the agent's prompt, so it keeps the whole draft, not a summary.
  CREATE TABLE IF NOT EXISTS rejections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id    INTEGER REFERENCES queue(id),
    direction   TEXT NOT NULL,             -- inbound | outbound
    gate        TEXT NOT NULL,
    detail      TEXT,
    subject     TEXT,                      -- the post text (inbound) or draft (outbound)
    rejected_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rejections_gate_idx ON rejections (gate, rejected_at);

  -- Opt-outs and manual blocks. Permanent; no appeal flow in v1.
  CREATE TABLE IF NOT EXISTS denylist (
    did        TEXT PRIMARY KEY,
    reason     TEXT NOT NULL,              -- opt_out | manual
    detail     TEXT,
    added_at   TEXT NOT NULL
  );

  -- When we last told an account we were out of answers, so the notice goes
  -- once per cooldown window rather than on every question after the limit.
  CREATE TABLE IF NOT EXISTS cooldowns (
    did         TEXT PRIMARY KEY,
    notified_at TEXT NOT NULL,
    gate        TEXT NOT NULL
  );

  -- Standing corrections from the people who run the potato, sent to the
  -- agent with every turn. Written only from a post whose signed author is on
  -- ADMIN_DIDS, or from the command line (src/tools/lessons.js).
  CREATE TABLE IF NOT EXISTS lessons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    author_did  TEXT,                      -- null when added from the command line
    source_uri  TEXT,                      -- the post that taught it, if any
    added_at    TEXT NOT NULL,
    removed_at  TEXT
  );

  -- The potato's notes about each person, as the agent last saved them, and
  -- whether that version is in the public repo yet. The agent keeps the
  -- primary copy in Vercel Blob; this is what gets published, and what
  -- npm run memory reads.
  CREATE TABLE IF NOT EXISTS memory_docs (
    did           TEXT PRIMARY KEY,
    content       TEXT NOT NULL,           -- the document exactly as the agent stored it
    notes         TEXT NOT NULL,           -- JSON: the notes that may be published
    held_back     INTEGER NOT NULL DEFAULT 0, -- notes kept private by the publish rules
    updated_at    TEXT NOT NULL,
    published_at  TEXT,                    -- null until the repo has this version
    publish_note  TEXT                     -- why it is not published, when it is not
  );

  -- Scan approvals are tied to one agent dispatch generation. A fixed post
  -- record key makes retries of the escalation safe after uncertain PDS writes.
  CREATE TABLE IF NOT EXISTS scan_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    post_uri TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    queue_id INTEGER NOT NULL REFERENCES queue(id),
    escalation_uri TEXT NOT NULL UNIQUE,
    escalation_cid TEXT,
    post_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    bot_expires_at INTEGER,
    approval_token TEXT,
    failure_reason TEXT,
    status TEXT NOT NULL,
    admin_reply_uri TEXT UNIQUE,
    admin_did TEXT,
    option_id TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS scan_approvals_status_idx ON scan_approvals(status, expires_at);

  -- One scan per dispatched post and attempt, regardless of how many workers
  -- share the session. A subsequent dispatch generation gets a fresh claim.
  CREATE TABLE IF NOT EXISTS scan_budget_claims (
    post_uri TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    queue_id INTEGER NOT NULL REFERENCES queue(id),
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (post_uri, attempt)
  );

  -- Raw list_records reservations are separate from the one-shot scan claim.
  -- The primary key serializes all workers for one dispatch generation.
  CREATE TABLE IF NOT EXISTS list_records_budget_claims (
    post_uri TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    queue_id INTEGER NOT NULL REFERENCES queue(id),
    session_id TEXT NOT NULL,
    pages_claimed INTEGER NOT NULL DEFAULT 0 CHECK (pages_claimed BETWEEN 0 AND 10),
    records_claimed INTEGER NOT NULL DEFAULT 0 CHECK (records_claimed BETWEEN 0 AND 1000),
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (post_uri, attempt)
  );

  -- Non-Bluesky sessions (website and operator DM) have no queued post.
  -- This is a session-lifetime cap, NOT a per-turn cap: never reset it on a
  -- new turn or server restart. It is independent of post-bound reservations.
  CREATE TABLE IF NOT EXISTS list_records_session_budget_claims (
    session_id TEXT PRIMARY KEY,
    pages_claimed INTEGER NOT NULL DEFAULT 0 CHECK (pages_claimed BETWEEN 0 AND 10),
    records_claimed INTEGER NOT NULL DEFAULT 0 CHECK (records_claimed BETWEEN 0 AND 1000),
    claimed_at TEXT NOT NULL
  );

  -- Search pages are reserved before contacting the PDS. A retry of the
  -- same dispatch cannot recover spent pages; a new attempt gets three more.
  CREATE TABLE IF NOT EXISTS bluesky_search_budget_claims (
    post_uri TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    queue_id INTEGER NOT NULL REFERENCES queue(id),
    session_id TEXT NOT NULL,
    pages_claimed INTEGER NOT NULL CHECK (pages_claimed BETWEEN 1 AND 3),
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (post_uri, attempt)
  );
  CREATE TABLE IF NOT EXISTS bluesky_search_session_budget_claims (
    session_id TEXT PRIMARY KEY,
    pages_claimed INTEGER NOT NULL CHECK (pages_claimed BETWEEN 1 AND 3),
    claimed_at TEXT NOT NULL
  );

  -- Bot-loop backoff: a per-account quiet period with an expiry.
  CREATE TABLE IF NOT EXISTS backoff (
    did        TEXT PRIMARY KEY,
    until      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    set_at     TEXT NOT NULL
  );
`);

// SQLite cannot ALTER a CHECK constraint. Rebuild only legacy budget tables,
// copying every reservation so an upgrade never grants previously spent pages.
const budgetTables = [
  ['list_records_budget_claims', `
    CREATE TABLE list_records_budget_claims_upgrade (
      post_uri TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      queue_id INTEGER NOT NULL REFERENCES queue(id),
      session_id TEXT NOT NULL,
      pages_claimed INTEGER NOT NULL DEFAULT 0 CHECK (pages_claimed BETWEEN 0 AND 10),
      records_claimed INTEGER NOT NULL DEFAULT 0 CHECK (records_claimed BETWEEN 0 AND 1000),
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (post_uri, attempt)
    )`, 'post_uri, attempt, queue_id, session_id, pages_claimed, records_claimed, claimed_at'],
  ['list_records_session_budget_claims', `
    CREATE TABLE list_records_session_budget_claims_upgrade (
      session_id TEXT PRIMARY KEY,
      pages_claimed INTEGER NOT NULL DEFAULT 0 CHECK (pages_claimed BETWEEN 0 AND 10),
      records_claimed INTEGER NOT NULL DEFAULT 0 CHECK (records_claimed BETWEEN 0 AND 1000),
      claimed_at TEXT NOT NULL
    )`, 'session_id, pages_claimed, records_claimed, claimed_at'],
];
function isLegacyBudgetTable(name) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
  return /BETWEEN\s+0\s+AND\s+3\b/i.test(sql) || /BETWEEN\s+0\s+AND\s+300\b/i.test(sql);
}
const legacyBudgetTables = budgetTables.filter(([name]) => isLegacyBudgetTable(name));
if (legacyBudgetTables.length) {
  // PRAGMA foreign_keys must be set outside the transaction. Check integrity
  // before commit and restore enforcement even if the rebuild fails.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, create, columns] of legacyBudgetTables) {
        // Another process may have migrated this table while we waited for the lock.
        if (!isLegacyBudgetTable(name)) continue;
        const upgrade = `${name}_upgrade`;
        db.exec(create);
        db.exec(`INSERT INTO ${upgrade} (${columns}) SELECT ${columns} FROM ${name}`);
        db.exec(`DROP TABLE ${name}`);
        db.exec(`ALTER TABLE ${upgrade} RENAME TO ${name}`);
      }
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Budget migration violated foreign keys');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Existing installations have scan_approvals but not the bot's signed fields.
// Old approvals without a token must not be forwarded as signed responses.
for (const [column, type] of [['bot_expires_at', 'INTEGER'], ['approval_token', 'TEXT'], ['failure_reason', 'TEXT']]) {
  try { db.exec(`ALTER TABLE scan_approvals ADD COLUMN ${column} ${type}`); }
  catch { /* column already present */ }
}

// Added after the replies table shipped; harmless when it already exists.
try { db.exec('ALTER TABLE replies ADD COLUMN post_count INTEGER NOT NULL DEFAULT 1'); }
catch { /* column already present */ }
// Without this the links a turn's tools returned are lost the moment postReply
// finishes, so anything re-evaluating a stored draft -- the bench, a review, a
// retry -- silently falls back to the host allowlist and can reject a link that
// production would have accepted.
try { db.exec('ALTER TABLE queue ADD COLUMN draft_links TEXT'); }
catch { /* column already present */ }
try { db.exec('ALTER TABLE queue ADD COLUMN draft_retries INTEGER NOT NULL DEFAULT 0'); }
catch { /* column already present */ }
// Where reading the thread above a post starts, and what was read, kept so a
// retry shows the agent the same thread and a review can see what it saw.
try { db.exec('ALTER TABLE queue ADD COLUMN upstream_uri TEXT'); }
catch { /* column already present */ }
try { db.exec('ALTER TABLE queue ADD COLUMN thread_context TEXT'); }
catch { /* column already present */ }
// The lesson's record key in the potato's repo, once it is published there.
try { db.exec('ALTER TABLE lessons ADD COLUMN rkey TEXT'); }
catch { /* column already present */ }

export const nowIso = () => new Date().toISOString();

// --- cursor ---------------------------------------------------------------
const qSaveCursor = db.prepare(
  `INSERT INTO cursor (host, seq, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(host) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`
);
const qLoadCursor = db.prepare(`SELECT seq FROM cursor WHERE host = ?`);

export function saveCursor(host, seq) {
  qSaveCursor.run(host, Number(seq), nowIso());
}
export function loadCursor(host) {
  const row = qLoadCursor.get(host);
  return row ? Number(row.seq) : null;
}
export function clearCursor(host) {
  db.prepare(`DELETE FROM cursor WHERE host = ?`).run(host);
}

// --- seen -----------------------------------------------------------------
const qMarkSeen = db.prepare(
  `INSERT INTO seen (did, rkey, first_seen, source) VALUES (?, ?, ?, ?)
   ON CONFLICT(did, rkey) DO NOTHING`
);
const qIsSeen = db.prepare(`SELECT 1 AS hit FROM seen WHERE did = ? AND rkey = ?`);

/** True the first time this (did, rkey) is offered, false every time after. */
export function claimUnseen(did, rkey, source) {
  const res = qMarkSeen.run(did, rkey, nowIso(), source);
  return res.changes > 0;
}
export function isSeen(did, rkey) {
  return !!qIsSeen.get(did, rkey);
}

// --- queue ----------------------------------------------------------------
const qInsertQueue = db.prepare(`
  INSERT INTO queue (
    did, rkey, uri, cid, author_did, author_handle, text, reason, langs,
    record_created, thread_root, root_uri, root_cid, parent_uri, parent_cid,
    upstream_uri, status, source, matched_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(did, rkey) DO NOTHING
`);

export function enqueue(m, status = 'matched') {
  const res = qInsertQueue.run(
    m.did, m.rkey, m.uri, m.cid, m.authorDid, m.authorHandle ?? null, m.text, m.reason,
    m.langs ? JSON.stringify(m.langs) : null, m.recordCreated ?? null,
    m.threadRoot, m.rootUri, m.rootCid, m.parentUri, m.parentCid,
    m.upstreamUri ?? null, status, m.source, nowIso()
  );
  if (res.changes === 0) return null;
  return Number(res.lastInsertRowid);
}

export function setStatus(id, status, extra = {}) {
  const sets = ['status = ?'];
  const vals = [status];
  for (const [col, val] of Object.entries(extra)) {
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  vals.push(id);
  db.prepare(`UPDATE queue SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function getQueueRow(id) {
  return db.prepare(`SELECT * FROM queue WHERE id = ?`).get(id);
}
export function findByDraftKey(key) {
  return db.prepare(`SELECT * FROM queue WHERE draft_key = ?`).get(key);
}
/** Find only the exact pending post and dispatch generation. A thread root may
 * contain several people; a late draft for one may never answer another. */
export function findPendingByPostUri(postUri, threadRoot, attempt) {
  return db.prepare(`SELECT * FROM queue WHERE uri = ? AND thread_root = ?
    AND attempts = ? AND status = 'sent_to_agent' LIMIT 1`
  ).get(postUri, threadRoot, attempt);
}

/**
 * Put a refused turn back in flight for one more attempt.
 *
 * The draft key is UNIQUE and already claimed by the refused turn, so it has to
 * be released or the retry's callback is collapsed as a duplicate and the new
 * answer is silently dropped.
 */
export function rearmForRetry(id) {
  db.prepare(`
    UPDATE queue
       SET draft_key = NULL, draft_text = NULL, draft_links = NULL,
           gate = NULL, gate_detail = NULL, settled_at = NULL,
           status = 'sent_to_agent', sent_at = ?, draft_retries = draft_retries + 1
     WHERE id = ?
  `).run(nowIso(), id);
}

/** Claim the draft key for a queue row. False if some other row already holds
 *  it — which is how a duplicate callback delivery is collapsed to one post. */
export function claimDraftKey(id, key) {
  try {
    const res = db.prepare(
      `UPDATE queue SET draft_key = ? WHERE id = ? AND draft_key IS NULL`
    ).run(key, id);
    return res.changes > 0;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return false;
    throw err;
  }
}

// --- rate limiting --------------------------------------------------------
export function repliesToAuthorSince(authorDid, sinceIso) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM replies WHERE author_did = ? AND posted_at >= ?`
  ).get(authorDid, sinceIso).n;
}
export function repliesSince(sinceIso) {
  return db.prepare(`SELECT COUNT(*) AS n FROM replies WHERE posted_at >= ?`).get(sinceIso).n;
}
export function ourPostsInThread(threadRoot) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM replies r JOIN queue q ON q.id = r.queue_id
     WHERE q.thread_root = ?`
  ).get(threadRoot).n;
}
/** The whole text of our most recent answer in a thread, cooldown notes included. */
export function lastReplyTextInThread(threadRoot) {
  const row = db.prepare(
    `SELECT r.text FROM replies r JOIN queue q ON q.id = r.queue_id
     WHERE q.thread_root = ? ORDER BY r.posted_at DESC LIMIT 1`
  ).get(threadRoot);
  return row ? row.text : null;
}
export function lastReplyTextTo(authorDid) {
  const row = db.prepare(
    `SELECT text FROM replies WHERE author_did = ? ORDER BY posted_at DESC LIMIT 1`
  ).get(authorDid);
  return row ? row.text : null;
}

/**
 * One row per ANSWER, not per post. A three-post thread is still one reply as
 * far as the rate limits and the thread-depth cap are concerned: those gates
 * exist to stop the potato answering too often, not to stop it finishing a
 * sentence. reply_uri is the first post, which is the one to link to.
 */
export function recordReply(r) {
  db.prepare(`
    INSERT INTO replies (queue_id, author_did, in_reply_to, reply_uri, reply_cid, text, post_count, posted_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(r.queueId, r.authorDid, r.inReplyTo, r.replyUri, r.replyCid, r.text, r.postCount ?? 1, nowIso());
}

// --- denylist / backoff ---------------------------------------------------
export function isDenied(did) {
  return !!db.prepare(`SELECT 1 AS hit FROM denylist WHERE did = ?`).get(did);
}
export function deny(did, reason, detail) {
  db.prepare(
    `INSERT INTO denylist (did, reason, detail, added_at) VALUES (?,?,?,?)
     ON CONFLICT(did) DO NOTHING`
  ).run(did, reason, detail ?? null, nowIso());
  logger.warn('denylist add', { did, reason, detail });
}
export function backoffUntil(did) {
  const row = db.prepare(`SELECT until FROM backoff WHERE did = ?`).get(did);
  if (!row) return null;
  return row.until > nowIso() ? row.until : null;
}
export function setBackoff(did, untilIso, reason) {
  db.prepare(
    `INSERT INTO backoff (did, until, reason, set_at) VALUES (?,?,?,?)
     ON CONFLICT(did) DO UPDATE SET until = excluded.until, reason = excluded.reason, set_at = excluded.set_at`
  ).run(did, untilIso, reason, nowIso());
}

// --- lessons --------------------------------------------------------------
/** How many go to the agent at once. Past this, fold the old ones into the skill. */
export const MAX_LESSONS = 30;

export function addLesson(text, authorDid = null, sourceUri = null) {
  const res = db.prepare(
    `INSERT INTO lessons (text, author_did, source_uri, added_at) VALUES (?,?,?,?)`
  ).run(String(text).slice(0, 500), authorDid, sourceUri, nowIso());
  return Number(res.lastInsertRowid);
}
/** Active lessons, oldest first, the newest MAX_LESSONS of them. */
export function activeLessons() {
  return db.prepare(
    `SELECT id, text, author_did, source_uri, added_at, rkey FROM lessons
     WHERE removed_at IS NULL ORDER BY id DESC LIMIT ?`
  ).all(MAX_LESSONS).reverse();
}
export function removeLesson(id) {
  return db.prepare(`UPDATE lessons SET removed_at = ? WHERE id = ? AND removed_at IS NULL`)
    .run(nowIso(), id).changes > 0;
}
export function getLesson(id) {
  return db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(id);
}
export function setLessonRkey(id, rkey) {
  db.prepare(`UPDATE lessons SET rkey = ? WHERE id = ?`).run(rkey, id);
}
/** Active lessons not yet in the repo, and retired ones still in it. */
export function lessonsOutOfStep() {
  return {
    unpublished: db.prepare(`SELECT * FROM lessons WHERE removed_at IS NULL AND rkey IS NULL`).all(),
    lingering: db.prepare(`SELECT * FROM lessons WHERE removed_at IS NOT NULL AND rkey IS NOT NULL`).all(),
  };
}

// --- memory documents ------------------------------------------------------
export function getMemoryDoc(did) {
  return db.prepare(`SELECT * FROM memory_docs WHERE did = ?`).get(did);
}
export function saveMemoryDoc(did, content, notes, heldBack) {
  db.prepare(`
    INSERT INTO memory_docs (did, content, notes, held_back, updated_at, published_at, publish_note)
    VALUES (?,?,?,?,?,NULL,NULL)
    ON CONFLICT(did) DO UPDATE SET content = excluded.content, notes = excluded.notes,
      held_back = excluded.held_back, updated_at = excluded.updated_at,
      published_at = NULL, publish_note = NULL
  `).run(did, content, JSON.stringify(notes), heldBack, nowIso());
}
export function markMemoryPublished(did, note = null) {
  db.prepare(`UPDATE memory_docs SET published_at = ?, publish_note = ? WHERE did = ?`).run(nowIso(), note, did);
}
export function markMemoryUnpublished(did, note) {
  db.prepare(`UPDATE memory_docs SET published_at = NULL, publish_note = ? WHERE did = ?`).run(note, did);
}
export function deleteMemoryDoc(did) {
  db.prepare(`DELETE FROM memory_docs WHERE did = ?`).run(did);
}
export function memoryDocs() {
  return db.prepare(`SELECT * FROM memory_docs ORDER BY updated_at DESC`).all();
}
/** Versions the repo does not have yet, for the reconcile sweep to retry. */
export function unpublishedMemoryDocs() {
  return db.prepare(`SELECT * FROM memory_docs WHERE published_at IS NULL`).all();
}

/** The lesson a given post taught, so a retry of its turn still says so. */
export function lessonFromPost(uri) {
  const row = db.prepare(
    `SELECT text FROM lessons WHERE source_uri = ? AND removed_at IS NULL ORDER BY id DESC LIMIT 1`
  ).get(uri);
  return row ? row.text : null;
}

// --- cooldown notices -----------------------------------------------------
/** True if this account has not been told we are out of answers recently. */
export function claimCooldownNotice(did, gate, withinMins) {
  const cutoff = new Date(Date.now() - withinMins * 60000).toISOString();
  const row = db.prepare(`SELECT notified_at FROM cooldowns WHERE did = ?`).get(did);
  if (row && row.notified_at >= cutoff) return false;
  db.prepare(
    `INSERT INTO cooldowns (did, notified_at, gate) VALUES (?,?,?)
     ON CONFLICT(did) DO UPDATE SET notified_at = excluded.notified_at, gate = excluded.gate`
  ).run(did, nowIso(), gate);
  return true;
}

// --- rejections -----------------------------------------------------------
export function recordRejection(queueId, direction, gate, detail, subject) {
  db.prepare(`
    INSERT INTO rejections (queue_id, direction, gate, detail, subject, rejected_at)
    VALUES (?,?,?,?,?,?)
  `).run(queueId ?? null, direction, gate, detail ?? null, subject ?? null, nowIso());
}

// --- scan budget ----------------------------------------------------------
/** The queue check and unique claim share one statement, so concurrent workers
 * cannot both see an unclaimed turn and begin a collection scan. */
export function claimScanBudget(sessionId, postUri, attempt) {
  return db.prepare(`INSERT INTO scan_budget_claims (post_uri, attempt, session_id, queue_id, claimed_at)
    SELECT uri, attempts, ?, id, ? FROM queue
    WHERE uri = ? AND attempts = ? AND status = 'sent_to_agent'
    ON CONFLICT(post_uri, attempt) DO NOTHING`)
    .run(sessionId, nowIso(), postUri, attempt).changes === 1;
}

// --- raw list_records budget ----------------------------------------------
/** Reserve one page and its requested record limit in a single SQLite write.
 * The queue check also runs on conflict, so a completed or retried turn cannot
 * spend a previously created budget. */
export function claimListRecordsBudget(sessionId, postUri, attempt, limit) {
  const row = db.prepare(`
    INSERT INTO list_records_budget_claims
      (post_uri, attempt, queue_id, session_id, pages_claimed, records_claimed, claimed_at)
    SELECT uri, attempts, id, ?, 1, ?, ? FROM queue
    WHERE uri = ? AND attempts = ? AND status = 'sent_to_agent'
    ON CONFLICT(post_uri, attempt) DO UPDATE SET
      pages_claimed = list_records_budget_claims.pages_claimed + 1,
      records_claimed = list_records_budget_claims.records_claimed + excluded.records_claimed,
      claimed_at = excluded.claimed_at,
      session_id = excluded.session_id
    WHERE list_records_budget_claims.pages_claimed < 10
      AND list_records_budget_claims.records_claimed + excluded.records_claimed <= 1000
      AND EXISTS (SELECT 1 FROM queue
        WHERE id = list_records_budget_claims.queue_id
          AND uri = excluded.post_uri AND attempts = excluded.attempt
          AND status = 'sent_to_agent')
    RETURNING pages_claimed, records_claimed
  `).get(sessionId, limit, nowIso(), postUri, attempt);
  return row ? { remainingPages: 10 - row.pages_claimed, remainingRecords: 1000 - row.records_claimed } : null;
}

/** Reserve against a non-Bluesky session's lifetime budget. The single
 * upsert serializes parallel workers and never resets the count per turn. */
export function claimListRecordsSessionBudget(sessionId, limit) {
  const row = db.prepare(`
    INSERT INTO list_records_session_budget_claims
      (session_id, pages_claimed, records_claimed, claimed_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      pages_claimed = list_records_session_budget_claims.pages_claimed + 1,
      records_claimed = list_records_session_budget_claims.records_claimed + excluded.records_claimed,
      claimed_at = excluded.claimed_at
    WHERE list_records_session_budget_claims.pages_claimed < 10
      AND list_records_session_budget_claims.records_claimed + excluded.records_claimed <= 1000
    RETURNING pages_claimed, records_claimed
  `).get(sessionId, limit, nowIso());
  return row ? { remainingPages: 10 - row.pages_claimed, remainingRecords: 1000 - row.records_claimed } : null;
}

// --- Bluesky search budget ------------------------------------------------
export function claimBlueskySearchBudget(sessionId, postUri, attempt) {
  return db.prepare(`
    INSERT INTO bluesky_search_budget_claims
      (post_uri, attempt, queue_id, session_id, pages_claimed, claimed_at)
    SELECT uri, attempts, id, ?, 1, ? FROM queue
    WHERE uri = ? AND attempts = ? AND status = 'sent_to_agent'
    ON CONFLICT(post_uri, attempt) DO UPDATE SET
      pages_claimed = bluesky_search_budget_claims.pages_claimed + 1,
      claimed_at = excluded.claimed_at,
      session_id = excluded.session_id
    WHERE bluesky_search_budget_claims.pages_claimed < 3
      AND EXISTS (SELECT 1 FROM queue
        WHERE id = bluesky_search_budget_claims.queue_id
          AND uri = excluded.post_uri AND attempts = excluded.attempt
          AND status = 'sent_to_agent')
    RETURNING pages_claimed
  `).get(sessionId, nowIso(), postUri, attempt)?.pages_claimed ?? null;
}

export function claimBlueskySearchSessionBudget(sessionId) {
  return db.prepare(`
    INSERT INTO bluesky_search_session_budget_claims (session_id, pages_claimed, claimed_at)
    VALUES (?, 1, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      pages_claimed = bluesky_search_session_budget_claims.pages_claimed + 1,
      claimed_at = excluded.claimed_at
    WHERE bluesky_search_session_budget_claims.pages_claimed < 3
    RETURNING pages_claimed
  `).get(sessionId, nowIso())?.pages_claimed ?? null;
}

// --- reconciliation -------------------------------------------------------
/** Rows dispatched to the agent that never came back with a draft. */
// Only the current dispatch generation is held. Expired or terminal approvals
// release the queue row to the usual retry/abandon handling.
const noLiveApproval = `NOT EXISTS (SELECT 1 FROM scan_approvals AS approval
  WHERE approval.queue_id = queue.id AND approval.attempt = queue.attempts
    AND approval.status IN ('posting', 'awaiting', 'responding') AND approval.expires_at > ?)`;

export function stuckRows(olderThanIso, maxAttempts, atIso = nowIso()) {
  return db.prepare(`
    SELECT * FROM queue
    WHERE status = 'sent_to_agent' AND sent_at IS NOT NULL AND sent_at < ?
      AND attempts < ? AND ${noLiveApproval}
    ORDER BY sent_at ASC LIMIT 20
  `).all(olderThanIso, maxAttempts, atIso);
}
export function abandonedRows(olderThanIso, maxAttempts, atIso = nowIso()) {
  return db.prepare(`
    SELECT * FROM queue
    WHERE status = 'sent_to_agent' AND sent_at IS NOT NULL AND sent_at < ?
      AND attempts >= ? AND ${noLiveApproval}
  `).all(olderThanIso, maxAttempts, atIso);
}

export function closeDb() {
  try { db.close(); } catch { /* already closed */ }
}
