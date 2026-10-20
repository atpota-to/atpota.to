import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api/garden.js';
import { resetDiscussionCaches } from '../server/blog/discussion.js';
import {
  CACHE_OK,
  careFrom,
  createGardenHandlers,
  defaultPatch,
  FLOWER_KINDS,
  GARDEN_SUBJECT,
  GROW_DAYS,
  isThirsty,
  MAX_COLS,
  MAX_PLOTS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  newestPerAccount,
  PATCH_NSID,
  resolvePlots,
  SEASONS,
  SPROUT_DAYS,
  SPROUT_NSID,
  stageFor,
  TEND_ACTIONS,
  TEND_NSID,
  tidTime,
  toPatch,
  toSprout,
  type PatchSummary,
} from '../server/garden.js';
import * as flowers from '../src/scripts/flowers.js';
import * as client from '../src/scripts/garden.js';
import { CID, DAY, did, fakeFetch, patchRecord, patchUri, sprout, tendOf, tid, type Net } from './garden-net.js';

// /api/garden against a scripted network (tests/garden-net.ts): atpotato's PDS lists the
// patches, Constellation the sprouts in each and the tends on each flower, Slingshot serves
// each record, and the AppView names the accounts.

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const lexicon = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../lexicons/to/atpota/garden/${name}.json`, import.meta.url)), 'utf8'));
const patchEntry = (rkey: string, value: Record<string, unknown>, uri = patchUri(rkey)) => ({ uri, cid: 'bafypatchcid', value });

beforeEach(() => resetDiscussionCaches());

describe('patch records', () => {
  it('accepts well-formed patches from atpotato only', () => {
    const autumn = patchRecord('autumn 2026', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z');
    expect(toPatch(patchEntry('2026-autumn', autumn))).toEqual({
      rkey: '2026-autumn',
      uri: patchUri('2026-autumn'),
      cid: 'bafypatchcid',
      name: 'autumn 2026',
      season: 'autumn',
      cols: 12,
      rows: 8,
      opensAt: '2026-09-01T00:00:00.000Z',
      closesAt: '2026-12-01T00:00:00.000Z',
    });
    expect(toPatch(patchEntry('x', autumn, `at://${did(1)}/${PATCH_NSID}/x`))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, season: 'monsoon' }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, cols: MAX_COLS + 1 }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, rows: 1.5 }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, closesAt: autumn.opensAt }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, name: 'a'.repeat(41) }))).toBeNull();
  });

  it('the lexicons describe the same records', () => {
    const patch = lexicon('patch');
    expect(patch.id).toBe(PATCH_NSID);
    expect(patch.defs.main.key).toBe('any');
    expect(patch.defs.main.record.properties.season.knownValues).toEqual([...SEASONS]);
    expect([patch.defs.main.record.properties.cols.minimum, patch.defs.main.record.properties.cols.maximum]).toEqual([MIN_COLS, MAX_COLS]);
    expect([patch.defs.main.record.properties.rows.minimum, patch.defs.main.record.properties.rows.maximum]).toEqual([MIN_ROWS, MAX_ROWS]);
    expect(patch.defs.main.record.properties.name.maxGraphemes).toBe(40);

    const sprouted = lexicon('sprout');
    expect(sprouted.id).toBe(SPROUT_NSID);
    expect(sprouted.defs.main.record.required).toEqual(['patch', 'kind', 'plot', 'createdAt']);
    expect(sprouted.defs.main.record.properties.patch.ref).toBe('com.atproto.repo.strongRef');
    expect(sprouted.defs.main.record.properties.patch.description).toContain(GARDEN_SUBJECT);
    expect(sprouted.defs.main.record.properties.kind.knownValues).toEqual([...FLOWER_KINDS]);
    expect(sprouted.defs.main.record.properties.plot.maximum).toBe(MAX_PLOTS - 1);

    const tended = lexicon('tend');
    expect(tended.id).toBe(TEND_NSID);
    expect(tended.defs.main.key).toBe('tid');
    expect(tended.defs.main.record.properties.subject.ref).toBe('com.atproto.repo.strongRef');
    expect(tended.defs.main.record.properties.action.knownValues).toEqual([...TEND_ACTIONS]);
  });
});

