/**
 * The flower patch's data, for the browser: the records, what /api/garden and /api/gardener
 * answer (checked field by field before anything uses them), and the writes.
 *
 *   to.atpota.garden.patch   a garden: atpotato's seasonal patches, or anyone's own (record
 *                            key OWN_PATCH_RKEY), { name, note?, season?, cols, rows,
 *                            opensAt?, closesAt?, planting?, createdAt }
 *   to.atpota.garden.sprout  a flower, in the planter's repo: { patch: { uri, cid }, kind, plot, createdAt }
 *                            (kind "seed": the garden decides what grows, and shows it at bloom)
 *   to.atpota.garden.tend    tending a flower, in the tender's repo: { subject: { uri, cid }, action, createdAt }
 *
 * Constants here must match server/garden.ts (tests/api-garden.test.ts checks them).
 * garden.ts (the home page's patch) re-exports everything.
 */

import type { Session } from '../blog/auth';
import { createRecord, parseRecordUri, putRecord, type RecordRef } from '../blog/repo';
import { FAMILIES, familyOf, isSpecies, SEED, type Family } from '../../shared/garden-rules.js';
import { FLOWER_KINDS, flowerSeed, seedVariant, variantFor, type FlowerKind, type Variant } from './flowers';

export { SEED };

export const PATCH_NSID = 'to.atpota.garden.patch';
export const SPROUT_NSID = 'to.atpota.garden.sprout';
export const TEND_NSID = 'to.atpota.garden.tend';
/** atpotato's DID: its repo holds the community patches, and its garden is the default. */
export const GARDEN_SUBJECT = 'did:plc:qntsxa2i4sb24noi45fx4np2';
export const GARDEN_ENDPOINT = '/api/garden';
export const GARDENER_ENDPOINT = '/api/gardener';
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];
export const TEND_ACTIONS = ['water', 'sun', 'talk'] as const;
export type TendAction = (typeof TEND_ACTIONS)[number];
/**
 * How many flowers each account grows in a garden's open patches: "one" (the default), which
 * stays where it's planted; "move", one that planting again moves; or "many".
 */
export const PLANTING = ['one', 'move', 'many'] as const;
export type Planting = (typeof PLANTING)[number];
/** Match server/garden.ts: patches are 4–24 plots across and 2–40 down. */
export const MIN_COLS = 4;
export const MIN_ROWS = 2;
export const MAX_COLS = 24;
export const MAX_ROWS = 40;
export const MAX_PLOTS = MAX_COLS * MAX_ROWS;
/** The record key of someone's own garden. */
export const OWN_PATCH_RKEY = 'self';
/** The sizes offered for your own garden. */
export const GARDEN_SIZES = { small: { cols: 6, rows: 4 }, medium: { cols: 8, rows: 6 }, large: { cols: 12, rows: 8 } } as const;
/** A garden's name and note, in graphemes. */
export const NOTE_MAX = 140;
export const NAME_MAX = 40;
/** Poe, whose repo keeps its notes about people: one MEMORY_NSID record each, keyed by their DID. */
export const POE_DID = 'did:plc:6qw63oash3jfnpykvpbwnq5z';
export const MEMORY_NSID = 'to.atpota.poe.memory';

export interface Owner {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
}

export interface Patch {
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
  /** The week it grew in, once it has bloomed, and the busiest apps outside Bluesky that week. */
  grew: (Weather & { apps: string[] }) | null;
}

/** A kind the garden picks (and a seed's, before anyone knows): the kinds people pick, and 'seed'. */
export type PickedKind = (typeof FLOWER_KINDS)[number];

export interface Flower {
  did: string;
  rkey: string;
  uri: string;
  cid: string;
  handle: string;
  /** What it is, or 'seed' until a seed blooms. */
  kind: FlowerKind | typeof SEED;
  /** A seed's family once it buds (a picked kind's from the start); null before. */
  family: Family | null;
  /** The weather it was planted in and grew in, when the garden has it. */
  weather: FlowerWeather | null;
  plot: number;
  plantedAt: string;
  /** 0 to 1: how well it was tended while it grew. */
  care: number;
  /** Neighbours who helped it grow (up to 3). */
  helpers: number;
  lastTended: string | null;
  thirsty: boolean;
}

