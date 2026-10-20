// reconcile.js
// The agent drops a draft if our callback endpoint does not answer 2xx: it logs
// and moves on rather than failing the turn. So delivery cannot be assumed, and
// a turn dispatched with no draft coming back is invisible without this.
//
// Anything sitting in sent_to_agent past the stuck threshold is re-dispatched,
// up to a retry ceiling; past the ceiling it is failed loudly rather than
// retried forever.

import { config, gates, killSwitchEngaged } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import { dispatch, processQueuedMatch } from './pipeline.js';
import { matchPost } from './matcher.js';
import { reconcilePublished } from './memory.js';
import { isNapping, claimNapReplays, pauseRow, missingNapPost } from './nap.js';
import { retryApprovalResponses } from './scan-approval.js';

let catchupRunning = null;
let scanRunning = null;

function scanMissedNapNotifications(stats) {
  if (scanRunning) return scanRunning;
  scanRunning = import('./notifications.js')
    .then(({ sweepNotifications }) => sweepNotifications(stats, { napCatchup: true }))
    .finally(() => { scanRunning = null; });
  return scanRunning;
}

/** Work through saved nap posts in bounded batches; safe after restart or an automatic wake. */
export function resumeNapReplies(stats, { api } = {}) {
  if (catchupRunning) return catchupRunning;
  if (isNapping() || killSwitchEngaged() || config.stage < 4 || config.dryRun) return Promise.resolve(0);
  catchupRunning = (async () => {
    const counters = stats ?? { passed: 0, gated: 0, byGate: {}, dispatched: 0, dispatchErrors: 0 };
    const client = api ?? await import('./atproto.js');
    const rows = claimNapReplays();
    if (!rows.length) return 0;
    let posts;
    try {
      posts = await client.getPosts(rows.map((row) => row.uri));
    } catch (err) {
      for (const row of rows) pauseRow(row.id);
      throw err;
    }
    const byUri = new Map((posts.posts ?? []).map((post) => [post.uri, post]));
    for (const row of rows) {
      if (isNapping() || killSwitchEngaged()) {
        pauseRow(row.id);
        continue;
      }
      // A nap may have interrupted a multi-post answer after its first post.
      // Never answer that same incoming post twice.
      if (db.db.prepare('SELECT 1 FROM replies WHERE queue_id = ? LIMIT 1').get(row.id)) {
        db.setStatus(row.id, 'posted', { gate: null, settled_at: db.nowIso() });
        continue;
      }
      const post = byUri.get(row.uri);
      if (!post) {
        missingNapPost(row.id);
        continue;
      }
      if (post.cid !== row.cid || post.author?.did !== row.author_did) {
        db.setStatus(row.id, 'gated_out', {
          gate: 'changed_on_wake', gate_detail: 'post changed since it was matched', settled_at: db.nowIso(),
        });
        continue;
      }
      const match = matchPost({ did: row.did, rkey: row.rkey, cid: post.cid,
        record: post.record }, config.botDid, row.source);
      if (!match || match.uri !== row.uri) {
        db.setStatus(row.id, 'gated_out', {
          gate: 'changed_on_wake', gate_detail: 'post no longer addresses Poe', settled_at: db.nowIso(),
        });
        continue;
      }
      match.authorHandle = row.author_handle ?? post.author?.handle ?? null;
      try {
        const outcome = await processQueuedMatch(row.id, match, counters, { napReplay: true });
        logger.info('nap reply processed', { queueId: row.id, outcome });
      } catch (err) {
        // Another sweep can reclaim a crashed or temporarily failed replay.
        pauseRow(row.id);
        logger.error('nap reply processing failed', { queueId: row.id, error: err.message });
      }
    }
    return rows.length;
  })().finally(() => { catchupRunning = null; });
  return catchupRunning;
}

export function requestNapCatchup(stats) {
  if (isNapping() || config.stage < 4 || config.dryRun || killSwitchEngaged()) return;
  const counters = stats ?? { sweeps: 0, sweepFound: 0, sweepErrors: 0,
    matched: 0, duplicates: 0, self: 0, gated: 0, passed: 0,
    byGate: {}, dispatched: 0, dispatchErrors: 0 };
  scanMissedNapNotifications(counters).then(() => resumeNapReplies(counters))
    .catch((err) => logger.error('nap catch-up failed', { error: err.message }));
}

export async function reconcileOnce(stats, now = new Date()) {
  const cutoff = new Date(now.getTime() - config.reconcileStuckMin * 60000).toISOString();

  await retryApprovalResponses({ now });
  if (isNapping()) return;
  await scanMissedNapNotifications(stats);
  await resumeNapReplies(stats);
  if (isNapping()) return;
  const abandoned = db.abandonedRows(cutoff, config.reconcileMaxRetries, now.toISOString());
  for (const row of abandoned) {
    if (isNapping()) return;
    db.setStatus(row.id, 'failed', {
      gate: 'no_draft',
      gate_detail: `no draft after ${row.attempts} dispatches`,
      settled_at: db.nowIso(),
    });
    stats.reconcileAbandoned++;
    logger.error('turn abandoned: agent never returned a draft', {
      queueId: row.id, uri: row.uri, attempts: row.attempts, sentAt: row.sent_at,
    });
  }

  const stuck = db.stuckRows(cutoff, config.reconcileMaxRetries, now.toISOString());
  for (const row of stuck) {
    // A post that has aged past the staleness window while stuck is no longer
    // worth answering; replying to a two-hour-old question reads as a bot
    // waking up, not as an answer.
    if (row.record_created) {
      const ageMin = (now.getTime() - new Date(row.record_created).getTime()) / 60000;
      if (ageMin > gates().stalenessMin * 4) {
        db.setStatus(row.id, 'failed', {
          gate: 'stale_retry',
          gate_detail: `post is ${ageMin.toFixed(0)}m old; not retrying`,
          settled_at: db.nowIso(),
        });
        stats.reconcileStale++;
        logger.warn('stuck turn aged out; not retrying', { queueId: row.id, ageMin: Math.round(ageMin) });
        continue;
      }
    }
    stats.reconcileRetried++;
    logger.warn('re-dispatching a turn with no draft', {
      queueId: row.id, uri: row.uri, attempts: row.attempts, sentAt: row.sent_at,
    });
    await dispatch(row.id, stats);
  }

  // Notes and lessons whose public copy did not make it into the repo.
  const api = await import('./atproto.js');
  await reconcilePublished({ api, didResolves: async (did) => !!(await api.resolveHandleForDid(did)) });
}

export function startReconcile(stats) {
  if (config.stage < 3) return null;   // nothing is dispatched below stage 3
  const first = setTimeout(() => {
    requestNapCatchup(stats);
    retryApprovalResponses().catch((err) => logger.error('approval retry failed', { error: err.message }));
  }, 15000);
  first.unref?.();
  const timer = setInterval(() => {
    reconcileOnce(stats).catch((err) => logger.error('reconcile failed', { err }));
  }, config.reconcileMs);
  if (timer.unref) timer.unref();
  logger.info('reconciliation sweep scheduled', {
    everyMs: config.reconcileMs, stuckAfterMin: config.reconcileStuckMin,
  });
  return timer;
}