describe('sprout records', () => {
  it('accepts flowers of a known kind that point at a patch, not from the future', () => {
    const value = sprout('2026-autumn', 'rose', '2026-10-19T10:00:00Z', 14);
    expect(toSprout({ cid: CID, value }, did(1), 's1', NOW)).toEqual({
      did: did(1),
      rkey: 's1',
      uri: `at://${did(1)}/${SPROUT_NSID}/s1`,
      cid: CID,
      kind: 'rose',
      plot: 14,
      plantedAt: '2026-10-19T10:00:00.000Z',
      patch: patchUri('2026-autumn'),
    });
    // a plot that isn't a whole number on any patch is ignored (the flower gets a free one)
    for (const plot of [-1, 2.5, MAX_PLOTS, '3', null]) expect(toSprout({ cid: CID, value: { ...value, plot } }, did(1), 's1', NOW)?.plot).toBeNull();
    expect(toSprout({ cid: CID, value: { ...value, patch: patchUri('2026-autumn') } }, did(1), 's1', NOW)).toBeNull();
    expect(toSprout({ cid: CID, value: { ...value, patch: { uri: patchUri('2026-autumn') } } }, did(1), 's1', NOW)).toBeNull();
    expect(toSprout({ cid: CID, value: { ...value, kind: 'cactus' } }, did(1), 's1', NOW)).toBeNull();
    expect(toSprout({ cid: CID, value: { ...value, createdAt: '2027-01-01T00:00:00Z' } }, did(1), 's1', NOW)).toBeNull();
    expect(toSprout({ value }, did(1), 's1', NOW)).toBeNull();
  });

  it('settles plots in planting order in a patch of fixed size', () => {
    const placed = resolvePlots(
      [
        { id: 'a', plot: 3 },
        { id: 'b', plot: 3 },
        { id: 'c', plot: 7 },
        { id: 'd', plot: 40 },
        { id: 'e', plot: null },
        { id: 'f', plot: 0 },
        { id: 'g', plot: 1 },
        { id: 'h', plot: 5 },
        { id: 'i', plot: 2 },
      ],
      8,
    );
    // b moves along; c's plot 7 is the last; d is off the patch so starts from 0; i doesn't fit
    expect(placed.map((f) => [f.id, f.plot])).toEqual([
      ['a', 3],
      ['b', 4],
      ['c', 7],
      ['d', 0],
      ['e', 1],
      ['f', 2],
      ['g', 5],
      ['h', 6],
    ]);
  });

  it('keeps one flower per account across the open patches: the newest', () => {
    const s = (d: string, rkey: string, plantedAt: string) => ({ did: d, rkey, uri: `at://${d}/${SPROUT_NSID}/${rkey}`, cid: CID, kind: 'rose' as const, plot: 0, plantedAt });
    const keep = newestPerAccount([s(did(1), 'a', '2026-10-01T00:00:00Z'), s(did(1), 'b', '2026-10-05T00:00:00Z'), s(did(2), 'c', '2026-10-02T00:00:00Z')]);
    expect([...keep].sort()).toEqual([`at://${did(1)}/${SPROUT_NSID}/b`, `at://${did(2)}/${SPROUT_NSID}/c`]);
  });
});