export interface GardenView {
  /** Who the garden belongs to; null only from an answer that doesn't say (atpotato's, then). */
  owner: Owner | null;
  /** Null until the owner has a patch. */
  patch: Patch | null;
  patches: PatchSummary[];
  flowers: Flower[];
  /** Planting gives out seeds (the garden decides what grows), rather than letting you pick. */
  seeds: boolean;
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

export interface Tend {
  did: string;
  handle: string;
  action: TendAction;
  at: string;
}

export interface GardenerFlower extends Flower {
  patch: FlowerPatch;
  tends: Tend[];
}

export interface GivenTend {
  at: string;
  action: TendAction;
  flower: { uri: string; owner: { did: string; handle: string } };
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

export interface GardenerView {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
  garden: OwnGarden | null;
  flowers: GardenerFlower[];
  given: { total: number; helped: number; recent: GivenTend[] };
  /** The pets they've given Poe, and how many notes Poe keeps about them. */
  poe: { pets: number; notes: number };
}

/** A kind people pick themselves. */
export function isFlowerKind(value: unknown): value is PickedKind {
  return typeof value === 'string' && (FLOWER_KINDS as readonly string[]).includes(value);
}

/** What a flower can show as: any kind, or a seed. */
export function isKind(value: unknown): value is FlowerKind | typeof SEED {
  return value === SEED || isSpecies(value);
}

export function isTendAction(value: unknown): value is TendAction {
  return typeof value === 'string' && (TEND_ACTIONS as readonly string[]).includes(value);
}

export function isPlanting(value: unknown): value is Planting {
  return typeof value === 'string' && (PLANTING as readonly string[]).includes(value);
}

/** A whole plot number in a patch of `plots` plots (any patch, by default). */
export function isPlot(value: unknown, plots: number = MAX_PLOTS): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < plots;
}

/** A patch's at:// URI: in `owner`'s repo (atpotato's by default). */
export function patchUri(rkey: string, owner: string = GARDEN_SUBJECT): string {
  return `at://${owner}/${PATCH_NSID}/${rkey}`;
}

export function sproutRecord(patch: RecordRef, kind: PickedKind | typeof SEED, plot: number, now: Date): Record<string, unknown> {
  return { $type: SPROUT_NSID, patch: { uri: patch.uri, cid: patch.cid }, kind, plot, createdAt: now.toISOString() };
}

export function tendRecord(flowerUri: string, flowerCid: string, action: TendAction, now: Date): Record<string, unknown> {
  return { $type: TEND_NSID, subject: { uri: flowerUri, cid: flowerCid }, action, createdAt: now.toISOString() };
}

/** Tends a flower (anyone's): a to.atpota.garden.tend record in the reader's repo. */
export function tend(session: Session, flower: RecordRef, action: TendAction, now: Date = new Date()): Promise<RecordRef> {
  return createRecord(session, TEND_NSID, tendRecord(flower.uri, flower.cid, action, now));
}

/** A flower's look: from its DID and record key, fuller with care, shaped by the week it grew in. A seed's is only its leaves. */
export function flowerVariant(flower: Pick<Flower, 'did' | 'rkey' | 'kind' | 'care'> & { weather?: FlowerWeather | null }): Variant {
  const seed = flowerSeed(flower.did, flower.rkey);
  return flower.kind === SEED ? seedVariant(seed) : variantFor(flower.kind, seed, flower.care, flower.weather?.grew ?? null);
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
// Control and direction characters (zero-width joiners stay: emoji need them).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text for a garden's name or note: one line, no control characters, at most `max` graphemes. */
export function clipText(text: string, max: number): string {
  const one = text.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const g = segmenter ? Array.from(segmenter.segment(one), (s) => s.segment) : [...one];
  return g.length > max ? g.slice(0, max).join('').trim() : one;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

/**
 * Your own garden's record: a to.atpota.garden.patch with a name (NAME_MAX graphemes; "my
 * garden" if it's blank), an optional note (NOTE_MAX), a size inside the lexicon's limits,
 * how many flowers each visitor grows, and createdAt (kept from the old record when editing).
 * An empty note or closesAt, and the default planting, are left out.
 */
export function gardenRecord(
  opts: { name: string; note?: string | null; cols: number; rows: number; createdAt?: string; closesAt?: string | null; planting?: Planting },
  now: Date,
): Record<string, unknown> {
  const name = clipText(opts.name, NAME_MAX) || 'my garden';
  const note = opts.note ? clipText(opts.note, NOTE_MAX) : '';
  const created = opts.createdAt && Number.isFinite(Date.parse(opts.createdAt)) ? opts.createdAt : now.toISOString();
  return {
    $type: PATCH_NSID,
    name,
    ...(note ? { note } : {}),
    cols: clamp(opts.cols, MIN_COLS, MAX_COLS),
    rows: clamp(opts.rows, MIN_ROWS, MAX_ROWS),
    ...(opts.closesAt && Number.isFinite(Date.parse(opts.closesAt)) ? { closesAt: opts.closesAt } : {}),
    ...(opts.planting && opts.planting !== PLANTING[0] ? { planting: opts.planting } : {}),
    createdAt: created,
  };
}

/** Writes the reader's own garden (record key OWN_PATCH_RKEY), new or edited. */
export function saveGarden(session: Session, record: Record<string, unknown>): Promise<RecordRef> {
  return putRecord(session, PATCH_NSID, OWN_PATCH_RKEY, record);
}

/* ---------- checking answers ---------- */

const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;

function isSeason(value: unknown): value is Season {
  return typeof value === 'string' && (SEASONS as readonly string[]).includes(value);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** A date, null, or (for a field that isn't there) null; undefined for anything else. */
function maybeDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return isDate(value) ? value : undefined;
}

function isSize(cols: unknown, rows: unknown): boolean {
  return typeof cols === 'number' && typeof rows === 'number' && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= MAX_COLS && rows >= 1 && rows <= MAX_ROWS;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const isDidString = (value: unknown): value is string => typeof value === 'string' && /^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/.test(value);

function toOwner(v: unknown): Owner | null {
  const o = v as Owner;
  if (!isDidString(o?.did) || typeof o.handle !== 'string') return null;
  const displayName = typeof o.displayName === 'string' ? o.displayName : null;
  const avatar = typeof o.avatar === 'string' && /^https:\/\/[^\s"'<>]+$/.test(o.avatar) ? o.avatar : null;
  return { did: o.did, handle: o.handle, displayName, avatar };
}

function toPatch(v: unknown, owner: string): Patch | null {
  const p = v as Record<string, unknown>;
  if (typeof p?.rkey !== 'string' || !RKEY_RE.test(p.rkey) || p.uri !== patchUri(p.rkey, owner) || typeof p.cid !== 'string' || typeof p.name !== 'string') return null;
  if (!isSize(p.cols, p.rows) || typeof p.open !== 'boolean') return null;
  const opensAt = maybeDate(p.opensAt);
  const closesAt = maybeDate(p.closesAt);
  // An answer from before createdAt was sent dates the patch from when it opens.
  const createdAt = isDate(p.createdAt) ? p.createdAt : opensAt;
  if (opensAt === undefined || closesAt === undefined || !createdAt) return null;
  return {
    rkey: p.rkey,
    uri: p.uri,
    cid: p.cid,
    name: p.name,
    note: typeof p.note === 'string' && p.note !== '' ? p.note : null,
    season: isSeason(p.season) ? p.season : null,
    cols: p.cols as number,
    rows: p.rows as number,
    opensAt,
    closesAt,
    createdAt,
    // An answer from before planting was sent: the default.
    planting: isPlanting(p.planting) ? p.planting : PLANTING[0],
    open: p.open,
  };
}

function toSummary(v: unknown): PatchSummary | null {
  const p = v as Record<string, unknown>;
  const opensAt = maybeDate(p?.opensAt);
  const closesAt = maybeDate(p?.closesAt);
  if (typeof p?.rkey !== 'string' || !RKEY_RE.test(p.rkey) || typeof p.name !== 'string' || typeof p.open !== 'boolean') return null;
  if (!isPlot(p.planted, MAX_PLOTS + 1) || !isPlot(p.plots, MAX_PLOTS + 1) || opensAt === undefined || closesAt === undefined) return null;
  return { rkey: p.rkey, name: p.name, season: isSeason(p.season) ? p.season : null, open: p.open, planted: p.planted, plots: p.plots, opensAt, closesAt };
}

const isLevel = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4;

function toWeatherLevels(v: unknown): Weather | null {
  const w = v as Weather | null;
  return w && isLevel(w.wind) && isLevel(w.mix) ? { wind: w.wind, mix: w.mix } : null;
}

/** A flower's weather from an answer, checked; null for anything else (or an answer from before it was sent). */
export function toFlowerWeather(v: unknown): FlowerWeather | null {
  const w = v as { planted?: unknown; grew?: { apps?: unknown } | null } | null;
  if (!w || typeof w !== 'object') return null;
  const grew = toWeatherLevels(w.grew);
  const apps = Array.isArray(w.grew?.apps) ? w.grew.apps.filter((a): a is string => typeof a === 'string' && /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}$/.test(a)).slice(0, 7) : [];
  return { planted: toWeatherLevels(w.planted), grew: grew ? { ...grew, apps } : null };
}

/** A flower from an answer, checked, with family and weather filled in for an answer from before they were sent. */
function toFlower(v: unknown): Flower | null {
  if (!isFlower(v)) return null;
  const f = v as Flower & { family?: unknown; weather?: unknown };
  const family = (FAMILIES as readonly unknown[]).includes(f.family) ? (f.family as Family) : f.kind === SEED ? null : familyOf(f.kind);
  return { ...f, family, weather: toFlowerWeather(f.weather) };
}

function isFlower(v: unknown): v is Flower {
  const f = v as Flower;
  return (
    isDidString(f?.did) &&
    typeof f.rkey === 'string' &&
    typeof f.uri === 'string' &&
    parseRecordUri(f.uri)?.did === f.did &&
    typeof f.cid === 'string' &&
    typeof f.handle === 'string' &&
    isKind(f.kind) &&
    isPlot(f.plot) &&
    isDate(f.plantedAt) &&
    typeof f.care === 'number' &&
    f.care >= 0 &&
    f.care <= 1 &&
    typeof f.helpers === 'number' &&
    (f.lastTended === null || isDate(f.lastTended)) &&
    typeof f.thirsty === 'boolean'
  );
}

function isTend(v: unknown): v is Tend {
  const t = v as Tend;
  return isDidString(t?.did) && typeof t.handle === 'string' && isTendAction(t.action) && isDate(t.at);
}

/** { did, handle } for a garden's owner; atpotato when an older answer leaves it out. */
function toOwnerRef(v: unknown): { did: string; handle: string } | null {
  if (v === undefined) return { did: GARDEN_SUBJECT, handle: 'atpota.to' };
  const o = v as { did?: unknown; handle?: unknown };
  return isDidString(o?.did) && typeof o.handle === 'string' ? { did: o.did, handle: o.handle } : null;
}

function toFlowerPatch(v: unknown): FlowerPatch | null {
  const p = v as Record<string, unknown>;
  const owner = toOwnerRef(p?.owner);
  if (!owner || typeof p.rkey !== 'string' || !RKEY_RE.test(p.rkey) || p.uri !== patchUri(p.rkey, owner.did) || typeof p.name !== 'string') return null;
  if (typeof p.open !== 'boolean' || !isSize(p.cols, p.rows)) return null;
  return { rkey: p.rkey, uri: p.uri, name: p.name, season: isSeason(p.season) ? p.season : null, open: p.open, cols: p.cols as number, rows: p.rows as number, owner };
}

function toOwnGarden(v: unknown, did: string): OwnGarden | null {
  const g = v as Record<string, unknown>;
  if (typeof g?.rkey !== 'string' || !RKEY_RE.test(g.rkey) || g.uri !== patchUri(g.rkey, did) || typeof g.name !== 'string') return null;
  if (typeof g.open !== 'boolean' || !isCount(g.plots) || !isCount(g.planted)) return null;
  return { rkey: g.rkey, uri: g.uri, name: g.name, note: typeof g.note === 'string' && g.note !== '' ? g.note : null, open: g.open, plots: g.plots, planted: g.planted };
}

function toGiven(v: unknown): GardenerView['given'] {
  const g = v as { total?: unknown; helped?: unknown; recent?: unknown } | undefined;
  const recent = Array.isArray(g?.recent)
    ? g.recent.filter((r): r is GivenTend => {
        const t = r as GivenTend;
        return isDate(t?.at) && isTendAction(t.action) && typeof t.flower?.uri === 'string' && toOwnerRef(t.flower.owner) !== null && t.flower.owner !== undefined;
      })
    : [];
  return { total: isCount(g?.total) ? g.total : 0, helped: isCount(g?.helped) ? g.helped : 0, recent };
}

function toPoe(v: unknown): GardenerView['poe'] {
  const p = v as { pets?: unknown; notes?: unknown } | undefined;
  return { pets: isCount(p?.pets) ? p.pets : 0, notes: isCount(p?.notes) ? p.notes : 0 };
}

/* ---------- reading ---------- */

/**
 * A garden from /api/garden, checked; null when it didn't load (or isn't there). By
 * default atpotato's community garden; `owner` (a DID or handle) for anyone's, and `rkey`
 * for one of its patches (a bare string means an rkey of atpotato's). `version` is the CID
 * its keeper just saved, so the answer has it (and isn't an older cached one).
 */
export async function fetchGarden(fetchImpl: typeof fetch = fetch, opts: string | { owner?: string; rkey?: string; version?: string } = {}): Promise<GardenView | null> {
  const { owner, rkey, version } = typeof opts === 'string' ? { owner: undefined, rkey: opts, version: undefined } : opts;
  try {
    const params = new URLSearchParams();
    if (owner) params.set('owner', owner);
    if (rkey) params.set('patch', rkey);
    if (version) params.set('v', version);
    const query = params.toString();
    const res = await fetchImpl(query ? `${GARDEN_ENDPOINT}?${query}` : GARDEN_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { owner?: unknown; patch?: unknown; patches?: unknown; flowers?: unknown; seeds?: unknown };
    if (!Array.isArray(body?.flowers) || !Array.isArray(body.patches)) return null;
    const who = body.owner === undefined ? null : toOwner(body.owner);
    if (body.owner !== undefined && !who) return null;
    // Without an owner in the answer only atpotato's own garden can be checked.
    if (!who && owner && owner !== GARDEN_SUBJECT) return null;
    const patch = body.patch == null ? null : toPatch(body.patch, who?.did ?? GARDEN_SUBJECT);
    const plots = patch ? patch.cols * patch.rows : 0;
    return {
      owner: who,
      patch,
      patches: body.patches.map(toSummary).filter((p): p is PatchSummary => p !== null),
      flowers: patch ? body.flowers.map(toFlower).filter((f): f is Flower => f !== null && f.plot < plots) : [],
      seeds: body.seeds === true,
    };
  } catch {
    return null;
  }
}

/**
 * One person from /api/gardener (for their garden page), checked: 'missing' when there is
 * nobody by that DID or handle to show, null when it didn't load.
 */
export async function fetchGardener(actor: string, fetchImpl: typeof fetch = fetch): Promise<GardenerView | 'missing' | null> {
  try {
    const res = await fetchImpl(`${GARDENER_ENDPOINT}?${new URLSearchParams({ actor })}`, { headers: { accept: 'application/json' } });
    if (res.status === 404 || res.status === 400) return 'missing';
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (!isDidString(body?.did) || typeof body.handle !== 'string' || !Array.isArray(body.flowers)) return null;
    // The answer must be for who was asked about.
    if (actor.startsWith('did:') ? body.did !== actor : body.handle.toLowerCase() !== actor.toLowerCase()) return null;
    const did = body.did;
    const flowers: GardenerFlower[] = [];
    for (const f of body.flowers) {
      const g = f as Record<string, unknown>;
      const patch = toFlowerPatch(g?.patch);
      const flower = toFlower(g);
      if (!flower || !patch || !Array.isArray(g.tends) || flower.plot >= patch.cols * patch.rows) continue;
      flowers.push({ ...flower, patch, tends: g.tends.filter(isTend) });
    }
    const owner = toOwner(body);
    return {
      did,
      handle: body.handle,
      displayName: owner?.displayName ?? null,
      avatar: owner?.avatar ?? null,
      garden: body.garden == null ? null : toOwnGarden(body.garden, did),
      flowers,
      given: toGiven(body.given),
      poe: toPoe(body.poe),
    };
  } catch {
    return null;
  }
}
