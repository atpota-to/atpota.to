// notifications.js
// The safety net. Jetstream is the low-latency path, not the complete one:
// delivery is at-least-once with a bounded replay window, so a long outage or a
// dropped cursor leaves a gap. app.bsky.notification.listNotifications is the
// canonical record of who tried to reach us, and it closes that gap.
//
// Notifications are turned back into the same shape a Jetstream commit produces
// and run through the same matcher, so a match cannot be true on one path and
// false on the other. The appview's own `reason` is treated as a hint only --
// it marks thread participation as "reply" in cases where the post is not
// actually a reply to us, and matchPost checks the record itself.

import { config } from './config.js';
import { logger } from './logger.js';
import { matchPost, POST_COLLECTION } from './matcher.js';
import { processMatch } from './pipeline.js';
import { isSeen } from './db.js';
import { pendingNapScan, advanceNapScan, finishNapScan, isNapping } from './nap.js';

const WANTED_REASONS = new Set(['mention', 'reply']);

/** did and rkey out of an at:// post URI. */
export function parsePostUri(uri) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri ?? '');
  if (!m) return null;
  const [, did, collection, rkey] = m;
  if (collection !== POST_COLLECTION) return null;
  return { did, rkey };
}

/** One notification -> the event shape matchPost expects, or null. */
export function notificationToEvent(n) {
  if (!n || !WANTED_REASONS.has(n.reason)) return null;
  const parts = parsePostUri(n.uri);
  if (!parts) return null;
  if (!n.cid || typeof n.cid !== 'string') return null;
  const record = n.record;
  if (!record || typeof record.text !== 'string') return null;
  return {
    did: parts.did,
    rkey: parts.rkey,
    cid: n.cid,
    record,
    handle: n.author?.handle ?? null,
  };
}

export async function sweepNotifications(stats, { napCatchup = false, api } = {}) {
  const { listNotifications } = api ?? await import('./atproto.js');
  const scan = napCatchup ? pendingNapScan() : null;
  if (napCatchup && !scan) return;
  let cursor = scan?.cursor;
  let pages = 0;
  let considered = 0;
  let fresh = 0;

  try {
    // Walk back only until everything on a page is already known. The dedup
    // table is the stopping condition, so a quiet poll costs one request.
    while (pages < (scan ? 20 : 5)) {
      if (scan && isNapping()) break;
      const res = await listNotifications({ limit: 50, cursor });
      const notes = res?.notifications ?? [];
      if (!notes.length) {
        if (scan) finishNapScan();
        break;
      }
      pages++;

      let anyNew = false;
      let reachedStart = false;
      for (const n of notes) {
        if (scan && n.indexedAt && n.indexedAt < scan.since) {
          reachedStart = true;
          break;
        }
        if (scan && n.record?.createdAt && n.record.createdAt < scan.since) continue;
        const ev = notificationToEvent(n);
        if (!ev) continue;
        considered++;
        if (isSeen(ev.did, ev.rkey)) continue;
        anyNew = true;

        const match = matchPost(ev, config.botDid, 'notification');
        if (!match) continue;
        match.authorHandle = ev.handle;
        fresh++;
        logger.warn('notification sweep found a mention Jetstream missed', {
          uri: match.uri, reason: match.reason, author: ev.handle ?? match.authorDid,
        });
        await processMatch(match, stats, { napReplay: !!scan });
      }

      cursor = res.cursor;
      if (scan) {
        if (reachedStart || !cursor) { finishNapScan(); break; }
        advanceNapScan(cursor);
      } else if (!cursor || !anyNew) break;
    }
    stats.sweeps++;
    stats.sweepFound += fresh;
    logger.info('notification sweep', { pages, considered, newMatches: fresh });
  } catch (err) {
    stats.sweepErrors++;
    logger.error('notification sweep failed', { err });
  }
}

export function startNotificationSweep(stats) {
  if (!config.appPassword) {
    logger.warn('notification sweep disabled: no ATPROTO_APP_PASSWORD', {
      note: 'Jetstream is then the only detection path, with no cover for gaps',
    });
    return null;
  }
  // A first sweep shortly after boot catches anything missed while down.
  const first = setTimeout(() => sweepNotifications(stats), 15000);
  if (first.unref) first.unref();
  const timer = setInterval(() => sweepNotifications(stats), config.notifyPollMs);
  if (timer.unref) timer.unref();
  logger.info('notification sweep scheduled', { everyMs: config.notifyPollMs });
  return timer;
}
