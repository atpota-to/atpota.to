// backfill-hosts.js
// Estimates the PDS hosts' history from before the station kept it, from the PLC
// directory's log (plc.js), and writes it where the census goes (hosts.js,
// sql/atmosphere_hosts.sql) marked `estimated`. Runs anywhere with Node 22: a laptop is
// fine. It needs no atproto credential, only the Supabase service key to write.
//
//   node --env-file=.env src/backfill-hosts.js --from 2026-10-08 --dry-run
//   node --env-file=.env src/backfill-hosts.js --from 2026-10-08
//
// How. The relay's list of hosts only says how things stand now (accounts per host,
// today), so the run starts there and walks back: an account created on day D wasn't on
// its host before D, and one that moved was on its old host before it moved. For each
// day from --from to yesterday, a host's accounts are today's, less what arrived since
// that day, plus what left since. Only identities that changed in the window are kept in
// memory; everyone else was where they are now all along.
//
// An identity whose first operation in the window isn't its creation was somewhere before
// the window. If any of its operations name an independent host, or delete it, its whole
// history is read (/log/audit) to find where; otherwise (a handle change on a Bluesky host, say) it
// is taken to have been where its first operation puts it. That misses an account that
// moved from an independent host to Bluesky's in the window and then changed nothing:
// rare, and counted as having been on Bluesky's all along.
//
// What it can't know, so leaves out or estimates:
//   - only hosts the relay lists count. The log is full of hosts nobody relays (test
//     servers, bulk sign-ups to one-off domains): they're counted as `created_unlisted`
//     and nothing else
//   - a host counts as active on a day if the relay calls it active now (or the station
//     has seen it active: small hosts drift between active and idle) and it had an account
//     that day (or has none now): one that went offline since is missed. The relay's count
//     can lag a bulk sign-up, so a host the walk back would leave out is asked for its own
//     list of accounts (hostsBefore): one with an account from before the window stays
//   - "wrote in the last hour" has no history, so it's null
//   - accounts are the relay's count, moved by the log; did:web accounts and
//     deactivations never touch the log, so they're as they are today
//
// Alongside, from the same operations, each day's identity weather in atmosphere_plc_day:
// new accounts by where they signed up (Bluesky's hosts, independent hosts, unlisted
// ones), how many of the new accounts on listed hosts started with a handle on their own
// domain (not one their host hands out), the new accounts on independent hosts made in bulk (bulkRun), accounts
// moving out of Bluesky's hosts, back in, and between independent hosts, and deletions, and the independent hosts
// accounts moved to. These are counted, not estimated.
//
// Days the station already wrote itself are left alone unless --overwrite. The log pages
// and the audit answers are cached in --cache (default ./plc-cache), so a run that stops
// picks up where it got to, and a dry run's reading is reused by the real one. About
// 2,000 export pages for two weeks, plus an audit per identity that moved or changed
// on an independent host; plc.directory's 429s are waited out.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fetchHosts, isBlueskyHost, isHostname, summarizeHosts, DEFAULT_RELAY } from './hosts.js';
import { auditLog, exportPage, isCustomHandle, sideOf } from './plc.js';
import { supabaseRest } from './supabase.js';

const DAY_MS = 86_400_000;
/** At most this much in one run. */
export const MAX_DAYS = 60;
export const DEFAULT_DAYS = 14;
export const WRITE_BATCH = 1000;

/** Host index for no host (not yet created, or deleted) and for a host the relay doesn't list. */
export const NONE = -1;
export const UNLISTED = -2;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (day) => Date.parse(`${day}T00:00:00Z`);

export function parseArgs(argv, nowMs = Date.now()) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const today = dayOf(nowMs);
  const from = value('--from') ?? dayOf(nowMs - DEFAULT_DAYS * DAY_MS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(startOfDay(from))) throw new Error(`--from must be a day, like 2026-10-08 (got ${from})`);
  if (from >= today) throw new Error('--from must be before today: today is the station\'s');
  if ((startOfDay(today) - startOfDay(from)) / DAY_MS > MAX_DAYS) throw new Error(`at most ${MAX_DAYS} days in one run`);
  const concurrency = Number(value('--concurrency') ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('--concurrency must be 1 to 16');
  return { from, today, dryRun: argv.includes('--dry-run'), overwrite: argv.includes('--overwrite'), cache: value('--cache') ?? 'plc-cache', concurrency, relay: value('--relay') ?? DEFAULT_RELAY };
}

