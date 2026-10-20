// pipeline.js
// One match, from the socket to the agent. Both the Jetstream consumer and the
// notification sweep come through here, so a gate cannot be true on one path
// and false on the other.

import { config, gates, isAdmin } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import { evaluateInbound, lessonIn } from './gates/inbound.js';
import { sendMention } from './agent.js';
import { parseContext, readPostContext } from './thread.js';
import { forgetMemory, publishLesson } from './memory.js';
import { parseNapCommand } from './nap-time.js';
import { applyNapCommand, isNapping, pauseRow, deferNapRow } from './nap.js';
import { killSwitchEngaged } from './config.js';
import { interceptApprovalReply } from './scan-approval.js';

/** Everything the inbound gates need, bound to the real database. */
function inboundDeps(now = new Date()) {
  return {
    now,
    botDid: config.botDid,
    botHandle: config.botHandle,
    gates: gates(),
    isDenied: db.isDenied,
    deny: db.deny,
    backoffUntil: db.backoffUntil,
    setBackoff: db.setBackoff,
    ourPostsInThread: db.ourPostsInThread,
    repliesToAuthorSince: db.repliesToAuthorSince,
    repliesSince: db.repliesSince,
    isAdmin,
  };
}

/**
 * Process one match. Returns a short verdict string for the stats counters.
 *
 * Stages:
 *   1  queue it and stop
 *   2  run the inbound gates and record the verdict, still no agent call
 *   3+ dispatch to the agent
 */
export async function processMatch(match, stats, { napReplay = false } = {}) {
  // Self, again, before anything is written. The matcher already refuses this,
  // and the inbound gates refuse it a third time. It is the one failure that
  // compounds without limit, so it is checked on every code path that exists.
  if (match.authorDid === config.botDid) {
    stats.self++;
    return 'self';
  }

  // An admin decision is a reply to our escalation, not a new agent turn.
  // Intercept before the nap and inbound gates so a late/unauthorized reply
  // cannot be interpreted as an ordinary request.
  if (match.reason === 'reply' && await interceptApprovalReply(match)) {
    db.claimUnseen(match.did, match.rkey, match.source);
    return 'scan_approval';
  }

  // Dedup. At-least-once delivery, reconnect redelivery, and the notification
  // sweep re-offering the same post all land here.
  if (!db.claimUnseen(match.did, match.rkey, match.source)) {
    stats.duplicates++;
    return 'duplicate';
  }

  const queueId = db.enqueue(match);
  if (queueId == null) {
    stats.duplicates++;
    return 'duplicate';
  }
  stats.matched++;

  logger.info('matched', {
    queueId, uri: match.uri, reason: match.reason, source: match.source,
    author: match.authorHandle ?? match.authorDid,
    text: match.text.slice(0, 200),
  });

  // Only a signed admin post that the matcher found addressing Poe can control naps.
  const command = isAdmin(match.authorDid) ? parseNapCommand(match.text, new Date(), config.botHandle) : null;
  if (command) {
    if (napReplay) {
      db.setStatus(queueId, 'gated_out', {
        gate: 'old_nap_command', gate_detail: 'old operator command is not replayed', settled_at: db.nowIso(),
      });
      return 'old_nap_command';
    }
    const result = applyNapCommand(match.uri, command);
    db.setStatus(queueId, 'paused', { gate: 'nap_command', settled_at: db.nowIso() });
    if (command.kind === 'wake' && !result.duplicate && config.stage >= 4 && !config.dryRun) {
      import('./reconcile.js').then(({ requestNapCatchup }) => requestNapCatchup(stats))
        .catch((err) => logger.error('wake catch-up failed to start', { error: err.message }));
    }
    if (!result.duplicate && config.stage >= 4 && !config.dryRun && !killSwitchEngaged()) {
      // Acknowledgment is the sole public write allowed during a nap.
      import('./atproto.js').then(({ createPost }) => createPost({
        $type: 'app.bsky.feed.post', text: result.message, createdAt: db.nowIso(),
        reply: { root: { uri: match.rootUri, cid: match.rootCid },
          parent: { uri: match.parentUri, cid: match.parentCid } },
      }, { napAcknowledgment: true })).catch((err) => logger.error('nap command acknowledgment failed', { queueId, error: err.message }));
    }
    return 'nap_command';
  }
  if (isNapping()) {
    pauseRow(queueId);
    return 'paused';
  }
  if (napReplay) {
    db.setStatus(queueId, 'replaying', { gate: 'nap_replay', sent_at: db.nowIso() });
  }
  return processQueuedMatch(queueId, match, stats, { napReplay });
}

