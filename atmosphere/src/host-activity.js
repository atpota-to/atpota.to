// host-activity.js
// Who's active on each independent PDS host, day by day. Jetstream says which account
// wrote, but not where it lives, so the station keeps a directory of the accounts on
// independent hosts (about 364,000 in October 2026, against some 24 million on
// Bluesky's), and anyone it doesn't find there lives on Bluesky's hosts.
//
// The directory is filled from each independent host's own list of accounts
// (com.atproto.sync.listRepos, a page of 1,000 at a time), read again once a week, and
// kept up to date in between from the PLC directory's log (plc-watch.js): an account
// that moves to an independent host is added, one that moves away or deletes itself is
// dropped. It keys accounts by a 53-bit number from the SHA-256 of their DID, not the
// DID: about 40 MB in memory for 400,000 accounts (twice that for a moment while a new
// read replaces the old), and a collision among half a million is a one in a hundred
// thousand chance. It's saved to disk (HOST_DIRECTORY_FILE) after each read,
// so a restart doesn't wait for the next one.
//
// Each commit by an account in the directory goes into its host's HyperLogLog sketch for
// the UTC day (hll.js), and into one for every independent host together ('*'). After
// each host census (every 10 minutes) today's sketches are written to
// atmosphere_host_active_day (sql/atmosphere_hosts.sql), and the day before's one last
// time once the day has turned. Before each write it reads the day's rows back and merges
// them in, so what a restart or a backfill (backfill-host-activity.js, which can count
// today's morning) put there stays, and nothing is counted twice: merging a sketch is
// idempotent.
//
// No DID is written anywhere: the directory file holds the numbers, Supabase the sketches.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerOf, Sketch } from './hll.js';
import { isBlueskyHost, isHostname } from './hosts.js';
import { fromBytea, toBytea } from './rollup.js';

/** Read every independent host's accounts again after this long. */
export const DIRECTORY_MAX_AGE_MS = 7 * 86_400_000;
/** Hosts read at once while filling the directory. */
export const CRAWL_CONCURRENCY = 4;
/** At most this many pages of 1,000 accounts from one host (a million accounts). */
export const MAX_PAGES_PER_HOST = 1000;
export const PAGE_TIMEOUT_MS = 15_000;
/** The row for every independent host together. */
export const ALL_INDEPENDENT = '*';
const USER_AGENT = 'atpota.to weather station (https://atpota.to/weather)';

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A DID as the directory's key: the first 53 bits of its SHA-256, as a number. */
export function didKey(did) {
  const h = crypto.hash('sha256', did, 'buffer');
  return h.readUInt32BE(0) * 2 ** 21 + (h.readUInt32BE(4) >>> 11);
}

/** Which independent host each account lives on, by didKey. */
export class HostDirectory {
  constructor() {
    this.hosts = [];
    this.hostIndex = new Map();
    /** didKey -> index into hosts. */
    this.accounts = new Map();
    /** When it was last read from the hosts themselves (ms), or null. */
    this.readAt = null;
    /** While a new directory is being read: the changes to carry over into it. */
    this.journal = null;
  }

  get size() {
    return this.accounts.size;
  }

  indexOf(host) {
    let i = this.hostIndex.get(host);
    if (i === undefined) {
      i = this.hosts.length;
      this.hosts.push(host);
      this.hostIndex.set(host, i);
    }
    return i;
  }

  /** Puts an account on a host, or with host null, takes it out (it moved to Bluesky, or away). */
  place(did, host) {
    const key = didKey(did);
    if (host === null) this.accounts.delete(key);
    else this.accounts.set(key, this.indexOf(host));
    this.journal?.push([key, host]);
  }

  /** The independent host an account lives on, or null for Bluesky's (or not known). */
  hostOf(did) {
    const i = this.accounts.get(didKey(did));
    return i === undefined ? null : this.hosts[i];
  }

  /** Carries over the changes made to `older` while this one was being read. */
  replay(journal) {
    for (const [key, host] of journal) {
      if (host === null) this.accounts.delete(key);
      else this.accounts.set(key, this.indexOf(host));
    }
  }

