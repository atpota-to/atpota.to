// crawl.js
// Rebuilds the weather from before Jetstream v2's archive began, out of the crawl at
// its start. archive.js refuses that part of the archive, and rightly: a crawled record
// is stamped when it was crawled, so read as a stream it says the whole network was
// written in four days. But almost every record also says when it was made: its rkey is
// a TID its PDS (or app) minted when it was written. Counted by that, the crawl is the
// network's history, back to 2022, in surviving records.
//
//   node src/crawl.js --probe                      what the crawl holds; writes nothing
//   node src/crawl.js [--from 2022-11-01] [--to 2026-10-02] [--dry-run]
//
// On a machine with a couple of GB of memory to spare (see README.md, "Rebuilding
// older weather from the crawl"), from the data folder so it picks up the keys:
//
//   cd /root/atpotato-weather && nice -n 10 /opt/node22/bin/node --env-file=.env \
//     /root/atpota-live/atmosphere/src/crawl.js --probe
//
// What comes out is not what the station would have heard, in three ways:
//
//   - only records that still exist: likes taken back, posts deleted and deleted
//     accounts never made it into the crawl, so the past reads low, the more so the
//     further back (more time for things to be deleted);
//   - only creates: updates, deletes, identity and account events leave nothing behind,
//     so those columns are 0;
//   - the time is the one the record claims: an import that backdated its rkeys (old
//     tweets brought over, say) shows up as activity when it says, not when it came.
//     Records claiming to be from before EARLIEST_S are left out, as are those after
//     --to, and those with no TID rkey and no readable createdAt.
//
// So these minutes are a different kind of measurement from the station's, and from
// the archive's. Anything before RECONSTRUCTED_BEFORE came from here and can be told
// apart (or taken out) by time.
//
// The crawl is in repo order, not time order, so nothing is finished until the whole
// crawl is read: everything is added up in memory (about 600 MB for the default range,
// most of it the hours' account sketches), and saved to --state every
// CHECKPOINT_EVERY_MS and on Ctrl-C. Running it again picks up from the last save; the
// state remembers the last seq it counted, and events come in seq order. Once the crawl
// is read the state is marked complete, and the rows are written. Every write is an
// insert that leaves existing rows alone, so writing twice changes nothing and nothing
// the station or archive.js wrote is ever replaced.
//
// It writes:
//   atmosphere_minute               every minute in --from..--to (dids left null: per-
//                                   minute sketches for four years would be ~17 GB)
//   atmosphere_hour_app,            each app outside Bluesky, by hour and day (straight
//   atmosphere_day_app              to the roll-ups: minute app rows would only be pruned)
//   atmosphere_account_sketch       hours, days and months (whole ones) of active accounts
//   atmosphere_account_app_sketch   days and months, per app (hours are only kept 30
//                                   days, so none are written)
//
// `collections` and `apps` on the minute rows are estimated (linear counting over
// COLLECTION_BITS and APP_BITS bits a minute), since keeping each minute's set of
// collections for four years doesn't fit; everything else is an exact count.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDomain, COLLECTIONS, isBluesky, isNsid } from './atmosphere.js';
import { DEFAULT_HOST, listSegments, loadSdk, rateOf, LIVE_MAX_RATE, SDK_DIR, timeUsOf, tries } from './archive.js';
import { M, registerOf, Sketch, SPARSE_MAX } from './hll.js';
import { periodEnd, periodStart, sketchRows } from './rollup.js';

/** The earliest a record may claim to be from: Bluesky's first PDS records are from November 2022. */
export const EARLIEST_S = Date.UTC(2022, 10, 1) / 1000;
/** Where the archive's own history begins (archive.js). Everything before it came from the crawl. */
export const RECONSTRUCTED_BEFORE = '2026-10-06T14:00:00Z';
export const CHECKPOINT_EVERY_MS = 30 * 60_000;
export const COLLECTION_BITS = 128;
export const APP_BITS = 64;
/** Collections (and apps) given an id; past this, a new name counts for elsewhere but no app. */
export const MAX_NSIDS = 1 << 20;
/** Hour × collection pairs kept; past this a new pair counts for elsewhere but no app (a Map holds at most 2^24). */
export const MAX_PAIRS = 12_000_000;
export const STATE_VERSION = 1;
export const PROBE_EVENTS = 1_000_000;
/** Rows a request, by kind: sketch rows are up to 16 KB each. */
export const BATCH = { rows: 1000, sketches: 50 };

const iso = (second) => new Date(second * 1000).toISOString();
const isoUs = (us) => new Date(Math.floor(us / 1000)).toISOString();
const SHIFT = 2 ** 20;
const pad = (n) => (8 - (n % 8)) % 8;
const FIELDS = [COLLECTIONS.posts, COLLECTIONS.likes, COLLECTIONS.reposts, COLLECTIONS.follows];

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
const TID_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < 32; i++) TID_VALUE[TID_ALPHABET.charCodeAt(i)] = i;

