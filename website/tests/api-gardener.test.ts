import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api/gardener.js';
import { resetDiscussionCaches } from '../server/blog/discussion.js';
import { SPROUT_NSID, TEND_NSID } from '../server/garden.js';
import { CACHE_GARDENER, createGardenerHandlers, MAX_GARDENS, toGiven, toTend } from '../server/gardener.js';
import { fetchGardener } from '../src/scripts/garden.js';
import { CID, DAY, did, fakeFetch, gardenRecord, patchRecord, patchUri, sprout, tendOf, tid, type Net } from './garden-net.js';

// /api/gardener against the same scripted network as /api/garden. did(1) grew two flowers
// in atpotato's summer patch (now closed), has one growing in the autumn patch (after
// moving it once), planted one in did(2)'s garden, keeps a garden of its own that did(2)
// and did(3) planted in, and has tended other people's flowers.

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const daisy = `at://${did(1)}/${SPROUT_NSID}/n1`;
const daisyAt = Date.parse('2026-10-15T00:00:00Z');
const theirTulip = `at://${did(2)}/${SPROUT_NSID}/k2`;
const theirRose = `at://${did(3)}/${SPROUT_NSID}/k3`;
const at = (iso: string) => tid(Date.parse(iso));

function net(): Net {
  return {
    patches: {
      '2026-summer': patchRecord('summer 2026', '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', 4, 2, 'summer'),
      // a patch that moves flowers, so did(1)'s newest counts
      '2026-autumn': { ...patchRecord('autumn 2026', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z', 4, 2), planting: 'move' },
    },
    gardens: {
      [did(1)]: { self: gardenRecord('one’s garden', 4, 2) },
      [did(2)]: { self: gardenRecord('two’s garden', 6, 4, { note: 'all welcome' }) },
    },
    records: {
      [`${did(1)}/${SPROUT_NSID}/r1`]: sprout('2026-summer', 'rose', '2026-07-01T00:00:00Z', 0),
      [`${did(2)}/${SPROUT_NSID}/d2`]: sprout('2026-summer', 'daisy', '2026-07-05T00:00:00Z', 0),
      [`${did(1)}/${SPROUT_NSID}/t1`]: sprout('2026-summer', 'tulip', '2026-07-10T00:00:00Z', 1),
      // its old autumn flower, before it moved (left behind by a delete that failed)
      [`${did(1)}/${SPROUT_NSID}/v1`]: sprout('2026-autumn', 'violet', '2026-10-01T00:00:00Z', 3),
      [`${did(1)}/${SPROUT_NSID}/n1`]: sprout('2026-autumn', 'daisy', '2026-10-15T00:00:00Z', 2),
      // a flower in a patch atpotato doesn't have, and one in a garden nobody can find
      [`${did(1)}/${SPROUT_NSID}/x1`]: sprout('2024-spring', 'poppy', '2024-04-01T00:00:00Z', 0),
      [`${did(1)}/${SPROUT_NSID}/z1`]: sprout('self', 'poppy', '2026-10-19T00:00:00Z', 0, did(9)),
      // in did(2)'s garden
      [`${did(1)}/${SPROUT_NSID}/w1`]: sprout('self', 'poppy', '2026-10-18T00:00:00Z', 3, did(2)),
      // in did(1)'s own garden: did(3)'s asked for did(2)'s plot, later
      [`${did(2)}/${SPROUT_NSID}/k2`]: sprout('self', 'tulip', '2026-10-10T00:00:00Z', 0, did(1)),
      [`${did(3)}/${SPROUT_NSID}/k3`]: sprout('self', 'rose', '2026-10-11T00:00:00Z', 0, did(1)),
      // tending its daisy
      [`${did(1)}/${TEND_NSID}/${tid(daisyAt + 3600_000)}`]: tendOf(daisy),
      [`${did(2)}/${TEND_NSID}/${tid(daisyAt + DAY)}`]: tendOf(daisy, 'talk'),
      [`${did(5)}/${TEND_NSID}/${tid(daisyAt + DAY + 1)}`]: tendOf(daisy, 'sun'),
      [`${did(3)}/${TEND_NSID}/${tid(daisyAt + 2 * DAY)}`]: { ...tendOf(daisy), action: 'dance' },
      // what did(1) gave: did(2)'s tulip once, did(3)'s rose twice, and two records that don't count
      [`${did(1)}/${TEND_NSID}/${at('2026-10-19T09:00:00Z')}`]: tendOf(theirTulip, 'sun'),
      [`${did(1)}/${TEND_NSID}/${at('2026-10-19T10:00:00Z')}`]: tendOf(theirRose),
      [`${did(1)}/${TEND_NSID}/${at('2026-10-20T08:00:00Z')}`]: tendOf(theirRose, 'talk'),
      [`${did(1)}/${TEND_NSID}/${at('2026-10-20T09:00:00Z')}`]: { ...tendOf(theirRose), action: 'dance' },
      [`${did(1)}/${TEND_NSID}/${at('2026-10-20T10:00:00Z')}`]: tendOf(`at://${did(2)}/app.bsky.feed.post/3p`),
    },
    profiles: [
      { did: did(1), handle: 'one.test', displayName: 'One', avatar: 'https://cdn.bsky.app/one.jpg' },
      { did: did(2), handle: 'two.test' },
      { did: did(3), handle: 'three.test' },
      { did: did(4), handle: 'four.test', labels: [{ val: '!hide' }] },
      { did: did(5), handle: 'five.test' },
    ],
    blocks: [did(5)],
    unknownDids: [did(9)],
  };
}

const handlers = (n: Net = net(), log: (f: { event: string }) => void = () => undefined) => createGardenerHandlers({ fetch: fakeFetch(n), now: () => NOW, log });

beforeEach(() => resetDiscussionCaches());

describe('/api/gardener', () => {
  it('reads tend records: a known action, at a flower, timed by the TID key', () => {
    const t = Date.parse('2026-10-16T00:00:00Z');
    expect(toTend({ value: tendOf(daisy, 'sun') }, did(2), tid(t), daisy)).toEqual({ did: did(2), action: 'sun', at: t });
    expect(toTend({ value: tendOf(daisy, 'sing') }, did(2), tid(t), daisy)).toBeNull();
    expect(toTend({ value: tendOf(daisy) }, did(2), 'self', daisy)).toBeNull();
    expect(toTend({ value: tendOf(`at://${did(9)}/${SPROUT_NSID}/x`) }, did(2), tid(t), daisy)).toBeNull();
  });

  it('reads the tending someone gave: whose flower, what, and when (the TID key, else createdAt)', () => {
    const entry = (rkey: string, value: Record<string, unknown>) => ({ uri: `at://${did(1)}/${TEND_NSID}/${rkey}`, cid: CID, value });
    const t = Date.parse('2026-10-19T09:00:00Z');
    expect(toGiven(entry(tid(t), tendOf(theirTulip, 'sun')))).toEqual({ action: 'sun', at: t, uri: theirTulip, owner: did(2) });
    expect(toGiven(entry('plain', tendOf(theirTulip)))).toEqual({ action: 'water', at: Date.parse('2026-10-01T00:00:00Z'), uri: theirTulip, owner: did(2) });
    expect(toGiven(entry(tid(t), { ...tendOf(theirTulip), action: 'dance' }))).toBeNull();
    expect(toGiven(entry(tid(t), tendOf(`at://${did(2)}/app.bsky.feed.post/3p`)))).toBeNull();
  });

  it('shows someone across gardens: who they are, their own garden, every flower, and what they gave', async () => {
    const res = await handlers().GET(new Request(`https://atpota.to/api/gardener?actor=${did(1)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_GARDENER);
    const atpotato = { did: 'did:plc:qntsxa2i4sb24noi45fx4np2', handle: 'atpota.to' };
    const summer = { rkey: '2026-summer', uri: patchUri('2026-summer'), name: 'summer 2026', season: 'summer', open: false, cols: 4, rows: 2, owner: atpotato };
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
      displayName: 'One',
      avatar: 'https://cdn.bsky.app/one.jpg',
      // did(2)'s and did(3)'s flowers in it
      garden: { rkey: 'self', uri: patchUri('self', did(1)), name: 'one’s garden', note: null, open: true, plots: 8, planted: 2 },
      flowers: [
        {
          ...base('w1', 'poppy', 3, '2026-10-18T00:00:00.000Z'),
          patch: { rkey: 'self', uri: patchUri('self', did(2)), name: 'two’s garden', season: null, open: true, cols: 6, rows: 4, owner: { did: did(2), handle: 'two.test' } },
        },
        {
          ...base('n1', 'daisy', 2, '2026-10-15T00:00:00.000Z'),
          patch: { rkey: '2026-autumn', uri: patchUri('2026-autumn'), name: 'autumn 2026', season: 'autumn', open: true, cols: 4, rows: 2, owner: atpotato },
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
      given: {
        // its own daisy once, did(2)'s tulip once, did(3)'s rose twice
        total: 4,
        helped: 2,
        recent: [
          { at: '2026-10-20T08:00:00.000Z', action: 'talk', flower: { uri: theirRose, owner: { did: did(3), handle: 'three.test' } } },
          { at: '2026-10-19T10:00:00.000Z', action: 'water', flower: { uri: theirRose, owner: { did: did(3), handle: 'three.test' } } },
          { at: '2026-10-19T09:00:00.000Z', action: 'sun', flower: { uri: theirTulip, owner: { did: did(2), handle: 'two.test' } } },
          { at: new Date(daisyAt + 3600_000).toISOString(), action: 'water', flower: { uri: daisy, owner: { did: did(1), handle: 'one.test' } } },
        ],
      },
    });
  });

  it('in a garden of one each, their flower is the first they planted there, as the garden shows it', async () => {
    const n = net();
    delete n.patches['2026-autumn']!.planting;
    const body = await (await handlers(n).GET(new Request(`https://atpota.to/api/gardener?actor=${did(1)}`))).json();
    const autumn = body.flowers.filter((f: { patch: { rkey: string } }) => f.patch.rkey === '2026-autumn');
    expect(autumn.map((f: { rkey: string; plot: number }) => [f.rkey, f.plot])).toEqual([['v1', 3]]);
  });

  it('a handle works as well as a DID, and so does the older ?did=', async () => {
    const h = handlers();
    const byDid = await (await h.GET(new Request(`https://atpota.to/api/gardener?actor=${did(1)}`))).json();
    expect(await (await h.GET(new Request('https://atpota.to/api/gardener?actor=One.Test'))).json()).toEqual(byDid);
    expect(await (await h.GET(new Request(`https://atpota.to/api/gardener?did=${did(1)}`))).json()).toEqual(byDid);
  });

  it('someone with no garden of their own, who planted in someone else’s', async () => {
    const body = await (await handlers().GET(new Request('https://atpota.to/api/gardener?actor=three.test'))).json();
    expect(body.garden).toBeNull();
    expect(body.flowers.map((f: { rkey: string; plot: number; patch: { owner: { handle: string } } }) => [f.rkey, f.plot, f.patch.owner.handle])).toEqual([['k3', 1, 'one.test']]);
    // its only tend record names an action that doesn't exist
    expect(body.given).toEqual({ total: 0, helped: 0, recent: [] });
  });

  it('turns away junk, and 404s for nobody, hidden accounts and ones atpotato blocks', async () => {
    const h = handlers();
    for (const q of ['did=bob', 'actor=', '', 'actor=not%20a%20handle']) expect((await h.GET(new Request(`https://atpota.to/api/gardener?${q}`))).status, q).toBe(400);
    for (const who of [did(9), 'nobody.test', did(4), did(5), 'five.test']) {
      expect((await h.GET(new Request(`https://atpota.to/api/gardener?actor=${who}`))).status, who).toBe(404);
    }
  });

  it(`reads at most ${MAX_GARDENS} gardens, the ones planted in most recently, and says so`, async () => {
    const n = net();
    for (let i = 0; i < MAX_GARDENS + 2; i++) {
      n.patches[`p${i}`] = patchRecord(`patch ${i}`, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 4, 2, 'winter');
      n.records[`${did(1)}/${SPROUT_NSID}/q${i}`] = sprout(`p${i}`, 'rose', `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, 0);
    }
    const logged: string[] = [];
    const body = await (await handlers(n, (f) => logged.push(f.event)).GET(new Request(`https://atpota.to/api/gardener?actor=${did(1)}`))).json();
    const read = body.flowers.map((f: { rkey: string }) => f.rkey);
    // the newest gardens: did(9)'s (which can't be read), did(2)'s, autumn's and summer's
    // (two flowers), then the twelve newest of the January ones
    expect(read).toHaveLength(MAX_GARDENS);
    expect(read).not.toContain('q0');
    expect(read).toContain(`q${MAX_GARDENS + 1}`);
    expect(logged).toContain('gardener_capped');
  });

  it('the browser reads the same shape, by DID or handle', async () => {
    const h = handlers();
    const browserFetch = (async (input: RequestInfo | URL) => h.GET(new Request(new URL(String(input), 'https://atpota.to')))) as typeof fetch;
    const view = await fetchGardener(did(1), browserFetch);
    if (!view || view === 'missing') throw new Error('no view');
    expect([view.handle, view.displayName, view.avatar]).toEqual(['one.test', 'One', 'https://cdn.bsky.app/one.jpg']);
    expect(view.garden).toMatchObject({ rkey: 'self', planted: 2, plots: 8 });
    expect(view.flowers.map((f) => [f.rkey, f.patch.rkey, f.patch.owner.handle, f.tends.length])).toEqual([
      ['w1', 'self', 'two.test', 0],
      ['n1', '2026-autumn', 'atpota.to', 2],
      ['t1', '2026-summer', 'atpota.to', 0],
      ['r1', '2026-summer', 'atpota.to', 0],
    ]);
    expect([view.given.total, view.given.helped, view.given.recent.length]).toEqual([4, 2, 4]);
    expect(await fetchGardener('one.test', browserFetch)).toMatchObject({ did: did(1) });
    expect(await fetchGardener('nobody.test', browserFetch)).toBe('missing');
    expect(await fetchGardener(did(2), (async () => new Response('down', { status: 503 })) as typeof fetch)).toBeNull();
    // an answer about someone else is turned down
    const other = (async () => Response.json({ did: did(2), handle: 'two.test', flowers: [] })) as typeof fetch;
    expect(await fetchGardener(did(1), other)).toBeNull();
    expect(await fetchGardener('one.test', other)).toBeNull();
    // a flower whose patch isn't in the repo of the owner it names is left out
    const real = await (await h.GET(new Request(`https://atpota.to/api/gardener?actor=${did(1)}`))).json();
    real.flowers[0].patch.owner = { did: did(3), handle: 'three.test' };
    const lying = (async () => Response.json(real)) as typeof fetch;
    const checked = await fetchGardener(did(1), lying);
    expect(checked !== 'missing' && checked?.flowers.map((f) => f.rkey)).toEqual(['n1', 't1', 'r1']);
  });

  it('says 503 when no garden it planted in can be read, rather than showing none', async () => {
    const res = await handlers({ ...net(), constellationDown: true }).GET(new Request(`https://atpota.to/api/gardener?actor=${did(1)}`));
    expect(res.status).toBe(503);
  });

  it('only takes GET and HEAD', async () => {
    const res = await api.POST(new Request('https://atpota.to/api/gardener', { method: 'POST' }));
    expect(res.status).toBe(405);
  });
});
