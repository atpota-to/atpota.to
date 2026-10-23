// repair.js
// The station fills in its own gaps. Minutes it couldn't hear whole (a slow network, a
// restart, Jetstream hanging up) are written short or not at all; Jetstream keeps a
// lookback of about a day and a half, so they can be heard again later. Every
// REPAIR_EVERY_MS, once the station has been healthy for HEALTHY_FOR_MS, it looks for
// minutes in the last LOOKBACK_S that are missing or short, takes the oldest run of them
// (at most MAX_RUN_S) and replays it: replay.js, as a child process at a lower priority,
// so the replay's download and counting stay out of the live station's way and its
// memory goes when it's done. Under systemd it runs in a scope of its own (systemd-run
// --scope), outside the station's MemoryMax and CPUQuota, with limits of its own.
// replay.js only rewrites a minute it heard whole.
//
// If the station falls behind while a replay runs, the replay is stopped (a SIGTERM,
// which closes its download; never SIGSTOP, which holds the download open and starves
// the whole machine's network: 2026-10-22) and tried again after AFTER_ABORT_MS. A minute
// that comes back short MAX_TRIES times is past Jetstream's lookback, or never was in it,
// and is left as it is.
//
// The hour and day account sketches aren't rewritten (replay.js says why); the minute rows
// carry their own active accounts.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRITE_LAG_S } from './replay.js';

/** How far back to look: inside Jetstream's lookback, with room to finish a replay. */
export const LOOKBACK_S = 30 * 3600;
export const REPAIR_EVERY_MS = 10 * 60_000;
/** The station has to have been healthy this long before a replay starts. */
export const HEALTHY_FOR_MS = 5 * 60_000;
/** At most this much in one replay. */
export const MAX_RUN_S = 2 * 3600;
/** A minute still short after this many replays is left alone. */
export const MAX_TRIES = 2;
/** After a replay stopped because the station fell behind, wait this long. */
export const AFTER_ABORT_MS = 30 * 60_000;

const iso = (second) => new Date(second * 1000).toISOString();
const REPLAY_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'replay.js');

/** The minutes in [fromSec, toSec) with no row, or a row short of 60 seconds. */
export function gapsIn(rows, fromSec, toSec) {
  const covered = new Map(rows.map((r) => [Math.floor(Date.parse(r.minute) / 1000), r.seconds_covered]));
  const gaps = [];
  for (let m = fromSec; m < toSec; m += 60) if ((covered.get(m) ?? 0) < 60) gaps.push(m);
  return gaps;
}

/** Consecutive minutes as [fromSec, toSec) runs, oldest first. */
export function runsOf(minutes) {
  const runs = [];
  for (const m of minutes) {
    const run = runs.at(-1);
    if (run && run[1] === m) run[1] = m + 60;
    else runs.push([m, m + 60]);
  }
  return runs;
}

/**
 * How replay.js is started: in a scope of its own under systemd (INVOCATION_ID is set for
 * a unit's processes), else just niced.
 */
export function replayCommand(args, env = process.env) {
  const node = [process.execPath, REPLAY_JS, ...args];
  if (env.INVOCATION_ID) return ['systemd-run', ['--scope', '--quiet', '--collect', '--nice=10', '-p', 'MemoryMax=320M', '-p', 'CPUQuota=50%', '--', ...node]];
  return ['nice', ['-n', '10', ...node]];
}

/** Runs replay.js for [fromSec, toSec) at a lower priority; rejects on a failure, or with `aborted` when `signal` stops it. */
export function replayChild({ fromSec, toSec, host, signal, log, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const [cmd, args] = replayCommand(['--from', iso(fromSec), '--to', iso(toSec), '--host', host]);
    const child = spawnImpl(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (d) => {
      tail = (tail + d).slice(-2000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', stop);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(Object.assign(new Error('replay stopped: the station fell behind'), { aborted: true }));
      if (code === 0) {
        log?.info('replay done', { from: iso(fromSec), to: iso(toSec), said: tail.trim().split('\n').slice(-2).join(' | ') });
        return resolve();
      }
      reject(new Error(`replay.js exited ${code}: ${tail.trim().split('\n').at(-1) ?? ''}`));
    });
  });
}

/**
 * healthy(): is the live station current? writtenBefore(): the writer's next minute (it
 * may still write anything from there on). covered(fromIso, toIso): the minute rows
 * there, { minute, seconds_covered }. replay({ fromSec, toSec, signal }): rewrites the
 * whole minutes it hears.
 */
export function createRepair({ healthy, writtenBefore, covered, replay, log, now = () => Date.now() }) {
  let healthySince = null;
  let restUntil = 0;
  let running = null;
  let controller = null;
  let scanning = null;
  /** minute -> replays that came back without it */
  const tries = new Map();
  const status = { missing: null, lost: 0, repairing: null, lastRepairAt: null };

  async function scan() {
    const t = now();
    if (running || healthySince === null || t - healthySince < HEALTHY_FOR_MS || t < restUntil) return;
    const fromSec = Math.ceil((t / 1000 - LOOKBACK_S) / 60) * 60;
    const toSec = Math.min(Math.floor((t / 1000 - WRITE_LAG_S) / 60) * 60, writtenBefore() ?? 0);
    if (toSec <= fromSec) return;
    const rows = await covered(iso(fromSec), iso(toSec));
    const all = gapsIn(rows, fromSec, toSec);
    for (const m of tries.keys()) if (m < fromSec) tries.delete(m);
    const gaps = all.filter((m) => (tries.get(m) ?? 0) < MAX_TRIES);
    status.missing = gaps.length;
    status.lost = all.length - gaps.length;
    if (!gaps.length) return;
    const [from, end] = runsOf(gaps)[0];
    const to = Math.min(end, from + MAX_RUN_S);
    running = { from: iso(from), to: iso(to) };
    status.repairing = running;
    controller = new AbortController();
    log.info('repairing missed minutes', { from: running.from, to: running.to, minutes: (to - from) / 60, missing: gaps.length });
    try {
      await replay({ fromSec: from, toSec: to, signal: controller.signal });
    } catch (err) {
      if (err?.aborted) {
        restUntil = now() + AFTER_ABORT_MS;
        log.warn('repair stopped: the station fell behind; trying again later', { from: running.from, retryAt: new Date(restUntil).toISOString() });
        return;
      }
      log.error('repair failed', { from: running.from, to: running.to, err });
    } finally {
      running = null;
      controller = null;
      status.repairing = null;
    }
    // what's still short after the replay counts a try against it
    const after = new Set(gapsIn(await covered(iso(from), iso(to)), from, to));
    for (let m = from; m < to; m += 60) if (after.has(m)) tries.set(m, (tries.get(m) ?? 0) + 1);
    const fixed = (to - from) / 60 - after.size;
    status.missing = Math.max(0, gaps.length - fixed);
    status.lastRepairAt = new Date(now()).toISOString();
    log.info('repaired missed minutes', { from: iso(from), to: iso(to), fixed, stillShort: after.size });
  }

  return {
    /** Call every few seconds: follows the station's health, and stops a replay when it falls behind. */
    tick() {
      const ok = healthy();
      if (!ok) {
        healthySince = null;
        controller?.abort();
      } else healthySince ??= now();
    },
    /** Looks for gaps and repairs the oldest run of them; one at a time. */
    scan() {
      scanning ??= scan()
        .catch((err) => log.error('repair scan failed', { err }))
        .finally(() => {
          scanning = null;
        });
      return scanning;
    },
    status,
  };
}
