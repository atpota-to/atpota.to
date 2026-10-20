// replay.js
// Recounts minutes from Jetstream's own history and rewrites them in Supabase: to repair
// minutes a glitch got into (17:37–17:38 on 2026-10-20, before clock.js), or to fill a
// gap. It counts exactly as the live station does (the same Station, clock.js and rows),
// and only rewrites a minute it heard whole (60 of 60 seconds), so a replay that started
// too late can't overwrite a good minute with part of one.
//
//   node src/replay.js --from 2026-10-20T17:36Z --to 2026-10-20T17:40Z [--dry-run] [--host wss://...]
//
// On the droplet, from the data folder so it picks up the service key:
//
//   cd /root/atpotato-weather && /opt/node22/bin/node --env-file=.env \
//     /root/atpota-live/atmosphere/src/replay.js --from ... --to ... --dry-run
//
// Jetstream only keeps a lookback (about a day and a half on Bluesky's hosts); minutes
// before it come back partial and are left alone. Older history needs the archive
// (Jetstream v2's network replay, with an API key; see README.md).
//
// Rewriting replaces the minute's row and all its app rows (a recount can drop an app the
// glitch put there), then re-sums the daily roll-up from --from on. It's safe while the
// live station runs: the station never goes back to a minute it has written, and --to may
// not be closer than WRITE_LAG_S to now, so the two never write the same minute.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { accountOf } from './accounts.js';
import { eventOfMessage } from './atmosphere.js';
import { happenedUs, MAX_EARLIER_S } from './clock.js';
import { DEFAULT_URLS, withCursor } from './jetstream.js';
import { Station } from './station.js';
import { minuteRows, REQUEST_TIMEOUT_MS } from './writer.js';

/** Start this long before --from: coverage begins on the second after the first event. */
export const LEAD_S = 5;
/** Give up when Jetstream goes this quiet mid-replay. */
export const SILENCE_MS = 30_000;
/** Minutes the live station may still be writing. */
export const WRITE_LAG_S = 180;
/** At most this much in one run. */
export const MAX_WINDOW_S = 48 * 3600;

const iso = (second) => new Date(second * 1000).toISOString();

/**
 * Reads Jetstream from just before `fromSec` until the stream is MAX_EARLIER_S past
 * `toSec`, and calls onMinute(minuteSec, tally, seconds, accounts) for each minute in
 * [fromSec, toSec) as soon as nothing more can land in it. Resolves with the time_us of
 * the first event Jetstream sent (later than asked means its lookback ends there).
 */
export function replayWindow({ host, fromSec, toSec, onMinute, open = (url) => new WebSocket(url), setTimer = setTimeout, clearTimer = clearTimeout }) {
  return new Promise((resolve, reject) => {
    // The station's clock follows the stream, so an hour-old replay isn't "too old".
    const clock = { ms: (fromSec - LEAD_S) * 1000 };
    const station = new Station({ now: () => clock.ms });
    let next = fromSec;
    let firstUs = null;
    let done = false;
    let quiet = null;
    const sock = open(withCursor(host, Math.round((fromSec - LEAD_S) * 1e6)));

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimer(quiet);
      try {
        sock.close();
      } catch {
        // already gone
      }
      if (err) reject(err);
      else resolve({ firstUs });
    };
    const listen = () => {
      clearTimer(quiet);
      quiet = setTimer(() => finish(new Error(`jetstream went quiet for ${SILENCE_MS / 1000} s`)), SILENCE_MS);
    };

    sock.onopen = () => {
      station.beginSession();
      listen();
    };
    sock.onmessage = (msg) => {
      if (done) return;
      listen();
      let m;
      try {
        m = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString('utf8'));
      } catch {
        return;
      }
      if (typeof m?.time_us !== 'number') return;
      if (firstUs === null) firstUs = m.time_us;
      clock.ms = Math.max(clock.ms, m.time_us / 1000 + 1000);
      station.ingest(m.time_us, eventOfMessage(m), happenedUs(m), accountOf(m));
      while (next < toSec && station.coveredThrough !== null && station.coveredThrough >= next + 59 + MAX_EARLIER_S) {
        const { tally, seconds, accounts } = station.minute(next);
        onMinute(next, tally, seconds, accounts);
        next += 60;
        // Keep memory flat over a long replay: nothing can land before `next` any more.
        for (const second of station.buckets.keys()) if (second < next) station.buckets.delete(second);
      }
      if (next >= toSec) finish(null);
    };
    sock.onerror = (e) => finish(new Error(`jetstream error: ${e?.message ?? 'unknown'}`));
    sock.onclose = () => finish(new Error('jetstream closed before the window was read'));
  });
}