/** The days of the run, oldest first: --from to yesterday. */
export function daysOf(from, today) {
  const days = [];
  for (let t = startOfDay(from); dayOf(t) < today; t += DAY_MS) days.push(dayOf(t));
  return days;
}

const emptySignals = () => ({ ops: 0, created_bluesky: 0, created_independent: 0, created_unlisted: 0, created_custom_handle: 0, created_bulk: 0, moved_out: 0, moved_in: 0, moved_between: 0, deleted: 0, destinations: {}, bulk_hosts: {} });

/** How many destinations (and hosts making accounts in bulk) a day's row names. */
export const TOP_DESTINATIONS = 10;

// ---------- new accounts made in bulk ----------
// Only the obvious: sign-ups arriving in a shape no crowd of people makes. A crowd, even a
// huge rush for a new app, builds up and trails off: people see a post, take a minute or two
// to sign up, and keep coming for hours. A script switches on at full speed, keeps a machine's
// pace, and stops dead. So each independent host's sign-ups are cut into runs, each within
// RUN_GAP_MS of the last (and within one UTC day), and a run of BULK_MIN or more is made in
// bulk if it started and stopped at full speed (its first and last EDGE at half its pace or
// better, one stray sign-up allowed at either end), the host then went quiet (QUIET_MAX or
// fewer sign-ups in the QUIET_MS after it), and it was either:
//   clockwork  its gaps too even for people: their coefficient of variation under CLOCKWORK_CV
//              (random arrivals give about 1; random runs of twenty or more never came under
//              0.2 in simulation). pds.1095.me's forty a second apart, goodmkt.id's 3,846 one
//              every 3 seconds
//   plateau    its pace too flat for people: the middle 80% cut into 40 to 60 equal stretches
//              of time, their counts' variance under PLATEAU_DISPERSION of their mean (random
//              arrivals give 1, and a crowd more). goodmkt.id's 4,500 at 208 to 230 a minute
// Or it's one of FLOODS_MIN or more runs on the host that day that each opened with EDGE
// sign-ups within FLOOD_MS, out of a minute of nobody (pds.svpn.com's blocks of 45). One
// flood can be sign-ups opening at a set time; five in a day can't.
//
// Checked against simulated crowds: rushes of 200 to 50,000 people, sign-ups opening at a set
// time with 5,000 waiting, outages mid-rush, servers too slow for the crowd, workshops pressing
// submit together; none of them counted. What can: a server maxed out by a crowd that then
// falls over, whose last minutes look just like a script's (website/server/weather-hosts.ts
// NOT_BULK lets a host be let off by hand).

export const RUN_GAP_MS = 60_000;
export const BULK_MIN = 20;
export const EDGE = 10;
export const CLOCKWORK_CV = 0.2;
export const PLATEAU_PER_BIN = 5;
export const PLATEAU_BINS_MIN = 40;
export const PLATEAU_BINS_MAX = 60;
export const PLATEAU_DISPERSION = 0.35;
export const QUIET_MS = 600_000;
export const QUIET_MAX = 5;
export const FLOOD_MS = 3000;
export const FLOODS_MIN = 5;

/** Sign-ups a second over a run of times (ms). */
const paceOf = (t, from = 0, to = t.length) => (to - from - 1) / Math.max(0.001, (t[to - 1] - t[from]) / 1000);

/** The EDGE sign-ups from `i` came at least half as fast as `pace`. */
const atSpeed = (t, i, pace) => i >= 0 && i + EDGE <= t.length && (t[i + EDGE - 1] - t[i]) / 1000 <= (2 * (EDGE - 1)) / pace;