/** Run ordinary inbound handling on a stored nap match without claiming it again. */
export async function processQueuedMatch(queueId, match, stats, { napReplay = false } = {}) {
  if (isNapping()) {
    pauseRow(queueId);
    return 'paused';
  }
  if (config.stage < 2) return 'queued';

  // A lesson from someone who runs the potato: saved, then acknowledged. It is
  // recognised before the inbound gates, because what it says ("don't reply
  // with a face every time") can look like a question, noise, or an opt-out,
  // and none of those is what it is. Only for an author on ADMIN_DIDS, which is
  // the DID on the signed record; from anyone else "remember:" is just a post.
  const lesson = isAdmin(match.authorDid) ? lessonIn(match.text) : null;
  if (lesson) {
    const lessonId = db.addLesson(lesson, match.authorDid, match.uri);
    logger.warn('lesson saved from an admin post', { queueId, lessonId, lesson });
    // Also into the potato's public repo; the sweep retries if this fails.
    import('./atproto.js').then((api) => publishLesson(lessonId, { api }))
      .catch((err) => logger.error('lesson publish threw', { lessonId, err }));
    db.setStatus(queueId, 'matched', { gate_detail: `admin lesson #${lessonId}` });
    stats.passed++;
    if (config.stage < 3) return 'lesson';
    return dispatch(queueId, stats);
  }

  const verdict = evaluateInbound(match, { ...inboundDeps(), napReplay });

  if (!verdict.ok) {
    // An opt-out is the one inbound "failure" that changes durable state.
    if (verdict.optOut) {
      db.deny(match.authorDid, 'opt_out', verdict.detail);

      // Forgetting includes the public record, and that is done here, in code,
      // rather than trusted to the farewell turn below.
      if (verdict.forgetMemory) {
        const api = await import('./atproto.js');
        await forgetMemory(match.authorDid, { api });
      }

      // "forget me" is the one opt-out that gets a reply, because it asks for
      // something the droplet cannot do on its own. Agent memory is keyed and
      // stored on the eve side, its backend exposes no delete, and the scope key
      // is derived by internals this service should not reconstruct. The model
      // holds the only clean handle on it: person__remove_memory.
      //
      // So one final turn goes out, the model clears its notes and says goodbye,
      // and the denylist above means nothing after this is ever answered. A
      // repeat of "forget me" is refused at the denylist gate, so this cannot
      // become a way to make it talk.
      if (verdict.forgetMemory && config.stage >= 3) {
        logger.warn('forget-me: dispatching a final turn to clear agent memory', {
          did: match.authorDid, queueId,
        });
        db.setStatus(queueId, 'matched', { gate: 'opt_out', gate_detail: 'forget-me farewell' });
        return dispatch(queueId, stats);
      }
    }
    // Rate limits get one warm word rather than silence, so somebody mid
    // conversation knows the potato is tired rather than broken or ignoring
    // them. Once per account per window; after that, silence.
    const RATE_GATES = new Set(['per_account_rate', 'global_rate', 'bot_loop', 'bot_loop_backoff']);
    if (napReplay && RATE_GATES.has(verdict.gate)) {
      const backoff = db.backoffUntil(match.authorDid);
      const retryAt = backoff && Date.parse(backoff) > Date.now()
        ? new Date(backoff) : new Date(Date.now() + 61 * 60000);
      deferNapRow(queueId, retryAt);
      logger.info('nap reply deferred by rate gate', { queueId, gate: verdict.gate, retryAt: retryAt.toISOString() });
      return `deferred:${verdict.gate}`;
    }
    if (RATE_GATES.has(verdict.gate)) {
      const row = db.getQueueRow(queueId);
      const { postCooldownNotice } = await import('./poster.js');
      postCooldownNotice(row, verdict.gate).catch((err) =>
        logger.error('cooldown notice threw', { queueId, err }));
    }

    db.recordRejection(queueId, 'inbound', verdict.gate, verdict.detail, match.text);
    db.setStatus(queueId, 'gated_out', {
      gate: verdict.gate, gate_detail: verdict.detail, settled_at: db.nowIso(),
    });
    stats.gated++;
    stats.byGate[verdict.gate] = (stats.byGate[verdict.gate] ?? 0) + 1;
    logger.info('gated out', { queueId, gate: verdict.gate, detail: verdict.detail });
    return `gated:${verdict.gate}`;
  }

  stats.passed++;

  if (config.stage < 3) {
    // Stage 2 records that it would have gone to the agent and stops.
    db.setStatus(queueId, 'matched', { gate: null, gate_detail: 'passed all inbound gates' });
    return 'passed';
  }

  return dispatch(queueId, stats);
}