/** Rewrites one minute: its row, then all its app rows. Throws on anything but success. */
export function supabaseReplace({ url, key, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  async function call(method, path, body, prefer) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method,
      headers: prefer ? { ...headers, prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  return {
    async minute(rows) {
      await call('POST', 'atmosphere_minute?on_conflict=minute', [rows.minute], 'resolution=merge-duplicates,return=minimal');
      await call('DELETE', `atmosphere_minute_app?minute=eq.${encodeURIComponent(rows.minute.minute)}`, undefined, 'return=minimal');
      if (rows.apps.length) await call('POST', 'atmosphere_minute_app?on_conflict=minute,domain', rows.apps, 'resolution=merge-duplicates,return=minimal');
    },
    /** Re-sums the daily per-app roll-up from `sinceIso` on. */
    async rollUp(sinceIso) {
      await call('POST', 'rpc/atmosphere_roll_up_day_apps', { since: sinceIso });
    },
  };
}

export function parseArgs(argv, nowMs = Date.now()) {
  const args = { dryRun: false, host: null, from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--from' || a === '--to' || a === '--host') args[a.slice(2)] = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${a}`);
  }
  const minute = (s, name) => {
    const t = Date.parse(s ?? '');
    if (!Number.isFinite(t)) throw new Error(`--${name} must be a time, like 2026-10-20T17:36Z`);
    return Math.floor(t / 60_000) * 60;
  };
  const fromSec = minute(args.from, 'from');
  const toSec = minute(args.to, 'to');
  if (toSec <= fromSec) throw new Error('--to must be after --from');
  if (toSec - fromSec > MAX_WINDOW_S) throw new Error(`at most ${MAX_WINDOW_S / 3600} hours in one run`);
  if (toSec > nowMs / 1000 - WRITE_LAG_S) throw new Error(`--to must be at least ${WRITE_LAG_S / 60} minutes ago, so the live station isn't still writing it`);
  return { ...args, fromSec, toSec };
}

async function main(argv) {
  const args = parseArgs(argv);
  const host = args.host ?? (process.env.JETSTREAM_URLS?.split(',')[0]?.trim() || DEFAULT_URLS[0]);
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!args.dryRun && !(url && key)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or pass --dry-run)');
  console.log(`replaying ${iso(args.fromSec)} to ${iso(args.toSec)} from ${host}${args.dryRun ? ' (dry run: nothing is written)' : ''}`);

  const whole = [];
  const partial = [];
  const started = Date.now();
  const { firstUs } = await replayWindow({
    host,
    fromSec: args.fromSec,
    toSec: args.toSec,
    onMinute(minuteSec, tally, seconds, accounts) {
      // the rewritten rows carry their active accounts too; the sketches (atmosphere_account_*) are left as they are
      const rows = minuteRows(minuteSec, tally, seconds, accounts);
      const m = rows.minute;
      console.log(`${m.minute}  ${String(seconds).padStart(2)}/60 s  ${(m.creates / Math.max(1, seconds)).toFixed(1).padStart(6)} records/s  ${String(m.elsewhere).padStart(5)} elsewhere  ${String(rows.apps.length).padStart(3)} apps`);
      (seconds === 60 ? whole : partial).push(rows);
    },
  });
  console.log(`read in ${Math.round((Date.now() - started) / 1000)} s; jetstream's first event was ${new Date(firstUs / 1000).toISOString()}`);
  if (partial.length) console.log(`${partial.length} minute(s) not heard whole, left alone: ${partial.map((r) => r.minute.minute).join(', ')}`);
  if (args.dryRun || !whole.length) return;

  const db = supabaseReplace({ url, key });
  for (const rows of whole) await db.minute(rows);
  await db.rollUp(iso(args.fromSec));
  console.log(`rewrote ${whole.length} minute(s), and re-summed the daily roll-up from ${iso(args.fromSec)}`);
}

/** Run as a command (not imported by a test). Real paths: the droplet runs it through a symlink. */
function isMain() {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
