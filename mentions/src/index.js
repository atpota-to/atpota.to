// index.js
// One process: consumer, callback server, sweeps. They are all I/O bound and
// this droplet has 1 GB of RAM, so three services would cost three Node heaps
// to no benefit.

import { config, gates, killSwitchEngaged, killSwitchPath } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import { connectJetstream } from './jetstream.js';
import { normaliseCommit, matchPost } from './matcher.js';
import { processMatch } from './pipeline.js';
import { startNotificationSweep } from './notifications.js';
import { startReconcile } from './reconcile.js';
import { startOperatorDmPoll } from './operator-dm.js';
import { startWeatherWatch } from './weather-posts.js';
import { startProfileLook } from './profile-look.js';
import { startDispatchDrafts } from './dispatch-drafts.js';

// node:sqlite and a stable Intl.Segmenter mean this needs Node 22. The default
// `node` on this droplet is 18, where the import fails with an opaque
// ERR_UNKNOWN_BUILTIN_MODULE several frames deep, so say so plainly up front.
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(
    `atpotato-mentions needs Node >= 22 (node:sqlite); this is ${process.version}.\n` +
    `Use /opt/node22/bin/node -- the systemd unit already does.\n`
  );
  process.exit(1);
}

const stats = {
  received: 0, unparseable: 0, handlerErrors: 0,
  candidates: 0, matched: 0, duplicates: 0, self: 0,
  gated: 0, passed: 0, byGate: {},
  dispatched: 0, dispatchErrors: 0,
  drafts: 0, callbackDuplicates: 0, callbackInvalid: 0,
  callbackUnauthorized: 0, callbackOrphans: 0,
  sweeps: 0, sweepFound: 0, sweepErrors: 0,
  reconcileRetried: 0, reconcileAbandoned: 0, reconcileStale: 0,
};

let windowStart = Date.now();

function resetWindow() {
  const snapshot = { ...stats, byGate: { ...stats.byGate } };
  snapshot.elapsedSec = (Date.now() - windowStart) / 1000;
  windowStart = Date.now();
  for (const k of Object.keys(stats)) {
    if (k === 'byGate') stats.byGate = {};
    else stats[k] = 0;
  }
  return snapshot;
}

// The hot path. Runs on every post in the firehose (~59/s measured), so it does
// the cheap synchronous work itself and only goes async once something matches.
let inFlight = 0;
function onEvent(payload) {
  const ev = normaliseCommit(payload);
  if (!ev) return;
  stats.candidates++;

  const match = matchPost(ev, config.botDid, 'jetstream');
  if (!match) return;

  inFlight++;
  processMatch(match, stats)
    .catch((err) => logger.error('processMatch threw', { err, uri: match.uri }))
    .finally(() => { inFlight--; });
}

async function main() {
  const g = gates();
  logger.info('atpotato-mentions starting', {
    stage: config.stage,
    stageMeaning: {
      1: 'detect only, nothing is sent or posted',
      2: 'detect + inbound gates, nothing is sent or posted',
      3: 'detect + gates + agent drafts, nothing is posted',
      4: 'full pipeline, replies are posted',
    }[config.stage],
    botDid: config.botDid,
    botHandle: config.botHandle,
    jetstream: config.jetstreamHosts,
    db: config.dbFile,
    killSwitch: killSwitchEngaged() ?? 'not engaged',
    killSwitchFile: killSwitchPath,
    node: process.version,
    gates: g,
  });

  if (config.stage >= 4 && killSwitchEngaged()) {
    logger.warn('stage 4 but the kill switch is engaged; nothing will be posted', {
      how: killSwitchEngaged(),
    });
  }

  let callbackServer = null;
  if (config.stage >= 3) {
    const { startCallbackServer } = await import('./callback.js');
    callbackServer = startCallbackServer({ stats });
    if (!config.callbackUrl) {
      logger.warn('DROPLET_CALLBACK_URL is unset', {
        note: 'the agent needs a URL reachable from Vercel or every draft is dropped',
      });
    }
  } else {
    logger.info('callback server not started (stage < 3)');
  }

  const sweepTimer = startNotificationSweep(stats);
  const reconcileTimer = startReconcile(stats);
  const dmTimer = startOperatorDmPoll();
  const weatherTimer = startWeatherWatch();
  const lookTimer = startProfileLook();
  const draftsTimer = startDispatchDrafts();
  const stream = connectJetstream({ onEvent, stats });

  const statsTimer = setInterval(() => {
    const w = resetWindow();
    logger.info('stats', {
      // Real elapsed, not the nominal interval: if the event loop is busy the
      // timer runs late, and dividing by the interval then reports a rate
      // several times higher than the firehose is actually delivering.
      windowSec: +w.elapsedSec.toFixed(0),
      received: w.received,
      posts: w.candidates,
      postsPerSec: +(w.candidates / Math.max(w.elapsedSec, 1)).toFixed(1),
      matched: w.matched,
      duplicates: w.duplicates,
      gated: w.gated,
      byGate: w.byGate,
      passed: w.passed,
      dispatched: w.dispatched,
      drafts: w.drafts,
      sweepFound: w.sweepFound,
      errors: w.handlerErrors + w.dispatchErrors + w.sweepErrors,
      inFlight,
      // rss and heapUsed together, because they answer different questions over
      // a long run: heapUsed climbing means the process is retaining objects,
      // rss climbing alone is usually V8 growing its heap toward a steady state
      // and is reclaimable. The number MemoryMax enforces is neither of these —
      // that is the cgroup's memory.current, which has read well below both.
      rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    });
  }, config.statsEveryMs);
  if (statsTimer.unref) statsTimer.unref();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal, inFlight });
    clearInterval(statsTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (dmTimer) clearInterval(dmTimer);
    if (weatherTimer) clearInterval(weatherTimer);
    if (lookTimer) clearInterval(lookTimer);
    if (draftsTimer) clearInterval(draftsTimer);
    stream.close();                       // flushes the cursor watermark
    callbackServer?.close();

    // Give anything mid-flight a moment to finish writing its row.
    const deadline = Date.now() + 8000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (inFlight > 0) logger.warn('shutting down with work in flight', { inFlight });
    db.closeDb();
    logger.info('stopped');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.error('fatal', { err });
  process.exit(1);
});
