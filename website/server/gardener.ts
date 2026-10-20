/**
 * /api/gardener: one person, for their garden page. Who they are, their own garden (if they
 * keep one), every flower they've planted in anyone's garden (growing, or pressed in a
 * patch that has since closed), and the tending they've given.
 *
 * Their sprout records come straight from their own repo (their PDS, from their DID
 * document). Each counts only as the garden it's in shows it (server/garden.ts): settled
 * the same way, so a flower here is the flower there, with the same plot and care. At most
 * MAX_GARDENS gardens' patches are read per request, the ones planted in most recently.
 * Each flower brings its recent tending: who, what, and when (from the tend record's TID
 * key), newest first. Tenders atpotato blocks, or whose accounts are hidden, are left out.
 * The tending they've given comes from their own tend records.
 *
 * And how they get on with Poe: the pets they've given it (their to.atpota.poe.pets record,
 * from their PDS; src/scripts/pet-sync.ts writes it) and how many notes Poe keeps about them
 * (its to.atpota.poe.memory record for their DID, from Poe's PDS, so a "forget me" shows at
 * once). Either one that can't be read is 0; neither ever fails the page.
 *
 *   GET /api/gardener?actor=<did or handle>  (or ?did=)  ->
 *     { did, handle, displayName, avatar,
 *       garden: { rkey, uri, name, note, open, plots, planted } | null   their "self" patch,
 *                                                                         else their newest open one
 *       flowers: [{ ...a flower from /api/garden,
 *                   patch: { rkey, uri, name, season, open, cols, rows, owner: { did, handle } },
 *                   tends: [{ did, handle, action, at }] }]                newest first
 *       given: { total, helped, recent: [{ at, action, flower: { uri, owner: { did, handle } } }] },
 *       poe: { pets, notes } }                                               pets given, notes Poe keeps
 *
 * Junk is a 400; an account that can't be found, is hidden, or atpotato blocks is a 404.
 * Fresh for 30 seconds at the CDN, so tending shows up soon.
 */

import { fetchJson, listRecords, type RecordEntry } from './blog/atproto.js';
import { POE_DID } from './blog/config.js';
import { backlinks, mapPool, SLINGSHOT } from './blog/discussion.js';
import {
  CACHE_MISSING,
  CONCURRENCY,
  createGardenReader,
  GARDEN_SUBJECT,
  isActor,
  isOpen,
  isTendAction,
  jsonResponse,
  methodNotAllowed,
  OWN_PATCH_RKEY,
  parsePatchUri,
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
  type Patch,
  type Season,
  type TendAction,
} from './garden.js';
import { getRecordFromPds } from './slingshot.js';

export const CACHE_GARDENER = 'public, max-age=0, s-maxage=30, stale-while-revalidate=120';
/** Tending shown per flower, newest first. */
export const MAX_TENDS_SHOWN = 30;
/** Gardens (patches) read per request: the ones planted in most recently. */
export const MAX_GARDENS = 16;
/** The newest tending given, listed. */
export const MAX_GIVEN_SHOWN = 20;
/** Pages of 100 records read from their repo. */
const SPROUT_PAGES = 2;
const TEND_PAGES = 5;

/** Poe's pet count, in the petter's repo at "self" (src/scripts/pet-sync.ts). */
export const PETS_NSID = 'to.atpota.poe.pets';
/** Poe's notes about someone, in Poe's repo with their DID as the key (mentions/src/memory.js). */
export const MEMORY_NSID = 'to.atpota.poe.memory';
/** A pet count past this is no record (pet-sync.ts's MAX_PETS). */
const MAX_PETS = 10_000_000;

const SPROUT_URI_RE = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/to\.atpota\.garden\.sprout\/[A-Za-z0-9._:~-]{1,512}$/;

export interface Tend {
  did: string;
  handle: string;
  action: TendAction;
  at: string;
}

export interface FlowerPatch {
  rkey: string;
  uri: string;
  name: string;
  season: Season | null;
  open: boolean;
  cols: number;
  rows: number;
  owner: { did: string; handle: string };
}

export interface GardenerFlower extends Flower {
  patch: FlowerPatch;
  tends: Tend[];
}

export interface OwnGarden {
  rkey: string;
  uri: string;
  name: string;
  note: string | null;
  open: boolean;
  plots: number;
  planted: number;
}

export interface GivenTend {
  at: string;
  action: TendAction;
  flower: { uri: string; owner: { did: string; handle: string } };
}

export interface Gardener {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
  garden: OwnGarden | null;
  flowers: GardenerFlower[];
  given: { total: number; helped: number; recent: GivenTend[] };
  poe: { pets: number; notes: number };
}