/** The variance over the mean of the counts in equal stretches of the middle 80% of a run, or null with too few to say. */
export function plateauOf(t) {
  const k = Math.floor(t.length / 10);
  const n = t.length - 2 * k;
  const bins = Math.min(PLATEAU_BINS_MAX, Math.floor(n / PLATEAU_PER_BIN));
  if (bins < PLATEAU_BINS_MIN) return null;
  const a = t[k];
  const w = (t[k + n - 1] - a) / bins;
  if (w <= 0) return 0;
  const c = new Array(bins).fill(0);
  for (let i = k; i < k + n; i++) c[Math.min(bins - 1, Math.floor((t[i] - a) / w))]++;
  const mean = n / bins;
  return c.reduce((v, x) => v + (x - mean) ** 2, 0) / bins / mean;
}

/** It opened with EDGE sign-ups within FLOOD_MS, among its first thirty. */
export function floodStart(t) {
  if (t.length < BULK_MIN) return false;
  for (let i = 0; i + EDGE <= Math.min(30, t.length); i++) if (t[i + EDGE - 1] - t[i] < FLOOD_MS) return true;
  return false;
}

/**
 * Whether a run (its sign-up times, ms) was made in bulk by its shape, and how: `after` is how
 * many sign-ups the host had in the QUIET_MS after it. Null if not, or if nothing says so.
 */
export function bulkRun(t, after = 0) {
  if (t.length < BULK_MIN || after > QUIET_MAX) return null;
  const k = Math.floor(t.length / 10);
  const pace = paceOf(t, k, t.length - k);
  const n = t.length;
  if (!(atSpeed(t, 0, pace) || atSpeed(t, 1, pace)) || !(atSpeed(t, n - EDGE, pace) || atSpeed(t, n - EDGE - 1, pace))) return null;
  let sum = 0;
  let sumSq = 0;
  for (let i = 1; i < n; i++) {
    const g = (t[i] - t[i - 1]) / 1000;
    sum += g;
    sumSq += g * g;
  }
  const mean = sum / (n - 1);
  const clockwork = mean <= 0 || Math.sqrt(Math.max(0, sumSq / (n - 1) - mean * mean)) / mean < CLOCKWORK_CV;
  const d = plateauOf(t);
  const plateau = d !== null && d < PLATEAU_DISPERSION;
  return clockwork || plateau ? { clockwork, plateau } : null;
}

function addBulk(s, host, t) {
  s.created_bulk += t.length;
  const b = (s.bulk_hosts[host] ??= { accounts: 0, bursts: 0, seconds: 0 });
  b.accounts += t.length;
  b.bursts++;
  b.seconds += (t[t.length - 1] - t[0]) / 1000;
}

/**
 * A day's atmosphere_plc_day row: its signals, with `destinations` (independent hosts
 * accounts moved to, out of Bluesky's hosts or from another independent one, by count)
 * and `bulk_hosts` (independent hosts that made accounts in bulk: how many, in how many
 * runs, over how many seconds) cut to the TOP_DESTINATIONS busiest.
 */
export function plcRow(day, signals) {
  const destinations = Object.entries(signals.destinations ?? {})
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_DESTINATIONS)
    .map(([hostname, accounts]) => ({ hostname, accounts }));
  const bulk_hosts = Object.entries(signals.bulk_hosts ?? {})
    .sort((a, b) => b[1].accounts - a[1].accounts || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_DESTINATIONS)
    .map(([hostname, b]) => ({ hostname, accounts: b.accounts, bursts: b.bursts, seconds: Math.round(b.seconds) }));
  return { day, ...signals, destinations, bulk_hosts };
}

/**
 * Everything the run learns from the log: each changed identity's hosts by day (`dids`:
 * did -> { start, events: [dayIndex, hostIndex, ...] }), and each day's signals.
 * Days are indexes from `from`; index `days` and past is today (still counted for the
 * walk back, never written).
 */
export class PlcHistory {
  constructor({ from, days, relayHosts }) {
    this.fromMs = startOfDay(from);
    this.days = days;
    this.relayHosts = relayHosts;
    this.hosts = [];
    this.hostIndex = new Map();
    this.dids = new Map();
    this.signals = Array.from({ length: days }, emptySignals);
    this.seen = 0;
    /** The latest operation's time (ms): the log's own clock. */
    this.clock = 0;
    /** Each independent host's run of sign-ups while it may go on: { day, t: [ms] }. */
    this.runs = new Map();
    /** Runs that are over, waiting out QUIET_MS to see if the host went quiet: { host, day, t, after }. */
    this.pending = [];
    /** Per day, each host's runs that opened with a flood and weren't made in bulk by their shape: [times]. */
    this.floods = Array.from({ length: days }, () => new Map());
  }

