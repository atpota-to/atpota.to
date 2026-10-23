// backfill-host-activity.js
// Who was active on each independent host on the days before the station counted it
// (host-activity.js), from Jetstream v2's archive: every commit in a UTC day, looked up
// in the directory of where accounts live, into the same per-host sketches, written to
// atmosphere_host_active_day.
//
//   node src/backfill-host-activity.js --from 2026-10-07 --to 2026-10-22 [--dry-run] [--directory host-directory.json]
//
// On the droplet, from the data folder (it reads the keys from .env and the station's
// host-directory.json from there), niced so the live station keeps the CPU it needs:
//
//   cd /root/atpotato-weather && nice -n 10 /opt/node22/bin/node --env-file=.env \
//     /root/atpota-live/atmosphere/src/backfill-host-activity.js --from 2026-10-07 --to 2026-10-22 --dry-run
//
// It needs what archive.js needs (JETSTREAM_API_KEY, the SDK installed once; README.md,
// "Backfilling from the archive"), and the station's directory: the station saves it after
// its first read of every host, 10 to 30 minutes after it starts. Without one it reads
// every independent host itself first (the same read, 10 to 30 minutes) and saves it.
//
// What it can't know: the directory is where accounts live now, so an account that moved
// between hosts in the window counts for the host it's on now, and one that has since left
// independent hosts (or deleted itself) isn't counted for the days it was there. Both are
// a few hundred accounts against tens of thousands active, and the PLC watch shows how
// many (atmosphere_plc_day). The archive also drops records deleted since, as archive.js
// says; an account whose every record that day was deleted doesn't count.
//
// Whole UTC days, and today as far as the archive goes (its last sealed segment, usually
// within the hour): the morning before the station started counting. Each day is merged
// with whatever rows it already has, and the station merges what's there before each of
// its writes, so the two add up, a stopped run can simply be started again, and running a
// day twice changes nothing. With today in the range it writes today once more after the
// station's next census (TODAY_AGAIN_MS later), in case the station read today's rows just
// before the backfill wrote and wrote just after. The archive is about 3.5 GB a day to
// download (it counts against the key's allowance), a day takes a few minutes to read.
//
// It steps aside for the live station. Every CHECK_EVERY_MS it asks the station's
// /healthz (STATION_HEALTH_URL, default the droplet's own); when the station has fallen
// behind it stops reading, which closes its download, waits until the station has been
// healthy for RESUME_AFTER_MS, and picks up a segment before where it stopped (counting
// an account twice changes nothing). Where no station answers (a laptop) it just reads.
// Stop it with Ctrl-C, never `kill -STOP`: a stopped process holds its download open, and
// on 2026-10-22 one did, filled the machine's network buffers and starved every
// connection on it, the station's too, for four hours.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST, listSegments, loadSdk, MAX_RETRY_WAIT_MS, messageOf, planRange, SDK_DIR } from './archive.js';
import { MAX_EARLIER_S } from './clock.js';
import { ActivityDay, HostDirectory, readDirectory } from './host-activity.js';
import { registerOf } from './hll.js';
import { DEFAULT_RELAY, fetchHosts } from './hosts.js';
import { LEAD_S } from './replay.js';
import { supabaseRest } from './supabase.js';

/** At most this many days in one run. */
export const MAX_DAYS = 31;
/** A day is done once the stream is this far past its end (records stamped a little late still count for it). */
export const SETTLE_S = 120;
/** Today is written again after this long: past the station's next census, every 10 minutes. */
export const TODAY_AGAIN_MS = 11 * 60_000;
/** How often it asks whether the station is keeping up. */
export const CHECK_EVERY_MS = 30_000;
/** After stepping aside, the station has to have been healthy this long before it reads again. */
export const RESUME_AFTER_MS = 2 * 60_000;
export const STATION_HEALTH_URL = 'http://127.0.0.1:8790/healthz';

/**
 * Whether the live station has fallen behind: a reason ("lag 42 s, 18 of 60 s heard"),
 * or null when it's keeping up or there's no station to ask.
 */
