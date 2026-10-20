/**
 * /api/garden: a garden. Anyone can keep one: a patch record in their own repo (record key
 * "self" by convention, written from their garden page). atpotato's are the community
 * patches on the home page, seasonal, written by scripts/open-patches.ts:
 *
 *   to.atpota.garden.patch   { name, note?, season?, cols, rows, opensAt?, closesAt?, planting?, createdAt }
 *
 * Visitors sign in with Bluesky and plant a flower in an open patch. It's a record in their
 * own repo, pointing at the patch with a strong ref (src/scripts/garden-api.ts writes it):
 *
 *   to.atpota.garden.sprout  { patch: { uri, cid }, kind: "seed" | "sunflower" | ..., plot, createdAt }
 *
 * A "seed" grows into whatever the garden decides (shared/garden-rules.js): the garden
 * indexer settles it a couple of minutes after it's planted, from its seed, its patch's
 * season and the network weather that minute, and settles the weather of its growing week
 * once it blooms (garden_growth in Supabase, written by garden/ on the droplet). This tells
 * nobody what a seed is before it blooms: a sprout is just a sprout, a bud shows its family,
 * and the bloom shows what it is (reveal). Older flowers keep the kind their planter picked.
 *
 * and anyone can tend a flower, their own or a neighbour's, with a record in their repo:
 *
 *   to.atpota.garden.tend    { subject: { uri, cid } (the flower), action: "water" | ..., createdAt }
 *
 * A patch is cols × rows plots; `plot` is the cell, counted from the top left, row by row.
 * Two flowers that claim the same plot: the one planted first keeps it, the other moves to
 * the next free plot along (resolvePlots); one that doesn't fit is left out. A patch is open
 * from opensAt (or, without one, createdAt) until closesAt, if it has one. How many flowers
 * an account has across a garden's open patches is the patch's `planting` (onePerAccount):
 * "one" (the default, and the community patches') keeps its first, so a flower stays where
 * it was planted; "move" keeps its newest, so planting again moves it; "many" keeps them
 * all. A closed patch keeps every flower it had, pressed, in full bloom.
 *
 * A flower grows for GROW_DAYS: a sprout, then a bud, then the bloom. Tending while it grows
 * makes a better bloom (careFrom): every day its owner tends it counts, and so does every
 * neighbour who helps (up to MAX_HELPERS). Tend times come from the records' TID keys. After
 * it blooms, a flower nobody has tended for THIRSTY_DAYS droops until someone does.
 *
 * Where the records come from is GARDEN_SOURCE (sourceFrom):
 *   constellation  the public AppView says who the garden's owner is (a handle works too),
 *                  their DID document where their PDS is, which lists their patches;
 *                  Constellation lists the records that link to a patch (and to a flower)
 *                  and Slingshot serves each record (the default)
 *   shadow         the same, and each patch's sprouts are also read from the garden index
 *                  and any difference logged (garden_shadow_diff), to check the index
 *   index          the garden index in Supabase (garden_records, kept by the droplet's
 *                  indexer from the firehose): one query for a garden's patches, one for a
 *                  patch's sprouts, one for its flowers' tends. Read only while the
 *                  indexer's heartbeat is fresh (garden_status); otherwise as constellation.
 * Either way the AppView gives the handles and labels. What's settled about each flower
 * comes from the index in every mode, and a flower simply has none while it can't be read.
 * A flower is left out when its record no longer points at the patch or names an unknown
 * kind, when its account has no profile view or carries one of HIDDEN_LABELS, or when
 * atpotato or the garden's owner blocks the account on Bluesky. A garden whose owner is
 * hidden, or blocked by atpotato, isn't shown at all, and tending by blocked accounts
 * doesn't count towards care. The only free text is the owner's own name and note.
 *
 *   GET /api/garden[?owner=<did or handle>][&patch=<rkey>]  ->  { owner, patch, patches, flowers, total, seeds }
 *     owner    { did, handle, displayName, avatar }; atpotato by default
 *     patch    the one asked for; by default the first open patch with a free plot (see
 *              defaultPatch). { rkey, uri, cid, name, note, season, cols, rows, opensAt,
 *              closesAt, createdAt, planting, open } (note, season and the dates may be
 *              null); null when the owner has no patches yet.
 *     patches  every patch, oldest first: { rkey, name, season, open, planted, plots,
 *              opensAt, closesAt }
 *     flowers  the patch's flowers, oldest first: { did, rkey, uri, cid, handle, kind, family,
 *              weather, plot, plantedAt, care, helpers, lastTended, thirsty }. kind is "seed"
 *              until a seed blooms; family is null until it buds; weather is { planted, grew }
 *              (each { wind, mix } from 0 to 4, grew also apps, the busiest apps outside
 *              Bluesky that week, once it has bloomed), or null when nothing is settled. The
 *              browser grows each one's look from its DID, record key, care and the week it
 *              grew in (src/scripts/flowers.ts).
 *     seeds    true when planting gives out seeds (only while the index is the source)
 *   An unknown owner or patch is a 404.
 *
 * Fresh for a minute at the CDN (15 seconds from the index), served stale while it refreshes.
 */

import { familyOf, isPickedKind, isSpecies, PICKED_KINDS, SEED, type Family, type PickedKind, type SpeciesId } from '../shared/garden-rules.js';
import { APPVIEW, AtprotoError, fetchJson, listRecords, resolveDid, TtlCache, type Fetch, type Identity, type RecordEntry } from './blog/atproto.js';
import { ATPOTATO_DID, isDid } from './blog/config.js';
import { backlinks, commentAuthors, HIDDEN_LABELS, mapPool, ownerBlocks, SLINGSHOT, type CommentAuthor } from './blog/discussion.js';
import { httpUrl } from './blog/html.js';
import { getRecord, getRecordFromPds, resolveMiniDoc } from './slingshot.js';
import { isRecord, supabase as openSupabase, type Env, type Supabase } from './supabase-public.js';

