import { db, nowIso } from './db.js';
import { easternLabel } from './nap-time.js';

// One durable state row. Expiration is evaluated on read, not by a process-local timer.
db.exec(`
  CREATE TABLE IF NOT EXISTS nap_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    until_at TEXT,
    active INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nap_commands (
    source TEXT PRIMARY KEY,
    outcome TEXT NOT NULL,
    processed_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO nap_state (id, active, updated_at) VALUES (1, 0, '');
`);
try { db.exec('ALTER TABLE queue ADD COLUMN nap_missing_checks INTEGER NOT NULL DEFAULT 0'); }
catch { /* already added */ }
for (const [column, type] of [['started_at', 'TEXT'], ['scan_cursor', 'TEXT'], ['scan_complete', 'INTEGER NOT NULL DEFAULT 1']]) {
  try { db.exec(`ALTER TABLE nap_state ADD COLUMN ${column} ${type}`); }
  catch { /* already added */ }
}

export function napStatus(now = new Date()) {
  const row = db.prepare('SELECT active, until_at FROM nap_state WHERE id = 1').get();
  const active = !!row.active && (!row.until_at || Date.parse(row.until_at) > now.getTime());
  return { active, until: active ? row.until_at : null };
}

export function isNapping() { return napStatus().active; }

export function napMessage(status = napStatus()) {
  return status.active
    ? status.until ? `i'm having a little lie down until ${easternLabel(new Date(status.until))}. (◕‿◕)ᶻᶻ` : "i'm having a little lie down until you wake me. (◕‿◕)ᶻᶻ"
    : "i'm awake and listening again! (◕‿◕)ノ";
}

// Called only after authenticating the signed public DID or private DM sender.
// The source key prevents a redelivered command from extending a duration.
export function applyNapCommand(source, command) {
  if (!source || !command || !['nap', 'wake', 'status', 'invalid'].includes(command.kind)) {
    throw new Error('invalid nap command');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT outcome FROM nap_commands WHERE source = ?').get(source);
    if (previous) {
      db.exec('COMMIT');
      return { duplicate: true, message: previous.outcome };
    }
    let message;
    if (command.kind === 'invalid') message = command.reason;
    else if (command.kind === 'status') message = napStatus().active ? napMessage() : "i'm awake right now! (◕‿◕)ノ";
    else {
      const wasNapping = napStatus().active;
      const scanPending = db.prepare('SELECT scan_complete FROM nap_state WHERE id = 1').get().scan_complete === 0;
      const start = command.kind === 'nap' && !wasNapping && !scanPending ? nowIso() : null;
      db.prepare(`UPDATE nap_state SET active = ?, until_at = ?, updated_at = ?,
        started_at = CASE WHEN ? IS NOT NULL THEN ? ELSE started_at END,
        scan_cursor = CASE WHEN ? = 1 THEN NULL ELSE scan_cursor END,
        scan_complete = CASE WHEN ? = 1 THEN 0 ELSE scan_complete END
        WHERE id = 1`)
        .run(command.kind === 'nap' ? 1 : 0, command.kind === 'nap' ? command.until : null,
          nowIso(), start, start, command.kind === 'nap' ? 1 : 0, command.kind === 'nap' ? 1 : 0);
      if (command.kind === 'nap') {
        db.prepare(`UPDATE queue SET status = 'paused', gate = 'nap', gate_detail = 'operator nap', settled_at = ?
          WHERE status IN ('matched', 'sent_to_agent', 'drafted', 'replaying')`).run(nowIso());
      }
      message = napMessage();
    }
    db.prepare('INSERT INTO nap_commands(source, outcome, processed_at) VALUES (?, ?, ?)')
      .run(source, message, nowIso());
    db.exec('COMMIT');
    return { duplicate: false, message };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Claim in oldest-first order, and reclaim a row left mid-replay by a crash.
// sent_at doubles as a retry/lease deadline only while the row is paused or replaying.
export function claimNapReplays(limit = 2, now = new Date()) {
  const iso = now.toISOString();
  const leaseExpired = new Date(now.getTime() - 20 * 60000).toISOString();
  const rows = db.prepare(`SELECT * FROM queue WHERE
    (status = 'paused' AND gate = 'nap' AND (sent_at IS NULL OR sent_at <= ?)) OR
    (status = 'replaying' AND gate = 'nap_replay' AND sent_at <= ?)
    ORDER BY id LIMIT ?`).all(iso, leaseExpired, limit);
  for (const row of rows) {
    db.prepare(`UPDATE queue SET status = 'replaying', gate = 'nap_replay',
      draft_key = NULL, draft_text = NULL, draft_links = NULL, draft_retries = 0,
      sent_at = ?, settled_at = NULL WHERE id = ?`).run(iso, row.id);
  }
  return rows;
}

export function pendingNapScan() {
  if (isNapping()) return null;
  const row = db.prepare('SELECT started_at, scan_cursor, scan_complete FROM nap_state WHERE id = 1').get();
  return row.started_at && !row.scan_complete ? { since: row.started_at, cursor: row.scan_cursor } : null;
}

export function advanceNapScan(cursor) {
  if (isNapping()) return;
  db.prepare('UPDATE nap_state SET scan_cursor = ? WHERE id = 1 AND scan_complete = 0')
    .run(cursor);
}

export function finishNapScan() {
  if (isNapping()) return;
  db.prepare('UPDATE nap_state SET scan_cursor = NULL, scan_complete = 1 WHERE id = 1')
    .run();
}

export function missingNapPost(id) {
  const row = db.prepare('SELECT nap_missing_checks FROM queue WHERE id = ?').get(id);
  if (!row || row.nap_missing_checks >= 2) {
    db.prepare(`UPDATE queue SET status = 'gated_out', gate = 'unavailable_on_wake',
      gate_detail = 'post missing after three checks', settled_at = ? WHERE id = ? AND status = 'replaying'`)
      .run(nowIso(), id);
    return;
  }
  db.prepare(`UPDATE queue SET status = 'paused', gate = 'nap',
    nap_missing_checks = nap_missing_checks + 1, sent_at = ?, settled_at = NULL
    WHERE id = ? AND status = 'replaying'`)
    .run(new Date(Date.now() + 5 * 60000).toISOString(), id);
}

export function deferNapRow(id, until) {
  db.prepare(`UPDATE queue SET status = 'paused', gate = 'nap', sent_at = ?,
    gate_detail = 'waiting for rate limit', settled_at = NULL WHERE id = ? AND status = 'replaying'`)
    .run(until.toISOString(), id);
}

export function pauseRow(id) {
  db.prepare(`UPDATE queue SET status = 'paused', gate = 'nap', gate_detail = 'operator nap', settled_at = ?
    WHERE id = ? AND status NOT IN ('posted', 'paused')`).run(nowIso(), id);
}
