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
// before it come back partial and are left alone. Bluesky's hosts also hang up on a long
// replay (on 2026-10-21, after about 95 s and 300 MB: some 20 minutes of the firehose), so
// when one does, it reconnects a little before the last event it got and carries on,
// dropping what it already counted, as the live station does. Older history comes from Jetstream
// v2's archive: archive.js, which counts with the same minuteCounter.
//
// Rewriting replaces the minute's row and all its app rows (a recount can drop an app the
// glitch put there), then re-sums the hourly and daily roll-ups from --from on. It's safe
// while the live station runs: the station never goes back to a minute it has written,
// and --to may not be closer than WRITE_LAG_S to now, so the two never write the same
// minute.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { accountOf } from './accounts.js';
import { eventOfMessage } from './atmosphere.js';
import { happenedUs, MAX_EARLIER_S } from './clock.js';
import { DEFAULT_URLS, REWIND_US, withCursor } from './jetstream.js';
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
/** Wait this long before picking a replay back up after Jetstream hangs up. */
export const RESUME_DELAY_MS = 1000;

const iso = (second) => new Date(second * 1000).toISOString();

/**
 * Counts a stream into minutes [fromSec, toSec) exactly as the live station does, and
 * calls onMinute(minuteSec, tally, seconds, accounts) for each as soon as nothing more
 * can land in it. Feed it messages in stream order with push(timeUs, event, atUs,
 * account), from a little before fromSec; push returns true once every minute is out.
 * Shared with archive.js.
 */
export function minuteCounter({ fromSec, toSec, onMinute }) {
  // The station's clock follows the stream, so an hour-old replay isn't "too old".
  const clock = { ms: (fromSec - LEAD_S) * 1000 };
  const station = new Station({ now: () => clock.ms });
  station.beginSession();
  let next = fromSec;
  return {
    station,
    push(timeUs, event, atUs, account = null) {
      if (next >= toSec) return true;
      if (typeof timeUs === 'number' && Number.isFinite(timeUs)) clock.ms = Math.max(clock.ms, timeUs / 1000 + 1000);
      station.ingest(timeUs, event, atUs, account);
      while (next < toSec && station.coveredThrough !== null && station.coveredThrough >= next + 59 + MAX_EARLIER_S) {
        const { tally, seconds, accounts } = station.minute(next);
        onMinute(next, tally, seconds, accounts);
        next += 60;
        // Keep memory flat over a long replay: nothing can land before `next` any more.
        for (const second of station.buckets.keys()) if (second < next) station.buckets.delete(second);
      }
      return next >= toSec;
    },
  };
}

/**
 * Reads Jetstream from just before `fromSec` until the stream is MAX_EARLIER_S past
 * `toSec`, and calls onMinute(minuteSec, tally, seconds, accounts) for each minute in
 * [fromSec, toSec) as soon as nothing more can land in it. Resolves with the time_us of
 * the first event Jetstream sent (later than asked means its lookback ends there).
 *
 * If Jetstream hangs up partway, it reconnects REWIND_US before the last event it got,
 * drops everything up to that event, and carries on (onResume({ atUs, resumes }) hears
 * about it). It only gives up when a connection brings nothing new.
 */
