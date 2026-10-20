/**
 * /api/atmosphere: the "atmospheric conditions" on the home page and the full weather
 * report at /weather. It listens to the whole firehose through Jetstream for a few
 * seconds and answers with rates per second: Bluesky's posts, likes, reposts and follows,
 * how many new records came from outside Bluesky (the diversity index), which apps wrote
 * them, and how many edits, deletions, identity and account events went by.
 *
 * Sampling happens here, not in the browser: the whole firehose is over 250 KB a second,
 * which no visitor should have to download for a weather report. One sample serves
 * everyone for a minute (CDN cache), and a function instance reuses its last sample for
 * SAMPLE_TTL_MS.
 *
 *   GET /api/atmosphere  ->  Reading (below)
 *
 * If Jetstream can't be reached, or stays silent, the answer is 503 and the tile says so.
 */

import { TtlCache } from './blog/atproto.js';

export const JETSTREAMS = ['wss://jetstream2.us-east.bsky.network/subscribe', 'wss://jetstream1.us-east.bsky.network/subscribe'] as const;

export const COLLECTIONS = {
  posts: 'app.bsky.feed.post',
  likes: 'app.bsky.feed.like',
  reposts: 'app.bsky.feed.repost',
  follows: 'app.bsky.graph.follow',
} as const;

export type Metric = keyof typeof COLLECTIONS;

/** Collections under these count as Bluesky; everything else is "elsewhere". */
export const BLUESKY_PREFIXES = ['app.bsky.', 'chat.bsky.'] as const;

/** How long to count for, once connected. */
export const SAMPLE_MS = 5000;
export const CONNECT_TIMEOUT_MS = 4000;
export const SAMPLE_TTL_MS = 30_000;
export const CACHE_OK = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';

/** Posts a second at which each condition starts; anything below "light" is calm. */
export const CONDITIONS = [
  ['stormy', 45],
  ['gusty', 30],
  ['breezy', 20],
  ['light', 12],
] as const;

export type Condition = 'calm' | (typeof CONDITIONS)[number][0];

/**
 * The diversity index is the share of new records, in percent, written outside Bluesky's
 * lexicons. Like the UV index, it comes with a level; each starts at the given index.
 */
export const DIVERSITY_LEVELS = [
  ['extreme', 11],
  ['very high', 8],
  ['high', 6],
  ['moderate', 3],
] as const;

export type DiversityLevel = 'low' | (typeof DIVERSITY_LEVELS)[number][0];

/** How many apps and Bluesky collections the reading names. */
export const TOP_APPS = 10;
export const TOP_BLUESKY = 8;
/** Collections tracked per sample; past this, new names are not counted on their own. */
export const MAX_COLLECTIONS = 2000;

export interface Rate {
  /** Records a second, one decimal. */
  perSecond: number;
  /** Records counted in the sample. */
  count: number;
}

export interface App extends Rate {
  /** The app's namespace as a domain: "sh.tangled.*" is "tangled.sh". */
  domain: string;
  /** Its busiest collections, busiest first (at most three). */
  collections: string[];
}

export interface Reading {
  measuredAt: string;
  /** Seconds actually counted. */
  seconds: number;
  /** New Bluesky records a second, one decimal. */
  perSecond: Record<Metric, number>;
  condition: Condition;
  /** New records a second, in any collection. */
  records: { perSecond: number; bluesky: number; elsewhere: number };
  diversity: {
    /** Percent of new records written outside Bluesky, two decimals (it is often under one). */
    index: number;
    level: DiversityLevel;
    /** Apps (namespaces) outside Bluesky that wrote anything. */
    apps: number;
    /** Distinct collections that got a new record. */
    collections: number;
  };
  /** The busiest apps outside Bluesky. */
  apps: App[];
  /** Bluesky's busiest collections. */
  bluesky: Array<Rate & { nsid: string }>;
  /** Everything that went by, a second. */
  events: { creates: number; updates: number; deletes: number; identity: number; account: number };
}

/** The parts of a WebSocket the sampler uses (the global WebSocket in Node 22 and browsers). */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close(): void;
}

export type OpenSocket = (url: string) => SocketLike;

export function conditionFor(postsPerSecond: number): Condition {
  for (const [name, from] of CONDITIONS) if (postsPerSecond >= from) return name;
  return 'calm';
}

export function diversityLevel(index: number): DiversityLevel {
  for (const [name, from] of DIVERSITY_LEVELS) if (index >= from) return name;
  return 'low';
}