  toJSON() {
    const keys = [];
    const hosts = [];
    for (const [k, i] of this.accounts) {
      keys.push(k);
      hosts.push(i);
    }
    return { readAt: this.readAt, hosts: this.hosts, keys, at: hosts };
  }

  static fromJSON(x) {
    const d = new HostDirectory();
    if (!x || !Array.isArray(x.hosts) || !Array.isArray(x.keys) || !Array.isArray(x.at) || x.keys.length !== x.at.length) return null;
    for (const h of x.hosts) d.indexOf(String(h));
    for (let j = 0; j < x.keys.length; j++) {
      const i = x.at[j];
      if (Number.isInteger(x.keys[j]) && Number.isInteger(i) && i >= 0 && i < d.hosts.length) d.accounts.set(x.keys[j], i);
    }
    d.readAt = Number.isFinite(x.readAt) ? x.readAt : null;
    return d;
  }
}

/** The independent hosts worth reading: active, with accounts, with a plain hostname. */
export function hostsToRead(census) {
  return (census ?? []).filter((h) => h.status === 'active' && h.accounts > 0 && isHostname(h.hostname) && !isBlueskyHost(h.hostname));
}

/** Every account a host lists, a page at a time; stops quietly at the first page that fails. */
export async function readHostAccounts(fetchImpl, hostname, { maxPages = MAX_PAGES_PER_HOST, onDid }) {
  let cursor = null;
  let n = 0;
  for (let page = 0; page < maxPages; page++) {
    const url = `https://${hostname}/xrpc/com.atproto.sync.listRepos?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let body;
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
      if (!res.ok) break;
      body = await res.json();
    } catch {
      break;
    }
    const repos = Array.isArray(body?.repos) ? body.repos : [];
    for (const r of repos) {
      if (typeof r?.did === 'string' && r.did.startsWith('did:') && r.active !== false) {
        onDid(r.did);
        n++;
      }
    }
    const next = typeof body?.cursor === 'string' && body.cursor ? body.cursor : null;
    if (!next || next === cursor || repos.length === 0) break;
    cursor = next;
  }
  return n;
}

async function pool(items, concurrency, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** A fresh directory read from every independent host in a census. */
export async function readDirectory({ fetchImpl, census, concurrency = CRAWL_CONCURRENCY, now = Date.now, log }) {
  const d = new HostDirectory();
  const hosts = hostsToRead(census);
  let answered = 0;
  await pool(hosts, concurrency, async (h) => {
    const n = await readHostAccounts(fetchImpl, h.hostname, { onDid: (did) => d.place(did, h.hostname) });
    if (n > 0) answered++;
  });
  d.readAt = now();
  log?.info('host directory read', { hosts: hosts.length, answered, accounts: d.size });
  return d;
}

/** One UTC day's sketches: one per independent host with anyone active, and '*' for them all. */
export class ActivityDay {
  constructor(day) {
    this.day = day;
    this.hosts = new Map();
    this.all = new Sketch();
  }

  add(host, packed) {
    let s = this.hosts.get(host);
    if (!s) this.hosts.set(host, (s = new Sketch()));
    s.add(packed);
    this.all.add(packed);
  }

  /** Merges in rows read back from Supabase. */
  merge(rows) {
    for (const r of rows) {
      if (r?.day !== this.day || typeof r.hostname !== 'string') continue;
      let sketch;
      try {
        sketch = fromBytea(r.sketch);
      } catch {
        continue;
      }
      if (r.hostname === ALL_INDEPENDENT) this.all.merge(sketch);
      else {
        const s = this.hosts.get(r.hostname);
        if (s) s.merge(sketch);
        else this.hosts.set(r.hostname, sketch);
      }
    }
  }

  /** atmosphere_host_active_day rows. */
  rows() {
    const row = (hostname, s) => ({ day: this.day, hostname, dids: s.estimate(), sketch: toBytea(s.encode()) });
    return [row(ALL_INDEPENDENT, this.all), ...[...this.hosts].map(([h, s]) => row(h, s))];
  }
}

/**
 * The station's part: `see` every Jetstream message, `onPlcEntry` every PLC operation
 * (plc-watch.js), `onCensus` after each host census, which reads the directory when it's
 * missing or a week old and writes today's rows.
 */
export function createHostActivity({ upsert, getAll, log, file = null, fetchImpl = (u, i) => fetch(u, i), now = () => Date.now(), read = readDirectory }) {
  let directory = load(file, log) ?? new HostDirectory();
  let today = null;
  let finished = null;
  let reading = null;

  const dayFor = (ms) => {
    const d = dayOf(ms);
    if (!today) today = new ActivityDay(d);
    else if (d > today.day) {
      finished = today;
      today = new ActivityDay(d);
    }
    return today.day === d ? today : finished?.day === d ? finished : null;
  };

  function see(m) {
    if (m?.kind !== 'commit' || typeof m.did !== 'string' || directory.size === 0) return;
    const host = directory.hostOf(m.did);
    if (!host) return;
    const ms = typeof m.time_us === 'number' ? m.time_us / 1000 : now();
    dayFor(ms)?.add(host, registerOf(m.did));
  }

  /** A PLC operation: an account moving to an independent host (one the relay lists), away, or deleting itself. */
  function onPlcEntry(e, relayHosts) {
    if (!e?.did || e.nullified) return;
    const independent = e.host && !e.deleted && !isBlueskyHost(e.host) && relayHosts.has(e.host) ? e.host : null;
    if (independent) directory.place(e.did, independent);
    else if (e.deleted || e.host) directory.place(e.did, null);
  }

  async function startReading(census) {
    const old = directory;
    old.journal = [];
    try {
      const fresh = await read({ fetchImpl, census, now, log });
      fresh.replay(old.journal);
      directory = fresh;
      save(file, fresh, log);
    } catch (err) {
      log?.warn('could not read the host directory', { err: err?.message ?? String(err) });
    } finally {
      old.journal = null;
      reading = null;
    }
  }

  async function onCensus(census) {
    const stale = directory.readAt === null || now() - directory.readAt > DIRECTORY_MAX_AGE_MS;
    if (stale && !reading) reading = startReading(census);
    dayFor(now());
    // what's there already (an earlier run's, a backfill's) merged in before writing over it
    for (const day of [finished, today]) {
      if (!day) continue;
      try {
        day.merge(await getAll(`atmosphere_host_active_day?day=eq.${day.day}&select=day,hostname,sketch&order=hostname`));
      } catch (err) {
        log?.warn('could not read back host activity', { day: day.day, err: err?.message ?? String(err) });
        return; // try again next census, rather than overwrite what's there
      }
    }
    try {
      if (finished) {
        await upsert('atmosphere_host_active_day', 'day,hostname', finished.rows());
        finished = null;
      }
      const rows = today.rows();
      await upsert('atmosphere_host_active_day', 'day,hostname', rows);
      log?.info('host activity written', { day: today.day, hosts: rows.length - 1, independent: rows[0].dids, directory: directory.size });
    } catch (err) {
      log?.warn('could not write host activity', { err: err?.message ?? String(err) });
    }
  }

  return {
    see,
    onPlcEntry,
    onCensus,
    get directory() {
      return directory;
    },
    get reading() {
      return reading;
    },
    get today() {
      return today;
    },
  };
}

function load(file, log) {
  if (!file) return null;
  try {
    const d = HostDirectory.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (d) log?.info('host directory loaded', { accounts: d.size, readAt: d.readAt && new Date(d.readAt).toISOString() });
    return d;
  } catch (err) {
    if (err?.code !== 'ENOENT') log?.warn('could not load the host directory', { err: err?.message ?? String(err) });
    return null;
  }
}

function save(file, d, log) {
  if (!file) return;
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(d));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    log?.warn('could not save the host directory', { err: err?.message ?? String(err) });
  }
}