export function replayWindow({
  host,
  fromSec,
  toSec,
  onMinute,
  onResume = () => {},
  open = (url) => new WebSocket(url),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  resumeDelayMs = RESUME_DELAY_MS,
}) {
  return new Promise((resolve, reject) => {
    let counter = null;
    let firstUs = null;
    /** The last event counted, on any connection. */
    let lastUs = null;
    let resumes = 0;
    let done = false;
    let quiet = null;
    let sock = null;

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

    function connect(cursorUs) {
      const self = open(withCursor(host, cursorUs));
      sock = self;
      // a connection picking up a replay drops what an earlier one already counted
      const dropThroughUs = lastUs;
      let fresh = false;
      // a connection that never opens goes quiet too
      listen();

      // the socket that hung up is ignored from here on
      const hungUp = (why) => {
        if (done || sock !== self) return;
        if (!fresh) return finish(new Error(why));
        resumes++;
        clearTimer(quiet);
        try {
          self.close();
        } catch {
          // already gone
        }
        onResume({ atUs: lastUs, resumes });
        setTimer(() => {
          if (!done) connect(lastUs - REWIND_US);
        }, resumeDelayMs);
        sock = null;
      };

      self.onopen = () => {
        if (done || sock !== self) return;
        counter ??= minuteCounter({ fromSec, toSec, onMinute });
        listen();
      };
      self.onmessage = (msg) => {
        if (done || sock !== self || !counter) return;
        listen();
        let m;
        try {
          m = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString('utf8'));
        } catch {
          return;
        }
        if (typeof m?.time_us !== 'number') return;
        if (dropThroughUs !== null && m.time_us <= dropThroughUs) return;
        fresh = true;
        if (firstUs === null) firstUs = m.time_us;
        if (lastUs === null || m.time_us > lastUs) lastUs = m.time_us;
        if (counter.push(m.time_us, eventOfMessage(m), happenedUs(m), accountOf(m))) finish(null);
      };
      self.onerror = (e) => hungUp(`jetstream error: ${e?.message ?? 'unknown'}`);
      self.onclose = () => hungUp('jetstream closed before the window was read');
    }

    connect(Math.round((fromSec - LEAD_S) * 1e6));
  });
}

/** Rewrites minutes in Supabase: their rows, then all their app rows. Throws on anything but success. */
export function supabaseReplace({ url, key, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  async function call(method, path, body, prefer, timeoutMs = REQUEST_TIMEOUT_MS) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method,
      headers: prefer ? { ...headers, prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return method === 'GET' ? res.json() : null;
  }
  const db = {
    /** Rewrites a batch of minutes (an hour, say) in three requests. */
    async minutes(list) {
      if (!list.length) return;
      await call('POST', 'atmosphere_minute?on_conflict=minute', list.map((r) => r.minute), 'resolution=merge-duplicates,return=minimal');
      await call('DELETE', `atmosphere_minute_app?minute=in.(${list.map((r) => encodeURIComponent(r.minute.minute)).join(',')})`, undefined, 'return=minimal');
      const apps = list.flatMap((r) => r.apps);
      if (apps.length) await call('POST', 'atmosphere_minute_app?on_conflict=minute,domain', apps, 'resolution=merge-duplicates,return=minimal');
    },
    async minute(rows) {
      await db.minutes([rows]);
    },
    /** The minutes in [fromIso, toIso) that already have a row (at most an hour's worth). */
    async existing(fromIso, toIso) {
      const rows = await call('GET', `atmosphere_minute?select=minute&minute=gte.${encodeURIComponent(fromIso)}&minute=lt.${encodeURIComponent(toIso)}`);
      return new Set(rows.map((r) => new Date(r.minute).toISOString()));
    },
    /** Re-sums the hourly and daily per-app roll-ups from `sinceIso` on (sql/atmosphere_retention.sql). */
    async rollUp(sinceIso) {
      await call('POST', 'rpc/atmosphere_roll_up_hour_apps', { since: sinceIso }, undefined, 60_000);
      await call('POST', 'rpc/atmosphere_roll_up_day_apps', { since: sinceIso }, undefined, 60_000);
    },
  };
  return db;
}

export function parseArgs(argv, nowMs = Date.now(), { maxWindowS = MAX_WINDOW_S } = {}) {
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
  if (toSec - fromSec > maxWindowS) throw new Error(`at most ${maxWindowS / 3600} hours in one run`);
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
    onResume: ({ atUs, resumes }) => console.log(`jetstream hung up at ${new Date(atUs / 1000).toISOString()}; picking it back up (${resumes})`),
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
  for (let i = 0; i < whole.length; i += 60) await db.minutes(whole.slice(i, i + 60));
  await db.rollUp(iso(args.fromSec));
  console.log(`rewrote ${whole.length} minute(s), and re-summed the hourly and daily roll-ups from ${iso(args.fromSec)}`);
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
