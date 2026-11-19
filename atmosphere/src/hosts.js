// hosts.js
// Where accounts live: the PDS hosts on the network, from the relay's own list of them
// (com.atproto.sync.listHosts on Bluesky's relay, the one jetstream2 reads from).
// Jetstream doesn't say which host a commit came from, so this is a census of hosts
// rather than a count from the firehose: every POLL_MS the station pages through the
// list and keeps the last whole one. A page that fails fails the census; half a list
// would read as hosts vanishing.
//
// For each host the relay says its status (active, idle, offline, throttled, banned), how
// many accounts it holds, and the last sequence number it relayed from it. A host whose
// seq moved between two censuses wrote something in between, so `writing` is the hosts
// whose seq moved in the last WRITING_MS (or since the first census, until there's been
// that long).
//
// Bluesky's own hosts (*.host.bsky.network, the "mushrooms") count as one place, the way
// all of app.bsky.* counts as one app: hosting diversity is
// share × √spread, like the diversity index (atmosphere.js diversityIndex), where share is
// the percent of accounts on active hosts that live outside Bluesky's, and spread is how
// many independent hosts those accounts are spread across, as an effective number
// (spreadOf). It goes by accounts hosted, not accounts active, so it is its own number on
// its own scale, not part of the diversity index.
//
// Tangled's knots are left out (knots.js): git servers the relay lists beside the PDS
// hosts, whose "accounts" are git repositories. A census says how many it left out.
//
// With Supabase, each census is also kept (createHostWriter): a row of its counts in
// atmosphere_hosts, and a row per active host for the day in atmosphere_host_day
// (atmosphere/sql/atmosphere_hosts.sql), for the weather report's trends. The day rows
// keep the knots too (the trends leave them out by atmosphere_host_kind), so a census
// from before they were left out can have them taken out of it.

import { diversityIndex, spreadOf } from './atmosphere.js';

export const DEFAULT_RELAY = 'https://relay1.us-east.bsky.network';
export const POLL_MS = 10 * 60_000;
/** A census older than this isn't served: the relay has been unreachable for a while. */
export const STALE_MS = 2 * 60 * 60_000;
/** A host wrote recently if its seq moved within this long. */
export const WRITING_MS = 60 * 60_000;
export const PAGE_LIMIT = 1000;
/** 50,000 hosts; the relay listed about 6,400 in October 2026. */
export const MAX_PAGES = 50;
export const PAGE_TIMEOUT_MS = 15_000;
/** How many independent hosts a reading names. */
export const TOP_HOSTS = 10;
/**
 * Independent hosts by how many accounts they hold: none, one (someone's own), up to 10,
 * 100, 1,000, 10,000, and more. `sizes` counts the hosts in each, `sizeAccounts` the
 * accounts they hold between them.
 */
export const SIZE_BOUNDS = [0, 1, 10, 100, 1000, 10000];
/** How many top-level domains a reading names. */
export const TOP_TLDS = 8;
/** The relay's states for a host, in the order a reading lists them. */
export const STATUSES = ['active', 'idle', 'offline', 'throttled', 'banned'];

/** Bluesky's own PDS hosts. */
const BLUESKY_HOST_RE = /\.host\.bsky\.network$/;
/** A hostname worth repeating to visitors (it's someone else's text). */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isBlueskyHost(hostname) {
  return BLUESKY_HOST_RE.test(hostname);
}

export function isHostname(value) {
  return typeof value === 'string' && HOSTNAME_RE.test(value);
}

const isCount = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const round2 = (n) => Math.round(n * 100) / 100;

/** One listHosts entry as { hostname, status, accounts, seq }, or null if it doesn't look right. */
export function hostOf(h) {
  if (typeof h !== 'object' || h === null || typeof h.hostname !== 'string' || h.hostname.length > 253) return null;
  return {
    hostname: h.hostname.toLowerCase(),
    status: typeof h.status === 'string' ? h.status : 'unknown',
    accounts: isCount(h.accountCount) ? Math.floor(h.accountCount) : 0,
    seq: isCount(h.seq) ? h.seq : null,
  };
}