  /** A sign-up on an independent host: counted against its runs waiting out QUIET_MS, and into its run. */
  signUp(host, day, ms) {
    for (const p of this.pending) if (p.host === host && ms - p.t[p.t.length - 1] <= QUIET_MS) p.after++;
    let run = this.runs.get(host);
    if (run && (run.day !== day || ms - run.t[run.t.length - 1] > RUN_GAP_MS)) {
      this.endRun(host, run);
      run = undefined;
    }
    if (run) run.t.push(ms);
    else this.runs.set(host, { day, t: [ms] });
  }

  endRun(host, run) {
    this.runs.delete(host);
    if (run.day < this.days && run.t.length >= BULK_MIN) this.pending.push({ host, day: run.day, t: run.t, after: 0 });
  }

  /** Ends the runs that have gone a minute without a sign-up, and judges the ones that have waited out QUIET_MS. */
  settleRuns(all = false) {
    for (const [host, run] of [...this.runs]) if (all || this.clock - run.t[run.t.length - 1] > RUN_GAP_MS) this.endRun(host, run);
    const waiting = [];
    for (const p of this.pending) {
      if (!all && this.clock - p.t[p.t.length - 1] <= QUIET_MS) waiting.push(p);
      else if (bulkRun(p.t, p.after)) addBulk(this.signals[p.day], p.host, p.t);
      else if (floodStart(p.t)) {
        const f = this.floods[p.day];
        f.set(p.host, [...(f.get(p.host) ?? []), p.t]);
      }
    }
    this.pending = waiting;
  }

  /** Judges every run, over or not: at the end of what was read. */
  endRuns() {
    this.settleRuns(true);
  }

  /**
   * A day's signals as they stand: the runs judged so far, the ones still waiting out
   * QUIET_MS as they look now, and the floods. A run still going isn't judged till it's over.
   */
  signalsOf(day) {
    const s = this.signals[day];
    const copy = { ...s, bulk_hosts: Object.fromEntries(Object.entries(s.bulk_hosts).map(([h, b]) => [h, { ...b }])) };
    const floods = new Map([...this.floods[day]].map(([h, runs]) => [h, [...runs]]));
    const flood = (host, t) => floods.set(host, [...(floods.get(host) ?? []), t]);
    for (const p of this.pending) {
      if (p.day !== day) continue;
      if (bulkRun(p.t, p.after)) addBulk(copy, p.host, p.t);
      else if (floodStart(p.t)) flood(p.host, p.t);
    }
    for (const [host, run] of this.runs) if (run.day === day && floodStart(run.t)) flood(host, run.t);
    for (const [host, runs] of floods) if (runs.length >= FLOODS_MIN) for (const t of runs) addBulk(copy, host, t);
    return copy;
  }

  /** A host as an index: NONE, UNLISTED, or a listed host's place in `hosts`. */
  intern(host) {
    if (host === null) return NONE;
    if (sideOf(host, this.relayHosts) === 'unlisted') return UNLISTED;
    let i = this.hostIndex.get(host);
    if (i === undefined) {
      i = this.hosts.length;
      this.hosts.push(host);
      this.hostIndex.set(host, i);
    }
    return i;
  }

  sideOfIndex(i) {
    if (i === NONE) return null;
    if (i === UNLISTED) return 'unlisted';
    return isBlueskyHost(this.hosts[i]) ? 'bluesky' : 'independent';
  }

  dayIndex(createdAt) {
    return Math.floor((Date.parse(createdAt) - this.fromMs) / DAY_MS);
  }

