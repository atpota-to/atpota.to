// archive.js
// Backfills minutes from Jetstream v2's archive, for history older than the day and a
// half replay.js can reach through the live lookback. It counts exactly as the station
// and replay.js do (minuteCounter: the same Station, clock.js and rows), and writes the
// same rows an hour at a time.
//
//   node src/archive.js --from 2026-10-06T14:00Z --to 2026-10-20T16:50Z [--dry-run] [--overwrite]
//
// On the droplet, from the data folder so it picks up the keys, and niced so the live
// station keeps the CPU it needs:
//
//   cd /root/atpotato-weather && nice -n 10 /opt/node22/bin/node --env-file=.env \
//     /root/atpota-live/atmosphere/src/archive.js --from ... --to ... --dry-run
//
// What the archive holds (Bluesky's us-east instance, from listSegments on 2026-10-20):
// it began on 2026-10-02 with a crawl of every repo, about 1.9 TB of records that
// already existed, finished by 2026-10-06 13:37Z; since then, the live stream, about
// 3.5 GB a day. The crawl is no history of activity (its records are stamped when they
// were crawled), so a range that reaches into it is refused. planRange tells the two
// apart by rate: the live stream runs at about 500 events a second, the crawl at many
// thousands.
//
// Archive minutes come out a little lower than the station's would have: the server
// periodically rewrites older segments to remove records deleted since (a like taken
// back, an account deleted), so as far as the archive knows those were never made. So
// minutes already in Supabase are left alone unless --overwrite (the station's own
// minutes are exact), which also makes a stopped run safe to start again.
//
// Needs JETSTREAM_API_KEY in .env (free, from https://bsky.network/account) and the
// official SDK, @bsky/jetstream, installed once outside the release, since deploys copy
// code only (README.md, "Backfilling from the archive"). Downloads count against the
// key's byte allowance; the SDK waits out a 429 and resumes a cut-off download from
// its byte offset, so a small allowance only makes it slower.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eventOfMessage } from './atmosphere.js';
import { happenedUs, MAX_EARLIER_S } from './clock.js';
import { LEAD_S, minuteCounter, parseArgs as parseReplayArgs, supabaseReplace } from './replay.js';
import { minuteRows, REQUEST_TIMEOUT_MS } from './writer.js';

export const DEFAULT_HOST = 'https://jetstream.us-east.bsky.network';
/** Where the SDK is installed on the droplet (JETSTREAM_SDK_DIR overrides it). */
export const SDK_DIR = '/root/atpotato-weather/jetstream-sdk';
/** At most this much in one run. */
export const MAX_ARCHIVE_WINDOW_S = 31 * 86400;
/** A segment faster than this (events a second, over the time it spans) is the crawl, not the live stream. */
export const LIVE_MAX_RATE = 5000;
/**
 * A silence longer than this in the archive is a hole in it (the network never goes a
 * minute without an event), not a quiet spell: those seconds aren't covered, so the
 * minutes around it come out partial and are left alone. A shorter one is a pause the
 * archive caught up on, and rev placement (clock.js) puts its records back.
 */
export const MAX_SILENCE_S = MAX_EARLIER_S;
/** Tries per Supabase request before giving up on the run. */
export const WRITE_TRIES = 5;

const iso = (second) => new Date(second * 1000).toISOString();
const isoUs = (us) => new Date(Math.floor(us / 1000)).toISOString();

/** Microseconds since the epoch from an event's time ("2026-10-20T21:14:03.067559Z"), or NaN. */
export function timeUsOf(time) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6})\d*)?Z$/.exec(typeof time === 'string' ? time : '');
  if (!m) return NaN;
  return Date.parse(`${m[1]}Z`) * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
}

/** An SDK event as the v1 message the station's counting reads (eventOfMessage, happenedUs). */
export function messageOf(evt) {
  const c = evt?.kind === 'commit' ? evt.commit : null;
  return { kind: evt?.kind, time_us: timeUsOf(evt?.time), commit: c ? { operation: c.operation, collection: c.collection, rev: c.rev } : undefined };
}

