// knots.js
// Tangled's knots: git servers, not homes for accounts. A knot serves the atproto sync
// endpoints, so the relay lists it beside the PDS hosts and counts the identities it
// serves as accounts, but each of those is a git repository (it holds an
// org.tangled.repo.manifest record naming the repository and its owner), not someone
// who signs in. knot1.tangled.sh alone held 8,829 of them on 2026-10-31. So knots don't
// count as hosts: the census leaves them out (hosts.js summarizeHosts), and the weather
// report's trends leave them out of what was kept before (sql/atmosphere_hosts.sql).
//
// A knot says so when asked how it is: GET /xrpc/_health answers
// {"version":"knot 2.0.0"}, where a PDS answers its own version ("0.5.29", or its
// software's name: tranquil, cirrus, cocoon, pegasus). After each census the station
// asks the active independent hosts it hasn't asked in a week, CHECKS_PER_CENSUS at a
// time, and keeps every answer in atmosphere_host_kind, which it reads back on start.
// A host that doesn't answer keeps what it said last (a host never asked counts as a
// PDS) and is asked again a day later.

import { isBlueskyHost, isHostname } from './hosts.js';

/** Ask a host again after this long. */
export const RECHECK_MS = 7 * 86_400_000;
/** And one that didn't answer, after this long. */
export const RETRY_MS = 86_400_000;
/** At most this many hosts asked after one census (about 1,900 independent hosts in October 2026). */
export const CHECKS_PER_CENSUS = 300;
export const CHECK_CONCURRENCY = 8;
export const HEALTH_TIMEOUT_MS = 8000;
const USER_AGENT = 'atpota.to weather station (https://atpota.to/weather)';

/** A /xrpc/_health version that's a knot's: "knot 2.0.0". */
export const isKnotVersion = (v) => typeof v === 'string' && /^knot\b/i.test(v.trim());

/** What a host says it is: { knot, version }, or null if it didn't answer. */
export async function askHost(fetchImpl, hostname) {
  try {
    const res = await fetchImpl(`https://${hostname}/xrpc/_health`, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json();
    const version = typeof body?.version === 'string' ? body.version.trim().slice(0, 100) : null;
    return { knot: isKnotVersion(version), version };
  } catch {
    return null;
  }
}

/**
 * The station's part: `isKnot` for the census, and `check` after each one, which asks the
 * hosts that are due and writes what they said. Without Supabase it still asks, and keeps
 * the answers until a restart.
 */
export function createKnotCheck({ upsert = null, getAll = null, log, fetchImpl = (u, i) => fetch(u, i), now = () => Date.now(), perCensus = CHECKS_PER_CENSUS }) {
  /** hostname -> { knot, checkedAt } */
  const known = new Map();
  /** hostname -> when it last didn't answer */
  const failed = new Map();
  let loaded = !getAll;
  let running = false;

  async function load() {
    try {
      for (const r of await getAll('atmosphere_host_kind?select=hostname,knot,checked_at&order=hostname')) {
        const at = Date.parse(r?.checked_at);
        if (typeof r?.hostname === 'string' && Number.isFinite(at)) known.set(r.hostname, { knot: r.knot === true, checkedAt: at });
      }
      loaded = true;
      log?.info('host kinds loaded', { hosts: known.size, knots: [...known.values()].filter((k) => k.knot).length });
    } catch (err) {
      log?.warn('could not read host kinds', { err: err?.message ?? String(err) });
    }
  }

  /** The hosts to ask now: active independent ones not asked within RECHECK_MS (or RETRY_MS, if they didn't answer). */
  function due(hosts) {
    const t = now();
    return (hosts ?? [])
      .filter((h) => h.status === 'active' && isHostname(h.hostname) && !isBlueskyHost(h.hostname))
      .filter((h) => {
        const k = known.get(h.hostname);
        const f = failed.get(h.hostname);
        return (!k || t - k.checkedAt > RECHECK_MS) && (f === undefined || t - f > RETRY_MS);
      })
      .slice(0, perCensus);
  }

  async function check(hosts) {
    if (running) return;
    running = true;
    try {
      if (!loaded) await load();
      // until the stored answers are read, asking again would only repeat them
      if (!loaded) return;
      const ask = due(hosts);
      if (!ask.length) return;
      const rows = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(CHECK_CONCURRENCY, ask.length) }, async () => {
          while (next < ask.length) {
            const { hostname } = ask[next++];
            const said = await askHost(fetchImpl, hostname);
            if (!said) {
              failed.set(hostname, now());
              continue;
            }
            failed.delete(hostname);
            const checkedAt = now();
            const was = known.get(hostname);
            if (was && was.knot !== said.knot) log?.info('host kind changed', { hostname, knot: said.knot, version: said.version });
            known.set(hostname, { knot: said.knot, checkedAt });
            rows.push({ hostname, knot: said.knot, version: said.version, checked_at: new Date(checkedAt).toISOString() });
          }
        }),
      );
      if (rows.length && upsert) {
        try {
          await upsert('atmosphere_host_kind', 'hostname', rows);
        } catch (err) {
          log?.warn('could not write host kinds', { err: err?.message ?? String(err) });
        }
      }
      log?.info('hosts asked what they are', { asked: ask.length, answered: rows.length, knots: rows.filter((r) => r.knot).length });
    } finally {
      running = false;
    }
  }

  return {
    check,
    isKnot: (hostname) => known.get(hostname)?.knot === true,
    /** Whether the answers kept so far have been read, so isKnot can be trusted. */
    get ready() {
      return loaded;
    },
    get knots() {
      return [...known].filter(([, k]) => k.knot).map(([h]) => h);
    },
  };
}
