/**
 * /api/garden: the flower patches on the home page. Each patch is a record in atpotato's
 * own repo, written by scripts/open-patches.ts, one per season (plus an overflow patch if
 * one fills up):
 *
 *   to.atpota.garden.patch   { name: "autumn 2026", season, cols, rows, opensAt, closesAt, createdAt }
 *
 * Visitors sign in with Bluesky and plant a flower in an open patch. It's a record in their
 * own repo, pointing at the patch with a strong ref (src/scripts/garden.ts writes it):
 *
 *   to.atpota.garden.sprout  { patch: { uri, cid }, kind: "sunflower" | ..., plot, createdAt }
 *
 * and anyone can tend a flower, their own or a neighbour's, with a record in their repo:
 *
 *   to.atpota.garden.tend    { subject: { uri, cid } (the flower), action: "water" | ..., createdAt }
 *
 * A patch is cols × rows plots; `plot` is the cell, counted from the top left, row by row.
 * Two flowers that claim the same plot: the one planted first keeps it, the other moves to
 * the next free plot along (resolvePlots); one that doesn't fit is left out. A patch is open
 * from opensAt until closesAt. One flower per account across the open patches (its newest);
 * a closed patch keeps every flower it had, pressed, in full bloom.
 *
 * A flower grows for GROW_DAYS: a sprout, then a bud, then the bloom. Tending while it grows
 * makes a better bloom (careFrom): every day its owner tends it counts, and so does every
 * neighbour who helps (up to MAX_HELPERS). Tend times come from the records' TID keys. After
 * it blooms, a flower nobody has tended for THIRSTY_DAYS droops until someone does.
 *
 * Nothing is stored on atpota.to. atpotato's PDS lists the patches, Constellation lists the
 * records that link to a patch (and to a flower), Slingshot serves each record, and the
 * public AppView gives the handles. A flower is left out when its record no longer points
 * at the patch or names an unknown kind, when its account has no profile view or carries
 * one of HIDDEN_LABELS, or when atpotato blocks the account on Bluesky. There is no free
 * text anywhere, so blocking is all the moderation it needs.
 *
 *   GET /api/garden[?patch=<rkey>]  ->  { patch, patches, flowers, total }
 *     patch    the one asked for; by default the first open patch with a free plot (see
 *              defaultPatch). { rkey, uri, cid, name, season, cols, rows, opensAt,
 *              closesAt, open }; null when there are no patches yet.
 *     patches  every patch, oldest first: { rkey, name, season, open, planted, plots,
 *              opensAt, closesAt }
 *     flowers  the patch's flowers, oldest first: { did, rkey, uri, cid, handle, kind, plot,
 *              plantedAt, care, helpers, lastTended, thirsty }. The browser grows each one's
 *              look from its DID, record key and care (src/scripts/flowers.ts).
 *   An unknown patch is a 404.
 *
 * Fresh for a minute at the CDN, served stale while it refreshes.
 */

import { fetchJson, listRecords, resolveDid, TtlCache, type Fetch, type Identity, type RecordEntry } from './blog/atproto.js';
import { ATPOTATO_DID } from './blog/config.js';
import { backlinks, commentAuthors, mapPool, ownerBlocks, SLINGSHOT, type CommentAuthor } from './blog/discussion.js';

export const PATCH_NSID = 'to.atpota.garden.patch';
export const SPROUT_NSID = 'to.atpota.garden.sprout';
export const TEND_NSID = 'to.atpota.garden.tend';
/** atpotato's DID: the patches are records in its repo. */
export const GARDEN_SUBJECT = ATPOTATO_DID;
export const FLOWER_KINDS = ['sunflower', 'rose', 'daisy', 'violet', 'poppy', 'tulip'] as const;
export type FlowerKind = (typeof FLOWER_KINDS)[number];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];
export const TEND_ACTIONS = ['water', 'sun', 'talk'] as const;
export type TendAction = (typeof TEND_ACTIONS)[number];

export const MIN_COLS = 4;
export const MAX_COLS = 24;
export const MIN_ROWS = 2;
export const MAX_ROWS = 40;
/** The biggest patch's plot count; a plot number is below this. */
export const MAX_PLOTS = MAX_COLS * MAX_ROWS;

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A sprout for SPROUT_DAYS, a bud until GROW_DAYS, then in bloom. */
export const SPROUT_DAYS = 2;
export const GROW_DAYS = 7;
/** Neighbours who tended a flower while it grew count towards its care, up to this many. */
export const MAX_HELPERS = 3;
/** A bloom nobody has tended for this long droops. */
export const THIRSTY_DAYS = 4;