  /** A move from one host to another, counted on its day (Bluesky's hosts among themselves, and unlisted ones, aren't moves). */
  countMove(day, from, to) {
    if (from === to || from === NONE || to === NONE || day < 0 || day >= this.days) return;
    const a = this.sideOfIndex(from);
    const b = this.sideOfIndex(to);
    const s = this.signals[day];
    if (a === 'bluesky' && b === 'independent') s.moved_out++;
    else if (a === 'independent' && b === 'bluesky') s.moved_in++;
    else if (a === 'independent' && b === 'independent') s.moved_between++;
    // where they went: an independent host, out of Bluesky's or from another
    if (b === 'independent' && (a === 'bluesky' || a === 'independent')) {
      const host = this.hosts[to];
      if (isHostname(host)) s.destinations[host] = (s.destinations[host] ?? 0) + 1;
    }
  }

  /** One export entry, slimmed (plc.js slimEntry). */
  add(entry) {
    if (!entry || entry.nullified || typeof entry.did !== 'string') return;
    const day = this.dayIndex(entry.at);
    if (!Number.isFinite(day) || day < 0) return;
    this.seen++;
    // the log's clock: once a minute, end the runs gone quiet and judge the ones that have waited long enough
    const ms = Date.parse(entry.at);
    if (Math.floor(ms / 60_000) > Math.floor(this.clock / 60_000)) {
      this.clock = ms;
      this.settleRuns();
    } else this.clock = Math.max(this.clock, ms);
    const host = this.intern(entry.host);
    if (day < this.days) {
      const s = this.signals[day];
      s.ops++;
      if (entry.deleted) s.deleted++;
      if (entry.genesis) {
        const side = this.sideOfIndex(host) ?? 'unlisted';
        s[`created_${side}`]++;
        if (side !== 'unlisted' && isCustomHandle(entry.handle, entry.host)) s.created_custom_handle++;
        // each independent host's runs of sign-ups: made in bulk or not (bulkRun)
        if (side === 'independent' && isHostname(entry.host)) this.signUp(entry.host, day, Date.parse(entry.at));
      }
    }
    let rec = this.dids.get(entry.did);
    if (!rec) {
      // created on a host nobody relays: nothing to place, unless it moves to one later
      if (entry.genesis && (host === UNLISTED || host === NONE)) return;
      rec = { start: entry.genesis ? NONE : null, events: [] };
      this.dids.set(entry.did, rec);
    } else {
      const last = rec.events.length ? rec.events[rec.events.length - 1] : rec.start;
      this.countMove(day, last, host);
    }
    rec.events.push(day, host);
  }

  /**
   * Identities whose start is unknown and worth an audit: any operation names an
   * independent host, or deletes it (to find which host it left).
   */
  needsAudit() {
    const out = [];
    for (const [did, rec] of this.dids) {
      if (rec.start !== null) continue;
      for (let i = 1; i < rec.events.length; i += 2) {
        if (rec.events[i] === NONE || this.sideOfIndex(rec.events[i]) === 'independent') {
          out.push(did);
          break;
        }
      }
    }
    return out;
  }

  /** An identity's history from its audit log: where it was before the window, then every operation in it. */
  fromAudit(did, log) {
    const rec = this.dids.get(did);
    if (!rec || !Array.isArray(log)) return;
    let start = NONE;
    const events = [];
    for (const e of log) {
      if (!e || e.nullified) continue;
      const day = this.dayIndex(e.at);
      const host = this.intern(e.host);
      if (day < 0) start = host;
      else events.push(day, host);
    }
    // its moves were counted against an unknown start: count its first one now
    if (events.length) this.countMove(events[0], start, events[1]);
    rec.start = start;
    rec.events = events;
  }

  /** The rest: taken to have been where its first operation in the window puts it. */
  settle() {
    for (const rec of this.dids.values()) if (rec.start === null) rec.start = rec.events.length ? rec.events[1] : NONE;
  }

  /**
   * Each day's change in accounts per listed host against now: delta[day][hostIndex] =
   * accounts that day less accounts now, from the changed identities. `created[hostIndex]`
   * is how many of each host's accounts now arrived after each day ended.
   */
  deltas() {
    const n = this.hosts.length;
    const delta = Array.from({ length: this.days }, () => new Int32Array(n));
    for (const rec of this.dids.values()) {
      const ev = rec.events;
      const now = ev.length ? ev[ev.length - 1] : rec.start;
      let at = rec.start;
      let next = 0;
      for (let d = 0; d < this.days; d++) {
        while (next < ev.length && ev[next] <= d) {
          at = ev[next + 1];
          next += 2;
        }
        if (at === now) continue;
        if (at >= 0) delta[d][at]++;
        if (now >= 0) delta[d][now]--;
      }
    }
    return delta;
  }
}