/** Every sealed segment the archive lists, in order. */
export async function listSegments({ host, key, fetch = globalThis.fetch }) {
  const segments = [];
  let cursor;
  for (let page = 0; page < 1000; page++) {
    const url = new URL('/xrpc/network.bsky.jetstream.listSegments', host);
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3) });
    if (!res.ok) throw new Error(`listSegments: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body = await res.json();
    segments.push(...(body.segments ?? []));
    if (!body.cursor || !body.segments?.length || body.cursor === cursor) break;
    cursor = body.cursor;
  }
  return segments.sort((a, b) => a.index - b.index);
}

const rateOf = (s) => s.eventCount / Math.max(1, (s.maxWitnessedAt - s.minWitnessedAt) / 1e6);

/**
 * Which part of the archive holds [fromSec, toSec): the seq bounds to ask the SDK for,
 * from the segment list. Throws unless the whole range is live stream, with enough after
 * it for the last minute to settle.
 */
export function planRange(segments, fromSec, toSec) {
  if (!segments.length) throw new Error('the archive lists no segments');
  const crawl = segments.filter((s) => rateOf(s) >= LIVE_MAX_RATE);
  const liveFromUs = crawl.length ? Math.max(...crawl.map((s) => s.maxWitnessedAt)) : segments[0].minWitnessedAt;
  const tipUs = Math.max(...segments.map((s) => s.maxWitnessedAt));
  const startUs = (fromSec - LEAD_S) * 1e6;
  // The last minute is out once the stream is MAX_EARLIER_S past its end.
  const endUs = (toSec + MAX_EARLIER_S + LEAD_S) * 1e6;
  if (startUs < liveFromUs) {
    throw new Error(`--from must be after ${isoUs(liveFromUs + LEAD_S * 1e6)}: before that the archive is ${crawl.length ? 'a crawl of records that already existed, not the live stream' : 'empty'}`);
  }
  if (endUs > tipUs) throw new Error(`--to must be before ${isoUs(tipUs - (MAX_EARLIER_S + LEAD_S) * 1e6)}: the archive's last sealed segment ends at ${isoUs(tipUs)}`);
  const picked = segments.filter((s) => s.maxWitnessedAt >= startUs && s.minWitnessedAt <= endUs);
  if (!picked.length) throw new Error(`the archive has no segment for ${iso(fromSec)} to ${iso(toSec)}`);
  return {
    afterSeq: picked[0].minSeq - 1,
    beforeSeq: picked.at(-1).maxSeq,
    segments: picked.length,
    bytes: picked.reduce((a, s) => a + s.sizeBytes, 0),
  };
}

/**
 * Counts archive events (the SDK's, in seq order) into minutes [fromSec, toSec), handing
 * them to `onMinutes(list)` an hour at a time ({ minuteSec, tally, seconds } each), and
 * waiting for it, so a slow write holds back the download rather than piling up. Stops
 * reading once the last minute is out. Resolves with what it read; `done` false means the
 * events ran out first, and `holes` lists any silence longer than MAX_SILENCE_S.
 */
export async function archiveWindow({ events, fromSec, toSec, onMinutes }) {
  let ready = [];
  const counter = minuteCounter({ fromSec, toSec, onMinute: (minuteSec, tally, seconds) => ready.push({ minuteSec, tally, seconds }) });
  const startUs = (fromSec - LEAD_S) * 1e6;
  const read = { events: 0, firstUs: null, lastUs: null, done: false, holes: [] };
  const hand = async () => {
    const list = ready;
    ready = [];
    await onMinutes(list);
  };
  for await (const evt of events) {
    read.events++;
    const m = messageOf(evt);
    // Anything that can be counted from fromSec on was stamped at fromSec or later.
    if (!(m.time_us >= startUs)) continue;
    read.firstUs ??= m.time_us;
    if (read.lastUs !== null && m.time_us - read.lastUs > MAX_SILENCE_S * 1e6) {
      read.holes.push([read.lastUs, m.time_us]);
      counter.station.endSession();
      counter.station.beginSession();
    }
    read.lastUs = Math.max(read.lastUs ?? m.time_us, m.time_us);
    const done = counter.push(m.time_us, eventOfMessage(m), happenedUs(m));
    if (done || ready.some((r) => (r.minuteSec + 60) % 3600 === 0)) await hand();
    if (done) {
      read.done = true;
      break;
    }
  }
  if (ready.length) await hand();
  return read;
}

