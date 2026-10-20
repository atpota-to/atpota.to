// likes.js
// The droplet's half of the agent's appreciate_post tool.
//
// During a turn about a public post, Poe may propose liking that post:
// POST /like-proposal { postUri, attempt }. This only marks the queue row the
// turn belongs to. The like is written later, by the poster, and only after
// the reply to that post has been posted in full. A proposal for a different
// post, for an old attempt, or arriving after the turn has ended finds no row
// and is declined. The subject's cid comes from the matched post as stored at
// match time, never from the agent.
//
// Likes are public, so they honour the kill switch, a nap and STAGE, skip
// anyone denylisted, are capped per hour and per person per day (gates.json),
// and are sent at most once per post. A failed like is recorded and not
// retried: a missing like costs nothing, a duplicate one is noise.

import { config, gates, killSwitchEngaged } from './config.js';
import { db, nowIso, isDenied } from './db.js';
import { logger } from './logger.js';
import * as atproto from './atproto.js';
import { isNapping } from './nap.js';

for (const [column, type] of [['like_proposed_at', 'TEXT']]) {
  try { db.exec(`ALTER TABLE queue ADD COLUMN ${column} ${type}`); }
  catch { /* already added */ }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS likes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id    INTEGER NOT NULL REFERENCES queue(id),
    author_did  TEXT NOT NULL,          -- whose post was liked
    subject_uri TEXT NOT NULL UNIQUE,   -- one like per post, ever
    subject_cid TEXT NOT NULL,
    status      TEXT NOT NULL,          -- sending | liked | failed | skipped
    detail      TEXT,
    like_uri    TEXT,
    created_at  TEXT NOT NULL,
    settled_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS likes_author_idx ON likes (author_did, created_at);
  CREATE INDEX IF NOT EXISTS likes_created_idx ON likes (created_at);
`);

const POST_URI = /^at:\/\/did:[a-z0-9]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._:~-]{1,512}$/;

/** Record a proposal against the turn it belongs to. Returns whether it was. */
export function receiveLikeProposal(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.postUri !== 'string' || !POST_URI.test(body.postUri) ||
      !Number.isSafeInteger(body.attempt) || body.attempt < 1 ||
      Object.keys(body).some((k) => k !== 'postUri' && k !== 'attempt')) {
    return { status: 400, body: { error: 'BadRequest' } };
  }
  const accepted = db.prepare(`UPDATE queue SET like_proposed_at = COALESCE(like_proposed_at, ?)
    WHERE uri = ? AND attempts = ? AND status = 'sent_to_agent' AND author_did != ?`)
    .run(nowIso(), body.postUri, body.attempt, config.botDid).changes > 0;
  if (accepted) logger.info('like proposed', { postUri: body.postUri, attempt: body.attempt });
  return { status: 200, body: { accepted } };
}

/** Why a proposed like for this posted row must not be sent, or null. */
function likeBlocked(row) {
  if (config.stage < 4 || config.dryRun) return 'stage';
  if (killSwitchEngaged()) return 'kill_switch';
  if (isNapping()) return 'nap';
  if (row.author_did === config.botDid) return 'self';
  if (row.source === 'voice-sample') return 'synthetic';
  if (isDenied(row.author_did)) return 'denylist';
  const g = gates();
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const dayAgo = new Date(Date.now() - 86400e3).toISOString();
  const lastHour = db.prepare(`SELECT COUNT(*) AS n FROM likes WHERE status IN ('sending', 'liked') AND created_at > ?`)
    .get(hourAgo).n;
  if (lastHour >= g.likesPerHour) return 'likes_per_hour';
  const theirs = db.prepare(`SELECT COUNT(*) AS n FROM likes WHERE status IN ('sending', 'liked')
    AND author_did = ? AND created_at > ?`).get(row.author_did, dayAgo).n;
  if (theirs >= g.likesPerAuthorPerDay) return 'likes_per_author';
  return null;
}

/**
 * Called by the poster once a reply is fully posted. Sends the like Poe
 * proposed for that post, if it did and nothing blocks it. Never throws.
 */
export async function sendProposedLike(rowId, api = atproto) {
  try {
    const row = db.prepare('SELECT * FROM queue WHERE id = ?').get(rowId);
    if (!row?.like_proposed_at || row.status !== 'posted') return { liked: false, reason: 'not proposed' };
    const blocked = likeBlocked(row);
    // Claim the post before writing, so nothing can like it twice.
    const claimed = db.prepare(`INSERT INTO likes (queue_id, author_did, subject_uri, subject_cid, status, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subject_uri) DO NOTHING`)
      .run(row.id, row.author_did, row.uri, row.cid, blocked ? 'skipped' : 'sending', blocked, nowIso()).changes > 0;
    if (!claimed) return { liked: false, reason: 'already liked' };
    if (blocked) {
      logger.info('proposed like skipped', { queueId: row.id, reason: blocked });
      return { liked: false, reason: blocked };
    }
    try {
      const res = await api.createRecord('app.bsky.feed.like', {
        $type: 'app.bsky.feed.like',
        subject: { uri: row.uri, cid: row.cid },
        createdAt: nowIso(),
      });
      db.prepare(`UPDATE likes SET status = 'liked', like_uri = ?, settled_at = ? WHERE subject_uri = ?`)
        .run(res.uri, nowIso(), row.uri);
      logger.info('liked post', { queueId: row.id, subject: row.uri, like: res.uri });
      return { liked: true, uri: res.uri };
    } catch (err) {
      db.prepare(`UPDATE likes SET status = 'failed', detail = ?, settled_at = ? WHERE subject_uri = ?`)
        .run(String(err.message).slice(0, 300), nowIso(), row.uri);
      logger.error('like failed; not retried', { queueId: row.id, error: err.message });
      return { liked: false, reason: 'failed' };
    }
  } catch (err) {
    logger.error('sendProposedLike threw', { rowId, error: err.message });
    return { liked: false, reason: 'error' };
  }
}