/**
 * The census of one past day: each host the relay calls active now (or that the station
 * has seen active: small hosts drift between active and idle), with that day's accounts,
 * leaving out a host all of whose accounts arrived after the day (it wasn't there yet). A
 * host with no accounts now stays: it can't be told apart. `floors` (hostsBefore) names
 * hosts known to have had accounts before the window, with how many: one of those is never
 * left out, however far the walk back goes (the relay's count can lag a bulk sign-up).
 */
export function hostsOnDay(census, history, delta, { floors = new Map(), seenActive = new Set() } = {}) {
  const out = [];
  for (const h of census) {
    if (h.status !== 'active' && !seenActive.has(h.hostname)) continue;
    const i = history.hostIndex.get(h.hostname);
    let accounts = h.accounts + (i === undefined ? 0 : delta[i]);
    const floor = floors.get(h.hostname);
    if (floor !== undefined) accounts = Math.max(accounts, floor);
    else if (h.accounts > 0 && accounts <= 0) continue;
    out.push({ hostname: h.hostname, status: 'active', accounts: Math.max(0, accounts), seq: null });
  }
  return out;
}

/**
 * Hosts the walk back would leave out on some day, that in fact had accounts before the
 * window: their own list of accounts (com.atproto.sync.listRepos, the first page) names
 * one that didn't arrive in the window. Each comes back with how many such accounts that
 * page has. A host that won't answer is left as the walk back has it.
 */
export async function hostsBefore({ fetchImpl, census, history, deltas, concurrency = 4, log }) {
  const candidates = census.filter((h) => {
    const i = history.hostIndex.get(h.hostname);
    return h.accounts > 0 && i !== undefined && isHostname(h.hostname) && !isBlueskyHost(h.hostname) && deltas.some((d) => h.accounts + d[i] <= 0);
  });
  const floors = new Map();
  await pool(candidates, concurrency, async (h) => {
    const i = history.hostIndex.get(h.hostname);
    try {
      const res = await fetchImpl(`https://${h.hostname}/xrpc/com.atproto.sync.listRepos?limit=1000`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const body = await res.json();
      // an account that didn't change in the window was there all along; one that changed but started here, too
      const before = (Array.isArray(body?.repos) ? body.repos : []).filter((r) => {
        const rec = typeof r?.did === 'string' ? history.dids.get(r.did) : undefined;
        return typeof r?.did === 'string' && (!rec || rec.start === i);
      }).length;
      if (before > 0) floors.set(h.hostname, before);
    } catch {
      // unreachable: leave it to the walk back
    }
  });
  log?.(`checked ${candidates.length} host(s) the walk back would leave out; ${floors.size} had accounts from before`);
  return floors;
}

/** A past day's rows: its atmosphere_hosts row (as at the end of the day) and its atmosphere_host_day rows. */
export function dayRows(day, hosts, listed) {
  const s = summarizeHosts(hosts, { measuredAt: `${day}T23:59:59.000Z` });
  return {
    census: {
      t: s.measuredAt,
      listed,
      active: s.active,
      bluesky: s.bluesky,
      independent: s.independent,
      writing_bluesky: null,
      writing_independent: null,
      writing_minutes: null,
      accounts_bluesky: s.accounts.bluesky,
      accounts_independent: s.accounts.independent,
      share: s.diversity.share,
      spread: s.diversity.spread,
      estimated: true,
    },
    days: hosts.filter((h) => isHostname(h.hostname)).map((h) => ({ day, hostname: h.hostname, bluesky: isBlueskyHost(h.hostname), accounts: h.accounts, seq: null, estimated: true })),
    summary: s,
  };
}

/**
 * A cache file's lines, one at a time: two weeks of the log is most of a gigabyte, past
 * the longest string Node will hold. A last line cut short by a stopped run is skipped.
 */
async function* cacheLines(file) {
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      continue;
    }
    yield line;
  }
}

