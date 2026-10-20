import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api/gardener.js';
import { resetDiscussionCaches } from '../server/blog/discussion.js';
import { SPROUT_NSID, TEND_NSID } from '../server/garden.js';
import { CACHE_GARDENER, createGardenerHandlers, toTend } from '../server/gardener.js';
import { fetchGardener } from '../src/scripts/garden.js';
import { CID, DAY, did, fakeFetch, patchRecord, patchUri, sprout, tendOf, tid, type Net } from './garden-net.js';

// /api/gardener against the same scripted network as /api/garden: did(1) grew two flowers
// in a summer patch that has closed, and has one growing now (after moving it once).

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const daisy = `at://${did(1)}/${SPROUT_NSID}/n1`;
const daisyAt = Date.parse('2026-10-15T00:00:00Z');

function net(): Net {
  return {
    patches: {
      '2026-summer': patchRecord('summer 2026', '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', 4, 2, 'summer'),
      '2026-autumn': patchRecord('autumn 2026', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z', 4, 2),
    },
    records: {
      [`${did(1)}/${SPROUT_NSID}/r1`]: sprout('2026-summer', 'rose', '2026-07-01T00:00:00Z', 0),
      [`${did(2)}/${SPROUT_NSID}/d2`]: sprout('2026-summer', 'daisy', '2026-07-05T00:00:00Z', 0),
      [`${did(1)}/${SPROUT_NSID}/t1`]: sprout('2026-summer', 'tulip', '2026-07-10T00:00:00Z', 1),
      // its old autumn flower, before it moved (left behind by a delete that failed)
      [`${did(1)}/${SPROUT_NSID}/v1`]: sprout('2026-autumn', 'violet', '2026-10-01T00:00:00Z', 3),
      [`${did(1)}/${SPROUT_NSID}/n1`]: sprout('2026-autumn', 'daisy', '2026-10-15T00:00:00Z', 2),
      // a flower in a patch the garden doesn't have
      [`${did(1)}/${SPROUT_NSID}/x1`]: sprout('2024-spring', 'poppy', '2024-04-01T00:00:00Z', 0),
      [`${did(1)}/${TEND_NSID}/${tid(daisyAt + 3600_000)}`]: tendOf(daisy),
      [`${did(2)}/${TEND_NSID}/${tid(daisyAt + DAY)}`]: tendOf(daisy, 'talk'),
      [`${did(5)}/${TEND_NSID}/${tid(daisyAt + DAY + 1)}`]: tendOf(daisy, 'sun'),
      [`${did(3)}/${TEND_NSID}/${tid(daisyAt + 2 * DAY)}`]: { ...tendOf(daisy), action: 'dance' },
    },
    profiles: [
      { did: did(1), handle: 'one.test' },
      { did: did(2), handle: 'two.test' },
      { did: did(3), handle: 'three.test' },
      { did: did(5), handle: 'five.test' },
    ],
    blocks: [did(5)],
  };
}

beforeEach(() => resetDiscussionCaches());

describe('/api/gardener', () => {
  it('reads tend records: a known action, at a flower, timed by the TID key', () => {
    const at = Date.parse('2026-10-16T00:00:00Z');
    expect(toTend({ value: tendOf(daisy, 'sun') }, did(2), tid(at), daisy)).toEqual({ did: did(2), action: 'sun', at });
    expect(toTend({ value: tendOf(daisy, 'sing') }, did(2), tid(at), daisy)).toBeNull();
    expect(toTend({ value: tendOf(daisy) }, did(2), 'self', daisy)).toBeNull();
    expect(toTend({ value: tendOf(`at://${did(9)}/${SPROUT_NSID}/x`) }, did(2), tid(at), daisy)).toBeNull();
  });

  it("lists someone's flowers, newest first: the one growing and the pressed ones, with their tending", async () => {
    const h = createGardenerHandlers({ fetch: fakeFetch(net()), now: () => NOW, log: () => undefined });
    const res = await h.GET(new Request(`https://atpota.to/api/gardener?did=${did(1)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_GARDENER);
    const summer = { rkey: '2026-summer', uri: patchUri('2026-summer'), name: 'summer 2026', season: 'summer', open: false, cols: 4, rows: 2 };
    const base = (rkey: string, kind: string, plot: number, plantedAt: string) => ({
      did: did(1),
      rkey,
      uri: `at://${did(1)}/${SPROUT_NSID}/${rkey}`,
      cid: CID,
      handle: 'one.test',
      kind,
      plot,
      plantedAt,
      care: 0,
      helpers: 0,
      lastTended: null,
      thirsty: false,
      tends: [],
    });
    expect(await res.json()).toEqual({
      did: did(1),
      handle: 'one.test',
      flowers: [
        {
          ...base('n1', 'daisy', 2, '2026-10-15T00:00:00.000Z'),
          patch: { rkey: '2026-autumn', uri: patchUri('2026-autumn'), name: 'autumn 2026', season: 'autumn', open: true, cols: 4, rows: 2 },
          // one day by its owner and three neighbours. Care counts from the index alone, so
          // did(5)'s (blocked) and did(3)'s (no such action) count, but aren't listed.
          care: 0.57,
          helpers: 3,
          lastTended: new Date(daisyAt + 2 * DAY).toISOString(),
          tends: [
            { did: did(2), handle: 'two.test', action: 'talk', at: new Date(daisyAt + DAY).toISOString() },
            { did: did(1), handle: 'one.test', action: 'water', at: new Date(daisyAt + 3600_000).toISOString() },
          ],
        },
        // two flowers in the summer patch, settled as the patch settles them (did(2)'s daisy took plot 1)
        { ...base('t1', 'tulip', 2, '2026-07-10T00:00:00.000Z'), patch: summer },
        { ...base('r1', 'rose', 0, '2026-07-01T00:00:00.000Z'), patch: summer },
      ],
    });
  });

  it('turns away a bad DID, 404s for one nobody knows, and shows nothing for a blocked account', async () => {
    const h = createGardenerHandlers({ fetch: fakeFetch({ ...net(), unknownDids: [did(9)] }), now: () => NOW, log: () => undefined });
    expect((await h.GET(new Request('https://atpota.to/api/gardener?did=bob'))).status).toBe(400);
    expect((await h.GET(new Request('https://atpota.to/api/gardener'))).status).toBe(400);
    expect((await h.GET(new Request(`https://atpota.to/api/gardener?did=${did(9)}`))).status).toBe(404);
    const blocked = await (await h.GET(new Request(`https://atpota.to/api/gardener?did=${did(5)}`))).json();
    expect(blocked).toEqual({ did: did(5), handle: 'five.test', flowers: [] });
  });

  it('the browser reads the same shape', async () => {
    const h = createGardenerHandlers({ fetch: fakeFetch(net()), now: () => NOW, log: () => undefined });
    const browserFetch = (async (input: RequestInfo | URL) => h.GET(new Request(new URL(String(input), 'https://atpota.to')))) as typeof fetch;
    const view = await fetchGardener(did(1), browserFetch);
    expect(view?.handle).toBe('one.test');
    expect(view?.flowers.map((f) => [f.rkey, f.patch.rkey, f.tends.length])).toEqual([
      ['n1', '2026-autumn', 2],
      ['t1', '2026-summer', 0],
      ['r1', '2026-summer', 0],
    ]);
    expect(await fetchGardener(did(2), (async () => new Response('down', { status: 503 })) as typeof fetch)).toBeNull();
  });

  it('only takes GET and HEAD', async () => {
    const res = await api.POST(new Request('https://atpota.to/api/gardener', { method: 'POST' }));
    expect(res.status).toBe(405);
  });
});
