/**
 * Writes the flower patch's seasonal patches (to.atpota.garden.patch) to atpota.to's repo:
 * the current season's and the next three, so there is always one open, and the site never
 * needs to write anything itself.
 *
 *   npm run garden:patches -- --dry-run                    show what would be written, touch nothing
 *   ATP_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run garden:patches
 *   ATP_APP_PASSWORD=... npm run garden:patches -- --overflow 2026-autumn
 *                                                          a second patch for a season that filled up
 *
 * Seasons are the northern meteorological ones: spring from 1 March, summer from 1 June,
 * autumn from 1 September and winter from 1 December, each open until the next starts
 * (00:00 UTC). Winter is named for the year it starts in ("winter 2026" runs December 2026
 * to February 2027). Each patch is PATCH_COLS × PATCH_ROWS plots, keyed "2026-autumn";
 * overflow patches are "2026-autumn-2", "2026-autumn-3" and so on, with the same dates.
 *
 * ATP_IDENTIFIER defaults to atpota.to. Use an app password (bsky.app -> settings ->
 * privacy and security -> app passwords), never the main one.
 *
 * Safe to run again: a patch that already matches is left alone (createdAt aside), and a
 * changed one keeps its createdAt.
 */

import { GARDEN_SUBJECT, PATCH_NSID, SEASONS, type Season } from '../server/garden.js';
import { canonical, pdsFor, xrpc } from './publish-guides.js';

type Fetch = typeof fetch;

export const PATCH_COLS = 12;
export const PATCH_ROWS = 8;
/** The month each season starts in (0 = January). */
const STARTS: Record<Season, number> = { spring: 2, summer: 5, autumn: 8, winter: 11 };

export interface PatchRecord {
  $type: typeof PATCH_NSID;
  name: string;
  season: Season;
  cols: number;
  rows: number;
  opensAt: string;
  closesAt: string;
  createdAt: string;
}

export interface PlannedPatch {
  rkey: string;
  record: PatchRecord;
}

export interface SeasonSpan {
  season: Season;
  /** The year it starts in. */
  year: number;
  opensAt: Date;
  closesAt: Date;
}

/** The season `year`'s `season` starts in, with its dates. */
export function seasonSpan(season: Season, year: number): SeasonSpan {
  const opensAt = new Date(Date.UTC(year, STARTS[season], 1));
  const next = SEASONS[(SEASONS.indexOf(season) + 1) % SEASONS.length]!;
  const closesAt = new Date(Date.UTC(season === 'winter' ? year + 1 : year, STARTS[next], 1));
  return { season, year, opensAt, closesAt };
}

/** The season `date` falls in. */
export function seasonAt(date: Date): SeasonSpan {
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  if (month < STARTS.spring) return seasonSpan('winter', year - 1);
  if (month < STARTS.summer) return seasonSpan('spring', year);
  if (month < STARTS.autumn) return seasonSpan('summer', year);
  if (month < STARTS.winter) return seasonSpan('autumn', year);
  return seasonSpan('winter', year);
}

export function nextSeason(span: SeasonSpan): SeasonSpan {
  return seasonAt(span.closesAt);
}

function record(span: SeasonSpan, name: string, createdAt: Date): PatchRecord {
  return {
    $type: PATCH_NSID,
    name,
    season: span.season,
    cols: PATCH_COLS,
    rows: PATCH_ROWS,
    opensAt: span.opensAt.toISOString(),
    closesAt: span.closesAt.toISOString(),
    createdAt: createdAt.toISOString(),
  };
}

/** The patches for the season `now` falls in and the `count - 1` after it. */
export function planPatches(now: Date, count = 4): PlannedPatch[] {
  const out: PlannedPatch[] = [];
  let span = seasonAt(now);
  for (let i = 0; i < count; i++) {
    out.push({ rkey: `${span.year}-${span.season}`, record: record(span, `${span.season} ${span.year}`, now) });
    span = nextSeason(span);
  }
  return out;
}

const BASE_RE = /^(\d{4})-(spring|summer|autumn|winter)(?:-(\d+))?$/;

/** The next overflow patch for a season's patch ("2026-autumn" -> "2026-autumn-2", ...); null for a key that isn't one. */
export function planOverflow(rkey: string, existing: ReadonlySet<string>, now: Date): PlannedPatch | null {
  const m = BASE_RE.exec(rkey);
  if (!m) return null;
  const span = seasonSpan(m[2] as Season, Number(m[1]));
  const base = `${m[1]}-${m[2]}`;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return { rkey: `${base}-${n}`, record: record(span, `${span.season} ${span.year} (${n})`, now) };
}