/** The official SDK, from where it was installed (not from the release: deploys copy code only). */
export async function loadSdk(dir = SDK_DIR) {
  let entry;
  try {
    entry = createRequire(path.resolve(dir, 'package.json')).resolve('@bsky/jetstream');
  } catch {
    throw new Error(`the Jetstream SDK isn't installed in ${dir}. Install it once (README.md, "Backfilling from the archive"):
  mkdir -p ${dir} && cp /root/atpota-live/atmosphere/archive-sdk/package*.json ${dir}/ && (cd ${dir} && PATH=/opt/node22/bin:$PATH npm ci --ignore-scripts)`);
  }
  return import(pathToFileURL(entry).href);
}

export function parseArgs(argv, nowMs = Date.now()) {
  const overwrite = argv.includes('--overwrite');
  return { ...parseReplayArgs(argv.filter((a) => a !== '--overwrite'), nowMs, { maxWindowS: MAX_ARCHIVE_WINDOW_S }), overwrite };
}

/** Retries a Supabase request a few times (a blip shouldn't end a run that's hours in). */
async function tries(what, fn) {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (err) {
      if (n >= WRITE_TRIES) throw new Error(`${what}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (n - 1)));
    }
  }
}

/**
 * One run: plans the range from the segment list, reads it through the SDK's snapshot,
 * and writes whole minutes an hour at a time (or only prints them, with no `db`). Minutes
 * that already have a row are left alone unless args.overwrite. Each UTC day's app
 * roll-up is re-summed once the day is written.
 */
export async function backfill({ args, host, apiKey, db, Jetstream, fetch = globalThis.fetch, log = console.log, warn = console.warn }) {
  const plan = planRange(await listSegments({ host, key: apiKey, fetch }), args.fromSec, args.toSec);
  log(`backfilling ${iso(args.fromSec)} to ${iso(args.toSec)} from ${host}: ${plan.segments} segments, about ${(plan.bytes / 1e9).toFixed(1)} GB to download${db ? '' : ' (dry run: nothing is written)'}`);
  log('if it stops, run it again with --from at the last hour it printed: minutes already written are left alone');

  const retried = { n: 0, ms: 0 };
  const sum = { written: 0, kept: 0, partial: [] };
  let rollFrom = null;
  const started = Date.now();

  async function onMinutes(list) {
    const rows = list.map((m) => minuteRows(m.minuteSec, m.tally, m.seconds));
    const whole = rows.filter((r) => r.minute.seconds_covered === 60);
    for (const r of rows) if (r.minute.seconds_covered !== 60) sum.partial.push(r.minute.minute);
    const first = list[0].minuteSec;
    const last = list.at(-1).minuteSec;
    let fresh = whole;
    if (db && whole.length) {
      const have = args.overwrite ? new Set() : await tries('reading which minutes exist', () => db.existing(iso(first), iso(last + 60)));
      fresh = whole.filter((r) => !have.has(r.minute.minute));
      sum.kept += whole.length - fresh.length;
      await tries(`writing ${iso(first)}`, () => db.minutes(fresh));
      sum.written += fresh.length;
      if (fresh.length) rollFrom ??= iso(Math.floor(first / 86400) * 86400);
    }
    // A UTC day is done: re-sum its apps (and anything after it, which is little).
    if (db && rollFrom && (last + 60) % 86400 === 0) {
      await tries('re-summing the daily roll-up', () => db.rollUp(rollFrom));
      rollFrom = null;
    }
    const creates = whole.reduce((a, r) => a + r.minute.creates, 0);
    const elsewhere = whole.reduce((a, r) => a + r.minute.elsewhere, 0);
    const apps = new Set(whole.flatMap((r) => r.apps.map((a) => a.domain))).size;
    const doneFrac = (last + 60 - args.fromSec) / (args.toSec - args.fromSec);
    const mins = (Date.now() - started) / 60_000;
    log(
      `${iso(first).slice(0, 16)}Z  ${String(whole.length).padStart(2)}/${list.length} min  ${(creates / Math.max(1, whole.length * 60)).toFixed(1).padStart(6)} records/s  ${String(elsewhere).padStart(6)} elsewhere  ${String(apps).padStart(3)} apps` +
        `${db ? `  ${String(fresh.length).padStart(2)} written` : ''}  ${(doneFrac * 100).toFixed(1).padStart(5)}%  ${Math.round(mins)} min in, about ${Math.round((mins / doneFrac) * (1 - doneFrac))} to go` +
        `${retried.n ? `  (downloads retried ${retried.n} times so far, ${Math.round(retried.ms / 1000)} s waiting)` : ''}`,
    );
  }

  const js = new Jetstream({
    service: host,
    apiKey,
    retry: {
      // Mostly the allowance running out (429): say so now and then, so a slow run doesn't look stuck.
      onRetry(err, info) {
        retried.n++;
        retried.ms += info.delayMs;
        if (info.attempt === 1 || info.attempt % 10 === 0) warn(`archive: ${info.target.name} try ${info.attempt} failed (${err.message}); again in ${Math.round(info.delayMs / 1000)} s`);
      },
    },
  });
  const read = await archiveWindow({
    events: js.snapshot({ raw: true, afterSeq: plan.afterSeq, beforeSeq: plan.beforeSeq, onError: (err) => warn(`archive: ${err.message}`) }),
    fromSec: args.fromSec,
    toSec: args.toSec,
    onMinutes,
  });
  if (db && rollFrom) await tries('re-summing the daily roll-up', () => db.rollUp(rollFrom));

  log(`read ${read.events.toLocaleString('en-US')} events in ${Math.round((Date.now() - started) / 60_000)} min${read.firstUs ? `, ${isoUs(read.firstUs)} to ${isoUs(read.lastUs)}` : ''}`);
  if (db) log(`wrote ${sum.written} minute(s); ${sum.kept} already in Supabase were left alone${args.overwrite ? '' : ' (--overwrite replaces them)'}`);
  if (read.holes.length) log(`the archive has ${read.holes.length} hole(s) longer than ${MAX_SILENCE_S} s: ${read.holes.slice(0, 10).map(([a, b]) => `${isoUs(a)} to ${isoUs(b)}`).join(', ')}${read.holes.length > 10 ? ', …' : ''}`);
  if (sum.partial.length) log(`${sum.partial.length} minute(s) not heard whole, left alone: ${sum.partial.slice(0, 20).join(', ')}${sum.partial.length > 20 ? ', …' : ''}`);
  if (!read.done) throw new Error('the archive ran out before the window was read');
  return { ...sum, read };
}

async function main(argv) {
  const args = parseArgs(argv);
  const apiKey = process.env.JETSTREAM_API_KEY?.trim().replace(/^["']|["']$/g, '');
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey) throw new Error('JETSTREAM_API_KEY must be set (make one at https://bsky.network/account)');
  if (!args.dryRun && !(url && key)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or pass --dry-run)');
  const { Jetstream } = await loadSdk(process.env.JETSTREAM_SDK_DIR?.trim() || SDK_DIR);
  await backfill({ args, host: args.host ?? DEFAULT_HOST, apiKey, db: args.dryRun ? null : supabaseReplace({ url, key }), Jetstream });
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