/**
 * A TID's microseconds, or null if it isn't one: clock.js's tidUs without BigInts, for
 * the billions of rkeys. The first eleven characters are the top 55 bits; the top two
 * are zero in a TID, so the rest (the microseconds) fit a double exactly.
 */
export function tidMicros(s) {
  if (typeof s !== 'string' || s.length !== 13) return null;
  let v = 0;
  for (let i = 0; i < 13; i++) {
    const c = s.charCodeAt(i);
    const d = c < 128 ? TID_VALUE[c] : -1;
    if (d < 0 || (i === 0 && d > 7)) return null;
    if (i < 11) v = v * 32 + d;
  }
  return v;
}

/** When a crawled record says it was made, in microseconds: its rkey's TID, else its createdAt; null for neither. */
export function madeUs(commit, parseRawRecord) {
  const t = tidMicros(commit.rkey);
  if (t !== null) return t;
  try {
    const ms = Date.parse(parseRawRecord(commit.record)?.createdAt);
    return Number.isFinite(ms) ? ms * 1000 : null;
  } catch {
    return null;
  }
}

/** A small string hash, for picking a name's bit in a minute's bitmap. */
function bitOf(s, bits) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) % bits;
}

/** Distinct names from a bitmap of `bits` bits with `set` of them set (linear counting). */
export function linearCount(set, bits) {
  if (set === 0) return 0;
  const zeros = bits - set;
  return Math.round(bits * Math.log(bits / Math.max(zeros, 0.5)));
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** An app's accounts on a day: sparse (a Map of register to value) until dense is smaller. */
class AppSketch {
  constructor() {
    this.sparse = new Map();
    this.dense = null;
  }
  add(packed) {
    const i = packed >>> 6;
    const v = packed & 63;
    if (this.dense) {
      if (v > this.dense[i]) this.dense[i] = v;
      return;
    }
    if (v > (this.sparse.get(i) ?? 0)) this.sparse.set(i, v);
    if (this.sparse.size > SPARSE_MAX) {
      this.dense = new Uint8Array(M);
      for (const [r, x] of this.sparse) this.dense[r] = x;
      this.sparse = null;
    }
  }
  toSketch() {
    if (this.dense) return new Sketch(new Uint8Array(this.dense));
    const s = new Sketch();
    for (const [r, x] of this.sparse) s.registers[r] = x;
    return s;
  }
  static of(sketch) {
    const a = new AppSketch();
    for (let i = 0; i < M; i++) if (sketch.registers[i]) a.add((i << 6) | sketch.registers[i]);
    return a;
  }
}

/**
 * Everything counted from the crawl over [fromSec, toSec) (whole UTC days), in memory:
 * per minute, per hour and collection, per hour and app, and per day and app.
 */
export class History {
  constructor({ fromSec, toSec }) {
    if (fromSec % 86400 || toSec % 86400 || toSec <= fromSec) throw new Error('the range must be whole UTC days');
    this.fromSec = fromSec;
    this.toSec = toSec;
    this.minutes = (toSec - fromSec) / 60;
    this.hours = this.minutes / 60;
    const n = this.minutes;
    this.creates = new Uint32Array(n);
    this.elsewhere = new Uint32Array(n);
    this.fields = FIELDS.map(() => new Uint32Array(n));
    this.colBits = new Uint32Array(n * (COLLECTION_BITS / 32));
    this.appBits = new Uint32Array(n * (APP_BITS / 32));
    // Each hour's account sketches, Bluesky then elsewhere: hour h is at h * 2 * M.
    this.hourSketches = new Uint8Array(this.hours * 2 * M);
    this.nsids = []; // id -> name
    this.nsidIds = new Map(); // name -> id, or -1 for a name that isn't an NSID
    this.nsidInfo = []; // id -> { bluesky, field, domain, colBit, appBit }
    this.domains = [];
    this.domainIds = new Map();
    this.hourNsid = new Map(); // hour * SHIFT + nsid id -> creates
    this.hourAppMask = new Map(); // hour * SHIFT + domain id -> index into maskPool (two words: minutes 0-29, 30-59)
    this.maskPool = new Uint32Array(1 << 16);
    this.maskUsed = 0;
    this.dayApps = new Map(); // day * SHIFT + domain id -> AppSketch
    this.stats = { overflow: 0 };
  }

  /** The id for a collection, registering it; -1 if it isn't an NSID, -2 once MAX_NSIDS are taken. */
  nsidId(name) {
    const known = this.nsidIds.get(name);
    if (known !== undefined) return known;
    if (!isNsid(name)) {
      if (this.nsidIds.size < MAX_NSIDS * 2) this.nsidIds.set(name, -1);
      return -1;
    }
    if (this.nsids.length >= MAX_NSIDS) return -2;
    const id = this.nsids.length;
    this.nsids.push(name);
    this.nsidIds.set(name, id);
    this.nsidInfo.push(this.#infoOf(name));
    return id;
  }

  #infoOf(name) {
    const bluesky = isBluesky(name);
    let domain = -1;
    if (!bluesky) {
      const d = appDomain(name);
      domain = this.domainIds.get(d) ?? -1;
      if (domain < 0) {
        domain = this.domains.length;
        this.domains.push(d);
        this.domainIds.set(d, domain);
      }
    }
    return { bluesky, field: FIELDS.indexOf(name), domain, colBit: bitOf(name, COLLECTION_BITS), appBit: bluesky ? -1 : bitOf(this.domains[domain], APP_BITS) };
  }

  /** Counts one record made at `us` in `collection` by the account `register` (registerOf); false if it's out of range or unreadable. */
  add(collection, us, register) {
    const m = Math.floor(us / 60e6 - this.fromSec / 60);
    if (!(m >= 0 && m < this.minutes)) return false;
    const id = this.nsidId(collection);
    if (id === -1) return false;
    const h = Math.floor(m / 60);
    this.creates[m]++;
    if (id === -2) {
      // a collection past MAX_NSIDS: always someone else's, since Bluesky's are long registered
      this.elsewhere[m]++;
      this.#account(h, 1, register);
      return true;
    }
    const info = this.nsidInfo[id];
    this.colBits[m * 4 + (info.colBit >>> 5)] |= 1 << (info.colBit & 31);
    if (info.bluesky) {
      if (info.field >= 0) this.fields[info.field][m]++;
      this.#account(h, 0, register);
      return true;
    }
    this.elsewhere[m]++;
    this.appBits[m * 2 + (info.appBit >>> 5)] |= 1 << (info.appBit & 31);
    this.#account(h, 1, register);
    const key = h * SHIFT + id;
    const n = this.hourNsid.get(key);
    if (n !== undefined) this.hourNsid.set(key, n + 1);
    else if (this.hourNsid.size < MAX_PAIRS) this.hourNsid.set(key, 1);
    else {
      this.stats.overflow++;
      return true;
    }
    const appKey = h * SHIFT + info.domain;
    let at = this.hourAppMask.get(appKey);
    if (at === undefined) {
      if (this.maskUsed * 2 >= this.maskPool.length) {
        const grown = new Uint32Array(this.maskPool.length * 2);
        grown.set(this.maskPool);
        this.maskPool = grown;
      }
      at = this.maskUsed++;
      this.hourAppMask.set(appKey, at);
    }
    const mm = m % 60;
    this.maskPool[at * 2 + (mm >= 30 ? 1 : 0)] |= 1 << mm % 30;
    const dayKey = Math.floor(h / 24) * SHIFT + info.domain;
    let s = this.dayApps.get(dayKey);
    if (!s) this.dayApps.set(dayKey, (s = new AppSketch()));
    s.add(register);
    return true;
  }

  #account(h, side, packed) {
    const at = (h * 2 + side) * M + (packed >>> 6);
    const v = packed & 63;
    if (v > this.hourSketches[at]) this.hourSketches[at] = v;
  }

  /** Hour h's sketch, Bluesky (side 0) or elsewhere (1), sharing this history's memory. */
  hourSketch(h, side) {
    return new Sketch(this.hourSketches.subarray((h * 2 + side) * M, (h * 2 + side + 1) * M));
  }

  /** The atmosphere_minute rows for minutes [from, to) (indexes). */
  minuteRows(from = 0, to = this.minutes) {
    const rows = [];
    for (let m = from; m < to; m++) {
      let cols = 0;
      for (let w = 0; w < 4; w++) cols += popcount(this.colBits[m * 4 + w]);
      const apps = popcount(this.appBits[m * 2]) + popcount(this.appBits[m * 2 + 1]);
      const creates = this.creates[m];
      const elsewhere = this.elsewhere[m];
      rows.push({
        minute: iso(this.fromSec + m * 60),
        seconds_covered: 60,
        creates,
        bluesky: creates - elsewhere,
        elsewhere,
        posts: this.fields[0][m],
        likes: this.fields[1][m],
        reposts: this.fields[2][m],
        follows: this.fields[3][m],
        updates: 0,
        deletes: 0,
        identity: 0,
        account: 0,
        collections: linearCount(cols, COLLECTION_BITS),
        apps: linearCount(apps, APP_BITS),
      });
    }
    return rows;
  }

  /**
   * Each app's hours: Map<hour index, Map<domain, { creates, minutes, collections }>>,
   * collections being its three busiest in the hour.
   */
  hourApps() {
    const byHour = new Map();
    for (const [key, n] of this.hourNsid) {
      const h = Math.floor(key / SHIFT);
      const id = key - h * SHIFT;
      const info = this.nsidInfo[id];
      let apps = byHour.get(h);
      if (!apps) byHour.set(h, (apps = new Map()));
      const domain = this.domains[info.domain];
      let a = apps.get(domain);
      if (!a) {
        const at = this.hourAppMask.get(h * SHIFT + info.domain);
        apps.set(domain, (a = { creates: 0, minutes: popcount(this.maskPool[at * 2]) + popcount(this.maskPool[at * 2 + 1]), nsids: [] }));
      }
      a.creates += n;
      a.nsids.push([this.nsids[id], n]);
    }
    for (const apps of byHour.values()) {
      for (const a of apps.values()) {
        a.collections = a.nsids.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 3).map(([nsid]) => nsid);
        delete a.nsids;
      }
    }
    return byHour;
  }

  /** The atmosphere_hour_app and atmosphere_day_app rows; a day's collections are its busiest hour's. */
  appRows() {
    const hours = [];
    const days = new Map();
    for (const [h, apps] of [...this.hourApps()].sort((a, b) => a[0] - b[0])) {
      const hour = iso(this.fromSec + h * 3600);
      const day = iso(this.fromSec + Math.floor(h / 24) * 86400);
      for (const [domain, a] of apps) {
        hours.push({ hour, domain, creates: a.creates, minutes: a.minutes, collections: a.collections });
        const key = `${day} ${domain}`;
        const d = days.get(key) ?? { day, domain, creates: 0, minutes: 0, collections: [], busiest: 0 };
        d.creates += a.creates;
        d.minutes += a.minutes;
        if (a.creates > d.busiest) Object.assign(d, { busiest: a.creates, collections: a.collections });
        days.set(key, d);
      }
    }
    return { hours, days: [...days.values()].map(({ busiest, ...d }) => d) };
  }

  /**
   * Account sketch periods, as rollup.js's entries, oldest first: every hour, every day,
   * and every month wholly inside the range. Only days and months carry apps.
   */
  *sketchPeriods() {
    const hourOf = (t) => (t - this.fromSec) / 3600;
    for (let h = 0; h < this.hours; h++) {
      const t = this.fromSec + h * 3600;
      yield { period: 'hour', t, through: t + 3540, seconds: 3600, bluesky: this.hourSketch(h, 0), elsewhere: this.hourSketch(h, 1), apps: new Map() };
    }
    const dayOf = (t) => {
      const bluesky = new Sketch();
      const elsewhere = new Sketch();
      for (let h = hourOf(t); h < hourOf(t) + 24; h++) {
        bluesky.merge(this.hourSketch(h, 0));
        elsewhere.merge(this.hourSketch(h, 1));
      }
      const d = (t - this.fromSec) / 86400;
      const apps = new Map();
      for (let id = 0; id < this.domains.length; id++) {
        const s = this.dayApps.get(d * SHIFT + id);
        if (s) apps.set(this.domains[id], s.toSketch());
      }
      return { period: 'day', t, through: t + 86340, seconds: 86400, bluesky, elsewhere, apps };
    };
    let month = null;
    for (let t = this.fromSec; t < this.toSec; t += 86400) {
      const day = dayOf(t);
      yield day;
      const mt = periodStart('month', t);
      if (mt < this.fromSec) continue;
      if (!month || month.t !== mt) month = { period: 'month', t: mt, through: null, seconds: 0, bluesky: new Sketch(), elsewhere: new Sketch(), apps: new Map() };
      month.bluesky.merge(day.bluesky);
      month.elsewhere.merge(day.elsewhere);
      for (const [domain, s] of day.apps) {
        const into = month.apps.get(domain);
        if (into) into.merge(s);
        else month.apps.set(domain, new Sketch().merge(s));
      }
      month.seconds += 86400;
      month.through = t + 86340;
      if (periodEnd('month', mt) === t + 86400) {
        yield month;
        month = null;
      }
    }
  }

  /** How many bytes it holds, roughly, for the log. */
  get bytes() {
    const arrays = this.creates.byteLength * (2 + FIELDS.length) + this.colBits.byteLength + this.appBits.byteLength + this.hourSketches.byteLength + this.maskPool.byteLength;
    return arrays + (this.hourNsid.size + this.hourAppMask.size) * 40 + this.dayApps.size * 200;
  }

  /** Writes it to `file` (through a temporary file, so a crash mid-save leaves the last one), with `meta` alongside. */
  save(file, meta) {
    const hourNsidKeys = Float64Array.from(this.hourNsid.keys());
    const hourNsidValues = Float64Array.from(this.hourNsid.values());
    const maskKeys = Float64Array.from(this.hourAppMask.keys());
    const maskAt = Uint32Array.from(this.hourAppMask.values());
    const dayKeys = Float64Array.from(this.dayApps.keys());
    const dayBytes = [...this.dayApps.values()].map((s) => s.toSketch().encode());
    const dayOffsets = new Uint32Array(dayBytes.length + 1);
    for (let i = 0; i < dayBytes.length; i++) dayOffsets[i + 1] = dayOffsets[i] + dayBytes[i].length;
    const arrays = {
      creates: this.creates,
      elsewhere: this.elsewhere,
      ...Object.fromEntries(this.fields.map((f, i) => [`field${i}`, f])),
      colBits: this.colBits,
      appBits: this.appBits,
      hourSketches: this.hourSketches,
      hourNsidKeys,
      hourNsidValues,
      maskKeys,
      maskAt,
      maskPool: this.maskPool.subarray(0, this.maskUsed * 2),
      dayKeys,
      dayOffsets,
      dayBytes: Buffer.concat(dayBytes),
    };
    const manifest = {
      version: STATE_VERSION,
      ...meta,
      fromSec: this.fromSec,
      toSec: this.toSec,
      nsids: this.nsids,
      invalid: [...this.nsidIds].filter(([, id]) => id === -1).map(([name]) => name),
      stats: this.stats,
      arrays: Object.entries(arrays).map(([name, a]) => ({ name, type: a.constructor.name, length: a.length })),
    };
    // Each array starts on an 8-byte boundary, so load can use the file's memory as it is.
    const json = Buffer.from(JSON.stringify(manifest));
    const head = Buffer.concat([json, Buffer.alloc(pad(4 + json.length))]);
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(json.length);
      fs.writeSync(fd, len);
      fs.writeSync(fd, head);
      for (const a of Object.values(arrays)) {
        fs.writeSync(fd, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
        if (pad(a.byteLength)) fs.writeSync(fd, Buffer.alloc(pad(a.byteLength)));
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  /** { history, meta } from a file save wrote, or null if there's none. */
  static load(file) {
    if (!fs.existsSync(file)) return null;
    let buf = fs.readFileSync(file);
    if (buf.byteOffset % 8) buf = Buffer.from(buf); // a pooled (small) read; copy it onto a boundary
    const headLen = buf.readUInt32BE(0);
    const manifest = JSON.parse(buf.subarray(4, 4 + headLen).toString());
    if (manifest.version !== STATE_VERSION) throw new Error(`${file} is from another version of crawl.js; move it away to start again`);
    const types = { Uint8Array, Uint32Array, Float64Array, Buffer: Uint8Array };
    const arrays = {};
    let o = 4 + headLen + pad(4 + headLen);
    for (const { name, type, length } of manifest.arrays) {
      const T = types[type];
      const bytes = length * T.BYTES_PER_ELEMENT;
      arrays[name] = new T(buf.buffer, buf.byteOffset + o, length);
      o += bytes + pad(bytes);
    }
    const h = new History({ fromSec: manifest.fromSec, toSec: manifest.toSec });
    h.creates = arrays.creates;
    h.elsewhere = arrays.elsewhere;
    h.fields = FIELDS.map((_, i) => arrays[`field${i}`]);
    h.colBits = arrays.colBits;
    h.appBits = arrays.appBits;
    h.hourSketches = arrays.hourSketches;
    for (const name of manifest.nsids) h.nsidId(name);
    for (const name of manifest.invalid) h.nsidIds.set(name, -1);
    h.hourNsid = new Map();
    for (let i = 0; i < arrays.hourNsidKeys.length; i++) h.hourNsid.set(arrays.hourNsidKeys[i], arrays.hourNsidValues[i]);
    h.hourAppMask = new Map();
    for (let i = 0; i < arrays.maskKeys.length; i++) h.hourAppMask.set(arrays.maskKeys[i], arrays.maskAt[i]);
    h.maskUsed = arrays.maskPool.length / 2;
    h.maskPool = new Uint32Array(Math.max(1 << 16, 2 ** Math.ceil(Math.log2(arrays.maskPool.length + 2))));
    h.maskPool.set(arrays.maskPool);
    h.dayApps = new Map();
    for (let i = 0; i < arrays.dayKeys.length; i++) h.dayApps.set(arrays.dayKeys[i], AppSketch.of(Sketch.decode(arrays.dayBytes.subarray(arrays.dayOffsets[i], arrays.dayOffsets[i + 1]))));
    h.stats = manifest.stats;
    const { version, fromSec, toSec, nsids, invalid, stats, arrays: _, ...meta } = manifest;
    return { history: h, meta };
  }
}

/**
 * The part of the archive to read, from the segment list: everything from its first
 * segment through the last crawl segment (a segment far faster than the live stream,
 * as archive.js tells them apart). `startUs` is when the crawl began.
 */
export function planCrawl(segments) {
  if (!segments.length) throw new Error('the archive lists no segments');
  const isCrawl = segments.map((s) => rateOf(s) >= LIVE_MAX_RATE);
  const last = isCrawl.lastIndexOf(true);
  if (last < 0) throw new Error('the archive has no crawl: every segment runs at the live stream’s pace');
  const picked = segments.slice(0, last + 1);
  const crawl = picked.filter((_, i) => isCrawl[i]);
  return {
    afterSeq: picked[0].minSeq - 1,
    beforeSeq: picked.at(-1).maxSeq,
    segments: picked.length,
    bytes: picked.reduce((a, s) => a + s.sizeBytes, 0),
    events: picked.reduce((a, s) => a + s.eventCount, 0),
    startUs: Math.min(...crawl.map((s) => s.minWitnessedAt)),
    endUs: Math.max(...crawl.map((s) => s.maxWitnessedAt)),
    middle: crawl[Math.floor(crawl.length / 2)],
  };
}

export function parseArgs(argv) {
  const args = { probe: false, dryRun: false, from: null, to: null, host: null, state: 'crawl-state.bin', probeEvents: PROBE_EVENTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--probe') args.probe = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--from' || a === '--to' || a === '--host' || a === '--state') args[a.slice(2)] = argv[++i] ?? null;
    else if (a === '--probe-events') args.probeEvents = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  const day = (s, name) => {
    if (s === null) return null;
    const t = Date.parse(s);
    if (!Number.isFinite(t) || t % 86_400_000) throw new Error(`--${name} must be a UTC midnight, like 2022-11-01`);
    return t / 1000;
  };
  args.fromSec = day(args.from, 'from') ?? EARLIEST_S;
  args.toSec = day(args.to, 'to');
  if (args.fromSec < EARLIEST_S) throw new Error(`--from can't be before ${iso(EARLIEST_S).slice(0, 10)}`);
  if (!(args.probeEvents > 0)) throw new Error('--probe-events must be a number');
  return args;
}

/** fetch, counting the bytes of every response body as they arrive (what the key's allowance meters). */
export function countingFetch(fetch = globalThis.fetch) {
  const counted = { bytes: 0 };
  const wrapped = async (...a) => {
    const res = await fetch(...a);
    if (!res.body) return res;
    const body = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, c) {
          counted.bytes += chunk.byteLength;
          c.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return { fetch: wrapped, counted };
}

/**
 * Reads events into a History, from the seq after `throughSeq`. Calls `onTick` every
 * 100k events (for checkpoints and progress); stops early once `limit` events are read.
 * Resolves with { throughSeq, done }.
 */
export async function readCrawl({ events, history, parseRawRecord, throughSeq, stats, onTick = async () => {}, limit = Infinity }) {
  let lastDid = null;
  let lastRegister = 0;
  let n = 0;
  for await (const evt of events) {
    if (!(evt.seq > throughSeq)) continue; // at least once: a re-planned download can repeat some
    throughSeq = evt.seq;
    stats.events++;
    if (evt.kind !== 'commit') stats.kinds[evt.kind] = (stats.kinds[evt.kind] ?? 0) + 1;
    else if (evt.commit.operation !== 'create') stats.kinds[evt.commit.operation] = (stats.kinds[evt.commit.operation] ?? 0) + 1;
    else {
      const c = evt.commit;
      const us = madeUs(c, parseRawRecord);
      if (us === null) stats.undated++;
      else {
        if (evt.did !== lastDid) {
          lastDid = evt.did;
          lastRegister = registerOf(evt.did);
        }
        if (history.add(c.collection, us, lastRegister)) stats.counted++;
        else if (us < history.fromSec * 1e6) stats.before++;
        else if (us >= history.toSec * 1e6) stats.after++;
        else stats.invalid++;
        if (stats.years) {
          const y = Number.isFinite(us) ? new Date(us / 1000).getUTCFullYear() : 'nonsense';
          stats.years[y] = (stats.years[y] ?? 0) + 1;
          const lagUs = timeUsOf(evt.time) - us;
          if (lagUs >= 0 && lagUs < 600e6) stats.fresh++;
        }
      }
    }
    if (++n % 100_000 === 0) await onTick(throughSeq);
    if (n >= limit) return { throughSeq, done: false };
  }
  return { throughSeq, done: true };
}

export const emptyStats = () => ({ events: 0, counted: 0, undated: 0, before: 0, after: 0, invalid: 0, kinds: {} });

/** Writes a finished History to Supabase: inserts only, so nothing already there changes. */
export function crawlStore({ url, key, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' };
  return {
    async insert(table, conflict, rows) {
      const res = await fetch(`${base}/rest/v1/${table}?on_conflict=${conflict}`, { method: 'POST', headers, body: JSON.stringify(rows), signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    },
  };
}

/** Writes everything a History holds, a batch at a time, oldest first. */
export async function writeHistory({ history, db, log = console.log }) {
  const put = async (table, conflict, rows, size = BATCH.rows) => {
    for (let i = 0; i < rows.length; i += size) await tries(`writing ${table}`, () => db.insert(table, conflict, rows.slice(i, i + size)));
  };
  const day = 1440;
  for (let m = 0; m < history.minutes; m += day) {
    await put('atmosphere_minute', 'minute', history.minuteRows(m, Math.min(m + day, history.minutes)));
    if ((m / day) % 30 === 29) log(`minutes written through ${iso(history.fromSec + (m + day) * 60).slice(0, 10)}`);
  }
  log(`wrote ${history.minutes.toLocaleString('en-US')} minutes`);
  const { hours, days } = history.appRows();
  await put('atmosphere_hour_app', 'hour,domain', hours);
  await put('atmosphere_day_app', 'day,domain', days);
  log(`wrote ${hours.length.toLocaleString('en-US')} app hours and ${days.length.toLocaleString('en-US')} app days`);
  const n = { hour: 0, day: 0, month: 0 };
  let batch = [];
  const flush = async () => {
    await put('atmosphere_account_sketch', 'period,t', batch, BATCH.sketches);
    batch = [];
  };
  for (const e of history.sketchPeriods()) {
    const rows = sketchRows(e.period, e.t, e);
    // apps first, so a period with a main row is always whole (as archive.js)
    if (rows.apps.length) await put('atmosphere_account_app_sketch', 'period,t,domain', rows.apps, BATCH.sketches * 4);
    batch.push(rows.main);
    n[e.period]++;
    if (batch.length >= BATCH.sketches) await flush();
  }
  if (batch.length) await flush();
  log(`wrote account sketches for ${n.hour} hours, ${n.day} days and ${n.month} months`);
}

/** Prints what the crawl holds from a sample of it, without keeping anything. */
export async function probe({ args, host, apiKey, sdk, fetch = globalThis.fetch, log = console.log }) {
  const plan = planCrawl(await listSegments({ host, key: apiKey, fetch }));
  log(`the crawl: ${plan.segments} segments, ${(plan.bytes / 1e12).toFixed(2)} TB, ${(plan.events / 1e9).toFixed(2)} billion events, ${isoUs(plan.startUs)} to ${isoUs(plan.endUs)}`);
  const s = plan.middle;
  log(`sampling ${args.probeEvents.toLocaleString('en-US')} events from the middle segment (${s.index}, seq ${s.minSeq} to ${s.maxSeq})`);
  const counting = countingFetch(fetch);
  const js = new sdk.Jetstream({ service: host, apiKey, fetchImpl: counting.fetch });
  const history = new History({ fromSec: EARLIEST_S, toSec: Math.floor(plan.startUs / 86400e6) * 86400 });
  const stats = { ...emptyStats(), years: {}, fresh: 0 };
  const started = Date.now();
  await readCrawl({ events: js.snapshot({ raw: true, afterSeq: s.minSeq - 1, beforeSeq: s.maxSeq }), history, parseRawRecord: sdk.parseRawRecord, throughSeq: s.minSeq - 1, stats, limit: args.probeEvents });
  const secs = (Date.now() - started) / 1000;
  const pct = (x) => `${((100 * x) / Math.max(1, stats.events)).toFixed(1)}%`;
  log(`read ${stats.events.toLocaleString('en-US')} events in ${secs.toFixed(0)} s (${Math.round(stats.events / secs).toLocaleString('en-US')} a second), ${(counting.counted.bytes / 1e6).toFixed(0)} MB downloaded`);
  log(`counted ${pct(stats.counted)}; no time ${pct(stats.undated)}; before ${iso(EARLIEST_S).slice(0, 10)} ${pct(stats.before)}; after the crawl began ${pct(stats.after)}; not an NSID ${pct(stats.invalid)}`);
  log(`not creates: ${JSON.stringify(stats.kinds)}; made within 10 min of being archived (live, not crawled): ${pct(stats.fresh)}`);
  log(`by the year they say they were made: ${JSON.stringify(stats.years)}`);
  const rate = stats.events / secs;
  log(`at this pace the whole crawl is about ${(plan.events / rate / 3600).toFixed(0)} hours of reading, and ${(((counting.counted.bytes / Math.max(1, stats.events)) * plan.events) / 1e12).toFixed(2)} TB of downloads`);
}

/** One run: reads the crawl into a History (resuming from args.state), then writes it (or prints it, with no db). */
export async function rebuild({ args, host, apiKey, sdk, db, fetch = globalThis.fetch, log = console.log, warn = console.warn, onSignal = (fn) => process.once('SIGINT', fn) }) {
  const plan = planCrawl(await listSegments({ host, key: apiKey, fetch }));
  const lastDay = Math.floor(plan.endUs / 86400e6) * 86400;
  const toSec = args.toSec ?? Math.floor(plan.startUs / 86400e6) * 86400;
  if (toSec > lastDay) throw new Error(`--to can't be after ${iso(lastDay).slice(0, 10)}: the crawl ended at ${isoUs(plan.endUs)}`);
  if (toSec * 1e6 > plan.startUs) warn(`--to is after the crawl began (${isoUs(plan.startUs)}): repos crawled before ${iso(toSec)} are missing what they wrote after they were crawled`);

  const saved = History.load(args.state);
  let history;
  let meta;
  if (saved) {
    ({ history, meta } = saved);
    if (history.fromSec !== args.fromSec || history.toSec !== toSec || meta.host !== host) {
      throw new Error(`${args.state} is for ${iso(history.fromSec).slice(0, 10)} to ${iso(history.toSec).slice(0, 10)} from ${meta.host}; move it away to start a different run`);
    }
    log(`picking up ${args.state}: ${meta.complete ? 'the crawl is all read' : `through seq ${meta.throughSeq.toLocaleString('en-US')}`}`);
  } else {
    history = new History({ fromSec: args.fromSec, toSec });
    meta = { host, throughSeq: plan.afterSeq, complete: false, counts: emptyStats(), downloaded: 0 };
  }
  log(`rebuilding ${iso(history.fromSec).slice(0, 10)} to ${iso(toSec).slice(0, 10)} from the crawl on ${host}: ${plan.segments} segments, ${(plan.bytes / 1e12).toFixed(2)} TB, ${(plan.events / 1e9).toFixed(2)} billion events; about ${(history.bytes / 1e6).toFixed(0)} MB in memory to start`);

  if (!meta.complete) {
    const counting = countingFetch(fetch);
    const retried = { n: 0 };
    const js = new sdk.Jetstream({
      service: host,
      apiKey,
      fetchImpl: counting.fetch,
      retry: {
        onRetry(err, info) {
          retried.n++;
          if (info.attempt === 1 || info.attempt % 10 === 0) warn(`crawl: ${info.target.name} try ${info.attempt} failed (${err.message}); again in ${Math.round(info.delayMs / 1000)} s`);
        },
      },
    });
    const started = Date.now();
    const startEvents = meta.counts.events;
    let savedAt = Date.now();
    let loggedAt = Date.now();
    // Ctrl-C: save at the next tick and stop. A second one ends it at once, unsaved.
    let stopping = false;
    onSignal(() => {
      stopping = true;
      log('stopping: saving first (Ctrl-C again to quit without saving)');
    });
    const save = (throughSeq) => {
      meta.throughSeq = throughSeq;
      meta.downloaded += counting.counted.bytes;
      counting.counted.bytes = 0;
      history.save(args.state, meta);
      savedAt = Date.now();
    };
    let read;
    try {
      read = await readCrawl({
        events: js.snapshot({ raw: true, afterSeq: meta.throughSeq, beforeSeq: plan.beforeSeq, onError: (err) => warn(`crawl: ${err.message}`) }),
        history,
        parseRawRecord: sdk.parseRawRecord,
        throughSeq: meta.throughSeq,
        stats: meta.counts,
        async onTick(throughSeq) {
          if (stopping) {
            save(throughSeq);
            throw Object.assign(new Error('stopped'), { stopped: true });
          }
          if (Date.now() - loggedAt >= 60_000) {
            loggedAt = Date.now();
            const done = meta.counts.events / Math.max(1, plan.events);
            const rate = (meta.counts.events - startEvents) / ((Date.now() - started) / 1000);
            log(
              `${(done * 100).toFixed(2).padStart(6)}%  ${(meta.counts.events / 1e9).toFixed(3)}B events  ${Math.round(rate).toLocaleString('en-US')}/s  ${((meta.downloaded + counting.counted.bytes) / 1e9).toFixed(1)} GB in  ` +
                `about ${((plan.events - meta.counts.events) / Math.max(1, rate) / 3600).toFixed(1)} h to go  ${(history.bytes / 1e6).toFixed(0)} MB${retried.n ? `  (downloads retried ${retried.n} times)` : ''}`,
            );
          }
          if (Date.now() - savedAt >= CHECKPOINT_EVERY_MS) save(throughSeq);
        },
      });
    } catch (err) {
      if (!err.stopped) throw err;
      log(`stopped; saved through seq ${meta.throughSeq.toLocaleString('en-US')} to ${args.state}. Run the same command again to carry on`);
      return { history, meta, stopped: true };
    }
    meta.complete = true;
    save(read.throughSeq);
    const c = meta.counts;
    log(`read the crawl: ${c.events.toLocaleString('en-US')} events, ${(meta.downloaded / 1e12).toFixed(2)} TB; counted ${c.counted.toLocaleString('en-US')} records`);
    log(`left out: ${c.undated.toLocaleString('en-US')} with no time, ${c.before.toLocaleString('en-US')} claiming to be older, ${c.after.toLocaleString('en-US')} newer than --to, ${c.invalid.toLocaleString('en-US')} not NSIDs; not creates: ${JSON.stringify(c.kinds)}`);
    if (history.stats.overflow) warn(`${history.stats.overflow.toLocaleString('en-US')} records counted for elsewhere but no app: more than ${MAX_PAIRS.toLocaleString('en-US')} hour × collection pairs`);
  }

  if (!db) {
    for (let d = 0; d < history.minutes; d += 1440 * 30) {
      const rows = history.minuteRows(d, Math.min(d + 1440 * 30, history.minutes));
      const creates = rows.reduce((a, r) => a + r.creates, 0);
      const elsewhere = rows.reduce((a, r) => a + r.elsewhere, 0);
      log(`${rows[0].minute.slice(0, 10)}  ${(creates / (rows.length * 60)).toFixed(1).padStart(7)} records/s  ${((100 * elsewhere) / Math.max(1, creates)).toFixed(2).padStart(6)}% elsewhere`);
    }
    log('dry run: nothing written');
    return { history, meta };
  }
  await writeHistory({ history, db, log });
  return { history, meta };
}

async function main(argv) {
  const args = parseArgs(argv);
  const apiKey = process.env.JETSTREAM_API_KEY?.trim().replace(/^["']|["']$/g, '');
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey) throw new Error('JETSTREAM_API_KEY must be set (make one at https://bsky.network/account)');
  if (!args.probe && !args.dryRun && !(url && key)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or pass --dry-run)');
  const sdk = await loadSdk(process.env.JETSTREAM_SDK_DIR?.trim() || SDK_DIR);
  const host = args.host ?? DEFAULT_HOST;
  if (args.probe) return probe({ args, host, apiKey, sdk });
  await rebuild({ args: { ...args, state: path.resolve(args.state) }, host, apiKey, sdk, db: args.dryRun ? null : crawlStore({ url, key }) });
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
      console.error(err.message);
      process.exit(1);
    },
  );
}
