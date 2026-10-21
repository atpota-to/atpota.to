/**
 * /api/leaderboard: the garden's leaderboards, on the community garden page. Who has planted
 * the most flowers, done the most tending for other people's flowers, given Poe the most
 * pets, found the most kinds, and had the most visitors to their own garden.
 *
 * The counting is the garden index's (garden_leaderboard, garden/supabase/garden_leaderboard.sql),
 * read with the publishable key whatever GARDEN_SOURCE says, like what's settled about each
 * flower: nothing else can add up the whole network at once. In short:
 *
 *   flowers   flowers in the gardens the site shows; one a patch, unless the patch takes many
 *   tending   other people's flowers tended, each counting once a day
 *   pets      their to.atpota.poe.pets count (their own number in their own repo)
 *   kinds     kinds they've grown to bloom, as the field guide counts them found
 *   visitors  other people who have planted in their own garden
 *
 * Here the boards are moderated the garden's way: an account with no profile view, one
 * carrying a HIDDEN_LABELS label, one without a working handle, or one atpotato blocks on
 * Bluesky is left off, and so is atpotato itself (the community garden is its own). What's
 * left is ranked, ties sharing a rank (1, 2, 2, 4).
 *
 *   GET /api/leaderboard  ->  { boards: { flowers, tending, pets, kinds, visitors }, updatedAt }
 *     each board  up to MAX_SHOWN, most first: [{ rank, did, handle, avatar, n }] (flowers also
 *                 has gardens, how many people's gardens they're in; tending neighbours, how
 *                 many people's flowers they've tended)
 *     updatedAt   the index's heartbeat
 *   503 while the index hasn't finished its first backfill, or can't be read.
 *
 * Fresh for two minutes at the CDN, and a minute in each instance.
 */

import { TtlCache } from './blog/atproto.js';
import { isDid } from './blog/config.js';
import { createGardenReader, GARDEN_SUBJECT, jsonResponse, methodNotAllowed, type GardenDeps, type GardenHandlers } from './garden.js';
import { isRecord, iso, num, supabase as openSupabase } from './supabase-public.js';

export const BOARDS = ['flowers', 'tending', 'pets', 'kinds', 'visitors'] as const;
export type Board = (typeof BOARDS)[number];
/** Shown on each board, after moderation. */
export const MAX_SHOWN = 20;
/** Asked of the index for each board, so moderation leaves enough. */
export const MAX_ASKED = 40;
export const LEADERBOARD_TTL_MS = 60_000;
export const CACHE_LEADERBOARD = 'public, max-age=0, s-maxage=120, stale-while-revalidate=600';

export interface Leader {
  rank: number;
  did: string;
  handle: string;
  avatar: string | null;
  n: number;
  /** flowers: how many people's gardens they're in. */
  gardens?: number;
  /** tending: how many people's flowers they've tended. */
  neighbours?: number;
}

export interface Leaderboard {
  boards: Record<Board, Leader[]>;
  updatedAt: string | null;
}

/** A row the index answers: { did, n } and the board's own count, checked; null otherwise. */
export interface Entry {
  did: string;
  n: number;
  gardens?: number;
  neighbours?: number;
}

const isWhole = (x: unknown): boolean => {
  const n = num(x);
  return Number.isSafeInteger(n) && n >= 0;
};

export function toEntry(board: Board, value: unknown): Entry | null {
  if (!isRecord(value) || typeof value.did !== 'string' || !isDid(value.did) || !isWhole(value.n) || num(value.n) < 1) return null;
  const entry: Entry = { did: value.did, n: num(value.n) };
  if (board === 'flowers') entry.gardens = isWhole(value.gardens) ? num(value.gardens) : 0;
  if (board === 'tending') entry.neighbours = isWhole(value.neighbours) ? num(value.neighbours) : 0;
  return entry;
}

/** Most first (ties as the index had them); each with its rank, equal counts sharing one. */
export function ranked<T extends { n: number }>(rows: readonly T[]): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  let rank = 0;
  return sorted.map((r, i) => {
    if (i === 0 || r.n !== sorted[i - 1]!.n) rank = i + 1;
    return { ...r, rank };
  });
}

class Unavailable extends Error {}

export function createLeaderboardHandlers(deps: GardenDeps = {}): GardenHandlers {
  const reader = createGardenReader(deps);
  const db = openSupabase(deps.env ?? process.env, reader.fetch);
  const cache = new TtlCache<Promise<Leaderboard>>(LEADERBOARD_TTL_MS, reader.now, 1);

  async function read(): Promise<Leaderboard> {
    const body = await db.rpc('garden_leaderboard', { p_limit: MAX_ASKED });
    if (!isRecord(body)) throw new Error('not a leaderboard');
    const status = isRecord(body.status) ? body.status : null;
    // Before its first backfill the index doesn't have everyone yet.
    if (!iso(status?.backfilled_at)) throw new Unavailable('not backfilled');
    const entries = Object.fromEntries(
      BOARDS.map((b) => [b, (Array.isArray(body[b]) ? body[b] : []).map((v) => toEntry(b, v)).filter((e): e is Entry => e !== null)]),
    ) as Record<Board, Entry[]>;
    const dids = [...new Set(BOARDS.flatMap((b) => entries[b].map((e) => e.did)))].filter((d) => d !== GARDEN_SUBJECT);
    const { authors, blocked } = await reader.authors(dids);
    const boards = Object.fromEntries(
      BOARDS.map((b) => {
        const shown = entries[b].flatMap((e) => {
          const who = authors.get(e.did);
          if (e.did === GARDEN_SUBJECT || !who || blocked.has(e.did) || who.handle.startsWith('did:')) return [];
          return [{ ...e, handle: who.handle, avatar: who.avatar }];
        });
        return [b, ranked(shown.slice(0, MAX_SHOWN))];
      }),
    ) as Record<Board, Leader[]>;
    return { boards, updatedAt: iso(status?.heartbeat_at) };
  }

  function load(): Promise<Leaderboard> {
    const cached = cache.get('all');
    if (cached) return cached;
    const pending = read();
    cache.set('all', pending);
    pending.catch((error) => {
      cache.delete('all');
      reader.log({ event: error instanceof Unavailable ? 'leaderboard_unavailable' : 'leaderboard_error', error: (error as Error)?.message ?? 'Error' });
    });
    return pending;
  }

  async function GET(request: Request): Promise<Response> {
    try {
      return jsonResponse(request, 200, await load(), CACHE_LEADERBOARD);
    } catch {
      return jsonResponse(request, 503, { error: 'unavailable' }, 'no-store');
    }
  }

  return { GET, HEAD: GET, methodNotAllowed };
}
