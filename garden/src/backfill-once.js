// backfill-once.js
// `npm run backfill`: one reconcile pass, by hand, then exit: 0 when every repo was listed
// and reconciled, 1 otherwise (the log says which). Safe while the service runs: everything it
// writes is idempotent. It writes garden_status.backfilled_at but never state.json, so it
// can't clobber the running service's cursors; the service keeps its own schedule.
//
//   cd /root/atpotato-garden && /opt/node22/bin/node --env-file=.env /root/atpota-live/garden/src/backfill-once.js

import { createBackfill } from './backfill.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createStore } from './state.js';
import { supabaseRest } from './supabase.js';

const config = loadConfig();
const log = createLogger(config.logLevel);
const db = supabaseRest(config.supabase);

const backfill = createBackfill({
  rpc: db.rpc,
  writeStatus: (values) => db.upsert('garden_status', 'id', [{ id: 1, ...values }]),
  store: createStore(null, log),
  log,
  relayUrl: config.relayUrl,
  plcUrl: config.plcUrl,
});

const result = await backfill.run('by hand');
process.exit(result?.listed && result.incomplete === 0 ? 0 : 1);
