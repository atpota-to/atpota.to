// backfill-host-activity.js
// Who was active on each independent host on the days before the station counted it
// (host-activity.js), from Jetstream v2's archive: every commit in a UTC day, looked up
// in the directory of where accounts live, into the same per-host sketches, written to
// atmosphere_host_active_day.
//
//   node src/backfill-host-activity.js --from 2026-10-07 --to 2026-10-21 [--dry-run] [--directory host-directory.json]
//
// On the droplet, from the data folder (it reads the keys from .env and the station's
// host-directory.json from there), niced so the live station keeps the CPU it needs:
//
//   cd /root/atpotato-weather && nice -n 10 /opt/node22/bin/node --env-file=.env \
//     /root/atpota-live/atmosphere/src/backfill-host-activity.js --from 2026-10-07 --to 2026-10-21 --dry-run
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
// Days only, whole ones, before today: the station keeps today's sketches in memory and
// rewrites them every census, so a backfill's additions to today wouldn't last. Each day
// is merged with whatever rows it already has, so a stopped run can simply be started
// again, and running a day twice changes nothing. The archive is about 3.5 GB a day to
// download (it counts against the key's allowance), a day takes a few minutes to read.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST, listSegments, loadSdk, MAX_RETRY_WAIT_MS, messageOf, planRange, SDK_DIR } from './archive.js';
import { ActivityDay, HostDirectory, readDirectory } from './host-activity.js';
import { registerOf } from './hll.js';
import { DEFAULT_RELAY, fetchHosts } from './hosts.js';
import { supabaseRest } from './supabase.js';

/** At most this many days in one run. */
export const MAX_DAYS = 31;
/** A day is done once the stream is this far past its end (records stamped a little late still count for it). */
export const SETTLE_S = 120;

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
  if (out.to >= dayOf(nowMs)) throw new Error(`--to must be before today (${dayOf(nowMs)}): the station counts today itself`);
  const days = [];
  for (let s = startOf(out.from); s <= startOf(out.to); s += DAY_S) days.push(dayOf(s * 1000));
  if (days.length > MAX_DAYS) throw new Error(`at most ${MAX_DAYS} days in one run`);
  return { ...out, days };
}

/**
 * Counts archive events (the SDK's, in seq order) into a day's sketches for each of
 * `days`, handing each to `onDay(day)` once the stream is SETTLE_S past its end (and
 * waiting for it), the last one when the events run out. Resolves with what it read.
 */
export async function countDays({ events, days, directory, onDay }) {
  const wanted = new Set(days);
  const open = new Map();
  const read = { events: 0, commits: 0, counted: 0, firstMs: null, lastMs: null };
  const lastEnd = (startOf(days.at(-1)) + DAY_S + SETTLE_S) * 1000;
  for await (const evt of events) {
    read.events++;
    const m = messageOf(evt);
    const ms = m.time_us / 1000;
    if (!Number.isFinite(ms)) continue;
    read.firstMs ??= ms;
    read.lastMs = Math.max(read.lastMs ?? ms, ms);
    // days well behind the stream are done
    for (const [day, d] of open) {
      if (read.lastMs >= (startOf(day) + DAY_S + SETTLE_S) * 1000) {
        open.delete(day);
        await onDay(d);
      }
    }
    if (read.lastMs >= lastEnd) break;
    if (m.kind !== 'commit' || typeof m.did !== 'string') continue;
    read.commits++;
    const day = dayOf(ms);
    if (!wanted.has(day)) continue;
    const host = directory.hostOf(m.did);
    if (!host) continue;
    let d = open.get(day);
    if (!d) open.set(day, (d = new ActivityDay(day)));
    d.add(host, registerOf(m.did));
    read.counted++;
  }
  for (const d of open.values()) await onDay(d);
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

export async function backfillActivity({ args, host, apiKey, rest, Jetstream, directory, fetch = globalThis.fetch, log = console.log, warn = console.warn }) {
  const fromSec = startOf(args.days[0]);
  const toSec = startOf(args.days.at(-1)) + DAY_S;
  const plan = planRange(await listSegments({ host, key: apiKey, fetch }), fromSec, toSec);
  log(`counting who was active on independent hosts, ${args.days[0]} to ${args.days.at(-1)} (${args.days.length} day${args.days.length === 1 ? '' : 's'}): ${plan.segments} segments, about ${(plan.bytes / 1e9).toFixed(1)} GB to download${rest ? '' : ' (dry run: nothing is written)'}`);
  const started = Date.now();
  const written = [];

  async function onDay(d) {
    if (rest) {
      // merged with what's there: a second run of a day changes nothing
      d.merge(await rest.getAll(`atmosphere_host_active_day?day=eq.${d.day}&select=day,hostname,sketch&order=hostname`));
      await rest.upsert('atmosphere_host_active_day', 'day,hostname', d.rows());
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
  const read = await countDays({
    events: js.snapshot({ raw: true, afterSeq: plan.afterSeq, beforeSeq: plan.beforeSeq, onError: (err) => warn(`archive: ${err.message}`) }),
    days: args.days,
    directory,
    onDay,
  });
  log(`read ${read.events.toLocaleString('en-US')} events (${read.commits.toLocaleString('en-US')} commits, ${read.counted.toLocaleString('en-US')} by accounts on independent hosts) in ${Math.round((Date.now() - started) / 60_000)} min`);
  const missing = args.days.filter((day) => !written.some((w) => w.day === day));
  if (missing.length) throw new Error(`the archive ran out before ${missing.join(', ')}`);
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
  await backfillActivity({ args, host: args.host ?? DEFAULT_HOST, apiKey, rest, Jetstream, directory });
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