/** The whole firehose: no wantedCollections. */
export function jetstreamUrl(base: string): string {
  return base;
}

const METRIC_FOR: Record<string, Metric> = Object.fromEntries(Object.entries(COLLECTIONS).map(([metric, nsid]) => [nsid, metric as Metric]));

/** A collection name worth repeating to visitors (the relay validates these, but they are still someone else's text). */
const NSID_RE = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62}){1,}\.[a-z][a-z0-9]{0,62}$/i;

export function isNsid(value: string): boolean {
  return value.length <= 253 && NSID_RE.test(value);
}

export function isBluesky(nsid: string): boolean {
  return BLUESKY_PREFIXES.some((p) => nsid.startsWith(p));
}

/** An NSID's app, as a domain: its first two segments, reversed ("fyi.unravel.frontpage.post" -> "unravel.fyi"). */
export function appDomain(nsid: string): string {
  const [tld, name] = nsid.toLowerCase().split('.');
  return `${name}.${tld}`;
}

export type Event =
  | { kind: 'create'; collection: string }
  | { kind: 'update' | 'delete' | 'identity' | 'account' };

/** What a Jetstream message is, or null for anything unreadable. */
export function eventOf(data: unknown): Event | null {
  if (typeof data !== 'string') return null;
  let m: { kind?: unknown; commit?: { operation?: unknown; collection?: unknown } };
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (m?.kind === 'identity' || m?.kind === 'account') return { kind: m.kind };
  if (m?.kind !== 'commit') return null;
  const op = m.commit?.operation;
  if (op === 'update' || op === 'delete') return { kind: op };
  if (op !== 'create' || typeof m.commit?.collection !== 'string' || !isNsid(m.commit.collection)) return null;
  return { kind: 'create', collection: m.commit.collection };
}

/** The metric a Jetstream message counts toward: a new record in one of COLLECTIONS. */
export function metricOf(data: unknown): Metric | null {
  const e = eventOf(data);
  return e?.kind === 'create' ? (METRIC_FOR[e.collection] ?? null) : null;
}

export interface Tally {
  creates: Map<string, number>;
  /** New records in collections past MAX_COLLECTIONS (counted, but not by name). */
  unnamed: number;
  updates: number;
  deletes: number;
  identity: number;
  account: number;
}

export function emptyTally(): Tally {
  return { creates: new Map(), unnamed: 0, updates: 0, deletes: 0, identity: 0, account: 0 };
}

