// index.js
// atpotato garden index: every to.atpota.garden.* record on the network, kept in Supabase
// from Jetstream and reconciled against each repo, and what each flower grew into.
// See README.md.
//
// Timers: the indexer flushes on its own (indexer.js); a reconcile is checked for every
// minute (backfill.js); flowers are settled every SETTLE_SECONDS (settle.js); the
// heartbeat every 30 s; a stats line every 5 minutes.

import { createBackfill } from './backfill.js';
import { loadConfig } from './config.js';
import { createIndexer } from './indexer.js';
import { createJetstream } from './jetstream.js';
import { createLogger } from './logger.js';
import { eventOf } from './records.js';
import { createServer, health } from './server.js';
import { createSettler } from './settle.js';
import { createStore } from './state.js';
import { supabaseRest } from './supabase.js';

export const HEARTBEAT_MS = 30_000;
export const STATS_MS = 5 * 60_000;
export const STOP_FLUSH_MS = 5_000;

const config = loadConfig();
const log = createLogger(config.logLevel);
const startedAt = Date.now();
const db = supabaseRest(config.supabase);
const store = createStore(config.stateFile, log);

// garden_status: the heartbeat and the reconcile write it; /healthz watches the writes.
const status = { lastAttemptAt: null, lastOkAt: null };
async function writeStatus(values) {
  status.lastAttemptAt = Date.now();
  await db.upsert('garden_status', 'id', [{ id: 1, ...values }]);
  status.lastOkAt = Date.now();
}

const indexer = createIndexer({ rpc: db.rpc, store, log });

const backfill = createBackfill({
  rpc: db.rpc,
  writeStatus,
  store,
  log,
  relayUrl: config.relayUrl,
  plcUrl: config.plcUrl,
  reconcileMs: config.reconcileHours * 3600_000,
  touchedSince: indexer.touchedSince,
});

const jetstream = createJetstream({
  hosts: config.jetstreamHosts,
  log,
  cursorFor: (host) => store.cursor(host),
  dropCursor: (host) => {
    store.dropCursor(host);
    indexer.forget(host);
  },
  onEvent: (payload, meta) => indexer.add(eventOf(payload), meta),
  reconcile: (reason) => backfill.request(reason),
  onOpen: () => setTimeout(() => void beat(), 1000),
  beforeRecycle: () => indexer.flush(),
  recycleMs: config.recycleMinutes * 60_000,
});

const settler = createSettler({
  rpc: db.rpc,
  upsert: db.upsert,
  patch: db.patch,
  log,
  // Not before the first reconcile: a seed's patch (and its season) must be in the index.
  ready: () => store.backfilledAt !== null,
});

/** The indexer was connected and had applied everything it received. */
async function beat() {
  if (!jetstream.state.connected || indexer.pending > 0) return;
  const values = { heartbeat_at: new Date().toISOString() };
  if (indexer.streamAt) values.stream_at = indexer.streamAt;
  try {
    await writeStatus(values);
  } catch (err) {
    log.warn('heartbeat failed', { err });
  }
}

const snapshot = () => ({
  startedAt,
  connected: jetstream.state.connected,
  host: jetstream.state.host,
  pending: indexer.pending,
  lastFlushAt: indexer.lastFlushAt,
  lastStatusAt: status.lastOkAt,
  lastStatusAttemptAt: status.lastAttemptAt,
  backfilledAt: store.backfilledAt,
});

const server = createServer({ snapshot });
server.listen(config.port, config.host, () => log.info('listening', { host: config.host, port: config.port }));

log.info('starting', { hosts: config.jetstreamHosts, cursors: store.snapshot.cursors, backfilledAt: store.backfilledAt });
jetstream.start();
backfill.start();

const timers = [
  setInterval(() => void beat(), HEARTBEAT_MS),
  setInterval(() => void settler.tick().catch((err) => log.error('settle pass failed', { err })), config.settleSeconds * 1000),
  setInterval(() => {
    const j = jetstream.counts;
    const x = indexer.counts;
    const s = settler.counts;
    log.info('stats', {
      ...health(snapshot(), Date.now()),
      lastMessageAt: jetstream.state.lastMessageAt,
      streamAt: indexer.streamAt,
      cursors: store.snapshot.cursors,
      messages: j.messages,
      unparseable: j.unparseable,
      connects: j.connects,
      recycles: j.recycles,
      events: x.events,
      applied: x.applied,
      applyFailures: x.failures,
      dropped: x.dropped,
      settled: s.settled,
      grown: s.grown,
      settleFailures: s.failed,
      reconciling: backfill.running,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    });
    for (const c of [j, x, s]) for (const k of Object.keys(c)) c[k] = 0;
  }, STATS_MS),
];

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('stopping', { signal });
  timers.forEach(clearInterval);
  backfill.stop();
  jetstream.stop();
  server.close();
  // What's pending goes now if it can; if not, the saved cursor replays it on the next start.
  const flushed = await Promise.race([indexer.flush(), new Promise((r) => setTimeout(() => r(false), STOP_FLUSH_MS))]);
  indexer.stop();
  log.info('stopped', { flushed, pending: indexer.pending });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
