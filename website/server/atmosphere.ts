/**
 * /api/atmosphere: the home page's "atmospheric conditions", a weather report for the
 * network. It listens to Bluesky's firehose through Jetstream for a few seconds, counts
 * new posts, likes, reposts and follows, and answers with rates per second.
 *
 * Sampling happens here, not in the browser: the firehose for these four collections is
 * over 100 KB a second, which no visitor should have to download for a weather report.
 * One sample serves everyone for a minute (CDN cache), and a function instance reuses its
 * last sample for SAMPLE_TTL_MS.
 *
 *   GET /api/atmosphere  ->  { measuredAt, seconds, perSecond: { posts, likes, reposts, follows }, condition }
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

/** How long to count for, once connected. */
export const SAMPLE_MS = 3000;
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

export interface Reading {
  measuredAt: string;
  /** Seconds actually counted. */
  seconds: number;
  /** New records a second, one decimal. */
  perSecond: Record<Metric, number>;
  condition: Condition;
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

export function jetstreamUrl(base: string): string {
  const params = new URLSearchParams();
  for (const nsid of Object.values(COLLECTIONS)) params.append('wantedCollections', nsid);
  return `${base}?${params}`;
}

const METRIC_FOR: Record<string, Metric> = Object.fromEntries(Object.entries(COLLECTIONS).map(([metric, nsid]) => [nsid, metric as Metric]));

/** The metric a Jetstream message counts toward: a new record in one of COLLECTIONS. */
export function metricOf(data: unknown): Metric | null {
  if (typeof data !== 'string') return null;
  let m: { kind?: unknown; commit?: { operation?: unknown; collection?: unknown } };
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (m?.kind !== 'commit' || m.commit?.operation !== 'create' || typeof m.commit.collection !== 'string') return null;
  return METRIC_FOR[m.commit.collection] ?? null;
}

/**
 * Connects, counts for `sampleMs`, disconnects. Rejects if the socket fails or doesn't
 * open in time, or if nothing at all arrived (a stalled stream is not a calm day).
 */
export function sample(open: OpenSocket, url: string, now: () => number, sampleMs = SAMPLE_MS, connectMs = CONNECT_TIMEOUT_MS): Promise<Reading> {
  return new Promise((resolve, reject) => {
    const counts: Record<Metric, number> = { posts: 0, likes: 0, reposts: 0, follows: 0 };
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
      const perSecond = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / seconds) * 10) / 10])) as Record<Metric, number>;
      resolve({ measuredAt: new Date(now()).toISOString(), seconds: Math.round(seconds * 10) / 10, perSecond, condition: conditionFor(perSecond.posts) });
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
      const metric = metricOf(event.data);
      if (metric) counts[metric] += 1;
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