/**
 * Reads the export from `from` up to `untilMs`, slimmed (plc.js slimEntry), through a
 * cache file it can resume. Pages go by `after` (a createdAt), so the operations stamped
 * at a page's last instant can come again on the next page: only those are remembered,
 * to drop the repeats.
 */
export async function readExport({ fetchImpl, from, untilMs, cacheFile, onEntry, log }) {
  let after = `${from}T00:00:00.000Z`;
  let atAfter = new Set();
  let total = 0;
  const take = (e) => {
    if (e.at === after) {
      if (atAfter.has(e.cid)) return false;
    } else {
      after = e.at;
      atAfter = new Set();
    }
    atAfter.add(e.cid);
    onEntry(e);
    total++;
    return true;
  };
  if (cacheFile && fs.existsSync(cacheFile)) {
    for await (const line of cacheLines(cacheFile)) take(JSON.parse(line));
    log(`read ${total.toLocaleString('en-US')} operations from the cache, up to ${after}`);
  }
  const out = cacheFile ? fs.createWriteStream(cacheFile, { flags: 'a' }) : null;
  let pages = 0;
  try {
    for (;;) {
      const asked = after;
      const page = await exportPage(fetchImpl, asked, { log });
      pages++;
      for (const e of page) {
        if (Date.parse(e.at) > untilMs) break;
        if (take(e)) out?.write(`${JSON.stringify(e)}\n`);
      }
      const lastAt = page.length ? page[page.length - 1].at : null;
      if (pages % 50 === 0) log(`read ${pages} pages, up to ${lastAt}`);
      // a short page is the end of the log; a page that didn't move on would go round forever
      if (!lastAt || page.length < 1000 || Date.parse(lastAt) > untilMs || after === asked) break;
    }
  } finally {
    await new Promise((r) => (out ? out.end(r) : r()));
  }
  return pages;
}

/** Runs `fn` over `items`, `concurrency` at a time. */
async function pool(items, concurrency, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Audits through a cache file of { did, log } lines. */
async function readAudits({ fetchImpl, dids, cacheFile, concurrency, onLog, log }) {
  const cached = new Map();
  if (cacheFile && fs.existsSync(cacheFile)) {
    for await (const line of cacheLines(cacheFile)) {
      const { did, log: entries } = JSON.parse(line);
      cached.set(did, entries);
    }
  }
  const out = cacheFile ? fs.createWriteStream(cacheFile, { flags: 'a' }) : null;
  let fetched = 0;
  try {
    await pool(dids, concurrency, async (did) => {
      let entries = cached.get(did);
      if (entries === undefined) {
        entries = await auditLog(fetchImpl, did, { log });
        out?.write(`${JSON.stringify({ did, log: entries })}\n`);
        if (++fetched % 500 === 0) log(`audited ${fetched.toLocaleString('en-US')} of ${(dids.length - cached.size).toLocaleString('en-US')}`);
      }
      onLog(did, entries);
    });
  } finally {
    await new Promise((r) => (out ? out.end(r) : r()));
  }
  return { fetched, cached: cached.size };
}

/** The first day the station wrote itself (not estimated), or null. */
async function firstLiveDay({ url, key, fetchImpl }) {
  const res = await fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/atmosphere_host_day?select=day&estimated=eq.false&order=day.asc&limit=1`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`could not read atmosphere_host_day: HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0]?.day ?? null;
}

const pad = (v, n) => String(v).padStart(n);