export const PATCH_NSID = 'to.atpota.garden.patch';
export const SPROUT_NSID = 'to.atpota.garden.sprout';
export const TEND_NSID = 'to.atpota.garden.tend';
/** atpotato's DID: the community patches are records in its repo, and its garden is the default. */
export const GARDEN_SUBJECT = ATPOTATO_DID;
/** The record key of someone's own garden, by convention. */
export const OWN_PATCH_RKEY = 'self';
/** A garden's name and note, in graphemes. */
export const NAME_MAX = 40;
export const NOTE_MAX = 140;
/** The kinds a planter can pick themselves; or SEED, and the garden decides (shared/garden-rules.js). */
export const FLOWER_KINDS = PICKED_KINDS;
export type FlowerKind = PickedKind;
/** What a sprout record's kind can be. */
export type RecordKind = PickedKind | typeof SEED;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];
export const TEND_ACTIONS = ['water', 'sun', 'talk'] as const;
export type TendAction = (typeof TEND_ACTIONS)[number];
/** How many flowers each account grows in a garden's open patches (the lexicon's planting); the first is the default. */
export const PLANTING = ['one', 'move', 'many'] as const;
export type Planting = (typeof PLANTING)[number];

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

/** Where the garden reads its records (see the top of this file). */
export const SOURCES = ['constellation', 'shadow', 'index'] as const;
export type GardenSource = (typeof SOURCES)[number];
/** The index is read only while the indexer's heartbeat is newer than this, and it has finished a backfill. */
export const INDEX_FRESH_MS = 5 * 60_000;
/** The indexer's heartbeat is re-read after this. */
const STATUS_TTL_MS = 15_000;

export const GARDEN_TTL_MS = 30_000;
/** From the index, a garden is re-read after this. */
export const INDEX_GARDEN_TTL_MS = 10_000;
export const PATCHES_TTL_MS = 60_000;
/** Owners' profiles and DID documents are re-read after these. */
const OWNER_TTL_MS = 5 * 60_000;
const IDENTITY_TTL_MS = 10 * 60_000;
/** Sprouts of an open patch are re-read after this; a closed patch's change rarely. */
const OPEN_SPROUTS_TTL_MS = 60_000;
const CLOSED_SPROUTS_TTL_MS = 10 * 60_000;
/** Care while a flower grows (or while its patch is open) is re-read after this. */
const CARE_TTL_MS = 60_000;
const FIXED_CARE_TTL_MS = 60 * 60_000;
/** Tend records read per flower (newest first), for care. */
const MAX_TENDS = 300;
export const CACHE_OK = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';
/** Reading from the index is cheap, so a planting or a watering shows sooner. */
export const CACHE_INDEX = 'public, max-age=0, s-maxage=15, stale-while-revalidate=120';
export const CACHE_MISSING = 'public, max-age=0, s-maxage=30';
export const REQUEST_TIMEOUT_MS = 4000;
export const CONCURRENCY = 8;

