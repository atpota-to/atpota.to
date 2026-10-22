// plc-watch.js
// Today's identity weather, live: the station reads the PLC directory's log (plc.js) as
// it goes, after each host census, and keeps today's row of atmosphere_plc_day
// (sql/atmosphere_hosts.sql) up to date. It counts exactly as backfill-hosts.js does
// (PlcHistory, one day at a time): new accounts by where they signed up, new accounts
// with a handle on their own domain, accounts moving out of Bluesky's hosts, back in and
// between independent hosts (and the hosts they moved to), and deletions.
//
// A move needs to know where an account was before. One seen earlier today is known; one
// that wasn't, and now names an independent host (or deletes itself), has its history
// read once (/log/audit). About 250,000 operations a day is about 250 pages, so each
// poll reads a few dozen.
//
// After a restart it reads today again from midnight UTC, so today's row stays whole. A
// day the station was down across the end of isn't finished: the backfill rewrites it.

import { PlcHistory, plcRow } from './backfill-hosts.js';
import { auditLog, exportPage, PAGE_COUNT } from './plc.js';

/** At most this many pages a poll: a restart's catch-up spreads over a poll or two. */
export const MAX_PAGES_PER_POLL = 400;
/** At most this many histories read a poll (the rest wait for the next). */
export const MAX_AUDITS_PER_POLL = 300;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createPlcWatch({ census, upsert, log, fetchImpl = (u, i) => fetch(u, i), now = () => Date.now(), maxPages = MAX_PAGES_PER_POLL, maxAudits = MAX_AUDITS_PER_POLL }) {
  let day = null;
  let history = null;
  let after = null;
  let atAfter = new Set();
  let audited = new Set();
  let running = false;

  const begin = (d) => {
    day = d;
    history = new PlcHistory({ from: d, days: 1, relayHosts: history?.relayHosts ?? new Set() });
    audited = new Set();
  };

  async function audit(limit) {
    const want = history.needsAudit().filter((did) => !audited.has(did)).slice(0, limit);
    for (const did of want) {
      audited.add(did);
      history.fromAudit(did, await auditLog(fetchImpl, did, { log: (m) => log?.warn('plc', { m }) }));
    }
    return want.length;
  }

  async function write() {
    await upsert('atmosphere_plc_day', 'day', [plcRow(day, history.signals[0])]);
  }

  async function poll() {
    if (running || !census.hosts) return;
    running = true;
    try {
      if (!day) {
        begin(dayOf(now()));
        after = `${day}T00:00:00.000Z`;
      }
      // only hosts the relay lists count, as of its latest census
      history.relayHosts = new Set(census.hosts.map((h) => h.hostname));
      let pages = 0;
      for (; pages < maxPages; pages++) {
        const asked = after;
        const page = await exportPage(fetchImpl, asked, { log: (m) => log?.warn('plc', { m }) });
        for (const e of page) {
          if (e.at === after) {
            if (atAfter.has(e.cid)) continue;
          } else {
            after = e.at;
            atAfter = new Set();
          }
          atAfter.add(e.cid);
          const d = dayOf(Date.parse(e.at));
          if (d > day) {
            // midnight: finish the day before starting the next
            await audit(Infinity);
            await write();
            log?.info('plc day written', { day, moved_out: history.signals[0].moved_out });
            begin(d);
          }
          history.add(e);
        }
        if (page.length < PAGE_COUNT || after === asked) break;
      }
      const audits = await audit(maxAudits);
      await write();
      const { destinations, ...counted } = history.signals[0];
      log?.info('plc counted', { day, pages, audits, up: after, ...counted, destinations: Object.keys(destinations).length });
    } catch (err) {
      log?.warn('could not count plc', { err: err?.message ?? String(err) });
    } finally {
      running = false;
    }
  }

  return {
    poll,
    get day() {
      return day;
    },
    get signals() {
      return history?.signals[0] ?? null;
    },
  };
}