describe('growing and tending', () => {
  const planted = '2026-10-10T00:00:00.000Z';
  const at = Date.parse(planted);

  it('reads the time a TID key was made, and nothing from other keys', () => {
    expect(tidTime(tid(at))).toBe(at);
    expect(tidTime(tid(at + 1234, 999))).toBe(at + 1234);
    for (const key of ['self', '3kabc', 'zzzzzzzzzzzzz', tid(at).toUpperCase()]) expect(tidTime(key)).toBeNull();
  });

  it('grows from sprout to bud to bloom in a week, and a closed patch is all in bloom', () => {
    expect(stageFor(planted, at + 1000)).toBe('sprout');
    expect(stageFor(planted, at + SPROUT_DAYS * DAY)).toBe('bud');
    expect(stageFor(planted, at + GROW_DAYS * DAY - 1)).toBe('bud');
    expect(stageFor(planted, at + GROW_DAYS * DAY)).toBe('bloom');
    expect(stageFor(planted, at + 1000, false)).toBe('bloom');
  });

  it('counts care: each day its owner tended it, and up to three neighbours', () => {
    const tends = [
      { did: did(1), rkey: tid(at + 1 * 3600_000) },
      { did: did(1), rkey: tid(at + 5 * 3600_000) }, // the same day again
      { did: did(1), rkey: tid(at + 2 * DAY + 10) },
      { did: did(1), rkey: tid(at + 3 * DAY + 10) },
      { did: did(2), rkey: tid(at + DAY) },
      { did: did(2), rkey: tid(at + 2 * DAY) }, // a neighbour counts once
      { did: did(3), rkey: tid(at + DAY) },
      { did: did(4), rkey: tid(at + DAY) },
      { did: did(5), rkey: tid(at + DAY) }, // the fourth neighbour doesn't add more
      { did: did(1), rkey: 'not-a-tid' },
      { did: did(1), rkey: tid(at - DAY) }, // before it was planted
      { did: did(6), rkey: tid(at + 8 * DAY) }, // after it grew: not care, but it was tended
      { did: did(1), rkey: tid(NOW + DAY) }, // in the future
    ];
    expect(careFrom(did(1), planted, tends, NOW)).toEqual({ care: 0.86, helpers: 3, lastTended: at + 8 * DAY });
    expect(careFrom(did(1), planted, [], NOW)).toEqual({ care: 0, helpers: 0, lastTended: null });
    const everyDay = Array.from({ length: 9 }, (_, i) => ({ did: did(1), rkey: tid(at + i * DAY + 60_000) }));
    expect(careFrom(did(1), planted, everyDay, NOW).care).toBe(1);
  });

  it('a bloom nobody has tended for four days is thirsty, while its patch is open', () => {
    const bloomed = at + GROW_DAYS * DAY;
    expect(isThirsty(planted, null, bloomed + 4 * DAY + 1, true)).toBe(true);
    expect(isThirsty(planted, null, bloomed + 4 * DAY - 1, true)).toBe(false);
    expect(isThirsty(planted, bloomed + 3 * DAY, bloomed + 6 * DAY, true)).toBe(false);
    expect(isThirsty(planted, bloomed + 1 * DAY, bloomed + 6 * DAY, true)).toBe(true);
    expect(isThirsty(planted, null, bloomed + 9 * DAY, false)).toBe(false);
    expect(isThirsty(planted, null, at + 3 * DAY, true)).toBe(false);
  });

  it('shows the first open patch with room, else the newest open one, else the newest opened, else the next', () => {
    const p = (rkey: string, open: boolean, planted: number, opensAt: string): PatchSummary => ({ rkey, name: rkey, season: 'autumn', open, planted, plots: 8, opensAt, closesAt: '2027-01-01T00:00:00Z' });
    const summer = p('summer', false, 3, '2026-06-01T00:00:00Z');
    const autumn = p('autumn', true, 8, '2026-09-01T00:00:00Z');
    const autumn2 = p('autumn-2', true, 2, '2026-09-01T00:00:00Z');
    const winter = p('winter', false, 0, '2026-12-01T00:00:00Z');
    expect(defaultPatch([summer, autumn, autumn2, winter], NOW)?.rkey).toBe('autumn-2');
    expect(defaultPatch([summer, autumn, { ...autumn2, planted: 8 }, winter], NOW)?.rkey).toBe('autumn-2');
    expect(defaultPatch([summer, winter], NOW)?.rkey).toBe('summer');
    expect(defaultPatch([winter], NOW)?.rkey).toBe('winter');
    expect(defaultPatch([], NOW)).toBeNull();
  });

  it('the browser and the server agree', () => {
    expect(client.SPROUT_NSID).toBe(SPROUT_NSID);
    expect(client.PATCH_NSID).toBe(PATCH_NSID);
    expect(client.TEND_NSID).toBe(TEND_NSID);
    expect(client.GARDEN_SUBJECT).toBe(GARDEN_SUBJECT);
    expect([...client.FLOWER_KINDS]).toEqual([...FLOWER_KINDS]);
    expect([...client.SEASONS]).toEqual([...SEASONS]);
    expect([...client.TEND_ACTIONS]).toEqual([...TEND_ACTIONS]);
    expect([client.MAX_COLS, client.MAX_ROWS, client.MAX_PLOTS]).toEqual([MAX_COLS, MAX_ROWS, MAX_PLOTS]);
    expect([flowers.SPROUT_DAYS, flowers.GROW_DAYS]).toEqual([SPROUT_DAYS, GROW_DAYS]);
    for (const age of [0, 1, 2, 3, 6.9, 7, 30]) {
      for (const open of [true, false]) expect(flowers.stageFor(planted, at + age * DAY, open)).toBe(stageFor(planted, at + age * DAY, open));
    }
    const ref = { uri: patchUri('2026-autumn'), cid: CID };
    expect(toSprout({ cid: CID, value: client.sproutRecord(ref, 'tulip', 7, new Date(NOW - 1000)) }, did(1), 's', NOW)).toMatchObject({ kind: 'tulip', plot: 7, patch: ref.uri });
    expect(client.tendRecord(`at://${did(1)}/${SPROUT_NSID}/s`, CID, 'sun', new Date(NOW))).toEqual({
      $type: TEND_NSID,
      subject: { uri: `at://${did(1)}/${SPROUT_NSID}/s`, cid: CID },
      action: 'sun',
      createdAt: new Date(NOW).toISOString(),
    });
    expect(client.patchUri('2026-autumn')).toBe(patchUri('2026-autumn'));
  });
});

