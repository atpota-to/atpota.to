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
  constructor() {
    /** hostname -> { seq, movedAt } (movedAt null: not seen to move yet). */
    this.seen = new Map();
    this.hosts = null;
    this.at = null;
    this.firstAt = null;
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
    });
  }
}

/**
 * A census as a reading's `hosts`: how many the relay lists and how many are active,
 * Bluesky's and everyone else's, how many wrote lately, the accounts on each side, the
 * hosting diversity ({ index, share, spread }), and the independent hosts with the most
 * accounts.
 */
export function summarizeHosts(hosts, { measuredAt, writing = () => false, writingMinutes = null } = {}) {
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
    accounts,
    diversity: { index: diversityIndex(share, spread), share, spread },
    top: independent
      .filter((h) => h.accounts > 0 && isHostname(h.hostname))
      .sort((a, b) => b.accounts - a.accounts || (a.hostname < b.hostname ? -1 : 1))
      .slice(0, TOP_HOSTS)
      .map((h) => ({ hostname: h.hostname, accounts: h.accounts })),
  };
}

/** Polls the relay every POLL_MS into a census; a failed poll keeps the last one. */
export function createHostWatch({ census = new HostCensus(), log, relay = DEFAULT_RELAY, fetchImpl = (u, i) => fetch(u, i), now = () => Date.now() }) {
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
