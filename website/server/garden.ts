/**
 * /api/garden: the flower patch on the home page. Visitors sign in with Bluesky and plant
 * a flower, which is a record in their own repo (src/scripts/garden.ts writes it):
 *
 *   to.atpota.garden.sprout  { subject: <atpotato's DID>, kind: "sunflower" | ..., plot, createdAt }
 *
 * The patch is a grid GRID_COLS plots wide; `plot` is the cell, counted from the top left.
 * Two flowers that claim the same plot: the one planted first keeps it, the other moves to
 * the next free plot along (resolvePlots). A flower with no plot, or one off the grid, gets
 * the first free plot. The grid has MIN_ROWS rows to start, and grows a row whenever it
 * fills up, so there is always a free plot.
 *
 * Nothing is stored on atpota.to. Constellation lists the records whose `subject` links to
 * atpotato's DID, Slingshot serves each record, and the public AppView gives the handles.
 * One flower per account (its newest record). A flower is left out when its record no
 * longer points here or names an unknown kind, when its account has no profile view or
 * carries one of HIDDEN_LABELS, or when atpotato blocks the account on Bluesky. There is no
 * free text anywhere, so blocking is all the moderation it needs.
 *
 *   GET /api/garden  ->  { flowers: [{ did, rkey, handle, kind, plot, plantedAt }], total, cols, rows },
 *                        oldest first. The browser grows each flower's look from its DID and
 *                        record key (src/scripts/flowers.ts).
 *
 * Fresh for a minute at the CDN, served stale while it refreshes.
 */

import { fetchJson, resolveDid, TtlCache, type Fetch, type Identity } from './blog/atproto.js';
import { ATPOTATO_DID } from './blog/config.js';
import { backlinks, commentAuthors, mapPool, ownerBlocks, SLINGSHOT } from './blog/discussion.js';

export const SPROUT_NSID = 'to.atpota.garden.sprout';
export const GARDEN_SUBJECT = ATPOTATO_DID;
export const FLOWER_KINDS = ['sunflower', 'rose', 'daisy', 'violet', 'poppy', 'tulip'] as const;
export type FlowerKind = (typeof FLOWER_KINDS)[number];

/** The patch shows at most this many flowers (the newest accounts win). */
export const MAX_FLOWERS = 240;
export const GRID_COLS = 12;
export const MIN_ROWS = 5;
/** Plots past this are off the grid (40 rows). */
export const MAX_PLOTS = GRID_COLS * 40;
export const GARDEN_TTL_MS = 30_000;
export const CACHE_OK = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';
const REQUEST_TIMEOUT_MS = 4000;
const CONCURRENCY = 8;

export interface Flower {
  did: string;
  rkey: string;
  handle: string;
  kind: FlowerKind;
  plot: number;
  plantedAt: string;
}

export interface Garden {
  flowers: Flower[];
  total: number;
  cols: number;
  rows: number;
}

export function isPlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_PLOTS;
}

/**
 * Gives every flower a plot of its own, in planting order: a flower keeps the plot it asked
 * for unless an earlier flower has it, then takes the next free one along.
 */
export function resolvePlots<T extends { plot: number | null }>(oldestFirst: readonly T[]): Array<T & { plot: number }> {
  const taken = new Set<number>();
  return oldestFirst.map((f) => {
    let plot = f.plot ?? 0;
    while (taken.has(plot)) plot = (plot + 1) % MAX_PLOTS;
    taken.add(plot);
    return { ...f, plot };
  });
}

/** Rows the grid needs: MIN_ROWS, every planted plot, and at least one free plot. */
export function rowsFor(flowers: readonly { plot: number }[]): number {
  const highest = flowers.reduce((m, f) => Math.max(m, f.plot), -1);
  return Math.max(MIN_ROWS, Math.ceil((highest + 1) / GRID_COLS), Math.ceil((flowers.length + 1) / GRID_COLS));
}

export function isFlowerKind(value: unknown): value is FlowerKind {
  return typeof value === 'string' && (FLOWER_KINDS as readonly string[]).includes(value);
}

