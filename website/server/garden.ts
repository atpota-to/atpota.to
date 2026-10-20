/**
 * /api/garden: the flower patch on the home page. Visitors sign in with Bluesky and plant
 * a flower, which is a record in their own repo (src/scripts/garden.ts writes it):
 *
 *   to.atpota.garden.sprout  { subject: <atpotato's DID>, kind: "sunflower" | ..., createdAt }
 *
 * Nothing is stored on atpota.to. Constellation lists the records whose `subject` links to
 * atpotato's DID, Slingshot serves each record, and the public AppView gives the handles.
 * One flower per account (its newest record). A flower is left out when its record no
 * longer points here or names an unknown kind, when its account has no profile view or
 * carries one of HIDDEN_LABELS, or when atpotato blocks the account on Bluesky. There is no
 * free text anywhere, so blocking is all the moderation it needs.
 *
 *   GET /api/garden  ->  { flowers: [{ did, handle, kind, plantedAt }], total }, oldest first
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
export const MAX_FLOWERS = 120;
export const GARDEN_TTL_MS = 30_000;
export const CACHE_OK = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';
const REQUEST_TIMEOUT_MS = 4000;
const CONCURRENCY = 8;

export interface Flower {
  did: string;
  handle: string;
  kind: FlowerKind;
  plantedAt: string;
}

export interface Garden {
  flowers: Flower[];
  total: number;
}

export function isFlowerKind(value: unknown): value is FlowerKind {
  return typeof value === 'string' && (FLOWER_KINDS as readonly string[]).includes(value);
}

/** A sprout record planted here, checked field by field; null otherwise. */
export function toSprout(entry: unknown, now: number): { kind: FlowerKind; plantedAt: string } | null {
  const v = (entry as { value?: Record<string, unknown> })?.value;
  if (!v || typeof v !== 'object' || v.subject !== GARDEN_SUBJECT || !isFlowerKind(v.kind)) return null;
  const created = typeof v.createdAt === 'string' ? Date.parse(v.createdAt) : NaN;
  if (!Number.isFinite(created) || created > now + 5 * 60_000) return null;
  return { kind: v.kind, plantedAt: new Date(created).toISOString() };
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
        return sprout ? { did, ...sprout } : null;
      } catch {
        return null;
      }
    });
    const planted = sprouts.filter((s): s is NonNullable<typeof s> => s !== null);
    const [authors, blocked] = await Promise.all([planted.length ? commentAuthors(doFetch, planted.map((s) => s.did)) : new Map(), blocks]);
    const flowers: Flower[] = [];
    for (const s of planted) {
      const author = authors.get(s.did);
      if (!author || blocked.has(s.did) || author.handle.startsWith('did:')) continue;
      flowers.push({ did: s.did, handle: author.handle, kind: s.kind, plantedAt: s.plantedAt });
    }
    flowers.sort((a, b) => a.plantedAt.localeCompare(b.plantedAt) || a.did.localeCompare(b.did));
    return { flowers, total: flowers.length };
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