/** Three patches (one closed, two open) and a winter one to come, with flowers and tending. */
function gardenNet(): Net {
  const poppy = `at://${did(2)}/${SPROUT_NSID}/p2`;
  const poppyAt = Date.parse('2026-10-14T00:00:00Z');
  return {
    patches: {
      '2026-summer': patchRecord('summer 2026', '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', 4, 2, 'summer'),
      '2026-autumn': patchRecord('autumn 2026', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z', 4, 2),
      '2026-autumn-2': patchRecord('autumn 2026 (2)', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z', 4, 2),
      '2026-winter': patchRecord('winter 2026', '2026-12-01T00:00:00Z', '2027-03-01T00:00:00Z', 4, 2, 'winter'),
      broken: { name: 'no size' },
    },
    records: {
      // summer, closed: every flower stays, two of them did(1)'s
      [`${did(1)}/${SPROUT_NSID}/r1`]: sprout('2026-summer', 'rose', '2026-07-01T00:00:00Z', 0),
      [`${did(2)}/${SPROUT_NSID}/d2`]: sprout('2026-summer', 'daisy', '2026-07-05T00:00:00Z', 0),
      [`${did(1)}/${SPROUT_NSID}/t1`]: sprout('2026-summer', 'tulip', '2026-07-10T00:00:00Z', 1),
      // autumn: did(1)'s older flower gives way to its newer one in autumn-2
      [`${did(1)}/${SPROUT_NSID}/v1`]: sprout('2026-autumn', 'violet', '2026-10-01T00:00:00Z', 3),
      [`${did(7)}/${SPROUT_NSID}/u7`]: sprout('2026-autumn', 'tulip', '2026-09-02T00:00:00Z', 7),
      [`${did(2)}/${SPROUT_NSID}/p2`]: sprout('2026-autumn', 'poppy', '2026-10-14T00:00:00Z', 5),
      [`${did(3)}/${SPROUT_NSID}/s3`]: sprout('2026-autumn', 'sunflower', '2026-10-18T00:00:00Z', 5),
      [`${did(4)}/${SPROUT_NSID}/h4`]: sprout('2026-autumn', 'daisy', '2026-10-18T00:00:00Z', 1),
      [`${did(5)}/${SPROUT_NSID}/b5`]: sprout('2026-autumn', 'daisy', '2026-10-18T00:00:00Z', 2),
      [`${did(8)}/${SPROUT_NSID}/c8`]: sprout('2026-autumn', 'cactus', '2026-10-18T00:00:00Z', 4),
      // autumn-2
      [`${did(1)}/${SPROUT_NSID}/n1`]: sprout('2026-autumn-2', 'daisy', '2026-10-15T00:00:00Z', 0),
      // tending did(2)'s poppy: three days by its owner, and four neighbours (three count)
      [`${did(2)}/${TEND_NSID}/${tid(poppyAt + 3600_000)}`]: tendOf(poppy),
      [`${did(2)}/${TEND_NSID}/${tid(poppyAt + 2 * DAY)}`]: tendOf(poppy, 'sun'),
      [`${did(2)}/${TEND_NSID}/${tid(poppyAt + 3 * DAY)}`]: tendOf(poppy, 'talk'),
      [`${did(3)}/${TEND_NSID}/${tid(poppyAt + DAY)}`]: tendOf(poppy),
      [`${did(6)}/${TEND_NSID}/${tid(poppyAt + DAY + 1)}`]: tendOf(poppy),
      [`${did(7)}/${TEND_NSID}/${tid(poppyAt + DAY + 2)}`]: tendOf(poppy),
      [`${did(9)}/${TEND_NSID}/${tid(poppyAt + DAY + 3)}`]: tendOf(poppy),
    },
    // an index entry whose record now points somewhere else
    extraLinks: [{ target: patchUri('2026-autumn'), did: did(3), collection: SPROUT_NSID, rkey: 'moved' }],
    profiles: [
      { did: did(1), handle: 'one.test' },
      { did: did(2), handle: 'two.test' },
      { did: did(3), handle: 'three.test' },
      { did: did(4), handle: 'four.test', labels: [{ val: '!hide' }] },
      { did: did(5), handle: 'five.test' },
      { did: did(7), handle: 'seven.test' },
      { did: did(8), handle: 'eight.test' },
    ],
    blocks: [did(5)],
  };
}

const flower = (d: string, rkey: string, handle: string, kind: string, plot: number, plantedAt: string, extra: Record<string, unknown> = {}) => ({
  did: d,
  rkey,
  uri: `at://${d}/${SPROUT_NSID}/${rkey}`,
  cid: CID,
  handle,
  kind,
  plot,
  plantedAt,
  care: 0,
  helpers: 0,
  lastTended: null,
  thirsty: false,
  ...extra,
});

describe('/api/garden', () => {
  it('shows the open patch with room, its flowers settled, tended and moderated, and every patch', async () => {
    const net = gardenNet();
    net.records[`${did(3)}/${SPROUT_NSID}/moved`] = sprout('2025-autumn', 'rose', '2026-10-01T00:00:00Z');
    const h = createGardenHandlers({ fetch: fakeFetch(net), now: () => NOW, log: () => undefined });
    const res = await h.GET(new Request('https://atpota.to/api/garden'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    const body = await res.json();
    expect(body.patch).toEqual({
      rkey: '2026-autumn',
      uri: patchUri('2026-autumn'),
      cid: 'bafypatch2026autumn',
      name: 'autumn 2026',
      season: 'autumn',
      cols: 4,
      rows: 2,
      opensAt: '2026-09-01T00:00:00.000Z',
      closesAt: '2026-12-01T00:00:00.000Z',
      open: true,
    });
    expect(body.patches).toEqual([
      { rkey: '2026-summer', name: 'summer 2026', season: 'summer', open: false, planted: 3, plots: 8, opensAt: '2026-06-01T00:00:00.000Z', closesAt: '2026-09-01T00:00:00.000Z' },
      { rkey: '2026-autumn', name: 'autumn 2026', season: 'autumn', open: true, planted: 3, plots: 8, opensAt: '2026-09-01T00:00:00.000Z', closesAt: '2026-12-01T00:00:00.000Z' },
      { rkey: '2026-autumn-2', name: 'autumn 2026 (2)', season: 'autumn', open: true, planted: 1, plots: 8, opensAt: '2026-09-01T00:00:00.000Z', closesAt: '2026-12-01T00:00:00.000Z' },
      { rkey: '2026-winter', name: 'winter 2026', season: 'winter', open: false, planted: 0, plots: 8, opensAt: '2026-12-01T00:00:00.000Z', closesAt: '2027-03-01T00:00:00.000Z' },
    ]);
    const poppyAt = Date.parse('2026-10-14T00:00:00Z');
    expect(body.flowers).toEqual([
      // bloomed on 9 September, untended since: thirsty
      flower(did(7), 'u7', 'seven.test', 'tulip', 7, '2026-09-02T00:00:00.000Z', { thirsty: true }),
      // 3 days by did(2), plus 3 of its 4 helpers: 6/7
      flower(did(2), 'p2', 'two.test', 'poppy', 5, '2026-10-14T00:00:00.000Z', { care: 0.86, helpers: 3, lastTended: new Date(poppyAt + 3 * DAY).toISOString() }),
      // asked for plot 5 too, later: the next one along
      flower(did(3), 's3', 'three.test', 'sunflower', 6, '2026-10-18T00:00:00.000Z'),
    ]);
    expect(body.total).toBe(3);
  });

  it('shows a closed patch when asked, with every flower it had', async () => {
    const h = createGardenHandlers({ fetch: fakeFetch(gardenNet()), now: () => NOW, log: () => undefined });
    const body = await (await h.GET(new Request('https://atpota.to/api/garden?patch=2026-summer'))).json();
    expect(body.patch).toMatchObject({ rkey: '2026-summer', open: false });
    expect(body.flowers).toEqual([
      flower(did(1), 'r1', 'one.test', 'rose', 0, '2026-07-01T00:00:00.000Z'),
      flower(did(2), 'd2', 'two.test', 'daisy', 1, '2026-07-05T00:00:00.000Z'),
      flower(did(1), 't1', 'one.test', 'tulip', 2, '2026-07-10T00:00:00.000Z'),
    ]);

    const second = await (await h.GET(new Request('https://atpota.to/api/garden?patch=2026-autumn-2'))).json();
    expect(second.flowers.map((f: { rkey: string }) => f.rkey)).toEqual(['n1']);
  });

  it('a full patch sends you to the next open one with room', async () => {
    const net = gardenNet();
    for (let i = 10; i < 15; i++) {
      net.records[`${did(i)}/${SPROUT_NSID}/f${i}`] = sprout('2026-autumn', 'rose', '2026-10-02T00:00:00Z', i - 10);
      net.profiles.push({ did: did(i), handle: `n${i}.test` });
    }
    const h = createGardenHandlers({ fetch: fakeFetch(net), now: () => NOW, log: () => undefined });
    const body = await (await h.GET(new Request('https://atpota.to/api/garden'))).json();
    expect(body.patches[1]).toMatchObject({ rkey: '2026-autumn', planted: 8, plots: 8 });
    expect(body.patch.rkey).toBe('2026-autumn-2');
  });

  it('404s for a patch that does not exist, and is fine before the first patch', async () => {
    const h = createGardenHandlers({ fetch: fakeFetch(gardenNet()), now: () => NOW, log: () => undefined });
    for (const q of ['nope', 'a%2Fb', '']) {
      const res = await h.GET(new Request(`https://atpota.to/api/garden?patch=${q}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    const empty = createGardenHandlers({ fetch: fakeFetch({ patches: {}, records: {}, profiles: [] }), now: () => NOW, log: () => undefined });
    const res = await empty.GET(new Request('https://atpota.to/api/garden'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ patch: null, patches: [], flowers: [], total: 0 });
  });

  it('says 503 when the patches or the index are down', async () => {
    for (const trouble of [{ pdsDown: true }, { constellationDown: true }]) {
      const h = createGardenHandlers({ fetch: fakeFetch({ ...gardenNet(), ...trouble }), now: () => NOW, log: () => undefined });
      const res = await h.GET(new Request('https://atpota.to/api/garden'));
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('keeps a flower’s care when tending can’t be read, and once it has grown, never lowers it', async () => {
    const net = gardenNet();
    let now = NOW;
    const h = createGardenHandlers({ fetch: fakeFetch(net), now: () => now, log: () => undefined });
    const poppy = async () => ((await (await h.GET(new Request('https://atpota.to/api/garden'))).json()).flowers as Array<{ rkey: string; care: number }>).find((f) => f.rkey === 'p2')!.care;
    expect(await poppy()).toBe(0.86);
    // the index can't answer for tends a few minutes on: the last care stands
    net.tendsDown = true;
    now += 5 * 60_000;
    expect(await poppy()).toBe(0.86);
    // the poppy blooms on 21 October; after that its early tends falling out of the index don't count against it
    net.tendsDown = false;
    now = Date.parse('2026-10-22T00:00:00Z');
    expect(await poppy()).toBe(0.86);
    for (const key of Object.keys(net.records)) if (key.includes(TEND_NSID)) delete net.records[key];
    now += 5 * 60_000;
    expect(await poppy()).toBe(0.86);
  });

  it('only takes GET and HEAD', async () => {
    const res = await api.DELETE(new Request('https://atpota.to/api/garden', { method: 'DELETE' }));
    expect(res.status).toBe(405);
  });
});
