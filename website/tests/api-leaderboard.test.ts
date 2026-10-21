import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api/leaderboard.js';
import { resetDiscussionCaches } from '../server/blog/discussion.js';
import { GARDEN_SUBJECT } from '../server/garden.js';
import { BOARDS, CACHE_LEADERBOARD, createLeaderboardHandlers, LEADERBOARD_TTL_MS, MAX_ASKED, MAX_SHOWN, ranked, toEntry } from '../server/leaderboard.js';
import { SUPABASE_URL } from '../server/supabase-public.js';
import { BOARDS as CLIENT_BOARDS, fetchLeaderboard, LEADERBOARD_ENDPOINT } from '../src/scripts/garden.js';
import { did, fakeFetch, json, type Net } from './garden-net.js';

// /api/leaderboard: what the garden index counted (garden_leaderboard, stubbed here; the SQL
// itself is garden/supabase/garden_leaderboard.sql), moderated and ranked. did(4) carries a
// hidden label, atpotato blocks did(5), did(6) has no handle that works, and did(7) has no
// profile at all.

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

const net = (): Net => ({
  patches: {},
  records: {},
  profiles: [
    { did: did(1), handle: 'one.test', displayName: 'One', avatar: 'https://cdn.bsky.app/one.jpg' },
    { did: did(2), handle: 'two.test' },
    { did: did(3), handle: 'three.test' },
    { did: did(4), handle: 'four.test', labels: [{ val: '!hide' }] },
    { did: did(5), handle: 'five.test' },
    { did: did(6), handle: 'handle.invalid' },
    { did: did(8), handle: 'Eight.Test' },
    { did: GARDEN_SUBJECT, handle: 'atpota.to' },
  ],
  blocks: [did(5)],
});

const board = () => ({
  status: { id: 1, heartbeat_at: '2026-10-21T11:59:40+00:00', stream_at: '2026-10-21T11:59:00+00:00', backfilled_at: '2026-10-21T06:00:00+00:00' },
  flowers: [
    { did: did(4), n: 30, gardens: 3 },
    { did: did(1), n: 12, gardens: 4 },
    { did: GARDEN_SUBJECT, n: 9, gardens: 1 },
    { did: did(2), n: 5, gardens: 2 },
    { did: did(3), n: 5, gardens: 1 },
    { did: did(8), n: 2, gardens: 1 },
  ],
  tending: [
    { did: did(5), n: 40, neighbours: 9 },
    { did: did(2), n: 7, neighbours: 3 },
    { did: did(7), n: 6, neighbours: 2 },
    { did: did(1), n: 1, neighbours: 1 },
  ],
  pets: [
    { did: did(6), n: 9000 },
    { did: did(3), n: '1500' },
    { did: did(1), n: 108 },
    { did: 'not a did', n: 50 },
    { did: did(2), n: 0 },
    { did: did(8), n: 2.5 },
  ],
  kinds: [{ did: did(1), n: 4 }],
  visitors: 'nope',
});

interface Rig {
  handlers: ReturnType<typeof createLeaderboardHandlers>;
  asked: Array<Record<string, unknown>>;
  logs: Array<{ event: string }>;
  setNow: (t: number) => void;
}

function rig(answer: () => unknown = board, status = 200): Rig {
  const asked: Array<Record<string, unknown>> = [];
  const logs: Array<{ event: string }> = [];
  const n = net();
  const base = fakeFetch(n);
  let now = NOW;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === SUPABASE_URL && url.pathname === '/rest/v1/rpc/garden_leaderboard') {
      asked.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return status === 200 ? json(answer()) : json({ message: 'nope' }, status);
    }
    return base(input, init);
  }) as typeof fetch;
  const handlers = createLeaderboardHandlers({ fetch: fetchImpl, now: () => now, log: (f) => logs.push(f) });
  return { handlers, asked, logs, setNow: (t) => (now = t) };
}

const get = (r: Rig) => r.handlers.GET(new Request('https://atpota.to/api/leaderboard'));

beforeEach(() => resetDiscussionCaches());