export const GARDEN_TTL_MS = 30_000;
export const PATCHES_TTL_MS = 60_000;
/** Sprouts of an open patch are re-read after this; a closed patch's change rarely. */
const OPEN_SPROUTS_TTL_MS = 60_000;
const CLOSED_SPROUTS_TTL_MS = 10 * 60_000;
/** Care while a flower grows (or while its patch is open) is re-read after this. */
const CARE_TTL_MS = 60_000;
const FIXED_CARE_TTL_MS = 60 * 60_000;
/** Tend records read per flower (newest first), for care. */
const MAX_TENDS = 300;
export const CACHE_OK = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';
export const CACHE_MISSING = 'public, max-age=0, s-maxage=30';
export const REQUEST_TIMEOUT_MS = 4000;
export const CONCURRENCY = 8;

const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;
const CID_RE = /^[a-zA-Z0-9]{8,200}$/;
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const S32 = '234567abcdefghijklmnopqrstuvwxyz';

export interface Patch {
  rkey: string;
  uri: string;
  cid: string;
  name: string;
  season: Season;
  cols: number;
  rows: number;
  opensAt: string;
  closesAt: string;
}

export interface PatchView extends Patch {
  open: boolean;
}

export interface PatchSummary {
  rkey: string;
  name: string;
  season: Season;
  open: boolean;
  planted: number;
  plots: number;
  opensAt: string;
  closesAt: string;
}

export interface Flower {
  did: string;
  rkey: string;
  uri: string;
  cid: string;
  handle: string;
  kind: FlowerKind;
  plot: number;
  plantedAt: string;
  /** 0 to 1: how well it was tended while it grew. */
  care: number;
  /** Neighbours who helped it grow, up to MAX_HELPERS. */
  helpers: number;
  lastTended: string | null;
  thirsty: boolean;
}

export interface Garden {
  patch: PatchView | null;
  patches: PatchSummary[];
  flowers: Flower[];
  total: number;
}

/** A sprout record, checked, before moderation and plot settling. */
export interface Sprout {
  did: string;
  rkey: string;
  uri: string;
  cid: string;
  kind: FlowerKind;
  /** The plot asked for; null when it isn't a whole number on any patch. */
  plot: number | null;
  plantedAt: string;
}

export function isFlowerKind(value: unknown): value is FlowerKind {
  return typeof value === 'string' && (FLOWER_KINDS as readonly string[]).includes(value);
}