/** A tend record pointing at `flower`, checked; its time from the TID key. Null otherwise. */
export function toTend(entry: unknown, did: string, rkey: string, flower: string): { did: string; action: TendAction; at: number } | null {
  const v = (entry as { value?: Record<string, unknown> })?.value;
  const at = tidTime(rkey);
  if (!v || typeof v !== 'object' || at === null || !isTendAction(v.action) || strongRef(v.subject)?.uri !== flower) return null;
  return { did, action: v.action, at };
}

/** One of their own tend records: what, when (TID key, else createdAt), and whose flower. Null otherwise. */
export function toGiven(entry: RecordEntry): { action: TendAction; at: number | null; uri: string; owner: string } | null {
  const v = entry.value as Record<string, unknown>;
  const subject = strongRef(v.subject);
  const m = subject ? SPROUT_URI_RE.exec(subject.uri) : null;
  if (!isTendAction(v.action) || !subject || !m) return null;
  const rkey = entry.uri.slice(entry.uri.lastIndexOf('/') + 1);
  const created = typeof v.createdAt === 'string' ? Date.parse(v.createdAt) : NaN;
  const at = tidTime(rkey) ?? (Number.isFinite(created) ? created : null);
  return { action: v.action, at, uri: subject.uri, owner: m[1]! };
}

/** The count in a pets record: a whole number up to MAX_PETS, else 0. */
export function toPets(value: unknown): number {
  const count = (value as { count?: unknown } | null)?.count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= MAX_PETS ? count : 0;
}

