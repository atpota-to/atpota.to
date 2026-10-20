/**
 * The weather station's Supabase project, read the way anyone could read it: with the
 * publishable key, through PostgREST, under row-level security. Shared by
 * /api/weather-history and /api/weather-almanac. Nothing here can write.
 *
 *   ATMOSPHERE_SUPABASE_URL   default SUPABASE_URL
 *   ATMOSPHERE_SUPABASE_KEY   default SUPABASE_PUBLISHABLE_KEY
 *
 * Everything that comes back is someone else's data (app names are other people's
 * lexicons), so callers check every field; the helpers for that live here too.
 */

export const SUPABASE_URL = 'https://zdzjtziydmwkxbzlkwxv.supabase.co';
/** The project's publishable key: public by design, it only reaches what row-level security lets anyone read. */
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_pPelLpQDK2XWc9HuxjUOmQ_RlPfGcx_';
export const UPSTREAM_TIMEOUT_MS = 5000;

export type Env = Record<string, string | undefined>;
export type Fetch = typeof fetch;

export interface Supabase {
  /** GET /rest/v1/<path>, answering the parsed JSON. */
  get(path: string): Promise<unknown>;
  /** POST /rest/v1/rpc/<name> with named arguments, answering the parsed JSON. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function supabase(env: Env, fetchImpl: Fetch): Supabase {
  const base = (env.ATMOSPHERE_SUPABASE_URL?.trim() || SUPABASE_URL).replace(/\/+$/, '');
  const key = env.ATMOSPHERE_SUPABASE_KEY?.trim() || SUPABASE_PUBLISHABLE_KEY;
  const call = async (url: string, init: RequestInit) => {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`supabase answered ${res.status}`);
    return (await res.json()) as unknown;
  };
  return {
    get: (path) => call(`${base}/rest/v1/${path}`, { headers: { accept: 'application/json', apikey: key } }),
    rpc: (name, args) =>
      call(`${base}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { accept: 'application/json', apikey: key, 'content-type': 'application/json' },
        body: JSON.stringify(args),
      }),
  };
}

/** An app's namespace as a domain ("tangled.sh"), as the station writes it. */
export const DOMAIN_RE = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}$/;
export const NSID_RE = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62}){1,}\.[a-z][a-z0-9]{0,62}$/i;

/** A count from PostgREST: sums of numeric arrive as numbers or strings. NaN if it isn't one. */
export function num(x: unknown): number {
  return typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
}

export const isCount = (x: unknown): boolean => {
  const n = num(x);
  return Number.isFinite(n) && n >= 0;
};

/** An ISO timestamp, normalized, or null. */
export function iso(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** `keys` of `x` as numbers, or null if any is missing or negative. */
export function counts<K extends string>(x: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(x) || !keys.every((k) => isCount(x[k]))) return null;
  return Object.fromEntries(keys.map((k) => [k, num(x[k])])) as Record<K, number>;
}

/** Up to three collection names that look like NSIDs. */
export function collectionsOf(x: unknown): string[] {
  return (Array.isArray(x) ? x : []).filter((c): c is string => typeof c === 'string' && c.length <= 253 && NSID_RE.test(c)).slice(0, 3);
}

export function methodNotAllowed(request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : 'method not allowed\n', {
    status: 405,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD', 'x-content-type-options': 'nosniff' },
  });
}

export function json(request: Request, status: number, body: unknown, cache: string): Response {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': cache },
  });
}