describe('/api/leaderboard', () => {
  it('ranks most first, ties sharing a rank', () => {
    expect(ranked([{ n: 3 }, { n: 9 }, { n: 3 }, { n: 1 }, { n: 9 }]).map((r) => [r.n, r.rank])).toEqual([
      [9, 1],
      [9, 1],
      [3, 3],
      [3, 3],
      [1, 5],
    ]);
    expect(ranked([])).toEqual([]);
  });

  it('reads rows the index answers: a DID, a whole count of at least one, and the board’s own count', () => {
    expect(toEntry('flowers', { did: did(1), n: 3, gardens: 2 })).toEqual({ did: did(1), n: 3, gardens: 2 });
    expect(toEntry('flowers', { did: did(1), n: 3 })).toEqual({ did: did(1), n: 3, gardens: 0 });
    expect(toEntry('tending', { did: did(1), n: '7', neighbours: 2 })).toEqual({ did: did(1), n: 7, neighbours: 2 });
    expect(toEntry('pets', { did: did(1), n: 108, gardens: 5 })).toEqual({ did: did(1), n: 108 });
    expect(toEntry('pets', { did: did(1), n: 0 })).toBeNull();
    expect(toEntry('pets', { did: did(1), n: 1.5 })).toBeNull();
    expect(toEntry('pets', { did: did(1), n: -2 })).toBeNull();
    expect(toEntry('pets', { did: 'someone', n: 2 })).toBeNull();
    expect(toEntry('pets', null)).toBeNull();
  });

  it('every board, moderated the garden’s way and ranked', async () => {
    const r = rig();
    const res = await get(r);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_LEADERBOARD);
    expect(r.asked).toEqual([{ p_limit: MAX_ASKED }]);
    const body = await res.json();
    expect(Object.keys(body.boards)).toEqual([...BOARDS]);
    expect(body.updatedAt).toBe('2026-10-21T11:59:40.000Z');
    // hidden did(4) and atpotato itself are off; the two on 5 share third
    expect(body.boards.flowers).toEqual([
      { rank: 1, did: did(1), handle: 'one.test', avatar: 'https://cdn.bsky.app/one.jpg', n: 12, gardens: 4 },
      { rank: 2, did: did(2), handle: 'two.test', avatar: null, n: 5, gardens: 2 },
      { rank: 2, did: did(3), handle: 'three.test', avatar: null, n: 5, gardens: 1 },
      { rank: 4, did: did(8), handle: 'eight.test', avatar: null, n: 2, gardens: 1 },
    ]);
    // blocked did(5) and did(7), who has no profile, are off
    expect(body.boards.tending).toEqual([
      { rank: 1, did: did(2), handle: 'two.test', avatar: null, n: 7, neighbours: 3 },
      { rank: 2, did: did(1), handle: 'one.test', avatar: 'https://cdn.bsky.app/one.jpg', n: 1, neighbours: 1 },
    ]);
    // did(6), with no working handle, is off, and so are rows that aren't counts
    expect(body.boards.pets.map((l: { did: string; n: number; rank: number }) => [l.rank, l.did, l.n])).toEqual([
      [1, did(3), 1500],
      [2, did(1), 108],
    ]);
    expect(body.boards.kinds).toEqual([{ rank: 1, did: did(1), handle: 'one.test', avatar: 'https://cdn.bsky.app/one.jpg', n: 4 }]);
    expect(body.boards.visitors).toEqual([]);
  });

  it(`shows ${MAX_SHOWN} a board at most`, async () => {
    const many = Array.from({ length: MAX_ASKED }, (_, i) => ({ did: did(1), n: MAX_ASKED - i }));
    const r = rig(() => ({ ...board(), kinds: many }));
    const body = await (await get(r)).json();
    expect(body.boards.kinds).toHaveLength(MAX_SHOWN);
  });

  it('is unavailable before the index has finished its first backfill, or when it can’t be read', async () => {
    const early = rig(() => ({ ...board(), status: { id: 1, heartbeat_at: '2026-10-21T11:59:40+00:00', backfilled_at: null } }));
    const res = await get(early);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(early.logs.map((l) => l.event)).toContain('leaderboard_unavailable');
    const down = rig(board, 500);
    expect((await get(down)).status).toBe(503);
    expect(down.logs.map((l) => l.event)).toContain('leaderboard_error');
    expect((await get(rig(() => [1, 2, 3]))).status).toBe(503);
  });

  it('asks the index once a minute, and again after a failure', async () => {
    const r = rig();
    await get(r);
    await get(r);
    expect(r.asked).toHaveLength(1);
    r.setNow(NOW + LEADERBOARD_TTL_MS + 1);
    await get(r);
    expect(r.asked).toHaveLength(2);
    let fail = true;
    const flaky = rig(() => {
      if (fail) {
        fail = false;
        return 'nope';
      }
      return board();
    });
    expect((await get(flaky)).status).toBe(503);
    expect((await get(flaky)).status).toBe(200);
  });

  it('answers HEAD without a body, and nothing else', async () => {
    const r = rig();
    const head = await r.handlers.HEAD(new Request('https://atpota.to/api/leaderboard', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const res = await api[method](new Request('https://atpota.to/api/leaderboard', { method }));
      expect(res.status).toBe(405);
    }
  });

  it('the page reads what it answers, and checks it', async () => {
    expect(CLIENT_BOARDS).toEqual(BOARDS);
    const r = rig();
    const served = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(LEADERBOARD_ENDPOINT);
      return get(r);
    }) as typeof fetch;
    const view = await fetchLeaderboard(served);
    expect(view?.boards.flowers.map((l) => [l.rank, l.handle, l.n, l.gardens])).toEqual([
      [1, 'one.test', 12, 4],
      [2, 'two.test', 5, 2],
      [2, 'three.test', 5, 1],
      [4, 'eight.test', 2, 1],
    ]);
    expect(view?.boards.tending[0]).toEqual({ rank: 1, did: did(2), handle: 'two.test', avatar: null, n: 7, neighbours: 3 });
    // junk in an answer is left out, row by row; a broken answer is no leaderboard
    const answer = (body: unknown, status = 200) => (async () => json(body, status)) as unknown as typeof fetch;
    const junk = await fetchLeaderboard(
      answer({
        boards: {
          flowers: [
            { rank: 1, did: did(1), handle: 'one.test', avatar: 'javascript:alert(1)', n: 3 },
            { rank: 2, did: 'x', handle: 'two.test', avatar: null, n: 2 },
            { rank: 'three', did: did(3), handle: 'three.test', avatar: null, n: 1 },
          ],
          pets: 'lots',
        },
      }),
    );
    expect(junk?.boards.flowers).toEqual([{ rank: 1, did: did(1), handle: 'one.test', avatar: null, n: 3 }]);
    expect(junk?.boards.pets).toEqual([]);
    expect(junk?.boards.visitors).toEqual([]);
    expect(await fetchLeaderboard(answer({ error: 'unavailable' }, 503))).toBeNull();
    expect(await fetchLeaderboard(answer({ boards: [] }))).toBeNull();
    expect(await fetchLeaderboard((async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toBeNull();
  });
});