/** How many notes a memory record holds about `did`; 0 when it's about someone else. */
export function toNotes(value: unknown, did: string): number {
  const v = value as { subject?: unknown; notes?: unknown } | null;
  if (v?.subject !== did || !Array.isArray(v.notes)) return 0;
  return v.notes.filter((n) => typeof n === 'string' && n.trim() !== '').length;
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

  /** Their flowers, as each garden shows them, newest first. */
  async function planted(did: string, records: readonly RecordEntry[]): Promise<Array<Omit<GardenerFlower, 'tends'>>> {
    const at = reader.now();
    const theirs = new Set<string>();
    const newest = new Map<string, string>();
    for (const r of records) {
      const s = toSprout(r, did, r.uri.slice(r.uri.lastIndexOf('/') + 1), at);
      if (!s || !parsePatchUri(s.patch)) continue;
      theirs.add(s.uri);
      if ((newest.get(s.patch) ?? '') < s.plantedAt) newest.set(s.patch, s.plantedAt);
    }
    const patchUris = [...newest].sort((a, b) => b[1].localeCompare(a[1])).map(([uri]) => uri);
    if (patchUris.length > MAX_GARDENS) reader.log({ event: 'gardener_capped', did, gardens: patchUris.length });
    const wanted = patchUris.slice(0, MAX_GARDENS);
    const owners = [...new Set(wanted.map((uri) => parsePatchUri(uri)!.owner))];
    const site = await reader.blocked();
    // Each garden's owner and patches; one that can't be read, is hidden or blocked is skipped.
    const gardens = new Map(
      await mapPool(owners, 4, async (o): Promise<[string, { handle: string; all: Patch[] } | null]> => {
        try {
          const who = await reader.owner(o);
          if (!who || (o !== GARDEN_SUBJECT && site.has(o))) return [o, null];
          return [o, { handle: who.handle, all: await reader.patches(o) }];
        } catch {
          return [o, null];
        }
      }),
    );
    let read = 0;
    let failed = 0;
    const found = (
      await mapPool(wanted, 4, async (uri) => {
        const owner = parsePatchUri(uri)!.owner;
        const garden = gardens.get(owner);
        const p = garden?.all.find((x) => x.uri === uri);
        if (!garden || !p) return [];
        read++;
        const open = isOpen(p, at);
        let shown: Awaited<ReturnType<typeof reader.planted>>;
        try {
          shown = await reader.planted(p, garden.all);
        } catch {
          failed++;
          return [];
        }
        const flowers = await withCare(
          reader,
          shown.filter((f) => theirs.has(f.uri)),
          open,
        );
        return flowers.map((f) => ({ ...f, patch: { rkey: p.rkey, uri: p.uri, name: p.name, season: p.season, open, cols: p.cols, rows: p.rows, owner: { did: owner, handle: garden.handle } } }));
      })
    ).flat();
    // One garden that can't be read is left out; none readable at all is an outage, not "no flowers".
    if (read > 0 && failed === read) throw new Error('gardens unreadable');
    return found.sort((a, b) => b.plantedAt.localeCompare(a.plantedAt) || b.uri.localeCompare(a.uri));
  }

  /** Their own garden: the "self" patch, else their newest open one. */
  async function ownGarden(did: string): Promise<OwnGarden | null> {
    const all = await reader.patches(did).catch(() => [] as Patch[]);
    const at = reader.now();
    const own = all.find((p) => p.rkey === OWN_PATCH_RKEY) ?? [...all].reverse().find((p) => isOpen(p, at));
    if (!own) return null;
    const count = await reader
      .planted(own, all)
      .then((f) => f.length)
      .catch(() => 0);
    return { rkey: own.rkey, uri: own.uri, name: own.name, note: own.note, open: isOpen(own, at), plots: own.cols * own.rows, planted: count };
  }

  /** The tending they've given: how much, to how many others, and the newest. */
  async function given(did: string, records: readonly RecordEntry[]): Promise<Gardener['given']> {
    const all = records.map(toGiven).filter((g): g is NonNullable<typeof g> => g !== null);
    const helped = new Set(all.filter((g) => g.owner !== did).map((g) => g.owner));
    const newest = all
      .filter((g): g is typeof g & { at: number } => g.at !== null && g.at <= reader.now() + 60_000)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_GIVEN_SHOWN);
    const { authors, blocked } = await reader.authors([...new Set(newest.map((g) => g.owner))]).catch(() => ({ authors: new Map(), blocked: new Set<string>() }));
    const recent: GivenTend[] = newest.flatMap((g) => {
      const owner = authors.get(g.owner);
      if (!owner || blocked.has(g.owner) || owner.handle.startsWith('did:')) return [];
      return [{ at: new Date(g.at).toISOString(), action: g.action, flower: { uri: g.uri, owner: { did: g.owner, handle: owner.handle } } }];
    });
    return { total: all.length, helped: helped.size, recent };
  }

  /** Their pets for Poe, and the notes Poe keeps about them. */
  async function poe(did: string, pds: string): Promise<Gardener['poe']> {
    const [pets, notes] = await Promise.all([
      getRecordFromPds(reader.fetch, pds, did, PETS_NSID, 'self')
        .then((r) => toPets(r?.value))
        .catch(() => 0),
      reader
        .identity(POE_DID)
        .then((p) => getRecordFromPds(reader.fetch, p.pds, POE_DID, MEMORY_NSID, did))
        .then((r) => toNotes(r?.value, did))
        .catch(() => 0),
    ]);
    return { pets, notes };
  }

  async function read(actor: string): Promise<Gardener> {
    const who = await reader.owner(actor);
    if (!who) throw new Missing();
    if (who.did !== GARDEN_SUBJECT && (await reader.blocked()).has(who.did)) throw new Missing();
    const did = who.did;
    const identity = await reader.identity(did).catch(() => {
      throw new Missing();
    });
    const [sprouts, tendRecords] = await Promise.all([
      listRecords(reader.fetch, identity.pds, did, SPROUT_NSID, SPROUT_PAGES),
      listRecords(reader.fetch, identity.pds, did, TEND_NSID, TEND_PAGES).catch(() => [] as RecordEntry[]),
    ]);
    const [found, garden, gave, withPoe] = await Promise.all([planted(did, sprouts), ownGarden(did), given(did, tendRecords), poe(did, identity.pds)]);

    const tended = await mapPool(found, 4, tends);
    const { authors: tenders, blocked: blockedTenders } = await reader.authors(tended.flat().map((t) => t.did));
    const flowers: GardenerFlower[] = found.map((f, i) => ({
      ...f,
      tends: tended[i]!.flatMap((t) => {
        const tender = tenders.get(t.did);
        if (!tender || blockedTenders.has(t.did) || tender.handle.startsWith('did:')) return [];
        return [{ did: t.did, handle: tender.handle, action: t.action, at: new Date(t.at).toISOString() }];
      }),
    }));
    return { did, handle: who.handle, displayName: who.displayName, avatar: who.avatar, garden, flowers, given: gave, poe: withPoe };
  }

  async function GET(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const actor = params.get('actor') ?? params.get('did') ?? '';
    if (!isActor(actor)) return jsonResponse(request, 400, { error: 'bad_actor' }, 'no-store');
    try {
      return jsonResponse(request, 200, await read(actor), CACHE_GARDENER);
    } catch (error) {
      if (error instanceof Missing) return jsonResponse(request, 404, { error: 'not_found' }, CACHE_MISSING);
      reader.log({ event: 'gardener_error', error: (error as Error)?.message ?? 'Error' });
      return jsonResponse(request, 503, { error: 'unavailable' }, 'no-store');
    }
  }

  return { GET, HEAD: GET, methodNotAllowed };
}