export function isTendAction(value: unknown): value is TendAction {
  return typeof value === 'string' && (TEND_ACTIONS as readonly string[]).includes(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isPlot(value: unknown): value is number {
  return isInt(value, 0, MAX_PLOTS - 1);
}

export function patchUri(rkey: string): string {
  return `at://${GARDEN_SUBJECT}/${PATCH_NSID}/${rkey}`;
}

/** { uri, cid } with an at:// URI and a CID-shaped cid; null otherwise. */
export function strongRef(value: unknown): { uri: string; cid: string } | null {
  const v = value as { uri?: unknown; cid?: unknown } | null;
  if (typeof v?.uri !== 'string' || typeof v.cid !== 'string' || !v.uri.startsWith('at://') || !CID_RE.test(v.cid)) return null;
  return { uri: v.uri, cid: v.cid };
}

/** A patch record from atpotato's repo, checked field by field; null otherwise. */
export function toPatch(entry: RecordEntry): Patch | null {
  const v = entry.value as Record<string, unknown>;
  const rkey = entry.uri.slice(entry.uri.lastIndexOf('/') + 1);
  if (entry.uri !== patchUri(rkey) || !RKEY_RE.test(rkey) || !CID_RE.test(entry.cid)) return null;
  if (typeof v.name !== 'string' || v.name.trim() === '' || [...v.name].length > 40) return null;
  if (typeof v.season !== 'string' || !(SEASONS as readonly string[]).includes(v.season)) return null;
  if (!isInt(v.cols, MIN_COLS, MAX_COLS) || !isInt(v.rows, MIN_ROWS, MAX_ROWS)) return null;
  const opens = typeof v.opensAt === 'string' ? Date.parse(v.opensAt) : NaN;
  const closes = typeof v.closesAt === 'string' ? Date.parse(v.closesAt) : NaN;
  if (!Number.isFinite(opens) || !Number.isFinite(closes) || opens >= closes) return null;
  return {
    rkey,
    uri: entry.uri,
    cid: entry.cid,
    name: v.name.trim(),
    season: v.season as Season,
    cols: v.cols,
    rows: v.rows,
    opensAt: new Date(opens).toISOString(),
    closesAt: new Date(closes).toISOString(),
  };
}

export function isOpen(patch: Pick<Patch, 'opensAt' | 'closesAt'>, now: number): boolean {
  return Date.parse(patch.opensAt) <= now && now < Date.parse(patch.closesAt);
}

/** A sprout record (by `did`, at `rkey`), checked field by field, with the patch it points at; null otherwise. */
export function toSprout(entry: unknown, did: string, rkey: string, now: number): (Sprout & { patch: string }) | null {
  const e = entry as { cid?: unknown; value?: Record<string, unknown> };
  const v = e?.value;
  if (!v || typeof v !== 'object' || typeof e.cid !== 'string' || !CID_RE.test(e.cid) || !isFlowerKind(v.kind)) return null;
  const patch = strongRef(v.patch);
  if (!patch) return null;
  const created = typeof v.createdAt === 'string' ? Date.parse(v.createdAt) : NaN;
  if (!Number.isFinite(created) || created > now + 5 * 60_000) return null;
  return {
    did,
    rkey,
    uri: `at://${did}/${SPROUT_NSID}/${rkey}`,
    cid: e.cid,
    kind: v.kind,
    plot: isPlot(v.plot) ? v.plot : null,
    plantedAt: new Date(created).toISOString(),
    patch: patch.uri,
  };
}

/** Oldest first, ties by DID then record key, so everyone settles plots the same way. */
export function byPlanting(a: Pick<Sprout, 'plantedAt' | 'did' | 'rkey'>, b: Pick<Sprout, 'plantedAt' | 'did' | 'rkey'>): number {
  return a.plantedAt.localeCompare(b.plantedAt) || a.did.localeCompare(b.did) || a.rkey.localeCompare(b.rkey);
}

/**
 * Gives every flower a plot of its own in a patch of `plots` plots, in planting order: a
 * flower keeps the plot it asked for unless an earlier flower has it, then takes the next
 * free one along (from the first plot, for a plot off the patch). One that doesn't fit is
 * left out.
 */
export function resolvePlots<T extends { plot: number | null }>(oldestFirst: readonly T[], plots: number): Array<T & { plot: number }> {
  const taken = new Set<number>();
  const out: Array<T & { plot: number }> = [];
  for (const f of oldestFirst) {
    if (taken.size >= plots) break;
    let plot = f.plot !== null && f.plot < plots ? f.plot : 0;
    while (taken.has(plot)) plot = (plot + 1) % plots;
    taken.add(plot);
    out.push({ ...f, plot });
  }
  return out;
}

/** The newest flower per account across the open patches, by URI. */
export function newestPerAccount(sprouts: readonly Sprout[]): Set<string> {
  const newest = new Map<string, Sprout>();
  for (const s of sprouts) {
    const seen = newest.get(s.did);
    if (!seen || byPlanting(seen, s) < 0) newest.set(s.did, s);
  }
  return new Set([...newest.values()].map((s) => s.uri));
}

/** When a TID record key was made (ms since the epoch), or null for any other key. */
export function tidTime(rkey: string): number | null {
  if (!TID_RE.test(rkey)) return null;
  let n = 0n;
  for (const ch of rkey) n = n * 32n + BigInt(S32.indexOf(ch));
  // 1 bit (zero), 53 bits of microseconds, 10 bits of clock id.
  return Number((n >> 10n) / 1000n);
}

export type Stage = 'sprout' | 'bud' | 'bloom';

/** A sprout, then a bud, then in bloom; every flower in a closed patch is in bloom. */
export function stageFor(plantedAt: string, now: number, open = true): Stage {
  if (!open) return 'bloom';
  const age = now - Date.parse(plantedAt);
  if (!Number.isFinite(age) || age < SPROUT_DAYS * DAY_MS) return 'sprout';
  if (age < GROW_DAYS * DAY_MS) return 'bud';
  return 'bloom';
}

export interface Care {
  care: number;
  helpers: number;
  lastTended: number | null;
}

/**
 * How well a flower was tended while it grew, from the tend records that point at it
 * (who wrote each, and its TID key): a day counts when its owner tended it that day, and
 * a neighbour counts once for helping (up to MAX_HELPERS). care = those / GROW_DAYS, at
 * most 1. Keys that aren't TIDs, and times before planting or in the future, don't count.
 */
export function careFrom(owner: string, plantedAt: string, tends: readonly { did: string; rkey: string }[], now: number): Care {
  const planted = Date.parse(plantedAt);
  const grown = planted + GROW_DAYS * DAY_MS;
  const days = new Set<number>();
  const helpers = new Set<string>();
  let last: number | null = null;
  for (const t of tends) {
    const at = tidTime(t.rkey);
    if (at === null || at < planted || at > now + 60_000) continue;
    if (last === null || at > last) last = at;
    if (at >= grown) continue;
    if (t.did === owner) days.add(Math.floor((at - planted) / DAY_MS));
    else helpers.add(t.did);
  }
  const helped = Math.min(MAX_HELPERS, helpers.size);
  return { care: Math.round((Math.min(GROW_DAYS, days.size + helped) / GROW_DAYS) * 100) / 100, helpers: helped, lastTended: last };
}

/** A bloom in an open patch that nobody has tended for THIRSTY_DAYS (since it bloomed). */
export function isThirsty(plantedAt: string, lastTended: number | null, now: number, open: boolean): boolean {
  if (!open || stageFor(plantedAt, now, open) !== 'bloom') return false;
  const bloomed = Date.parse(plantedAt) + GROW_DAYS * DAY_MS;
  return now - Math.max(lastTended ?? 0, bloomed) > THIRSTY_DAYS * DAY_MS;
}

/**
 * The patch to show when none is asked for: the first open patch with a free plot, else
 * the newest open one, else the newest that has opened, else the next to open.
 */
export function defaultPatch(patches: readonly PatchSummary[], now: number): PatchSummary | null {
  const open = patches.filter((p) => p.open);
  const opened = patches.filter((p) => Date.parse(p.opensAt) <= now);
  return open.find((p) => p.planted < p.plots) ?? open.at(-1) ?? opened.at(-1) ?? patches[0] ?? null;
}

export interface GardenDeps {
  fetch?: Fetch;
  now?: () => number;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

/** A patch's flowers before care: moderated, deduplicated, on their plots. */
type Planted = Omit<Flower, 'care' | 'helpers' | 'lastTended' | 'thirsty'>;

export interface GardenReader {
  now(): number;
  log: NonNullable<GardenDeps['log']>;
  /** Every valid patch, oldest first. */
  patches(): Promise<Patch[]>;
  /** A patch's flowers as shown, oldest first, without care. */
  planted(patch: Patch, all: readonly Patch[]): Promise<Planted[]>;
  care(flower: Pick<Flower, 'did' | 'uri' | 'plantedAt'>, open: boolean): Promise<Care>;
  authors(dids: readonly string[]): Promise<{ authors: Map<string, CommentAuthor>; blocked: Set<string> }>;
  fetch: Fetch;
}

/**
 * Reads the garden from the network, with small per-instance caches: atpotato's PDS, the
 * patch list, each patch's sprouts, and each flower's care. A flower whose care can no
 * longer change keeps it for an hour, and a failed read falls back to the last one, so a
 * bloom never flickers between looks.
 */
export function createGardenReader(deps: GardenDeps = {}): GardenReader {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const log =
    deps.log ??
    ((fields) => {
      const line = JSON.stringify({ src: 'garden', ...fields });
      if (fields.event.endsWith('_error')) console.warn(line);
      else console.info(line);
    });
  let owner: Promise<Identity> | null = null;
  const patchCache = new TtlCache<Promise<Patch[]>>(PATCHES_TTL_MS, now);
  const sproutCache = new Map<string, { at: number; value: Promise<Sprout[]> }>();
  const careCache = new Map<string, Care & { at: number }>();

  function ownerIdentity(): Promise<Identity> {
    owner ??= resolveDid(doFetch, GARDEN_SUBJECT).catch(() => {
      owner = null;
      return { did: GARDEN_SUBJECT, pds: 'https://pds.atpota.to', handle: 'atpota.to' };
    });
    return owner;
  }

  function patches(): Promise<Patch[]> {
    const cached = patchCache.get('patches');
    if (cached) return cached;
    const pending = ownerIdentity().then(async (o) => {
      const records = await listRecords(doFetch, o.pds, GARDEN_SUBJECT, PATCH_NSID, 3);
      const list = records.map(toPatch).filter((p): p is Patch => p !== null);
      return list.sort((a, b) => a.opensAt.localeCompare(b.opensAt) || a.rkey.localeCompare(b.rkey));
    });
    patchCache.set('patches', pending);
    pending.catch(() => patchCache.delete('patches'));
    return pending;
  }

  /** Every sprout record pointing at the patch (Constellation, then Slingshot per record). */
  function sprouts(patch: Patch): Promise<Sprout[]> {
    const at = now();
    const ttl = isOpen(patch, at) ? OPEN_SPROUTS_TTL_MS : CLOSED_SPROUTS_TTL_MS;
    const hit = sproutCache.get(patch.uri);
    if (hit && at - hit.at < ttl) return hit.value;
    const value = (async () => {
      const refs = await backlinks(doFetch, patch.uri, SPROUT_NSID, '.patch.uri', Math.max(100, patch.cols * patch.rows * 2));
      const read = await mapPool(refs, CONCURRENCY, async ({ did, rkey }) => {
        const params = new URLSearchParams({ repo: did, collection: SPROUT_NSID, rkey });
        try {
          const s = toSprout(await fetchJson(doFetch, `${SLINGSHOT}/xrpc/com.atproto.repo.getRecord?${params}`, REQUEST_TIMEOUT_MS), did, rkey, now());
          if (!s || s.patch !== patch.uri) return null;
          const { patch: _p, ...sprout } = s;
          return sprout;
        } catch {
          return null;
        }
      });
      return read.filter((s): s is Sprout => s !== null);
    })();
    sproutCache.set(patch.uri, { at, value });
    value.catch(() => sproutCache.delete(patch.uri));
    return value;
  }

  async function authors(dids: readonly string[]): Promise<{ authors: Map<string, CommentAuthor>; blocked: Set<string> }> {
    const blocks = ownerIdentity().then((o) => ownerBlocks(doFetch, o));
    const [found, blocked] = await Promise.all([dids.length ? commentAuthors(doFetch, [...new Set(dids)]) : new Map<string, CommentAuthor>(), blocks]);
    return { authors: found, blocked };
  }

  async function planted(patch: Patch, all: readonly Patch[]): Promise<Planted[]> {
    const at = now();
    let mine = await sprouts(patch);
    if (isOpen(patch, at)) {
      const open = all.filter((p) => isOpen(p, at));
      const everywhere = (await Promise.all(open.map((p) => (p.uri === patch.uri ? mine : sprouts(p).catch(() => []))))).flat();
      const keep = newestPerAccount(everywhere);
      mine = mine.filter((s) => keep.has(s.uri));
    }
    const { authors: found, blocked } = await authors(mine.map((s) => s.did));
    const shown = mine
      .filter((s) => {
        const author = found.get(s.did);
        return author && !blocked.has(s.did) && !author.handle.startsWith('did:');
      })
      .sort(byPlanting);
    return resolvePlots(shown, patch.cols * patch.rows).map((s) => ({
      did: s.did,
      rkey: s.rkey,
      uri: s.uri,
      cid: s.cid,
      handle: found.get(s.did)!.handle,
      kind: s.kind,
      plot: s.plot,
      plantedAt: s.plantedAt,
    }));
  }

  async function care(flower: Pick<Flower, 'did' | 'uri' | 'plantedAt'>, open: boolean): Promise<Care> {
    const at = now();
    const grown = at >= Date.parse(flower.plantedAt) + GROW_DAYS * DAY_MS;
    const hit = careCache.get(flower.uri);
    // Care is fixed once the flower has grown; while its patch is open, lastTended still moves.
    const ttl = grown && !open ? FIXED_CARE_TTL_MS : CARE_TTL_MS;
    if (hit && at - hit.at < ttl) return hit;
    try {
      const refs = await backlinks(doFetch, flower.uri, TEND_NSID, '.subject.uri', MAX_TENDS);
      const fresh = careFrom(flower.did, flower.plantedAt, refs, at);
      // A grown flower's early tends can fall off the newest pages; never let its care drop.
      const settled = grown && hit && hit.care > fresh.care ? { ...fresh, care: hit.care, helpers: hit.helpers } : fresh;
      if (careCache.size >= 2000) careCache.delete(careCache.keys().next().value!);
      careCache.set(flower.uri, { ...settled, at });
      return settled;
    } catch {
      return hit ?? { care: 0, helpers: 0, lastTended: null };
    }
  }

  return { now, log, patches, planted, care, authors, fetch: doFetch };
}

/** The flowers with their care, and whether each is thirsty. */
export async function withCare(reader: GardenReader, flowers: readonly Planted[], open: boolean): Promise<Flower[]> {
  return mapPool(flowers, CONCURRENCY, async (f) => {
    const c = await reader.care(f, open);
    return {
      ...f,
      care: c.care,
      helpers: c.helpers,
      lastTended: c.lastTended === null ? null : new Date(c.lastTended).toISOString(),
      thirsty: isThirsty(f.plantedAt, c.lastTended, reader.now(), open),
    };
  });
}

export function view(patch: Patch, now: number): PatchView {
  return { ...patch, open: isOpen(patch, now) };
}

export interface GardenHandlers {
  GET(request: Request): Promise<Response>;
  HEAD(request: Request): Promise<Response>;
  methodNotAllowed(request: Request): Promise<Response>;
}

export const BASE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

export function jsonResponse(request: Request, status: number, body: unknown, cache: string): Response {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...BASE_HEADERS },
  });
}

