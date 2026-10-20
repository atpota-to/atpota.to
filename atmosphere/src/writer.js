// writer.js
// One row a minute to Supabase: atmosphere_minute (the whole firehose, summed) and one
// atmosphere_minute_app row per app outside Bluesky. Counts, not rates: rates and the
// diversity index for any range come from dividing sums, so rollups stay exact.
//
// A minute is sealed SETTLE_S after it ends, once the stream has got MAX_EARLIER_S past
// it: a record goes in the second its rev says, up to a minute before Jetstream's stamp
// (clock.js), so until then a backlog after a pause could still add to it, and a
// reconnect's replay could still fill it. If the stream never gets there, it is sealed
// with whatever it has once it is GIVE_UP_S old, before its seconds are pruned. A minute
// with no covered seconds is never written.
//
// Writes are upserts on the primary keys, so a retry or a restart never duplicates a
// minute. Sealed rows wait in memory, oldest first, while Supabase is down.

import { appDomain, COLLECTIONS, isBluesky, splitOf } from './atmosphere.js';
import { MAX_EARLIER_S } from './clock.js';
import { RETAIN_SECONDS } from './station.js';

export const SETTLE_S = 15;
export const GIVE_UP_S = RETAIN_SECONDS - 300;
/** A day of minutes. Past that the oldest are dropped, loudly. */
export const MAX_PENDING = 1440;
export const RETRY_MS = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
export const REQUEST_TIMEOUT_MS = 10_000;
/** A minute Supabase rejects as bad data (400, 422) is dropped after this many tries, so it can't block the ones behind it. */
export const MAX_REJECTED_TRIES = 3;

const iso = (second) => new Date(second * 1000).toISOString();

/** The rows for one minute: { minute: atmosphere_minute row, apps: atmosphere_minute_app rows }. */
export function minuteRows(minuteSec, tally, seconds) {
  const { creates, bluesky, elsewhere } = splitOf(tally);
  const apps = new Map();
  for (const [nsid, count] of tally.creates) {
    if (isBluesky(nsid)) continue;
    const domain = appDomain(nsid);
    const app = apps.get(domain) ?? { creates: 0, collections: [] };
    app.creates += count;
    app.collections.push([nsid, count]);
    apps.set(domain, app);
  }
  const minute = iso(minuteSec);
  return {
    minute: {
      minute,
      seconds_covered: seconds,
      creates,
      bluesky,
      elsewhere,
      posts: tally.creates.get(COLLECTIONS.posts) ?? 0,
      likes: tally.creates.get(COLLECTIONS.likes) ?? 0,
      reposts: tally.creates.get(COLLECTIONS.reposts) ?? 0,
      follows: tally.creates.get(COLLECTIONS.follows) ?? 0,
      updates: tally.updates,
      deletes: tally.deletes,
      identity: tally.identity,
      account: tally.account,
      collections: tally.creates.size,
      apps: apps.size,
    },
    apps: [...apps]
      .sort((a, b) => b[1].creates - a[1].creates)
      .map(([domain, a]) => ({
        minute,
        domain,
        creates: a.creates,
        collections: a.collections
          .sort((x, y) => y[1] - x[1])
          .slice(0, 3)
          .map(([nsid]) => nsid),
      })),
  };
}

/** Upserts one minute's rows through PostgREST. Throws on anything but success. */
export function supabaseUpsert({ url, key, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    prefer: 'resolution=merge-duplicates,return=minimal',
  };
  async function post(path, body) {
    const res = await fetch(`${base}/rest/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`), { status: res.status });
    }
  }
  return async (rows) => {
    // The minute first: app rows reference it.
    await post('atmosphere_minute?on_conflict=minute', [rows.minute]);
    if (rows.apps.length) await post('atmosphere_minute_app?on_conflict=minute,domain', rows.apps);
  };
}

export function createWriter({ station, upsert, log, startMinute, now = () => Date.now(), onWritten = () => {} }) {
  let next = startMinute;
  const pending = [];
  let failures = 0;
  let retryAt = 0;
  let inFlight = null;

  function seal(nowSec) {
    const oldest = Math.ceil((nowSec - RETAIN_SECONDS + 60) / 60) * 60;
    if (next < oldest) {
      log.warn('minutes skipped: older than the hour kept', { from: iso(next), to: iso(oldest) });
      next = oldest;
    }
    while (next + 60 + SETTLE_S <= nowSec) {
      const streamPast = station.coveredThrough !== null && station.coveredThrough >= next + 59 + MAX_EARLIER_S;
      if (!streamPast && nowSec - (next + 60) < GIVE_UP_S) break;
      const { tally, seconds } = station.minute(next);
      if (seconds > 0) pending.push(minuteRows(next, tally, seconds));
      else log.info('minute not covered, not written', { minute: iso(next) });
      next += 60;
    }
    while (pending.length > MAX_PENDING) {
      const dropped = pending.shift();
      log.error('minute dropped: unwritten for too long', { minute: dropped.minute.minute });
    }
  }

  async function flush() {
    while (pending.length) {
      const rows = pending[0];
      try {
        await upsert(rows);
      } catch (err) {
        failures++;
        if ((err.status === 400 || err.status === 422) && failures >= MAX_REJECTED_TRIES) {
          log.error('minute dropped: rejected by supabase', { minute: rows.minute.minute, err });
          pending.shift();
          failures = 0;
          continue;
        }
        const wait = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)];
        retryAt = now() + wait;
        log.warn('minute write failed', { minute: rows.minute.minute, err, retryInMs: wait, pending: pending.length });
        return;
      }
      pending.shift();
      failures = 0;
      const m = rows.minute;
      log.info('minute written', { minute: m.minute, seconds: m.seconds_covered, creates: m.creates, elsewhere: m.elsewhere, apps: rows.apps.length });
      onWritten(Date.parse(m.minute) / 1000);
    }
  }

  return {
    /** Seals what's ready and writes what's pending; call it every second or so. */
    async tick() {
      seal(now() / 1000);
      if (inFlight || !pending.length || now() < retryAt) return inFlight;
      inFlight = flush().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    get pending() {
      return pending.length;
    },
    get next() {
      return next;
    },
  };
}