const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;
const CID_RE = /^[a-zA-Z0-9]{8,200}$/;
const HANDLE_RE = /^(?=.{3,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
// Control and direction characters (zero-width joiners stay: emoji need them).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const S32 = '234567abcdefghijklmnopqrstuvwxyz';

/** A garden's owner, from the AppView. */
export interface Owner {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
}

export interface Patch {
  /** The DID whose repo it's in. */
  owner: string;
  rkey: string;
  uri: string;
  cid: string;
  name: string;
  note: string | null;
  season: Season | null;
  cols: number;
  rows: number;
  opensAt: string | null;
  closesAt: string | null;
  createdAt: string;
  planting: Planting;
}

export interface PatchView extends Omit<Patch, 'owner'> {
  open: boolean;
}

export interface PatchSummary {
  rkey: string;
  name: string;
  season: Season | null;
  open: boolean;
  planted: number;
  plots: number;
  opensAt: string | null;
  closesAt: string | null;
}

/** How windy and how mixed, each 0 to 4 (shared/garden-rules.js WIND and MIX). */
export interface Weather {
  wind: number;
  mix: number;
}

export interface FlowerWeather {
  /** The minute it was planted; null when the weather station has no reading for it. */
  planted: Weather | null;
  /** The week it grew in, once it has bloomed (and the busiest apps outside Bluesky that week). */
  grew: (Weather & { apps: string[] }) | null;
}

/** What the garden indexer settled about a flower (garden_growth). */
export interface Growth {
  plantedAt: string;
  species: string;
  plantWind: number | null;
  plantMix: number | null;
  grown: boolean;
  growWind: number | null;
  growMix: number | null;
  growApps: string[];
}

export interface Flower {
  did: string;
  rkey: string;
  uri: string;
  cid: string;
  handle: string;
  /** What it is: a seed until it blooms, then what it grew into; or the kind its planter picked. */
  kind: SpeciesId | typeof SEED;
  /** Its family once it buds (a seed's), or always (a picked kind's); null before that. */
  family: Family | null;
  weather: FlowerWeather | null;
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
  owner: Owner;
  patch: PatchView | null;
  patches: PatchSummary[];
  flowers: Flower[];
  total: number;
  seeds: boolean;
}

/** A sprout record, checked, before moderation and plot settling. */
export interface Sprout {
  did: string;
  rkey: string;
  uri: string;
  cid: string;
  kind: RecordKind;
  /** The plot asked for; null when it isn't a whole number on any patch. */
  plot: number | null;
  plantedAt: string;
  /** What's settled about it; undefined when it couldn't be read. */
  growth?: Growth | null;
}

export function isFlowerKind(value: unknown): value is FlowerKind {
  return isPickedKind(value);
}

/** A kind a sprout record may name: a picked kind, or a seed. */
export function isRecordKind(value: unknown): value is RecordKind {
  return value === SEED || isPickedKind(value);
}

/** Where to read from: GARDEN_SOURCE, constellation unless it says otherwise. */
export function sourceFrom(env: Env): GardenSource {
  const v = env.GARDEN_SOURCE?.trim().toLowerCase();
  return (SOURCES as readonly string[]).includes(v ?? '') ? (v as GardenSource) : 'constellation';
}

const isLevel = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4;
const DOMAIN_RE = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}$/;

/** A garden_growth row as the index answers it, checked; null otherwise. */
export function toGrowth(value: unknown): Growth | null {
  if (!isRecord(value)) return null;
  const at = typeof value.plantedAt === 'string' ? Date.parse(value.plantedAt) : NaN;
  if (!Number.isFinite(at) || typeof value.species !== 'string' || value.species.length > 64) return null;
  const level = (n: unknown) => (isLevel(n) ? n : null);
  return {
    plantedAt: new Date(at).toISOString(),
    species: value.species,
    plantWind: level(value.plantWind),
    plantMix: level(value.plantMix),
    grown: value.grown === true,
    growWind: level(value.growWind),
    growMix: level(value.growMix),
    growApps: Array.isArray(value.growApps) ? value.growApps.filter((a): a is string => typeof a === 'string' && DOMAIN_RE.test(a)).slice(0, 7) : [],
  };
}

/**
 * What the garden shows of a flower at this stage: a seed is a seed until it blooms (and
 * what it grew into is settled), and shows its family from the bud on; a picked kind is
 * what it is from the start. The weather it was planted in shows from the start, the week
 * it grew in once it has bloomed.
 */
export function reveal(kind: RecordKind, growth: Growth | null | undefined, stage: Stage): Pick<Flower, 'kind' | 'family' | 'weather'> {
  const grewInto = growth && isSpecies(growth.species) ? growth.species : null;
  const seed = kind === SEED;
  const shown: Flower['kind'] = seed ? (stage === 'bloom' && grewInto ? grewInto : SEED) : kind;
  const family = seed ? (stage !== 'sprout' && grewInto ? familyOf(grewInto) : null) : familyOf(kind);
  if (!growth) return { kind: shown, family, weather: null };
  const planted = isLevel(growth.plantWind) && isLevel(growth.plantMix) ? { wind: growth.plantWind, mix: growth.plantMix } : null;
  const grew = stage === 'bloom' && growth.grown && isLevel(growth.growWind) && isLevel(growth.growMix) ? { wind: growth.growWind, mix: growth.growMix, apps: growth.growApps } : null;
  return { kind: shown, family, weather: { planted, grew } };
}

export function isTendAction(value: unknown): value is TendAction {
  return typeof value === 'string' && (TEND_ACTIONS as readonly string[]).includes(value);
}

export function isPlanting(value: unknown): value is Planting {
  return typeof value === 'string' && (PLANTING as readonly string[]).includes(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isPlot(value: unknown): value is number {
  return isInt(value, 0, MAX_PLOTS - 1);
}

export function patchUri(rkey: string, owner: string = GARDEN_SUBJECT): string {
  return `at://${owner}/${PATCH_NSID}/${rkey}`;
}

/** The owner and record key of a patch's at:// URI; null for anything else. */
export function parsePatchUri(uri: string): { owner: string; rkey: string } | null {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!m || m[2] !== PATCH_NSID || !isDid(m[1]!) || !RKEY_RE.test(m[3]!)) return null;
  return { owner: m[1]!, rkey: m[3]! };
}

/** A DID or a handle. */
export function isActor(value: string): boolean {
  return isDid(value) || HANDLE_RE.test(value);
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

/** The text's graphemes (characters as a reader sees them). */
export function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : [...text];
}

/** Free text from a record: no control or direction characters, spaces collapsed, at most `max` graphemes. */
export function cleanText(text: string, max: number): string {
  const one = text.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const g = graphemes(one);
  return g.length > max ? g.slice(0, max).join('').trim() : one;
}

/** { uri, cid } with an at:// URI and a CID-shaped cid; null otherwise. */
export function strongRef(value: unknown): { uri: string; cid: string } | null {
  const v = value as { uri?: unknown; cid?: unknown } | null;
  if (typeof v?.uri !== 'string' || typeof v.cid !== 'string' || !v.uri.startsWith('at://') || !CID_RE.test(v.cid)) return null;
  return { uri: v.uri, cid: v.cid };
}

/** A patch record from `owner`'s repo (atpotato's by default), checked field by field; null otherwise. */
export function toPatch(entry: RecordEntry, owner: string = GARDEN_SUBJECT): Patch | null {
  const v = entry.value as Record<string, unknown>;
  const rkey = entry.uri.slice(entry.uri.lastIndexOf('/') + 1);
  if (entry.uri !== patchUri(rkey, owner) || !RKEY_RE.test(rkey) || !CID_RE.test(entry.cid)) return null;
  if (typeof v.name !== 'string') return null;
  const name = v.name.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (name === '' || graphemes(name).length > NAME_MAX) return null;
  if (!isInt(v.cols, MIN_COLS, MAX_COLS) || !isInt(v.rows, MIN_ROWS, MAX_ROWS)) return null;
  const date = (value: unknown): number | null | undefined => {
    if (value === undefined || value === null) return null;
    const t = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(t) ? t : undefined;
  };
  const created = date(v.createdAt);
  const opens = date(v.opensAt);
  const closes = date(v.closesAt);
  if (created === undefined || created === null || opens === undefined || closes === undefined) return null;
  if (closes !== null && closes <= (opens ?? created)) return null;
  const note = typeof v.note === 'string' ? cleanText(v.note, NOTE_MAX) : '';
  return {
    owner,
    rkey,
    uri: entry.uri,
    cid: entry.cid,
    name,
    note: note || null,
    season: typeof v.season === 'string' && (SEASONS as readonly string[]).includes(v.season) ? (v.season as Season) : null,
    cols: v.cols,
    rows: v.rows,
    opensAt: opens === null ? null : new Date(opens).toISOString(),
    closesAt: closes === null ? null : new Date(closes).toISOString(),
    createdAt: new Date(created).toISOString(),
    // Anything it doesn't know (knownValues is open) is the default.
    planting: isPlanting(v.planting) ? v.planting : PLANTING[0],
  };
}

/** When a patch opens: opensAt, or when it was made. */
export function opensFrom(patch: Pick<Patch, 'opensAt' | 'createdAt'>): string {
  return patch.opensAt ?? patch.createdAt;
}

export function isOpen(patch: Pick<Patch, 'opensAt' | 'closesAt' | 'createdAt'>, now: number): boolean {
  return Date.parse(opensFrom(patch)) <= now && (patch.closesAt === null || now < Date.parse(patch.closesAt));
}

/** A sprout record (by `did`, at `rkey`), checked field by field, with the patch it points at; null otherwise. */
export function toSprout(entry: unknown, did: string, rkey: string, now: number): (Sprout & { patch: string }) | null {
  const e = entry as { cid?: unknown; value?: Record<string, unknown> };
  const v = e?.value;
  if (!v || typeof v !== 'object' || typeof e.cid !== 'string' || !CID_RE.test(e.cid) || !isRecordKind(v.kind)) return null;
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

/** One flower per account across the open patches, by URI: each account's first, or its newest. */
export function onePerAccount(sprouts: readonly Sprout[], keep: 'first' | 'newest'): Set<string> {
  const kept = new Map<string, Sprout>();
  for (const s of sprouts) {
    const seen = kept.get(s.did);
    if (!seen || (keep === 'newest' ? byPlanting(seen, s) < 0 : byPlanting(s, seen) < 0)) kept.set(s.did, s);
  }
  return new Set([...kept.values()].map((s) => s.uri));
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
  const opened = patches.filter((p) => p.opensAt === null || Date.parse(p.opensAt) <= now);
  return open.find((p) => p.planted < p.plots) ?? open.at(-1) ?? opened.at(-1) ?? patches[0] ?? null;
}

export interface GardenDeps {
  fetch?: Fetch;
  now?: () => number;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
  /** GARDEN_SOURCE, and where Supabase is (server/supabase-public.ts); process.env by default. */
  env?: Env;
}

/** A patch's flowers before care: moderated, deduplicated, on their plots. */
type Planted = Omit<Flower, 'care' | 'helpers' | 'lastTended' | 'thirsty'>;

/** A tend record pointing at a flower: who, and its record key (its time). */
export interface TendRef {
  did: string;
  rkey: string;
  action: string;
}

/** The indexer's heartbeat, as garden_status has it. */
interface IndexStatus {
  heartbeatAt: number | null;
  backfilledAt: number | null;
}

/** True while the indexer has finished a backfill and its heartbeat is recent. */
export function isFresh(status: { heartbeat_at?: unknown; backfilled_at?: unknown } | null | undefined, now: number): boolean {
  const at = (x: unknown) => (typeof x === 'string' ? Date.parse(x) : NaN);
  const beat = at(status?.heartbeat_at);
  return Number.isFinite(beat) && now - beat < INDEX_FRESH_MS && beat <= now + 60_000 && Number.isFinite(at(status?.backfilled_at));
}

class IndexUnavailable extends Error {}

export interface GardenReader {
  now(): number;
  log: NonNullable<GardenDeps['log']>;
  /** Where the records come from (GARDEN_SOURCE). */
  source: GardenSource;
  /**
   * Who a DID or handle is: the AppView's profile, or Slingshot's when the AppView doesn't
   * know them; null for an unknown, hidden or taken-down account.
   */
  owner(actor: string): Promise<Owner | null>;
  /** Where a DID's PDS is (Slingshot, else its DID document). */
  identity(did: string): Promise<Identity>;
  /**
   * `owner`'s valid patches, oldest first: atpotato's seasonal ones (from the index, else
   * listed from its PDS), or someone's garden (their record at "self", from the index, else
   * Slingshot). With `version`, a list that doesn't have that version yet is read again,
   * from the PDS if neither has caught up.
   */
  patches(owner: string, version?: string): Promise<Patch[]>;
  /** A patch's flowers as shown, oldest first, without care. `all` is its owner's patches. */
  planted(patch: Patch, all: readonly Patch[]): Promise<Planted[]>;
  /** One flower's care, from Constellation's links to it, not counting tending by `blocked` accounts. */
  care(flower: Pick<Flower, 'did' | 'uri' | 'plantedAt'>, open: boolean, blocked?: ReadonlySet<string>): Promise<Care>;
  /** Every flower's care, by URI: from the index in one read when it's the source, else one by one. */
  cares(flowers: ReadonlyArray<Pick<Flower, 'did' | 'uri' | 'plantedAt'>>, open: boolean, blocked: ReadonlySet<string>): Promise<Map<string, Care>>;
  /** The tend records pointing at these flowers, from the index; null when the index isn't the source (or can't be read). */
  tends(uris: readonly string[]): Promise<Map<string, TendRef[]> | null>;
  /** Accounts atpotato blocks, plus those `owner` blocks when given. */
  blocked(owner?: string): Promise<Set<string>>;
  /** Profiles for these DIDs, and who is blocked (as blocked()). */
  authors(dids: readonly string[], owner?: string): Promise<{ authors: Map<string, CommentAuthor>; blocked: Set<string> }>;
  fetch: Fetch;
}

/** atpotato, when the AppView can't say: the community garden never hangs on its own profile. */
const ATPOTATO_OWNER: Owner = { did: GARDEN_SUBJECT, handle: 'atpota.to', displayName: 'atpotato', avatar: null };

/** An AppView profile view as an owner; null for a missing, mismatched or hidden account. */
export function toOwner(view: unknown, actor: string): Owner | null {
  const v = view as { did?: unknown; handle?: unknown; displayName?: unknown; avatar?: unknown; labels?: unknown } | null;
  if (typeof v?.did !== 'string' || !isDid(v.did)) return null;
  const labels = Array.isArray(v.labels) ? v.labels : [];
  if (labels.some((l) => HIDDEN_LABELS.has((l as { val?: unknown })?.val as string) && (l as { neg?: unknown }).neg !== true)) return null;
  const handle = typeof v.handle === 'string' && HANDLE_RE.test(v.handle) && v.handle !== 'handle.invalid' ? v.handle.toLowerCase() : null;
  if (isDid(actor) ? v.did !== actor : handle !== actor.toLowerCase()) return null;
  const name = typeof v.displayName === 'string' ? cleanText(v.displayName, 64) : '';
  const avatar = httpUrl(v.avatar);
  return { did: v.did, handle: handle ?? v.did, displayName: name || null, avatar: avatar?.startsWith('https://') ? avatar : null };
}

/**
 * Reads gardens, with small per-instance caches: owners' profiles and DID documents, each
 * owner's patch list, each patch's sprouts, and each flower's care. From the network, a
 * flower whose care can no longer change keeps it for an hour, and a failed read falls back
 * to the last one, so a bloom never flickers between looks. From the index (when it's the
 * source and fresh) the same, in a handful of queries; anything the index can't answer is
 * read from the network instead.
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
  const env: Env = deps.env ?? process.env;
  const source = sourceFrom(env);
  const db: Supabase = openSupabase(env, doFetch);
  const ownerCache = new TtlCache<Promise<Owner | null>>(OWNER_TTL_MS, now, 500);
  const identityCache = new TtlCache<Promise<Identity>>(IDENTITY_TTL_MS, now, 500);
  const patchCache = new TtlCache<Promise<Patch[]>>(PATCHES_TTL_MS, now, 500);
  const sproutCache = new Map<string, { at: number; value: Promise<Sprout[]> }>();
  const careCache = new Map<string, Care & { at: number }>();
  let status: { at: number; ready: Promise<boolean> } | null = null;
  let wasReady: boolean | null = null;
  /** When reading what's settled failed, it isn't tried again until then. */
  let growthDownUntil = 0;

  /** Whether to read the index: it's the source, it has finished a backfill, and its heartbeat is recent. */
  function useIndex(): Promise<boolean> {
    if (source !== 'index') return Promise.resolve(false);
    const at = now();
    if (status && at - status.at < STATUS_TTL_MS) return status.ready;
    const ready = db
      .get('garden_status?id=eq.1&select=heartbeat_at,backfilled_at')
      .then((rows) => isFresh(Array.isArray(rows) && isRecord(rows[0]) ? rows[0] : null, now()))
      .catch(() => false)
      .then((ok) => {
        if (ok !== wasReady) log({ event: ok ? 'garden_index_ready' : 'garden_index_stale' });
        wasReady = ok;
        return ok;
      });
    status = { at, ready };
    return ready;
  }

  function owner(actor: string): Promise<Owner | null> {
    // Handles are case-insensitive; DIDs are kept as asked (toOwner checks them exactly).
    const key = isDid(actor) ? actor : actor.toLowerCase();
    const cached = ownerCache.get(key);
    if (cached) return cached;
    const atpotato = actor === GARDEN_SUBJECT || key === ATPOTATO_OWNER.handle;
    // Someone the AppView doesn't know (or can't reach) may still be on the network:
    // Slingshot resolves them, with no name or avatar.
    const fromSlingshot = async (): Promise<Owner | null> => {
      const id = await resolveMiniDoc(doFetch, actor).catch(() => null);
      if (!id) return null;
      identityCache.set(id.did, Promise.resolve(id));
      return { did: id.did, handle: id.handle ?? id.did, displayName: null, avatar: null };
    };
    const pending = (async () => {
      let res: Response;
      try {
        res = await doFetch(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?${new URLSearchParams({ actor })}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        if (atpotato) return ATPOTATO_OWNER;
        const found = await fromSlingshot();
        if (found) return found;
        throw new AtprotoError('upstream', `profile fetch failed: ${(error as Error)?.name ?? 'Error'}`);
      }
      // The AppView answers an unknown actor with a 400 InvalidRequest, and a suspended or
      // taken-down one with its own error, which stays missing.
      if (res.status === 400 || res.status === 404) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        if (atpotato) return ATPOTATO_OWNER;
        return body?.error === 'InvalidRequest' || body?.error === undefined ? fromSlingshot() : null;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        if (atpotato) return ATPOTATO_OWNER;
        const found = await fromSlingshot();
        if (found) return found;
        throw new AtprotoError('upstream', `status ${res.status}`);
      }
      const found = toOwner(await res.json().catch(() => null), atpotato ? GARDEN_SUBJECT : actor);
      return found ?? (atpotato ? ATPOTATO_OWNER : null);
    })();
    ownerCache.set(key, pending);
    pending.catch(() => ownerCache.delete(key));
    return pending;
  }

  function identity(did: string): Promise<Identity> {
    const cached = identityCache.get(did);
    if (cached) return cached;
    const pending = resolveMiniDoc(doFetch, did)
      .catch(() => null)
      .then((found) => found ?? resolveDid(doFetch, did))
      .catch((error) => {
        if (did === GARDEN_SUBJECT) return { did, pds: 'https://pds.atpota.to', handle: 'atpota.to' };
        throw error;
      });
    identityCache.set(did, pending);
    pending.catch(() => identityCache.delete(did));
    return pending;
  }

  /** `owner`'s patches from the index, sorted, or null when the index can't say (or lacks `version`). */
  async function indexPatches(ownerDid: string, version?: string): Promise<Patch[] | null> {
    if (!(await useIndex())) return null;
    try {
      const params = new URLSearchParams({ collection: `eq.${PATCH_NSID}`, did: `eq.${ownerDid}`, select: 'uri,cid,record', order: 'uri.asc', limit: '1000' });
      const rows = await db.get(`garden_records?${params}`);
      if (!Array.isArray(rows)) throw new Error('not rows');
      const list = rows
        .map((r) => (isRecord(r) && typeof r.uri === 'string' && typeof r.cid === 'string' ? toPatch({ uri: r.uri, cid: r.cid, value: r.record }, ownerDid) : null))
        .filter((p): p is Patch => p !== null)
        // Someone's own garden is the one at "self"; atpotato's are all its seasons.
        .filter((p) => ownerDid === GARDEN_SUBJECT || p.rkey === OWN_PATCH_RKEY)
        .sort((a, b) => opensFrom(a).localeCompare(opensFrom(b)) || a.rkey.localeCompare(b.rkey));
      // The version its keeper just saved, not indexed yet: the network has it.
      if (version && !list.some((p) => p.cid === version)) return null;
      return list;
    } catch (error) {
      log({ event: 'garden_index_error', read: 'patches', error: (error as Error)?.message ?? 'Error' });
      return null;
    }
  }

  function patches(ownerDid: string, version?: string): Promise<Patch[]> {
    const cached = patchCache.get(ownerDid);
    if (cached && !version) return cached;
    const pending = (async () => {
      if (cached) {
        const had = await cached.catch(() => null);
        if (had?.some((p) => p.cid === version)) return had;
      }
      const indexed = await indexPatches(ownerDid, version);
      if (indexed) return indexed;
      if (ownerDid === GARDEN_SUBJECT) {
        const o = await identity(ownerDid);
        const records = await listRecords(doFetch, o.pds, ownerDid, PATCH_NSID, 3);
        const list = records.map((r) => toPatch(r, ownerDid)).filter((p): p is Patch => p !== null);
        return list.sort((a, b) => opensFrom(a).localeCompare(opensFrom(b)) || a.rkey.localeCompare(b.rkey));
      }
      // Someone's garden is one record, at "self". Slingshot has it; right after its keeper
      // changes it, Slingshot may not yet, so a version it doesn't have comes from the PDS.
      let entry = await getRecord(doFetch, ownerDid, PATCH_NSID, OWN_PATCH_RKEY);
      if (version && entry?.cid !== version) {
        const o = await identity(ownerDid);
        entry = await getRecordFromPds(doFetch, o.pds, ownerDid, PATCH_NSID, OWN_PATCH_RKEY);
      }
      const patch = entry ? toPatch(entry, ownerDid) : null;
      return patch ? [patch] : [];
    })();
    patchCache.set(ownerDid, pending);
    pending.catch(() => patchCache.delete(ownerDid));
    return pending;
  }

  async function blocked(ownerDid?: string): Promise<Set<string>> {
    const site = identity(GARDEN_SUBJECT).then((o) => ownerBlocks(doFetch, o));
    if (!ownerDid || ownerDid === GARDEN_SUBJECT) return site;
    const theirs = identity(ownerDid)
      .then((o) => ownerBlocks(doFetch, o))
      .catch(() => new Set<string>());
    const [a, b] = await Promise.all([site, theirs]);
    return new Set([...a, ...b]);
  }

  /** A patch's sprouts from the index, with what's settled about each. */
  async function indexSprouts(patch: Patch): Promise<Sprout[]> {
    const body = await db.rpc('garden_sprouts', { p_patches: [patch.uri] });
    if (!isRecord(body) || !Array.isArray(body.sprouts)) throw new Error('not sprouts');
    if (!isFresh(isRecord(body.status) ? body.status : null, now())) throw new IndexUnavailable('stale');
    const at = now();
    const out: Sprout[] = [];
    for (const row of body.sprouts) {
      if (!isRecord(row) || typeof row.did !== 'string' || !isDid(row.did) || typeof row.rkey !== 'string' || !RKEY_RE.test(row.rkey)) continue;
      if (row.uri !== `at://${row.did}/${SPROUT_NSID}/${row.rkey}`) continue;
      const s = toSprout({ cid: row.cid, value: row.value }, row.did, row.rkey, at);
      if (!s || s.patch !== patch.uri) continue;
      const { patch: _p, ...sprout } = s;
      out.push({ ...sprout, growth: toGrowth(row.growth) });
    }
    return out;
  }

  /** Every sprout record pointing at the patch (Constellation, then Slingshot per record). */
  async function networkSprouts(patch: Patch): Promise<Sprout[]> {
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
  }

  /** What's settled about each sprout, from the index; left unknown when it can't be read. */
  async function withGrowth(list: Sprout[]): Promise<Sprout[]> {
    if (!list.length || now() < growthDownUntil) return list;
    try {
      const body = await db.rpc('garden_growth_of', { p_flowers: list.map((s) => s.uri) });
      const found = isRecord(body) && isRecord(body.growth) ? body.growth : null;
      if (!found) throw new Error('not growth');
      return list.map((s) => ({ ...s, growth: toGrowth(found[s.uri]) }));
    } catch (error) {
      growthDownUntil = now() + 60_000;
      log({ event: 'garden_growth_error', error: (error as Error)?.message ?? 'Error' });
      return list;
    }
  }

  /** In shadow: the index's sprouts for the patch beside the network's, and any difference logged. */
  async function compare(patch: Patch, network: readonly Sprout[]): Promise<void> {
    try {
      const indexed = await indexSprouts(patch).catch((error) => {
        if (error instanceof IndexUnavailable) return null;
        throw error;
      });
      if (!indexed) {
        log({ event: 'garden_shadow', patch: patch.uri, fresh: false });
        return;
      }
      const a = new Set(network.map((s) => s.uri));
      const b = new Set(indexed.map((s) => s.uri));
      const missing = [...a].filter((u) => !b.has(u));
      const extra = [...b].filter((u) => !a.has(u));
      log({ event: missing.length || extra.length ? 'garden_shadow_diff' : 'garden_shadow', patch: patch.uri, network: a.size, index: b.size, missing: missing.slice(0, 5), extra: extra.slice(0, 5) });
    } catch (error) {
      log({ event: 'garden_shadow_error', patch: patch.uri, error: (error as Error)?.message ?? 'Error' });
    }
  }

  /** A patch's sprouts: from the index when it's the source and fresh, else from the network. */
  function sprouts(patch: Patch): Promise<Sprout[]> {
    const at = now();
    const ttl = source === 'index' ? INDEX_GARDEN_TTL_MS : isOpen(patch, at) ? OPEN_SPROUTS_TTL_MS : CLOSED_SPROUTS_TTL_MS;
    const hit = sproutCache.get(patch.uri);
    if (hit && at - hit.at < ttl) return hit.value;
    const value = (async () => {
      if (await useIndex()) {
        try {
          return await indexSprouts(patch);
        } catch (error) {
          log({ event: error instanceof IndexUnavailable ? 'garden_index_stale' : 'garden_index_error', read: 'sprouts', error: (error as Error)?.message ?? 'Error' });
        }
      }
      const found = await networkSprouts(patch);
      if (source === 'shadow') await compare(patch, found);
      return withGrowth(found);
    })();
    sproutCache.set(patch.uri, { at, value });
    value.catch(() => sproutCache.delete(patch.uri));
    return value;
  }

  async function authors(dids: readonly string[], ownerDid?: string): Promise<{ authors: Map<string, CommentAuthor>; blocked: Set<string> }> {
    const [found, blocks] = await Promise.all([dids.length ? commentAuthors(doFetch, [...new Set(dids)]) : new Map<string, CommentAuthor>(), blocked(ownerDid)]);
    return { authors: found, blocked: blocks };
  }

  async function planted(patch: Patch, all: readonly Patch[]): Promise<Planted[]> {
    const at = now();
    const open = isOpen(patch, at);
    let mine = await sprouts(patch);
    if (open && patch.planting !== 'many') {
      // One each across the garden's open patches, leaving out any that take many.
      const others = all.filter((p) => isOpen(p, at) && p.planting !== 'many');
      const everywhere = (await Promise.all(others.map((p) => (p.uri === patch.uri ? mine : sprouts(p).catch(() => []))))).flat();
      const keep = onePerAccount(everywhere, patch.planting === 'move' ? 'newest' : 'first');
      mine = mine.filter((s) => keep.has(s.uri));
    }
    const { authors: found, blocked: blocks } = await authors(
      mine.map((s) => s.did),
      patch.owner,
    );
    const shown = mine
      .filter((s) => {
        const author = found.get(s.did);
        return author && !blocks.has(s.did) && !author.handle.startsWith('did:');
      })
      .sort(byPlanting);
    return resolvePlots(shown, patch.cols * patch.rows).map((s) => ({
      did: s.did,
      rkey: s.rkey,
      uri: s.uri,
      cid: s.cid,
      handle: found.get(s.did)!.handle,
      ...reveal(s.kind, s.growth, stageFor(s.plantedAt, at, open)),
      plot: s.plot,
      plantedAt: s.plantedAt,
    }));
  }

  async function care(flower: Pick<Flower, 'did' | 'uri' | 'plantedAt'>, open: boolean, skip: ReadonlySet<string> = new Set()): Promise<Care> {
    const at = now();
    const grown = at >= Date.parse(flower.plantedAt) + GROW_DAYS * DAY_MS;
    const hit = careCache.get(flower.uri);
    // Care is fixed once the flower has grown; while its patch is open, lastTended still moves.
    const ttl = grown && !open ? FIXED_CARE_TTL_MS : CARE_TTL_MS;
    if (hit && at - hit.at < ttl) return hit;
    try {
      const refs = await backlinks(doFetch, flower.uri, TEND_NSID, '.subject.uri', MAX_TENDS);
      const fresh = careFrom(
        flower.did,
        flower.plantedAt,
        refs.filter((t) => !skip.has(t.did)),
        at,
      );
      // A grown flower's early tends can fall off the newest pages; never let its care drop.
      const settled = grown && hit && hit.care > fresh.care ? { ...fresh, care: hit.care, helpers: hit.helpers } : fresh;
      if (careCache.size >= 2000) careCache.delete(careCache.keys().next().value!);
      careCache.set(flower.uri, { ...settled, at });
      return settled;
    } catch {
      return hit ?? { care: 0, helpers: 0, lastTended: null };
    }
  }

  /** The tends pointing at these flowers, from the index, a few hundred flowers at a time. */
  async function indexTends(uris: readonly string[]): Promise<Map<string, TendRef[]>> {
    const out = new Map<string, TendRef[]>();
    const wanted = new Set(uris);
    for (let i = 0; i < uris.length; i += 200) {
      const rows = await db.rpc('garden_tends', { p_flowers: uris.slice(i, i + 200) });
      if (!Array.isArray(rows)) throw new Error('not tends');
      for (const row of rows) {
        if (!isRecord(row) || typeof row.flower !== 'string' || !wanted.has(row.flower)) continue;
        if (typeof row.did !== 'string' || !isDid(row.did) || typeof row.rkey !== 'string' || !RKEY_RE.test(row.rkey)) continue;
        const list = out.get(row.flower) ?? [];
        list.push({ did: row.did, rkey: row.rkey, action: typeof row.action === 'string' ? row.action : '' });
        out.set(row.flower, list);
      }
    }
    return out;
  }

  async function tends(uris: readonly string[]): Promise<Map<string, TendRef[]> | null> {
    if (!uris.length || !(await useIndex())) return null;
    try {
      return await indexTends(uris);
    } catch (error) {
      log({ event: 'garden_index_error', read: 'tends', error: (error as Error)?.message ?? 'Error' });
      return null;
    }
  }

  async function cares(flowers: ReadonlyArray<Pick<Flower, 'did' | 'uri' | 'plantedAt'>>, open: boolean, skip: ReadonlySet<string>): Promise<Map<string, Care>> {
    const indexed = await tends(flowers.map((f) => f.uri));
    if (indexed) {
      const at = now();
      return new Map(
        flowers.map((f) => [
          f.uri,
          careFrom(
            f.did,
            f.plantedAt,
            (indexed.get(f.uri) ?? []).filter((t) => !skip.has(t.did)),
            at,
          ),
        ]),
      );
    }
    const each = await mapPool(flowers, CONCURRENCY, (f) => care(f, open, skip));
    return new Map(flowers.map((f, i) => [f.uri, each[i]!]));
  }

  return { now, log, source, owner, identity, patches, planted, care, cares, tends, blocked, authors, fetch: doFetch };
}

/** The flowers with their care, and whether each is thirsty. Tending by `blocked` accounts doesn't count. */
export async function withCare(reader: GardenReader, flowers: readonly Planted[], open: boolean, blocked: ReadonlySet<string> = new Set()): Promise<Flower[]> {
  const cares = await reader.cares(flowers, open, blocked);
  return flowers.map((f) => {
    const c = cares.get(f.uri) ?? { care: 0, helpers: 0, lastTended: null };
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
  const { owner: _owner, ...rest } = patch;
  return { ...rest, open: isOpen(patch, now) };
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
  const fromIndex = reader.source === 'index';
  const cache = new TtlCache<Promise<Omit<Garden, 'owner'>>>(fromIndex ? INDEX_GARDEN_TTL_MS : GARDEN_TTL_MS, reader.now, 500);

  async function read(ownerDid: string, rkey: string | null, version: string | null): Promise<Omit<Garden, 'owner'>> {
    const all = await reader.patches(ownerDid, version ?? undefined).catch((error) => {
      // A DID document that isn't there: nobody to show.
      if (error instanceof AtprotoError && error.code === 'not_found') throw new NotFound();
      throw error;
    });
    const at = reader.now();
    if (rkey !== null && !all.some((p) => p.rkey === rkey)) throw new NotFound();
    if (all.length === 0) return { patch: null, patches: [], flowers: [], total: 0, seeds: fromIndex };
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
    const blocked = await reader.blocked(patch.owner).catch(() => new Set<string>());
    const flowers = await withCare(reader, planted.get(patch.uri) ?? [], open, blocked);
    return { patch: view(patch, at), patches: summaries, flowers, total: flowers.length, seeds: fromIndex };
  }

  function load(ownerDid: string, rkey: string | null, version: string | null): Promise<Omit<Garden, 'owner'>> {
    const key = `${ownerDid} ${rkey ?? ''} ${version ?? ''}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = read(ownerDid, rkey, version);
    cache.set(key, pending);
    pending.catch((error) => {
      cache.delete(key);
      if (!(error instanceof NotFound)) reader.log({ event: 'garden_error', owner: ownerDid, error: (error as Error)?.message ?? 'Error' });
    });
    return pending;
  }

  async function GET(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const actor = params.get('owner') ?? GARDEN_SUBJECT;
    const asked = params.get('patch');
    // ?v=<cid>: the version its keeper just saved, so the page shows it straight away.
    const version = params.get('v');
    const missing = () => jsonResponse(request, 404, { error: 'not_found' }, CACHE_MISSING);
    if (!isActor(actor) || (asked !== null && !RKEY_RE.test(asked)) || (version !== null && !CID_RE.test(version))) return missing();
    try {
      const owner = await reader.owner(actor);
      if (!owner || (owner.did !== GARDEN_SUBJECT && (await reader.blocked()).has(owner.did))) return missing();
      return jsonResponse(request, 200, { owner, ...(await load(owner.did, asked, version)) }, fromIndex ? CACHE_INDEX : CACHE_OK);
    } catch (error) {
      if (error instanceof NotFound) return missing();
      return jsonResponse(request, 503, { error: 'unavailable' }, 'no-store');
    }
  }

  return { GET, HEAD: GET, methodNotAllowed };
}