/** Same patch, ignoring createdAt. */
export function samePatch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = ({ createdAt: _c, ...rest }: Record<string, unknown>) => rest;
  return canonical(strip(a)) === canonical(strip(b));
}

export interface OpenPatchesDeps {
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
  log?: (line: string) => void;
  now?: () => Date;
}

async function existingPatches(doFetch: Fetch, pds: string): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ repo: GARDEN_SUBJECT, collection: PATCH_NSID, limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const { status, body } = await xrpc<{ records?: { uri?: string; value?: Record<string, unknown> }[]; cursor?: string }>(doFetch, `${pds}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (status !== 200 || !Array.isArray(body?.records)) throw new Error(`could not list the patches (${status})`);
    for (const r of body.records) if (typeof r.uri === 'string' && r.value) out.set(r.uri.slice(r.uri.lastIndexOf('/') + 1), r.value);
    if (!body.cursor || body.records.length === 0) break;
    cursor = body.cursor;
  }
  return out;
}

export async function main(args: string[], deps: OpenPatchesDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = (deps.now ?? (() => new Date()))();
  const dryRun = args.includes('--dry-run');
  const overflowAt = args.indexOf('--overflow');
  const overflow = overflowAt !== -1 ? (args[overflowAt + 1] ?? '') : null;

  let pds: string | null = null;
  let existing = new Map<string, Record<string, unknown>>();
  try {
    pds = await pdsFor(doFetch, GARDEN_SUBJECT);
    existing = await existingPatches(doFetch, pds);
  } catch (error) {
    if (!dryRun) {
      log(String((error as Error)?.message ?? error));
      return 1;
    }
    log(`(couldn't read the patches already there: ${(error as Error)?.message ?? error})`);
  }

  let planned: PlannedPatch[];
  if (overflow !== null) {
    if (!existing.has(overflow) && !dryRun) {
      log(`there is no patch ${overflow} to add an overflow patch to`);
      return 1;
    }
    const extra = planOverflow(overflow, new Set(existing.keys()), now);
    if (!extra) {
      log(`--overflow takes a season's patch, like 2026-autumn (got "${overflow}")`);
      return 1;
    }
    planned = [extra];
  } else {
    planned = planPatches(now);
  }

  log(`${dryRun ? 'dry run: ' : ''}${planned.length} patch${planned.length === 1 ? '' : 'es'} for atpota.to (${GARDEN_SUBJECT})`);
  for (const p of planned) {
    const current = existing.get(p.rkey);
    const what = !current ? 'new      ' : samePatch(current, p.record as unknown as Record<string, unknown>) ? 'unchanged' : 'changed  ';
    log(`  ${what}  ${p.rkey}  "${p.record.name}"  ${p.record.cols}×${p.record.rows}  ${p.record.opensAt.slice(0, 10)} to ${p.record.closesAt.slice(0, 10)}`);
  }
  if (dryRun) return 0;

  const password = env.ATP_APP_PASSWORD?.trim();
  if (!password) {
    log('set ATP_APP_PASSWORD (an app password for atpota.to), or pass --dry-run');
    return 1;
  }
  const identifier = env.ATP_IDENTIFIER?.trim() || 'atpota.to';
  const session = await xrpc<{ accessJwt?: string; did?: string; message?: string }>(doFetch, `${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (session.status !== 200 || !session.body?.accessJwt) {
    log(`sign-in failed (${session.status}): ${session.body?.message ?? 'no message'}`);
    return 1;
  }
  if (session.body.did !== GARDEN_SUBJECT) {
    log(`signed in as ${session.body.did}, but the patches live in ${GARDEN_SUBJECT}; nothing written`);
    return 1;
  }
  const auth = { authorization: `Bearer ${session.body.accessJwt}` };

  for (const p of planned) {
    const current = existing.get(p.rkey);
    if (current && samePatch(current, p.record as unknown as Record<string, unknown>)) continue;
    const value = current && typeof current.createdAt === 'string' ? { ...p.record, createdAt: current.createdAt } : p.record;
    const put = await xrpc<{ uri?: string; message?: string }>(doFetch, `${pds}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ repo: GARDEN_SUBJECT, collection: PATCH_NSID, rkey: p.rkey, record: value }),
    });
    if (put.status !== 200) {
      log(`writing ${p.rkey} failed (${put.status}): ${put.body?.message ?? ''}`);
      return 1;
    }
    log(`${current ? 'updated' : 'created'}  at://${GARDEN_SUBJECT}/${PATCH_NSID}/${p.rkey}`);
  }
  log('');
  log('check it: https://atpota.to/api/garden');
  return 0;
}
