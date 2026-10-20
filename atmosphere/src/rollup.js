// rollup.js
// Active accounts by hour, day and month (UTC), for the trends. Each minute's sketches
// (accounts.js, hll.js) are merged into the hour, day and month it belongs to, here, in
// memory: merging in Postgres is far too slow on this project. Each of the three is
// written back whole (atmosphere_account_sketch, atmosphere_account_app_sketch) every
// FLUSH_EVERY minutes, and when it ends.
//
// `through` is the last minute merged into each. A minute at or before it is never
// merged again, so a retried write can't count its seconds twice. After a restart, the
// first minute of a period loads what was written for it, then merges the minute rows
// (written every minute, and kept for a couple of hours) after its `through`, so the
// minutes between the last write and the restart aren't lost.

import { Sketch } from './hll.js';

export const PERIODS = ['hour', 'day', 'month'];
export const FLUSH_EVERY = 5;

const iso = (second) => new Date(second * 1000).toISOString();
const sec = (isoString) => Date.parse(isoString) / 1000;

/** A sketch as PostgREST takes and gives bytea: "\x" and hex. */
export const toBytea = (bytes) => `\\x${Buffer.from(bytes).toString('hex')}`;
export function fromBytea(text) {
  if (typeof text !== 'string' || !text.startsWith('\\x')) throw new Error('not bytea');
  return Sketch.decode(Buffer.from(text.slice(2), 'hex'));
}

/** The start (epoch seconds) of the UTC hour, day or month a second is in. */
export function periodStart(period, second) {
  if (period === 'minute') return Math.floor(second / 60) * 60;
  if (period === 'hour') return Math.floor(second / 3600) * 3600;
  if (period === 'day') return Math.floor(second / 86_400) * 86_400;
  const d = new Date(second * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

/** The start of the next one. */
export function periodEnd(period, start) {
  if (period === 'minute') return start + 60;
  if (period === 'hour') return start + 3600;
  if (period === 'day') return start + 86_400;
  const d = new Date(start * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

/**
 * The rows for one minute's accounts (`accounts` from writer.js's minuteRows), or one
 * period's: { main: atmosphere_account_sketch row, apps: atmosphere_account_app_sketch rows }.
 */
export function sketchRows(period, t, { through, seconds, bluesky, elsewhere, apps }) {
  const all = new Sketch().merge(bluesky).merge(elsewhere);
  return {
    main: {
      period,
      t: iso(t),
      through: iso(through),
      seconds,
      dids: all.estimate(),
      dids_bluesky: bluesky.estimate(),
      dids_elsewhere: elsewhere.estimate(),
      bluesky: toBytea(bluesky.encode()),
      elsewhere: toBytea(elsewhere.encode()),
    },
    apps: [...apps].map(([domain, s]) => ({ period, t: iso(t), domain, dids: s.estimate(), sketch: toBytea(s.encode()) })),
  };
}

function emptyEntry(period, t) {
  return { period, t, through: null, seconds: 0, bluesky: new Sketch(), elsewhere: new Sketch(), apps: new Map(), dirty: false, dirtyApps: new Set() };
}

/** Merges one minute ({ minute, seconds, bluesky, elsewhere, apps: Map }, sketches) into a period, unless it's already in. */
export function mergeMinute(e, m) {
  if (e.through !== null && m.minute <= e.through) return false;
  e.bluesky.merge(m.bluesky);
  e.elsewhere.merge(m.elsewhere);
  for (const [domain, s] of m.apps) {
    const into = e.apps.get(domain);
    if (into) into.merge(s);
    else e.apps.set(domain, new Sketch().merge(s));
    e.dirtyApps.add(domain);
  }
  e.seconds += m.seconds;
  e.through = m.minute;
  e.dirty = true;
  return true;
}

export function createRollup({ rest, log }) {
  const entries = new Map();

  async function load(period, t) {
    const e = emptyEntry(period, t);
    const at = iso(t);
    const [main] = await rest.getAll(`atmosphere_account_sketch?select=through,seconds,bluesky,elsewhere&period=eq.${period}&t=eq.${at}&order=t`);
    if (main) {
      e.through = sec(main.through);
      e.seconds = main.seconds;
      e.bluesky = fromBytea(main.bluesky);
      e.elsewhere = fromBytea(main.elsewhere);
      for (const a of await rest.getAll(`atmosphere_account_app_sketch?select=domain,sketch&period=eq.${period}&t=eq.${at}&order=domain`)) e.apps.set(a.domain, fromBytea(a.sketch));
    }
    // the minutes since it was last written
    const range = `t=gte.${iso(e.through === null ? t : e.through + 60)}&t=lt.${iso(periodEnd(period, t))}`;
    const minutes = await rest.getAll(`atmosphere_account_sketch?select=t,seconds,bluesky,elsewhere&period=eq.minute&${range}&order=t`);
    const minuteApps = await rest.getAll(`atmosphere_account_app_sketch?select=t,domain,sketch&period=eq.minute&${range}&order=t,domain`);
    for (const m of minutes) {
      const apps = new Map(minuteApps.filter((a) => a.t === m.t).map((a) => [a.domain, fromBytea(a.sketch)]));
      mergeMinute(e, { minute: sec(m.t), seconds: m.seconds, bluesky: fromBytea(m.bluesky), elsewhere: fromBytea(m.elsewhere), apps });
    }
    log?.info('account rollup loaded', { period, t: at, written: Boolean(main), minutesMerged: minutes.length, apps: e.apps.size });
    return e;
  }

  async function write(e) {
    const rows = sketchRows(e.period, e.t, { ...e, apps: [...e.dirtyApps].map((d) => [d, e.apps.get(d)]) });
    // apps first: if the main row's write fails, its `through` stays behind them, and merging again changes nothing
    for (let i = 0; i < rows.apps.length; i += 200) await rest.upsert('atmosphere_account_app_sketch', 'period,t,domain', rows.apps.slice(i, i + 200));
    await rest.upsert('atmosphere_account_sketch', 'period,t', [rows.main]);
    e.dirty = false;
    e.dirtyApps.clear();
  }

  async function entryFor(period, t) {
    const e = entries.get(period);
    if (e?.t === t) return e;
    if (e?.dirty) await write(e); // it's over: write what it has before letting it go
    const loaded = await load(period, t);
    entries.set(period, loaded);
    return loaded;
  }

  return {
    /** One minute's sketches, merged into its hour, day and month; written every FLUSH_EVERY minutes. */
    async add(m) {
      for (const period of PERIODS) mergeMinute(await entryFor(period, periodStart(period, m.minute)), m);
      if ((m.minute / 60) % FLUSH_EVERY === FLUSH_EVERY - 1) await this.flush();
    },
    async flush() {
      for (const e of entries.values()) if (e.dirty) await write(e);
    },
    entries,
  };
}