export function methodNotAllowed(request: Request): Promise<Response> {
  return Promise.resolve(
    new Response(request.method === 'HEAD' ? null : 'method not allowed\n', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD', ...BASE_HEADERS },
    }),
  );
}

class NotFound extends Error {}

export function createGardenHandlers(deps: GardenDeps = {}): GardenHandlers {
  const reader = createGardenReader(deps);
  const cache = new TtlCache<Promise<Garden>>(GARDEN_TTL_MS, reader.now);

  async function read(rkey: string | null): Promise<Garden> {
    const all = await reader.patches();
    const at = reader.now();
    if (rkey !== null && !all.some((p) => p.rkey === rkey)) throw new NotFound();
    if (all.length === 0) return { patch: null, patches: [], flowers: [], total: 0 };
    const planted = new Map<string, Planted[]>();
    const summaries = await mapPool(all, 4, async (p) => {
      const open = isOpen(p, at);
      // Closed patches other than the one shown only need a count; a failed read shows 0.
      const flowers = await reader.planted(p, all).catch((error) => {
        if (p.rkey === rkey || open) throw error;
        return [];
      });
      planted.set(p.uri, flowers);
      return { rkey: p.rkey, name: p.name, season: p.season, open, planted: flowers.length, plots: p.cols * p.rows, opensAt: p.opensAt, closesAt: p.closesAt };
    });
    const chosen = rkey ?? defaultPatch(summaries, at)!.rkey;
    const patch = all.find((p) => p.rkey === chosen)!;
    const open = isOpen(patch, at);
    const flowers = await withCare(reader, planted.get(patch.uri) ?? [], open);
    return { patch: view(patch, at), patches: summaries, flowers, total: flowers.length };
  }

  function load(rkey: string | null): Promise<Garden> {
    const key = rkey ?? '';
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = read(rkey);
    cache.set(key, pending);
    pending.catch((error) => {
      cache.delete(key);
      if (!(error instanceof NotFound)) reader.log({ event: 'garden_error', error: (error as Error)?.message ?? 'Error' });
    });
    return pending;
  }

  async function GET(request: Request): Promise<Response> {
    const asked = new URL(request.url).searchParams.get('patch');
    if (asked !== null && !RKEY_RE.test(asked)) return jsonResponse(request, 404, { error: 'not_found' }, CACHE_MISSING);
    try {
      return jsonResponse(request, 200, await load(asked), CACHE_OK);
    } catch (error) {
      if (error instanceof NotFound) return jsonResponse(request, 404, { error: 'not_found' }, CACHE_MISSING);
      return jsonResponse(request, 503, { error: 'unavailable' }, 'no-store');
    }
  }

  return { GET, HEAD: GET, methodNotAllowed };
}

