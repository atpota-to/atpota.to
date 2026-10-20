/**
 * /api/gardener: one person's flowers, for the garden page. Their flower in the open patch
 * (if they have one), and every flower they grew in a patch that has since closed, pressed.
 *
 * Their sprout records come straight from their own repo (their PDS, from their DID
 * document); only the ones in the patches the home page shows count, settled the same way
 * (server/garden.ts), so a flower here is the flower there, with the same plot and care.
 * Each flower brings its recent tending: who, what, and when (from the tend record's TID
 * key), newest first. Tenders atpotato blocks, or whose accounts are hidden, are left out;
 * so is everything for an account that is itself blocked or hidden.
 *
 *   GET /api/gardener?did=<did>  ->  { did, handle, flowers: [{ ...a flower from /api/garden,
 *                                     patch: { rkey, uri, name, season, open, cols, rows },
 *                                     tends: [{ did, handle, action, at }] }] }, newest first
 *
 * A bad DID is a 400; an account that can't be resolved is a 404. Fresh for 30 seconds at
 * the CDN, so tending shows up soon.
 */

import { fetchJson, listRecords, resolveDid, type Fetch } from './blog/atproto.js';
import { isDid } from './blog/config.js';
import { backlinks, mapPool, SLINGSHOT } from './blog/discussion.js';
import {
  CACHE_MISSING,
  CONCURRENCY,
  createGardenReader,
  isOpen,
  isTendAction,
  jsonResponse,
  methodNotAllowed,
  REQUEST_TIMEOUT_MS,
  SPROUT_NSID,
  strongRef,
  TEND_NSID,
  tidTime,
  toSprout,
  withCare,
  type Flower,
  type GardenDeps,
  type GardenHandlers,
  type Season,
  type TendAction,
} from './garden.js';

export const CACHE_GARDENER = 'public, max-age=0, s-maxage=30, stale-while-revalidate=120';
/** Tending shown per flower, newest first. */
export const MAX_TENDS_SHOWN = 30;
/** Pages of 100 sprout records read from their repo. */
const SPROUT_PAGES = 3;

export interface Tend {
  did: string;
  handle: string;
  action: TendAction;
  at: string;
}

export interface GardenerFlower extends Flower {
  patch: { rkey: string; uri: string; name: string; season: Season; open: boolean; cols: number; rows: number };
  tends: Tend[];
}

export interface Gardener {
  did: string;
  handle: string;
  flowers: GardenerFlower[];
}

/** A tend record pointing at `flower`, checked; its time from the TID key. Null otherwise. */
export function toTend(entry: unknown, did: string, rkey: string, flower: string): { did: string; action: TendAction; at: number } | null {
  const v = (entry as { value?: Record<string, unknown> })?.value;
  const at = tidTime(rkey);
  if (!v || typeof v !== 'object' || at === null || !isTendAction(v.action) || strongRef(v.subject)?.uri !== flower) return null;
  return { did, action: v.action, at };
}

class Missing extends Error {}

export function createGardenerHandlers(deps: GardenDeps = {}): GardenHandlers {
  const reader = createGardenReader(deps);

  async function tends(flower: Flower): Promise<Array<{ did: string; action: TendAction; at: number }>> {
    const refs = await backlinks(reader.fetch, flower.uri, TEND_NSID, '.subject.uri', MAX_TENDS_SHOWN * 2).catch(() => []);
    const read = await mapPool(refs, CONCURRENCY, async ({ did, rkey }) => {
      const params = new URLSearchParams({ repo: did, collection: TEND_NSID, rkey });
      try {
        return toTend(await fetchJson(reader.fetch, `${SLINGSHOT}/xrpc/com.atproto.repo.getRecord?${params}`, REQUEST_TIMEOUT_MS), did, rkey, flower.uri);
      } catch {
        return null;
      }
    });
    const now = reader.now();
    return read
      .filter((t): t is NonNullable<typeof t> => t !== null && t.at >= Date.parse(flower.plantedAt) && t.at <= now + 60_000)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_TENDS_SHOWN);
  }

  async function read(did: string): Promise<Gardener> {
    const identity = await resolveDid(reader.fetch, did).catch(() => {
      throw new Missing();
    });
    const [all, records] = await Promise.all([reader.patches(), listRecords(reader.fetch, identity.pds, did, SPROUT_NSID, SPROUT_PAGES)]);
    const at = reader.now();
    const theirs = new Set<string>();
    const inPatches = new Set<string>();
    for (const r of records) {
      const rkey = r.uri.slice(r.uri.lastIndexOf('/') + 1);
      const s = toSprout(r, did, rkey, at);
      if (s && all.some((p) => p.uri === s.patch)) {
        theirs.add(s.uri);
        inPatches.add(s.patch);
      }
    }
    const { authors, blocked } = await reader.authors([did]);
    const me = authors.get(did);
    const handle = me && !me.handle.startsWith('did:') ? me.handle : (identity.handle ?? did);
    if (!me || blocked.has(did)) return { did, handle, flowers: [] };

    // Each patch as the home page shows it: their flowers there, settled the same way.
    const patches = all.filter((p) => inPatches.has(p.uri));
    const found = (
      await mapPool(patches, 4, async (p) => {
        const open = isOpen(p, at);
        const mine = (await reader.planted(p, all)).filter((f) => theirs.has(f.uri));
        const flowers = await withCare(reader, mine, open);
        return flowers.map((f) => ({ ...f, patch: { rkey: p.rkey, uri: p.uri, name: p.name, season: p.season, open, cols: p.cols, rows: p.rows } }));
      })
    ).flat();
    found.sort((a, b) => b.plantedAt.localeCompare(a.plantedAt));

    const tended = await mapPool(found, 4, tends);
    const { authors: tenders, blocked: blockedTenders } = await reader.authors(tended.flat().map((t) => t.did));
    const flowers: GardenerFlower[] = found.map((f, i) => ({
      ...f,
      tends: tended[i]!.flatMap((t) => {
        const who = tenders.get(t.did);
        if (!who || blockedTenders.has(t.did) || who.handle.startsWith('did:')) return [];
        return [{ did: t.did, handle: who.handle, action: t.action, at: new Date(t.at).toISOString() }];
      }),
    }));
    return { did, handle, flowers };
  }

  async function GET(request: Request): Promise<Response> {
    const did = new URL(request.url).searchParams.get('did') ?? '';
    if (!isDid(did)) return jsonResponse(request, 400, { error: 'bad_did' }, 'no-store');
    try {
      return jsonResponse(request, 200, await read(did), CACHE_GARDENER);
    } catch (error) {
      if (error instanceof Missing) return jsonResponse(request, 404, { error: 'not_found' }, CACHE_MISSING);
      reader.log({ event: 'gardener_error', error: (error as Error)?.message ?? 'Error' });
      return jsonResponse(request, 503, { error: 'unavailable' }, 'no-store');
    }
  }

  return { GET, HEAD: GET, methodNotAllowed };
}