/**
 * Send a queued row to the agent. Shared with the reconciliation sweep and with
 * the poster's retry path, which passes a note saying why the previous answer
 * was refused.
 */
export async function dispatch(queueId, stats, retryNote) {
  let row = db.getQueueRow(queueId);
  if (!row) return 'missing';
  if (isNapping() || row.status === 'paused') {
    pauseRow(row.id);
    return 'paused';
  }

  // Jetstream gives a DID and no handle, and the agent's contract requires
  // authorHandle -- omitting it is a 400. Fill it in once, here, and persist it
  // so a retry does not resolve it again.
  if (!row.author_handle) {
    const { resolveHandleForDid } = await import('./atproto.js');
    const handle = await resolveHandleForDid(row.author_did);
    if (handle) {
      db.setStatus(row.id, row.status, { author_handle: handle });
      row = db.getQueueRow(row.id);
      logger.debug('resolved author handle', { queueId: row.id, handle });
    } else {
      // Dispatching without it just earns a 400, so fail here where the reason
      // is legible rather than downstream where it is not.
      db.setStatus(row.id, 'failed', {
        gate: 'handle_resolution',
        gate_detail: `could not resolve a handle for ${row.author_did}`,
        settled_at: db.nowIso(),
      });
      stats.dispatchErrors++;
      logger.error('could not resolve author handle; not dispatching', {
        queueId: row.id, authorDid: row.author_did,
      });
      return 'no_handle';
    }
  }

  // What the post carries and what is above it (thread.js). Read once and
  // kept, so a retry or a re-dispatch shows the agent the same thing; a failed
  // read is not kept, so the next attempt tries again.
  let context = parseContext(row.thread_context);
  if (!context) {
    const api = await import('./atproto.js');
    context = await readPostContext(row, { botDid: config.botDid, adminDids: config.adminDids, api });
    if (context) db.setStatus(row.id, row.status, { thread_context: JSON.stringify(context) });
  }

  if (isNapping() || db.getQueueRow(row.id).status === 'paused') {
    pauseRow(row.id);
    return 'paused';
  }
  db.setStatus(row.id, 'sent_to_agent', {
    sent_at: db.nowIso(),
    attempts: (row.attempts ?? 0) + 1,
  });
  // The callback is pinned to this exact generation. Sending the previous
  // in-memory row sends attempt 0 on a first dispatch, which the agent rejects.
  row = db.getQueueRow(row.id);

  // Direction from the people who run it: whether this post is from one of
  // them, the lesson it just taught if it taught one, and every standing lesson.
  const operator = isAdmin(row.author_did);
  const res = await sendMention(row, {
    retryNote,
    context,
    operator,
    lessonSaved: operator ? db.lessonFromPost(row.uri) : null,
    lessons: db.activeLessons().map((l) => l.text),
    styleNotes: db.db.prepare(`SELECT text FROM style_feedback WHERE removed_at IS NULL
      ORDER BY added_at DESC LIMIT 30`).all().reverse().map((note) => note.text),
  });
  if (res.ok) {
    stats.dispatched++;
    logger.info('dispatched to agent', { queueId: row.id, threadRoot: row.thread_root });
    return 'dispatched';
  }

  stats.dispatchErrors++;
  if (db.getQueueRow(row.id).status === 'paused') return 'paused';
  db.setStatus(row.id, 'failed', {
    gate: 'agent_dispatch', gate_detail: `${res.status}: ${res.detail}`, settled_at: db.nowIso(),
  });
  logger.error('agent dispatch failed', { queueId: row.id, status: res.status, detail: res.detail });
  return 'dispatch_failed';
}
