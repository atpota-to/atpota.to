// index.js
// atpotato weather station: the whole firehose, counted a second at a time, served as a
// rolling 60-second reading and written to Supabase a minute at a time.
// See README.md, and atmosphere/SPEC.md in atpota-to/atpota.to for the brief.

import { loadConfig } from './config.js';
import { createHostWatch, createHostWriter } from './hosts.js';
import { createJetstream, REWIND_US } from './jetstream.js';
import { createPlcWatch } from './plc-watch.js';
import { createLogger } from './logger.js';
import { createServer, health } from './server.js';
import { loadState, resumePoint, saveState } from './state.js';
import { Station } from './station.js';
import { supabaseRest } from './supabase.js';
import { createWriter, supabaseUpsert } from './writer.js';

const config = loadConfig();
const log = createLogger(config.logLevel);
const station = new Station();

const { startMinute, startCursorUs } = resumePoint(loadState(config.stateFile), Date.now(), config.maxReplaySeconds, REWIND_US);
log.info('starting', { startMinute: new Date(startMinute * 1000).toISOString(), replayFrom: startCursorUs === null ? null : new Date(startCursorUs / 1000).toISOString(), writer: config.supabase ? 'supabase' : 'off' });

const jetstream = createJetstream({ station, log, urls: config.jetstreamUrls, maxReplaySeconds: config.maxReplaySeconds, startCursorUs });

let writer = null;
if (config.supabase) {
  writer = createWriter({
    station,
    log,
    startMinute,
    upsert: supabaseUpsert({ ...config.supabase, log }),
    onWritten: (minute) => {
      try {
        saveState(config.stateFile, { lastWrittenMinute: minute });
      } catch (err) {
        log.error('could not save state', { err });
      }
    },
  });
} else {
  log.warn('minute writer off: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not both set');
}

// the PDS hosts on the network, from the relay's list of them (hosts.js), kept in Supabase for the trends
// and, after each census, today's identity changes from the PLC directory's log (plc-watch.js)
const rest = config.supabase ? supabaseRest(config.supabase) : null;
const hostWriter = rest ? createHostWriter({ upsert: rest.upsert, log }) : null;
let plcWatch = null;
const hostWatch = createHostWatch({
  log,
  relay: config.relayUrl,
  onCensus: hostWriter
    ? async (census) => {
        await hostWriter.write(census);
        plcWatch ??= createPlcWatch({ census, upsert: rest.upsert, log });
        await plcWatch.poll();
      }
    : null,
});

const server = createServer({ station, secret: config.secret, hosts: hostWatch.census });
server.listen(config.port, config.host, () => log.info('listening', { host: config.host, port: config.port }));

jetstream.start();
hostWatch.start();

const timers = [
  setInterval(() => writer?.tick().catch((err) => log.error('writer tick failed', { err })), 1000),
  setInterval(() => station.prune(), 10_000),
  setInterval(() => {
    const c = station.counts;
    const h = health(station, Date.now());
    log.info('stats', {
      ...h,
      host: jetstream.state.host,
      perSecond: Math.round(c.messages / 60),
      counted: c.counted,
      replayed: c.replayed,
      tooOld: c.tooOld,
      future: c.future,
      badTime: c.badTime,
      unparseable: c.unparseable,
      // records counted in an earlier second than Jetstream stamped (a backlog after a pause)
      movedBack: c.movedBack,
      maxMovedMs: c.maxMovedMs,
      buckets: station.buckets.size,
      pending: writer?.pending ?? null,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    });
    for (const k of Object.keys(c)) c[k] = 0;
  }, 60_000),
];

function shutdown(signal) {
  log.info('stopping', { signal });
  timers.forEach(clearInterval);
  jetstream.stop();
  hostWatch.stop();
  server.close();
  // Nothing to flush: unwritten minutes are replayed from Jetstream on the next start.
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