export async function backfill({ args, fetchImpl = (u, i) => fetch(u, i), db = null, nowMs = Date.now(), log = console.log }) {
  const days = daysOf(args.from, args.today);
  const census = await fetchHosts(fetchImpl, args.relay);
  const relayHosts = new Set(census.map((h) => h.hostname));
  log(`the relay lists ${census.length.toLocaleString('en-US')} hosts, ${census.filter((h) => h.status === 'active').length.toLocaleString('en-US')} active`);
  // the walk back runs from now, so the log is read up to now, today included
  const history = new PlcHistory({ from: args.from, days: days.length, relayHosts });
  fs.mkdirSync(args.cache, { recursive: true });
  const exportCache = path.join(args.cache, `export-${args.from}.ndjson`);
  log(`reading plc.directory's log from ${args.from} (cached in ${exportCache})`);
  const started = Date.now();
  const pages = await readExport({ fetchImpl, from: args.from, untilMs: nowMs, cacheFile: exportCache, onEntry: (e) => history.add(e), log });
  log(`read ${history.seen.toLocaleString('en-US')} operations (${pages} new pages) in ${Math.round((Date.now() - started) / 1000)} s; ${history.dids.size.toLocaleString('en-US')} identities on listed hosts changed`);

  const audit = history.needsAudit();
  log(`auditing ${audit.length.toLocaleString('en-US')} identities that changed on an independent host before their first operation here`);
  const a = await readAudits({ fetchImpl, dids: audit, cacheFile: path.join(args.cache, 'audit.ndjson'), concurrency: args.concurrency, onLog: (did, entries) => history.fromAudit(did, entries), log });
  log(`audited ${a.fetched.toLocaleString('en-US')} (${a.cached.toLocaleString('en-US')} from the cache)`);
  history.settle();
  history.endRuns();
  const delta = history.deltas();
  const floors = await hostsBefore({ fetchImpl, census, history, deltas: delta, concurrency: args.concurrency, log });
  const seenActive = db ? await db.seenActive() : new Set();

  let skipBefore = null;
  if (db && !args.overwrite) skipBefore = await db.firstLiveDay();
  const listed = census.length;
  const written = [];
  log('');
  log('day          active  indep   accounts elsewhere  diversity   new: bsky  indep  unlisted  own-domain   moved: out  in  between   deleted');
  for (let d = 0; d < days.length; d++) {
    const day = days[d];
    const rows = dayRows(day, hostsOnDay(census, history, delta[d], { floors, seenActive }), listed);
    const s = history.signalsOf(d);
    const plc = plcRow(day, s);
    log(
      `${day}  ${pad(rows.summary.active, 6)} ${pad(rows.summary.independent, 6)}  ${pad(rows.summary.accounts.independent.toLocaleString('en-US'), 18)}  ${pad(rows.summary.diversity.index, 9)}   ${pad(s.created_bluesky, 9)} ${pad(s.created_independent, 6)} ${pad(s.created_unlisted, 9)} ${pad(s.created_custom_handle, 11)}   ${pad(s.moved_out, 10)} ${pad(s.moved_in, 3)} ${pad(s.moved_between, 8)}   ${pad(s.deleted, 7)}`,
    );
    if (!db) continue;
    const live = skipBefore !== null && day >= skipBefore;
    await db.upsert('atmosphere_plc_day', 'day', [plc]);
    if (live) continue;
    await db.upsert('atmosphere_hosts', 't', [rows.census]);
    for (let i = 0; i < rows.days.length; i += WRITE_BATCH) await db.upsert('atmosphere_host_day', 'day,hostname', rows.days.slice(i, i + WRITE_BATCH));
    written.push(day);
  }
  log('');
  if (!db) log('dry run: nothing was written. run it again without --dry-run to write it (the cache makes that quick).');
  log(`peak memory ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
  if (db) log(`wrote ${written.length} day(s) of hosts${skipBefore ? `; ${skipBefore} on are the station's own and were left alone (--overwrite to replace them)` : ''}, and ${days.length} day(s) of identity signals`);
  return { history, days, written };
}

async function main(argv) {
  const args = parseArgs(argv);
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!args.dryRun && !(url && key)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or pass --dry-run)');
  const rest = args.dryRun ? null : supabaseRest({ url, key });
  const db = rest && {
    ...rest,
    firstLiveDay: () => firstLiveDay({ url, key, fetchImpl: fetch }),
    // hosts the station has seen active in its own censuses over the last two days
    seenActive: async () => new Set((await rest.getAll(`atmosphere_host_day?select=hostname&estimated=eq.false&day=gte.${dayOf(Date.now() - 2 * DAY_MS)}&order=day.asc,hostname.asc`)).map((r) => r.hostname)),
  };
  console.log(`backfilling hosts from ${args.from} to yesterday${args.dryRun ? ' (dry run: nothing is written)' : ''}`);
  await backfill({ args, db });
}

/** Run as a command (not imported by a test). */
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