export async function stationBehind(fetchImpl = globalThis.fetch, url = STATION_HEALTH_URL) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return null;
  }
  if (res.ok) return null;
  const h = await res.json().catch(() => ({}));
  if (h.connected === false) return 'disconnected';
  return `lag ${h.lagSeconds ?? '?'} s, ${h.covered60 ?? '?'} of 60 s heard`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_S = 86_400;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOf = (day) => Date.parse(`${day}T00:00:00Z`) / 1000;

export function parseArgs(argv, nowMs = Date.now()) {
  const out = { from: null, to: null, dryRun: false, directory: 'host-directory.json', host: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--directory') out.directory = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!DAY_RE.test(out.from ?? '') || !DAY_RE.test(out.to ?? '')) throw new Error('--from and --to must be days (YYYY-MM-DD, UTC)');
  if (out.to < out.from) throw new Error('--to must not be before --from');
  if (out.to > dayOf(nowMs)) throw new Error(`--to must not be after today (${dayOf(nowMs)})`);
  const days = [];
  for (let s = startOf(out.from); s <= startOf(out.to); s += DAY_S) days.push(dayOf(s * 1000));
  if (days.length > MAX_DAYS) throw new Error(`at most ${MAX_DAYS} days in one run`);
  return { ...out, days };
}

/** What a count has so far, kept across a pause. */
export function newCount() {
  return { open: new Map(), handed: new Set(), read: { events: 0, commits: 0, counted: 0, skipped: 0, firstMs: null, lastMs: null, paused: null } };
}

/**
 * Counts archive events (the SDK's, in seq order) into a day's sketches for each of
 * `days`, handing each to `onDay(day)` once the stream is SETTLE_S past its end (and
 * waiting for it), the last one when the events run out. Resolves with what it read.
 * With `pauseIf`, asks it every CHECK_EVERY_MS; when it gives a reason, calls `abort`
 * (which has to cut the downloads off), stops reading and resolves with `paused` set to
 * it. Pass the same `count` to pick up again: days already handed over aren't counted
 * again.
 */
export async function countDays({ events, days, directory, onDay, skip = [], count = newCount(), pauseIf = null, abort = () => {}, clock = Date.now }) {
  const wanted = new Set(days);
  const { open, handed, read } = count;
  read.paused = null;
  const lastEnd = (startOf(days.at(-1)) + DAY_S + SETTLE_S) * 1000;
  let checkAt = clock() + CHECK_EVERY_MS;
  const hand = async (day, d) => {
    open.delete(day);
    handed.add(day);
    await onDay(d);
  };
  for await (const evt of events) {
    if (pauseIf && clock() >= checkAt) {
      checkAt = clock() + CHECK_EVERY_MS;
      const why = await pauseIf();
      if (why) {
        read.paused = why;
        // before leaving the loop: closing `events` alone waits for its downloads to finish
        abort();
        return read;
      }
    }
    read.events++;
    const m = messageOf(evt);
    const ms = m.time_us / 1000;
    if (!Number.isFinite(ms)) continue;
    read.firstMs ??= ms;
    read.lastMs = Math.max(read.lastMs ?? ms, ms);
    // days well behind the stream are done
    for (const [day, d] of open) {
      if (read.lastMs >= (startOf(day) + DAY_S + SETTLE_S) * 1000) await hand(day, d);
    }
    if (read.lastMs >= lastEnd) break;
    if (m.kind !== 'commit' || typeof m.did !== 'string') continue;
    // a short dense stretch (planRange's skip): a re-crawl or a flushed backlog, not who was active then
    if (skip.some(([from, to]) => m.time_us >= from && m.time_us <= to)) {
      read.skipped++;
      continue;
    }
    read.commits++;
    const day = dayOf(ms);
    if (!wanted.has(day) || handed.has(day)) continue;
    const host = directory.hostOf(m.did);
    if (!host) continue;
    let d = open.get(day);
    if (!d) open.set(day, (d = new ActivityDay(day)));
    d.add(host, registerOf(m.did));
    read.counted++;
  }
  for (const [day, d] of [...open]) await hand(day, d);
  return read;
}

/** The directory: the station's saved one, or a fresh read of every independent host (saved for next time). */
export async function directoryFor({ file, fetchImpl = (u, i) => fetch(u, i), relay = DEFAULT_RELAY, log = console.log }) {
  try {
    const d = HostDirectory.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (d && d.size > 0) {
      log(`using the directory in ${file}: ${d.size.toLocaleString('en-US')} accounts on independent hosts, read ${d.readAt ? new Date(d.readAt).toISOString() : 'at an unknown time'}`);
      return d;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  log(`no directory in ${file}: reading every independent host's accounts (10 to 30 minutes)`);
  const census = await fetchHosts(fetchImpl, relay);
  const d = await readDirectory({ fetchImpl, census, log: { info: (m, f) => log(`${m} ${JSON.stringify(f)}`) } });
  fs.writeFileSync(file, JSON.stringify(d));
  return d;
}

/** Sleeps until `behind()` has said nothing for RESUME_AFTER_MS. */
async function untilCaughtUp(behind, sleep) {
  let good = 0;
  while (good < RESUME_AFTER_MS) {
    await sleep(CHECK_EVERY_MS);
    good = (await behind()) ? 0 : good + CHECK_EVERY_MS;
  }
}

export async function backfillActivity({ args, host, apiKey, rest, Jetstream, directory, fetch = globalThis.fetch, log = console.log, warn = console.warn, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), behind = null }) {
  const fromSec = startOf(args.days[0]);
  const segments = await listSegments({ host, key: apiKey, fetch });
  // today goes as far as the archive does: its last sealed segment, less the time the last minute needs to settle
  const today = dayOf(now());
  const tipSec = Math.floor(Math.max(...segments.map((x) => x.maxWitnessedAt)) / 1e6) - MAX_EARLIER_S - LEAD_S - 1;
  const withToday = args.days.at(-1) === today;
  const toSec = withToday ? Math.min(startOf(today) + DAY_S, tipSec) : startOf(args.days.at(-1)) + DAY_S;
  if (withToday && toSec <= startOf(today)) throw new Error(`the archive doesn't reach today yet (its last sealed segment ends ${new Date(tipSec * 1000).toISOString()}): try again later, or end at yesterday`);
  const plan = planRange(segments, fromSec, toSec, { skipShort: true });
  for (const [from, to, index] of plan.skip) log(`leaving out segment #${index}, ${new Date(from / 1000).toISOString()} to ${new Date(to / 1000).toISOString()}: too dense for the live stream (a re-crawl or a flushed backlog), and too short to matter`);
  if (withToday) log(`today is counted up to ${new Date(toSec * 1000).toISOString()}, where the archive ends for now; the station counts the rest`);
  log(`counting who was active on independent hosts, ${args.days[0]} to ${args.days.at(-1)} (${args.days.length} day${args.days.length === 1 ? '' : 's'}): ${plan.segments} segments, about ${(plan.bytes / 1e9).toFixed(1)} GB to download${rest ? '' : ' (dry run: nothing is written)'}`);
  const started = Date.now();
  const written = [];
  let todayRows = null;

  async function onDay(d) {
    if (rest) {
      // merged with what's there: a second run of a day changes nothing
      d.merge(await rest.getAll(`atmosphere_host_active_day?day=eq.${d.day}&select=day,hostname,sketch&order=hostname`));
      await rest.upsert('atmosphere_host_active_day', 'day,hostname', d.rows());
      if (d.day === today) todayRows = d.rows();
    }
    const rows = d.rows();
    const top = rows.slice(1).sort((a, b) => b.dids - a.dids).slice(0, 3).map((r) => `${r.hostname} ${r.dids.toLocaleString('en-US')}`);
    written.push({ day: d.day, independent: rows[0].dids, hosts: rows.length - 1 });
    log(`${d.day}  ${rows[0].dids.toLocaleString('en-US').padStart(7)} active on ${String(rows.length - 1).padStart(4)} independent hosts  (${top.join(', ')})${rest ? '  written' : ''}  ${Math.round((Date.now() - started) / 60_000)} min in`);
  }

  const js = new Jetstream({
    service: host,
    apiKey,
    retry: {
      maxDelayMs: MAX_RETRY_WAIT_MS,
      onRetry(err, info) {
        if (info.attempt === 1 || info.attempt % 10 === 0) warn(`archive: ${info.target.name} try ${info.attempt} failed (${err.message}); again in ${Math.round(info.delayMs / 1000)} s`);
      },
    },
  });
  const count = newCount();
  let afterSeq = plan.afterSeq;
  let read;
  for (;;) {
    // Stepping aside has to abort the snapshot: the SDK closes a snapshot left early by
    // finishing every download in flight first (the segment it's on and the next), and
    // waiting out any 429 on them, which on 2026-10-23 kept it downloading while the
    // station starved. Aborted, it drops them.
    const stop = new AbortController();
    read = await countDays({
      events: js.snapshot({ raw: true, afterSeq, beforeSeq: plan.beforeSeq, signal: stop.signal, onError: (err) => warn(`archive: ${err.message}`) }),
      days: args.days,
      directory,
      onDay,
      skip: plan.skip,
      count,
      pauseIf: behind,
      abort: () => stop.abort(),
      clock: now,
    });
    if (!read.paused) break;
    // a segment before the one it stopped in: what's read twice counts once
    const at = (read.lastMs ?? 0) * 1000;
    const i = segments.findLastIndex((x) => x.minWitnessedAt <= at);
    const from = segments[Math.max(0, i - 1)];
    afterSeq = Math.max(plan.afterSeq, from.minSeq - 1);
    log(`the live station has fallen behind (${read.paused}): stopped downloading until it has caught up`);
    await untilCaughtUp(behind, sleep);
    log(`the station has caught up: picking up again at segment #${from.index}`);
  }
  log(`read ${read.events.toLocaleString('en-US')} events (${read.commits.toLocaleString('en-US')} commits, ${read.counted.toLocaleString('en-US')} by accounts on independent hosts${read.skipped ? `, ${read.skipped.toLocaleString('en-US')} left out in dense stretches` : ''}) in ${Math.round((Date.now() - started) / 60_000)} min`);
  const missing = args.days.filter((day) => !written.some((w) => w.day === day));
  if (missing.length) throw new Error(`the archive ran out before ${missing.join(', ')}`);
  if (withToday && rest) {
    log(`writing today once more in ${Math.round(TODAY_AGAIN_MS / 60_000)} minutes, after the station's next write (in case the two crossed)`);
    await sleep(TODAY_AGAIN_MS);
    const again = new ActivityDay(today);
    again.merge(todayRows ?? []);
    again.merge(await rest.getAll(`atmosphere_host_active_day?day=eq.${today}&select=day,hostname,sketch&order=hostname`));
    await rest.upsert('atmosphere_host_active_day', 'day,hostname', again.rows());
    log(`${today}  ${again.rows()[0].dids.toLocaleString('en-US').padStart(7)} active on independent hosts so far today  written again`);
  }
  return { written, read };
}

async function main(argv) {
  const args = parseArgs(argv);
  const apiKey = process.env.JETSTREAM_API_KEY?.trim().replace(/^["']|["']$/g, '');
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey) throw new Error('JETSTREAM_API_KEY must be set (make one at https://bsky.network/account)');
  if (!args.dryRun && !(url && key)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or pass --dry-run)');
  const directory = await directoryFor({ file: args.directory, relay: process.env.RELAY_URL?.trim() || DEFAULT_RELAY });
  const { Jetstream } = await loadSdk(process.env.JETSTREAM_SDK_DIR?.trim() || SDK_DIR);
  const rest = args.dryRun ? null : supabaseRest({ url, key });
  const healthUrl = process.env.STATION_HEALTH_URL?.trim() || STATION_HEALTH_URL;
  await backfillActivity({ args, host: args.host ?? DEFAULT_HOST, apiKey, rest, Jetstream, directory, behind: () => stationBehind(globalThis.fetch, healthUrl) });
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
      console.error(err?.message ?? err);
      process.exit(1);
    },
  );
}