/** A sprout record planted here, checked field by field; null otherwise. */
export function toSprout(entry: unknown, now: number): { kind: FlowerKind; plot: number | null; plantedAt: string } | null {
  const v = (entry as { value?: Record<string, unknown> })?.value;
  if (!v || typeof v !== 'object' || v.subject !== GARDEN_SUBJECT || !isFlowerKind(v.kind)) return null;
  const created = typeof v.createdAt === 'string' ? Date.parse(v.createdAt) : NaN;
  if (!Number.isFinite(created) || created > now + 5 * 60_000) return null;
  return { kind: v.kind, plot: isPlot(v.plot) ? v.plot : null, plantedAt: new Date(created).toISOString() };
}

export interface GardenDeps {
  fetch?: Fetch;
  now?: () => number;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

export interface GardenHandlers {
  GET(request: Request): Promise<Response>;
  HEAD(request: Request): Promise<Response>;
  methodNotAllowed(request: Request): Promise<Response>;
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

export function createGardenHandlers(deps: GardenDeps = {}): GardenHandlers {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const log =
    deps.log ??
    ((fields) => {
      const line = JSON.stringify({ src: 'garden', ...fields });
      if (fields.event.endsWith('_error')) console.warn(line);
      else console.info(line);
    });
  const cache = new TtlCache<Promise<Garden>>(GARDEN_TTL_MS, now);

  async function owner(): Promise<Identity> {
    try {
      return await resolveDid(doFetch, GARDEN_SUBJECT);
    } catch {
      return { did: GARDEN_SUBJECT, pds: 'https://pds.atpota.to', handle: 'atpota.to' };
    }
  }

  async function read(): Promise<Garden> {
    const blocks = owner().then((o) => ownerBlocks(doFetch, o));
    const refs = await backlinks(doFetch, GARDEN_SUBJECT, SPROUT_NSID, '.subject', MAX_FLOWERS * 2);
    // Newest index entries come first: the first record per account is its current flower.
    const newest = new Map<string, string>();
    for (const ref of refs) if (!newest.has(ref.did) && newest.size < MAX_FLOWERS) newest.set(ref.did, ref.rkey);
    const at = now();
    const sprouts = await mapPool([...newest], CONCURRENCY, async ([did, rkey]) => {
      const params = new URLSearchParams({ repo: did, collection: SPROUT_NSID, rkey });
      try {
        const sprout = toSprout(await fetchJson(doFetch, `${SLINGSHOT}/xrpc/com.atproto.repo.getRecord?${params}`, REQUEST_TIMEOUT_MS), at);
        return sprout ? { did, rkey, ...sprout } : null;
      } catch {
        return null;
      }
    });
    const planted = sprouts.filter((s): s is NonNullable<typeof s> => s !== null);
    const [authors, blocked] = await Promise.all([planted.length ? commentAuthors(doFetch, planted.map((s) => s.did)) : new Map(), blocks]);
    const shown: Array<Omit<Flower, 'plot'> & { plot: number | null }> = [];
    for (const s of planted) {
      const author = authors.get(s.did);
      if (!author || blocked.has(s.did) || author.handle.startsWith('did:')) continue;
      shown.push({ did: s.did, rkey: s.rkey, handle: author.handle, kind: s.kind, plot: s.plot, plantedAt: s.plantedAt });
    }
    shown.sort((a, b) => a.plantedAt.localeCompare(b.plantedAt) || a.did.localeCompare(b.did));
    const flowers: Flower[] = resolvePlots(shown);
    return { flowers, total: flowers.length, cols: GRID_COLS, rows: rowsFor(flowers) };
  }

  function load(): Promise<Garden> {
    const cached = cache.get('garden');
    if (cached) return cached;
    const pending = read();
    cache.set('garden', pending);
    pending.catch((error) => {
      cache.delete('garden');
      log({ event: 'garden_error', error: (error as Error)?.message ?? 'Error' });
    });
    return pending;
  }

  async function GET(request: Request): Promise<Response> {
    let garden: Garden;
    try {
      garden = await load();
    } catch {
      return new Response(request.method === 'HEAD' ? null : '{"error":"unavailable"}', {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...BASE_HEADERS },
      });
    }
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(garden), {
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