/** Every host the relay lists, paged; throws if any page fails. */
export async function fetchHosts(fetchImpl, relay = DEFAULT_RELAY) {
  const hosts = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('/xrpc/com.atproto.sync.listHosts', relay);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'atpotato-weather (+https://atpota.to/weather)' }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`listHosts answered ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.hosts)) throw new Error('listHosts sent no hosts');
    for (const h of body.hosts) {
      const host = hostOf(h);
      if (host) hosts.push(host);
    }
    if (!body.hosts.length || typeof body.cursor !== 'string' || !body.cursor || body.cursor === cursor) return hosts;
    cursor = body.cursor;
  }
  throw new Error(`listHosts ran past ${MAX_PAGES} pages`);
}

/**
 * The censuses so far: the last whole one, and when each host's seq last moved. Holds
 * one small entry per host the relay lists, nothing else.
 */
export class HostCensus {
  /** `knots`: { isKnot(hostname), ready } (knots.js createKnotCheck), or null to count every host. */
  constructor({ knots = null } = {}) {
    /** hostname -> { seq, movedAt } (movedAt null: not seen to move yet). */
    this.seen = new Map();
    this.hosts = null;
    this.at = null;
    this.firstAt = null;
    this.knots = knots;
  }

  /** Takes a whole census, taken at `nowMs`. */
  record(hosts, nowMs) {
    const seen = new Map();
    for (const h of hosts) {
      const was = this.seen.get(h.hostname);
      const moved = was !== undefined && h.seq !== null && was.seq !== null && h.seq !== was.seq;
      seen.set(h.hostname, { seq: h.seq, movedAt: moved ? nowMs : (was?.movedAt ?? null) });
    }
    this.seen = seen;
    this.hosts = hosts;
    this.at = nowMs;
    this.firstAt ??= nowMs;
  }

  /** The reading's `hosts`, or null with no census, or only a stale one. */
  summary(nowMs) {
    if (!this.hosts || nowMs - this.at > STALE_MS) return null;
    // until there have been two censuses, nothing has had a chance to move
    const watched = this.at - this.firstAt;
    const since = Math.max(this.firstAt, this.at - WRITING_MS);
    const writing = (h) => watched > 0 && (this.seen.get(h.hostname)?.movedAt ?? -Infinity) > since;
    return summarizeHosts(this.hosts, {
      measuredAt: new Date(this.at).toISOString(),
      writing,
      writingMinutes: watched > 0 ? Math.round(Math.min(watched, WRITING_MS) / 60_000) : null,
      isKnot: this.knots ? (h) => this.knots.isKnot(h) : undefined,
    });
  }
}

/**
 * A census as a reading's `hosts`: how many the relay lists and how many are active,
 * Bluesky's and everyone else's, how many wrote lately, the accounts on each side, the
 * hosting diversity ({ index, share, spread }), and the independent hosts with the most
 * accounts. Hosts `isKnot` names aren't counted in any of it; `knots` says how many.
 */
export function summarizeHosts(all, { measuredAt, writing = () => false, writingMinutes = null, isKnot = () => false } = {}) {
  const hosts = all.filter((h) => !isKnot(h.hostname));
  const active = hosts.filter((h) => h.status === 'active');
  const bluesky = active.filter((h) => isBlueskyHost(h.hostname));
  const independent = active.filter((h) => !isBlueskyHost(h.hostname));
  const sum = (list) => list.reduce((n, h) => n + h.accounts, 0);
  const accounts = { bluesky: sum(bluesky), independent: sum(independent) };
  const total = accounts.bluesky + accounts.independent;
  const share = total > 0 ? round2((100 * accounts.independent) / total) : 0;
  const spread = share > 0 ? round2(spreadOf(independent.map((h) => h.accounts))) : 0;
  const wrote = writingMinutes === null ? null : { bluesky: bluesky.filter(writing).length, independent: independent.filter(writing).length };
  return {
    measuredAt,
    listed: hosts.length,
    active: active.length,
    bluesky: bluesky.length,
    independent: independent.length,
    writing: wrote && { ...wrote, minutes: writingMinutes },
    knots: all.length - hosts.length,
    accounts,
    diversity: { index: diversityIndex(share, spread), share, spread },
    top: independent
      .filter((h) => h.accounts > 0 && isHostname(h.hostname))
      .sort((a, b) => b.accounts - a.accounts || (a.hostname < b.hostname ? -1 : 1))
      .slice(0, TOP_HOSTS)
      .map((h) => ({ hostname: h.hostname, accounts: h.accounts })),
    statuses: statusesOf(hosts),
    sizes: sizesOf(independent),
    sizeAccounts: sizesOf(independent, (h) => h.accounts),
    tlds: tldsOf(independent),
  };
}

/** Every listed host by the relay's state for it ({ active, idle, offline, throttled, banned, other }). */
export function statusesOf(hosts) {
  const out = Object.fromEntries([...STATUSES, 'other'].map((k) => [k, 0]));
  for (const h of hosts) out[STATUSES.includes(h.status) ? h.status : 'other']++;
  return out;
}

/**
 * How many hosts hold at most each of SIZE_BOUNDS accounts (and more than the one before),
 * then more than the last; with `weigh`, what they add up to instead (their accounts).
 */
export function sizesOf(hosts, weigh = () => 1) {
  const out = new Array(SIZE_BOUNDS.length + 1).fill(0);
  for (const h of hosts) {
    const i = SIZE_BOUNDS.findIndex((max) => h.accounts <= max);
    out[i < 0 ? SIZE_BOUNDS.length : i] += weigh(h);
  }
  return out;
}

/** The top-level domains with the most hosts: [{ tld, hosts, accounts }]. */
export function tldsOf(hosts) {
  const by = new Map();
  for (const h of hosts) {
    if (!isHostname(h.hostname)) continue;
    const tld = h.hostname.slice(h.hostname.lastIndexOf('.') + 1);
    const t = by.get(tld) ?? { tld, hosts: 0, accounts: 0 };
    t.hosts++;
    t.accounts += h.accounts;
    by.set(tld, t);
  }
  return [...by.values()].sort((a, b) => b.hosts - a.hosts || b.accounts - a.accounts || (a.tld < b.tld ? -1 : 1)).slice(0, TOP_TLDS);
}

/** Census rows waiting while Supabase is down: a day of them. Past that the oldest go. */
export const MAX_PENDING_CENSUSES = 144;

/**
 * A census as rows: { census: an atmosphere_hosts row, days: an atmosphere_host_day row
 * per active host with a plain hostname, knots too }, or null with no census. The census
 * row's `knots` is how many it left out, or null while the station doesn't know yet which
 * hosts are knots (they're counted in then, and the trends take them out).
 */
export function hostRows(census) {
  const s = census.summary(census.at ?? 0);
  if (!s) return null;
  const day = s.measuredAt.slice(0, 10);
  return {
    census: {
      t: s.measuredAt,
      listed: s.listed,
      active: s.active,
      bluesky: s.bluesky,
      independent: s.independent,
      writing_bluesky: s.writing?.bluesky ?? null,
      writing_independent: s.writing?.independent ?? null,
      writing_minutes: s.writing?.minutes || null,
      accounts_bluesky: s.accounts.bluesky,
      accounts_independent: s.accounts.independent,
      share: s.diversity.share,
      spread: s.diversity.spread,
      knots: census.knots?.ready ? s.knots : null,
    },
    days: census.hosts
      .filter((h) => h.status === 'active' && isHostname(h.hostname))
      .map((h) => ({ day, hostname: h.hostname, bluesky: isBlueskyHost(h.hostname), accounts: h.accounts, seq: h.seq === null ? null : Math.floor(h.seq) })),
  };
}

/**
 * Writes each census (hostRows) with upserts, so a retry never counts one twice. Census
 * rows that fail wait for the next census, up to MAX_PENDING_CENSUSES; the hosts' day
 * rows are only ever the latest, since each census rewrites the day's anyway.
 */
export function createHostWriter({ upsert, log }) {
  let pending = [];
  return {
    get pending() {
      return pending.length;
    },
    async write(census) {
      const rows = hostRows(census);
      if (!rows) return;
      pending.push(rows.census);
      if (pending.length > MAX_PENDING_CENSUSES) {
        log?.warn('dropping unwritten host censuses', { dropped: pending.length - MAX_PENDING_CENSUSES });
        pending = pending.slice(-MAX_PENDING_CENSUSES);
      }
      try {
        await upsert('atmosphere_hosts', 't', pending);
        pending = [];
        await upsert('atmosphere_host_day', 'day,hostname', rows.days);
        log?.info('hosts written', { hosts: rows.days.length });
      } catch (err) {
        log?.warn('could not write hosts', { err: err?.message ?? String(err), pending: pending.length });
      }
    },
  };
}

/** Polls the relay every POLL_MS into a census; a failed poll keeps the last one. `onCensus` hears each new one. */
export function createHostWatch({ census = new HostCensus(), log, relay = DEFAULT_RELAY, fetchImpl = (u, i) => fetch(u, i), now = () => Date.now(), onCensus = null }) {
  let timer = null;
  let running = false;
  async function poll() {
    if (running) return;
    running = true;
    const started = now();
    try {
      const hosts = await fetchHosts(fetchImpl, relay);
      census.record(hosts, now());
      log?.info('hosts counted', { listed: hosts.length, ms: now() - started });
      await onCensus?.(census);
    } catch (err) {
      log?.warn('could not count hosts', { err: err?.message ?? String(err) });
    } finally {
      running = false;
    }
  }
  return {
    census,
    poll,
    start() {
      void poll();
      timer = setInterval(poll, POLL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