export function addEvent(tally: Tally, event: Event): void {
  if (event.kind !== 'create') {
    tally[event.kind === 'update' ? 'updates' : event.kind === 'delete' ? 'deletes' : event.kind] += 1;
    return;
  }
  const n = tally.creates.get(event.collection);
  if (n !== undefined) tally.creates.set(event.collection, n + 1);
  else if (tally.creates.size < MAX_COLLECTIONS) tally.creates.set(event.collection, 1);
  else tally.unnamed += 1;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A tally over `seconds`, as a Reading. */
export function summarize(tally: Tally, seconds: number, measuredAt: string): Reading {
  const rate = (count: number) => round1(count / seconds);
  let bluesky = 0;
  let elsewhere = tally.unnamed;
  const apps = new Map<string, { count: number; collections: Array<[string, number]> }>();
  const bsky: Array<[string, number]> = [];
  for (const [nsid, count] of tally.creates) {
    if (isBluesky(nsid)) {
      bluesky += count;
      bsky.push([nsid, count]);
      continue;
    }
    elsewhere += count;
    const domain = appDomain(nsid);
    const app = apps.get(domain) ?? { count: 0, collections: [] };
    app.count += count;
    app.collections.push([nsid, count]);
    apps.set(domain, app);
  }
  const total = bluesky + elsewhere;
  const index = total ? Math.round((elsewhere / total) * 10_000) / 100 : 0;
  const busiest = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  const perSecond = Object.fromEntries(Object.entries(COLLECTIONS).map(([metric, nsid]) => [metric, rate(tally.creates.get(nsid) ?? 0)])) as Record<Metric, number>;
  return {
    measuredAt,
    seconds: round1(seconds),
    perSecond,
    condition: conditionFor(perSecond.posts),
    records: { perSecond: rate(total), bluesky: rate(bluesky), elsewhere: rate(elsewhere) },
    diversity: { index, level: diversityLevel(index), apps: apps.size, collections: tally.creates.size },
    apps: [...apps]
      .map(([domain, a]) => ({
        domain,
        count: a.count,
        perSecond: rate(a.count),
        collections: a.collections
          .sort((x, y) => y[1] - x[1])
          .slice(0, 3)
          .map(([nsid]) => nsid),
      }))
      .sort(busiest)
      .slice(0, TOP_APPS),
    bluesky: bsky
      .map(([nsid, count]) => ({ nsid, count, perSecond: rate(count) }))
      .sort(busiest)
      .slice(0, TOP_BLUESKY),
    events: {
      creates: rate(total),
      updates: rate(tally.updates),
      deletes: rate(tally.deletes),
      identity: rate(tally.identity),
      account: rate(tally.account),
    },
  };
}

/**
 * Connects, counts for `sampleMs`, disconnects. Rejects if the socket fails or doesn't
 * open in time, or if nothing at all arrived (a stalled stream is not a calm day).
 */
export function sample(open: OpenSocket, url: string, now: () => number, sampleMs = SAMPLE_MS, connectMs = CONNECT_TIMEOUT_MS): Promise<Reading> {
  return new Promise((resolve, reject) => {
    const tally = emptyTally();
    let started = 0;
    let opened = false;
    let seen = 0;
    let done = false;
    let socket: SocketLike;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (error) return reject(error);
      if (seen === 0) return reject(new Error('jetstream was silent'));
      const seconds = Math.max(0.5, (now() - started) / 1000);
      resolve(summarize(tally, seconds, new Date(now()).toISOString()));
    };
    try {
      socket = open(url);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('could not open socket'));
      return;
    }
    timers.push(setTimeout(() => finish(new Error('jetstream did not connect')), connectMs));
    socket.onopen = () => {
      opened = true;
      started = now();
      timers.push(setTimeout(() => finish(null), sampleMs));
    };
    socket.onmessage = (event) => {
      if (done || !opened) return;
      seen += 1;
      const e = eventOf(event.data);
      if (e) addEvent(tally, e);
    };
    socket.onerror = () => finish(new Error('jetstream error'));
    socket.onclose = () => finish(opened ? null : new Error('jetstream closed'));
  });
}

export interface AtmosphereDeps {
  open?: OpenSocket;
  now?: () => number;
  sampleMs?: number;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

export interface AtmosphereHandlers {
  GET(request: Request): Promise<Response>;
  HEAD(request: Request): Promise<Response>;
  methodNotAllowed(request: Request): Promise<Response>;
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

export function createAtmosphereHandlers(deps: AtmosphereDeps = {}): AtmosphereHandlers {
  const open: OpenSocket = deps.open ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  const now = deps.now ?? (() => Date.now());
  const log =
    deps.log ??
    ((fields) => {
      const line = JSON.stringify({ src: 'atmosphere', ...fields });
      if (fields.event.endsWith('_error')) console.warn(line);
      else console.info(line);
    });
  const cache = new TtlCache<Promise<Reading>>(SAMPLE_TTL_MS, now);

  function load(): Promise<Reading> {
    const cached = cache.get('reading');
    if (cached) return cached;
    const pending = (async () => {
      let lastError: unknown = null;
      // The second Jetstream is a fallback for when the first is down or silent.
      for (const base of JETSTREAMS) {
        try {
          return await sample(open, jetstreamUrl(base), now, deps.sampleMs ?? SAMPLE_MS);
        } catch (error) {
          lastError = error;
          log({ event: 'sample_error', jetstream: base, error: (error as Error)?.message ?? 'Error' });
        }
      }
      throw lastError instanceof Error ? lastError : new Error('no reading');
    })();
    cache.set('reading', pending);
    pending.catch(() => cache.delete('reading'));
    return pending;
  }

  async function GET(request: Request): Promise<Response> {
    let reading: Reading;
    try {
      reading = await load();
    } catch {
      return new Response(request.method === 'HEAD' ? null : '{"error":"unavailable"}', {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...BASE_HEADERS },
      });
    }
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(reading), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': CACHE_OK, ...BASE_HEADERS },
    });
  }

  return {
    GET,
    HEAD: GET,
    async methodNotAllowed(request: Request) {
      return new Response(request.method === 'HEAD' ? null : 'method not allowed\n', {
        status: 405,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD', ...BASE_HEADERS },
      });
    },
  };
}
