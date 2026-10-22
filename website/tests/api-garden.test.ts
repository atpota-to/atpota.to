import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api/garden.js';
import { CONSTELLATION, resetDiscussionCaches, SLINGSHOT } from '../server/blog/discussion.js';
import {
  CACHE_INDEX,
  CACHE_OK,
  careFrom,
  createGardenHandlers,
  defaultPatch,
  FLOWER_KINDS,
  GARDEN_SUBJECT,
  GROW_DAYS,
  isFresh,
  isOpen,
  isThirsty,
  MAX_COLS,
  MAX_PLOTS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  NAME_MAX,
  onePerAccount,
  NOTE_MAX,
  OWN_PATCH_RKEY,
  parsePatchUri,
  PATCH_NSID,
  PLANTING,
  resolvePlots,
  reveal,
  SEASONS,
  sourceFrom,
  SPROUT_DAYS,
  SPROUT_NSID,
  stageFor,
  TEND_ACTIONS,
  TEND_NSID,
  tidTime,
  toGrowth,
  toOwner,
  toPatch,
  toSprout,
  type Growth,
  type PatchSummary,
} from '../server/garden.js';
import * as flowers from '../src/scripts/flowers.js';
import * as client from '../src/scripts/garden.js';
import { CID, DAY, did, fakeFetch, gardenRecord as ownGarden, patchCid, patchRecord, patchUri, sprout, tendOf, tid, type IndexState, type Net } from './garden-net.js';

// /api/garden against a scripted network (tests/garden-net.ts): a PDS lists each owner's
// patches (atpotato's seasonal ones, and other people's own gardens), Constellation the
// sprouts in each and the tends on each flower, Slingshot serves each record, and the
// AppView names the accounts.

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const lexicon = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../lexicons/to/atpota/garden/${name}.json`, import.meta.url)), 'utf8'));
const patchEntry = (rkey: string, value: Record<string, unknown>, uri = patchUri(rkey)) => ({ uri, cid: 'bafypatchcid', value });
/** atpotato when the AppView has no profile for it. */
const ATPOTATO = { did: GARDEN_SUBJECT, handle: 'atpota.to', displayName: 'atpotato', avatar: null };

beforeEach(() => resetDiscussionCaches());

describe('patch records', () => {
  it('accepts well-formed patches from the repo they are said to be in', () => {
    const autumn = patchRecord('autumn 2026', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z');
    expect(toPatch(patchEntry('2026-autumn', autumn))).toEqual({
      owner: GARDEN_SUBJECT,
      rkey: '2026-autumn',
      uri: patchUri('2026-autumn'),
      cid: 'bafypatchcid',
      name: 'autumn 2026',
      note: null,
      season: 'autumn',
      cols: 12,
      rows: 8,
      opensAt: '2026-09-01T00:00:00.000Z',
      closesAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      planting: 'one',
    });
    expect(toPatch(patchEntry('x', autumn, `at://${did(1)}/${PATCH_NSID}/x`))).toBeNull();
    // an unknown season is just no season, and unknown planting is one each
    expect(toPatch(patchEntry('x', { ...autumn, season: 'monsoon' }))?.season).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, planting: 'many' }))?.planting).toBe('many');
    expect(toPatch(patchEntry('x', { ...autumn, planting: 'move' }))?.planting).toBe('move');
    expect(toPatch(patchEntry('x', { ...autumn, planting: 'loads' }))?.planting).toBe('one');
    expect(toPatch(patchEntry('x', { ...autumn, createdAt: undefined }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, opensAt: 'soon' }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, cols: MAX_COLS + 1 }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, rows: 1.5 }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, closesAt: autumn.opensAt }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, name: 'a'.repeat(41) }))).toBeNull();
    expect(toPatch(patchEntry('x', { ...autumn, name: '  ' }))).toBeNull();
  });

  it('a garden of someone’s own: no season or dates, open from when it was made, with a note', () => {
    const uri = patchUri(OWN_PATCH_RKEY, did(1));
    const mine = ownGarden('dame’s garden', 6, 4, { note: '  plant\nsomething   cheerful!\u202e ' });
    const p = toPatch(patchEntry(OWN_PATCH_RKEY, mine, uri), did(1))!;
    expect(p).toEqual({
      owner: did(1),
      rkey: 'self',
      uri,
      cid: 'bafypatchcid',
      name: 'dame’s garden',
      note: 'plant something cheerful!',
      season: null,
      cols: 6,
      rows: 4,
      opensAt: null,
      closesAt: null,
      createdAt: '2026-09-15T00:00:00.000Z',
      planting: 'one',
    });
    expect(isOpen(p, NOW)).toBe(true);
    expect(isOpen(p, Date.parse('2026-09-14T00:00:00Z'))).toBe(false);
    // closing it presses it
    const closed = toPatch(patchEntry(OWN_PATCH_RKEY, { ...mine, closesAt: '2026-10-01T00:00:00Z' }, uri), did(1))!;
    expect(isOpen(closed, NOW)).toBe(false);
    expect(toPatch(patchEntry(OWN_PATCH_RKEY, { ...mine, closesAt: '2026-09-01T00:00:00Z' }, uri), did(1))).toBeNull();
    // a long note is cut to NOTE_MAX graphemes (one family emoji is one)
    const long = toPatch(patchEntry(OWN_PATCH_RKEY, { ...mine, note: '👨‍👩‍👧'.repeat(NOTE_MAX + 5) }, uri), did(1))!;
    expect(long.note).toBe('👨‍👩‍👧'.repeat(NOTE_MAX));
    expect(toPatch(patchEntry(OWN_PATCH_RKEY, { ...mine, name: '🌻'.repeat(NAME_MAX) }, uri), did(1))?.name).toBe('🌻'.repeat(NAME_MAX));
    expect(parsePatchUri(uri)).toEqual({ owner: did(1), rkey: 'self' });
    expect(parsePatchUri(`at://${did(1)}/${SPROUT_NSID}/self`)).toBeNull();
  });

  it('owners come from the AppView: hidden accounts, and answers for someone else, are nobody', () => {
    const view = { did: did(1), handle: 'Dame.IS', displayName: '  Dame  ', avatar: 'https://cdn.bsky.app/a.jpg' };
    expect(toOwner(view, did(1))).toEqual({ did: did(1), handle: 'dame.is', displayName: 'Dame', avatar: 'https://cdn.bsky.app/a.jpg' });
    expect(toOwner(view, 'dame.is')).toMatchObject({ did: did(1) });
    expect(toOwner(view, 'other.test')).toBeNull();
    expect(toOwner(view, did(2))).toBeNull();
    expect(toOwner({ ...view, avatar: 'http://cdn.bsky.app/a.jpg', displayName: '' }, did(1))).toMatchObject({ avatar: null, displayName: null });
    expect(toOwner({ ...view, labels: [{ val: '!hide' }] }, did(1))).toBeNull();
    expect(toOwner({ ...view, labels: [{ val: '!no-unauthenticated', src: did(1) }] }, did(1))).toMatchObject({ did: did(1) });
    expect(toOwner({ ...view, handle: 'handle.invalid' }, did(1))).toMatchObject({ handle: did(1) });
  });

  it('the lexicons describe the same records', () => {
    const patch = lexicon('patch');
    expect(patch.id).toBe(PATCH_NSID);
    expect(patch.defs.main.key).toBe('any');
    expect(patch.defs.main.record.properties.season.knownValues).toEqual([...SEASONS]);
    expect([patch.defs.main.record.properties.cols.minimum, patch.defs.main.record.properties.cols.maximum]).toEqual([MIN_COLS, MAX_COLS]);
    expect([patch.defs.main.record.properties.rows.minimum, patch.defs.main.record.properties.rows.maximum]).toEqual([MIN_ROWS, MAX_ROWS]);
    expect(patch.defs.main.record.properties.name.maxGraphemes).toBe(NAME_MAX);
    expect(patch.defs.main.record.properties.note.maxGraphemes).toBe(NOTE_MAX);
    expect(patch.defs.main.record.properties.planting.knownValues).toEqual([...PLANTING]);
    expect(patch.defs.main.record.properties.planting.description).toContain(`Without it, "${PLANTING[0]}"`);
    expect(patch.defs.main.record.required).toEqual(['name', 'cols', 'rows', 'createdAt']);

    const sprouted = lexicon('sprout');
    expect(sprouted.id).toBe(SPROUT_NSID);
    expect(sprouted.defs.main.record.required).toEqual(['patch', 'kind', 'plot', 'createdAt']);
    expect(sprouted.defs.main.record.properties.patch.ref).toBe('com.atproto.repo.strongRef');
    expect(sprouted.defs.main.record.properties.patch.description).toContain(GARDEN_SUBJECT);
    expect(sprouted.defs.main.record.properties.patch.description).toContain('garden owner');
    expect(sprouted.defs.main.record.properties.kind.knownValues).toEqual([...FLOWER_KINDS, 'seed']);
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

  it('keeps one flower per account across the open patches: its first (one each), or its newest (moving)', () => {
    const s = (d: string, rkey: string, plantedAt: string) => ({ did: d, rkey, uri: `at://${d}/${SPROUT_NSID}/${rkey}`, cid: CID, kind: 'rose' as const, plot: 0, plantedAt });
    const all = [s(did(1), 'b', '2026-10-05T00:00:00Z'), s(did(1), 'a', '2026-10-01T00:00:00Z'), s(did(2), 'c', '2026-10-02T00:00:00Z')];
    expect([...onePerAccount(all, 'first')].sort()).toEqual([`at://${did(1)}/${SPROUT_NSID}/a`, `at://${did(2)}/${SPROUT_NSID}/c`]);
    expect([...onePerAccount(all, 'newest')].sort()).toEqual([`at://${did(1)}/${SPROUT_NSID}/b`, `at://${did(2)}/${SPROUT_NSID}/c`]);
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
    expect([...client.PLANTING]).toEqual([...PLANTING]);
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
    expect(client.patchUri('self', did(1))).toBe(patchUri('self', did(1)));
    expect([client.OWN_PATCH_RKEY, client.NAME_MAX, client.NOTE_MAX, client.MIN_COLS, client.MIN_ROWS]).toEqual([OWN_PATCH_RKEY, NAME_MAX, NOTE_MAX, MIN_COLS, MIN_ROWS]);
    expect(client.GARDEN_SIZE.cols).toBeGreaterThanOrEqual(MIN_COLS);
    expect(client.GARDEN_SIZE.rows).toBeGreaterThanOrEqual(MIN_ROWS);
  });

  it('your own garden’s record: limited by graphemes, inside the lexicon’s sizes, and the server reads it back', () => {
    const now = new Date(NOW);
    const record = client.gardenRecord({ name: '  🌷 my\n garden  ', note: `${'🌱'.repeat(NOTE_MAX + 3)}`, cols: 100, rows: 1, planting: 'one' }, now);
    expect(record).toEqual({ $type: PATCH_NSID, name: '🌷 my garden', note: '🌱'.repeat(NOTE_MAX), cols: MAX_COLS, rows: MIN_ROWS, createdAt: now.toISOString() });
    expect(client.gardenRecord({ name: '', note: '   ', cols: 8, rows: 6, createdAt: '2026-09-01T00:00:00.000Z', closesAt: null }, now)).toEqual({
      $type: PATCH_NSID,
      name: 'my garden',
      cols: 8,
      rows: 6,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(client.gardenRecord({ name: 'x'.repeat(50), cols: 6, rows: 4, closesAt: '2026-11-01T00:00:00.000Z' }, now)).toMatchObject({ name: 'x'.repeat(NAME_MAX), closesAt: '2026-11-01T00:00:00.000Z' });
    // one each is the default, so it's left out; many (or moving) is written
    const many = client.gardenRecord({ name: 'open house', cols: 6, rows: 4, planting: 'many' }, now);
    expect(many).toMatchObject({ planting: 'many' });
    expect(toPatch(patchEntry(OWN_PATCH_RKEY, many, patchUri(OWN_PATCH_RKEY, did(1))), did(1))?.planting).toBe('many');
    const uri = patchUri(OWN_PATCH_RKEY, did(1));
    expect(toPatch(patchEntry(OWN_PATCH_RKEY, record, uri), did(1))).toMatchObject({ name: '🌷 my garden', cols: MAX_COLS, rows: MIN_ROWS, note: '🌱'.repeat(NOTE_MAX) });
  });
});

/**
 * Three patches (one closed, two open, both moving flowers) and a winter one to come, with
 * flowers and tending.
 */
function gardenNet(): Net {
  const poppy = `at://${did(2)}/${SPROUT_NSID}/p2`;
  const poppyAt = Date.parse('2026-10-14T00:00:00Z');
  return {
    patches: {
      '2026-summer': patchRecord('summer 2026', '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', 4, 2, 'summer'),
      '2026-autumn': { ...patchRecord('autumn 2026', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z', 4, 2), planting: 'move' },
      '2026-autumn-2': { ...patchRecord('autumn 2026 (2)', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z', 4, 2), planting: 'move' },
      '2026-winter': patchRecord('winter 2026', '2026-12-01T00:00:00Z', '2027-03-01T00:00:00Z', 4, 2, 'winter'),
      broken: { name: 'no size' },
    },
    records: {
      // summer, closed: every flower stays, two of them did(1)'s
      [`${did(1)}/${SPROUT_NSID}/r1`]: sprout('2026-summer', 'rose', '2026-07-01T00:00:00Z', 0),
      [`${did(2)}/${SPROUT_NSID}/d2`]: sprout('2026-summer', 'daisy', '2026-07-05T00:00:00Z', 0),
      [`${did(1)}/${SPROUT_NSID}/t1`]: sprout('2026-summer', 'tulip', '2026-07-10T00:00:00Z', 1),
      // autumn: did(1)'s older flower gives way to its newer one in autumn-2 (it moved)
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
  family: 'flower',
  weather: null,
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
    expect(body.owner).toEqual(ATPOTATO);
    expect(body.patch).toEqual({
      rkey: '2026-autumn',
      uri: patchUri('2026-autumn'),
      cid: patchCid('2026-autumn', net.patches['2026-autumn']!),
      name: 'autumn 2026',
      note: null,
      season: 'autumn',
      cols: 4,
      rows: 2,
      opensAt: '2026-09-01T00:00:00.000Z',
      closesAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      planting: 'move',
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

  it('one each by default: an account’s first flower stays put, and a later one anywhere in the garden doesn’t show', async () => {
    const net = gardenNet();
    for (const rkey of ['2026-autumn', '2026-autumn-2']) delete net.patches[rkey]!.planting;
    const h = createGardenHandlers({ fetch: fakeFetch(net), now: () => NOW, log: () => undefined });
    const body = await (await h.GET(new Request('https://atpota.to/api/garden?patch=2026-autumn'))).json();
    expect(body.patch.planting).toBe('one');
    // did(1)'s violet, planted first, keeps its plot; its later daisy in autumn-2 isn't shown
    expect(body.flowers.map((f: { rkey: string; plot: number }) => [f.rkey, f.plot])).toEqual([
      ['u7', 7],
      ['v1', 3],
      ['p2', 5],
      ['s3', 6],
    ]);
    const second = await (await h.GET(new Request('https://atpota.to/api/garden?patch=2026-autumn-2'))).json();
    expect(second.flowers).toEqual([]);
    expect(second.patches.map((p: { rkey: string; planted: number }) => [p.rkey, p.planted])).toEqual([
      ['2026-summer', 3],
      ['2026-autumn', 4],
      ['2026-autumn-2', 0],
      ['2026-winter', 0],
    ]);
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
    expect(await res.json()).toEqual({ owner: ATPOTATO, patch: null, patches: [], flowers: [], total: 0, seeds: false });
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

/** gardenNet, plus gardens of people's own: did(1)'s (it blocks did(3)), and did(6)'s three. */
function peopleNet(): Net {
  const net = gardenNet();
  net.gardens = {
    [did(1)]: { self: ownGarden('one’s garden', 6, 4, { note: 'plant something cheerful' }) },
    [did(6)]: {
      self: ownGarden('six’s garden', 4, 2),
      spare: ownGarden('six’s spare', 4, 2, { createdAt: '2026-10-01T00:00:00Z' }),
      old: ownGarden('six’s old', 4, 2, { createdAt: '2026-06-01T00:00:00Z', closesAt: '2026-08-01T00:00:00Z' }),
    },
  };
  net.ownerBlocks = { [did(1)]: [did(3)] };
  Object.assign(net.records, {
    // in did(1)'s garden: did(3)'s goes (did(1) blocks it), and did(7)'s moves along from plot 4
    [`${did(2)}/${SPROUT_NSID}/g2`]: sprout('self', 'rose', '2026-10-12T00:00:00Z', 4, did(1)),
    [`${did(3)}/${SPROUT_NSID}/g3`]: sprout('self', 'tulip', '2026-10-13T00:00:00Z', 4, did(1)),
    [`${did(7)}/${SPROUT_NSID}/g7`]: sprout('self', 'daisy', '2026-10-16T00:00:00Z', 4, did(1)),
    // did(2) in both of did(6)'s open gardens: only the newest counts there
    [`${did(2)}/${SPROUT_NSID}/s6a`]: sprout('self', 'violet', '2026-10-02T00:00:00Z', 0, did(6)),
    [`${did(2)}/${SPROUT_NSID}/s6b`]: sprout('spare', 'poppy', '2026-10-05T00:00:00Z', 1, did(6)),
    // did(6)'s old garden, closed
    [`${did(7)}/${SPROUT_NSID}/o7`]: sprout('old', 'sunflower', '2026-07-01T00:00:00Z', 0, did(6)),
  });
  net.profiles = net.profiles.map((p) => (p.did === did(1) ? { ...p, displayName: 'One', avatar: 'https://cdn.bsky.app/one.jpg' } : p));
  net.profiles.push({ did: did(6), handle: 'six.test', avatar: 'http://insecure.test/six.jpg' });
  return net;
}

describe('seeds and what the garden settled', () => {
  const growth = (extra: Partial<Growth> = {}): Growth => ({
    plantedAt: '2026-10-10T00:00:00.000Z',
    species: 'storm-lily',
    plantWind: 4,
    plantMix: 1,
    grown: false,
    growWind: null,
    growMix: null,
    growApps: [],
    ...extra,
  });

  it('a seed is a seed until it blooms: a sprout shows nothing of it, a bud its family, the bloom what it grew into', () => {
    expect(toSprout({ cid: CID, value: sprout('2026-autumn', 'seed', '2026-10-10T00:00:00Z') }, did(1), 's1', NOW)).toMatchObject({ kind: 'seed' });
    const settled = growth({ grown: true, growWind: 3, growMix: 2, growApps: ['leaflet.pub'] });
    expect(reveal('seed', settled, 'sprout')).toEqual({ kind: 'seed', family: null, weather: { planted: { wind: 4, mix: 1 }, grew: null } });
    expect(reveal('seed', settled, 'bud')).toEqual({ kind: 'seed', family: 'flower', weather: { planted: { wind: 4, mix: 1 }, grew: null } });
    expect(reveal('seed', settled, 'bloom')).toEqual({ kind: 'storm-lily', family: 'flower', weather: { planted: { wind: 4, mix: 1 }, grew: { wind: 3, mix: 2, apps: ['leaflet.pub'] } } });
    // a cactus buds as a succulent; a bloom whose week isn't settled yet has no week
    expect(reveal('seed', growth({ species: 'cactus' }), 'bud').family).toBe('succulent');
    expect(reveal('seed', growth({ species: 'cactus' }), 'bloom')).toEqual({ kind: 'cactus', family: 'succulent', weather: { planted: { wind: 4, mix: 1 }, grew: null } });
    // nothing settled, or something the browser can't draw: still a seed
    expect(reveal('seed', null, 'bloom')).toEqual({ kind: 'seed', family: null, weather: null });
    expect(reveal('seed', undefined, 'bud')).toEqual({ kind: 'seed', family: null, weather: null });
    expect(reveal('seed', growth({ species: 'triffid' }), 'bloom')).toMatchObject({ kind: 'seed', family: null });
    // no weather recorded either time
    expect(reveal('seed', growth({ plantWind: null, plantMix: null, grown: true }), 'bloom').weather).toEqual({ planted: null, grew: null });
    // a picked kind is what it is from the start, and remembers its weather all the same
    expect(reveal('poppy', settled, 'sprout')).toEqual({ kind: 'poppy', family: 'flower', weather: { planted: { wind: 4, mix: 1 }, grew: null } });
    expect(reveal('poppy', settled, 'bloom').weather?.grew).toEqual({ wind: 3, mix: 2, apps: ['leaflet.pub'] });
  });

  it('checks what the index says was settled', () => {
    const row = { plantedAt: '2026-10-10T00:00:00+00:00', species: 'lotus', plantWind: 0, plantMix: 1, grown: true, growWind: 2, growMix: 4, growApps: ['leaflet.pub', 'Not A Domain', 7, 'tangled.org'] };
    expect(toGrowth(row)).toEqual({ ...row, plantedAt: '2026-10-10T00:00:00.000Z', growApps: ['leaflet.pub', 'tangled.org'] });
    expect(toGrowth({ ...row, plantWind: 5, growMix: -1, grown: 'yes' })).toMatchObject({ plantWind: null, growMix: null, grown: false });
    expect(toGrowth({ ...row, plantedAt: 'whenever' })).toBeNull();
    expect(toGrowth({ ...row, species: 'x'.repeat(65) })).toBeNull();
    expect(toGrowth(null)).toBeNull();
  });

  it('reads from the index only when told to, and only while its heartbeat is fresh and it has finished a backfill', () => {
    expect(sourceFrom({})).toBe('constellation');
    expect(sourceFrom({ GARDEN_SOURCE: ' Index ' })).toBe('index');
    expect(sourceFrom({ GARDEN_SOURCE: 'shadow' })).toBe('shadow');
    expect(sourceFrom({ GARDEN_SOURCE: 'everything' })).toBe('constellation');
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(isFresh({ heartbeat_at: iso(NOW - 60_000), backfilled_at: iso(NOW - DAY) }, NOW)).toBe(true);
    expect(isFresh({ heartbeat_at: iso(NOW - 6 * 60_000), backfilled_at: iso(NOW - DAY) }, NOW)).toBe(false);
    expect(isFresh({ heartbeat_at: iso(NOW - 60_000), backfilled_at: null }, NOW)).toBe(false);
    expect(isFresh({ heartbeat_at: iso(NOW + 10 * 60_000), backfilled_at: iso(NOW - DAY) }, NOW)).toBe(false);
    expect(isFresh(null, NOW)).toBe(false);
  });
});

describe('/api/garden from the garden index', () => {
  const fresh = (extra: Partial<IndexState> = {}): IndexState => ({ heartbeatAt: new Date(NOW - 60_000).toISOString(), backfilledAt: '2026-10-20T00:00:00.000Z', ...extra });
  const handlersFor = (net: Net, source: string, log: (f: { event: string }) => void = () => undefined) =>
    createGardenHandlers({ fetch: fakeFetch(net), now: () => NOW, log, env: { GARDEN_SOURCE: source } });
  // Records from Constellation's links and Slingshot's records (Slingshot still resolves identities).
  const fromNetwork = (net: Net) => (net.calls ?? []).some((c) => c.startsWith(CONSTELLATION) || (c.startsWith(SLINGSHOT) && c.endsWith('getRecord')));
  const poppyAt = Date.parse('2026-10-14T00:00:00Z');
  const autumn = [
    flower(did(7), 'u7', 'seven.test', 'tulip', 7, '2026-09-02T00:00:00.000Z', { thirsty: true }),
    flower(did(2), 'p2', 'two.test', 'poppy', 5, '2026-10-14T00:00:00.000Z', { care: 0.86, helpers: 3, lastTended: new Date(poppyAt + 3 * DAY).toISOString() }),
    flower(did(3), 's3', 'three.test', 'sunflower', 6, '2026-10-18T00:00:00.000Z'),
  ];

  it('reads patches, sprouts and tending from the index, and shows the same garden as the network does', async () => {
    const net = { ...gardenNet(), index: fresh(), calls: [] as string[] };
    const res = await handlersFor(net, 'index').GET(new Request('https://atpota.to/api/garden'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_INDEX);
    const body = await res.json();
    expect(body.patch).toMatchObject({ rkey: '2026-autumn', open: true });
    expect(body.patches.map((p: PatchSummary) => [p.rkey, p.planted])).toEqual([
      ['2026-summer', 3],
      ['2026-autumn', 3],
      ['2026-autumn-2', 1],
      ['2026-winter', 0],
    ]);
    expect(body.flowers).toEqual(autumn);
    expect(body.seeds).toBe(true);
    expect(fromNetwork(net)).toBe(false);
  });

  it('grows seeds as the index settled them, and shows each only as far as it has grown', async () => {
    const net: Net = {
      patches: { open: { ...patchRecord('autumn 2026', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z', 4, 2), planting: 'many' } },
      records: {
        [`${did(1)}/${SPROUT_NSID}/a1`]: sprout('open', 'seed', '2026-10-19T12:00:00Z', 0),
        [`${did(2)}/${SPROUT_NSID}/b2`]: sprout('open', 'seed', '2026-10-17T00:00:00Z', 1),
        [`${did(3)}/${SPROUT_NSID}/c3`]: sprout('open', 'seed', '2026-10-12T00:00:00Z', 2),
        [`${did(7)}/${SPROUT_NSID}/d7`]: sprout('open', 'seed', '2026-10-12T00:00:00Z', 3),
      },
      profiles: [
        { did: did(1), handle: 'one.test' },
        { did: did(2), handle: 'two.test' },
        { did: did(3), handle: 'three.test' },
        { did: did(7), handle: 'seven.test' },
      ],
      index: fresh({
        growth: {
          [`at://${did(1)}/${SPROUT_NSID}/a1`]: { plantedAt: '2026-10-19T12:00:00Z', species: 'lotus', plantWind: 0, plantMix: 1, grown: false, growWind: null, growMix: null, growApps: [] },
          [`at://${did(2)}/${SPROUT_NSID}/b2`]: { plantedAt: '2026-10-17T00:00:00Z', species: 'toadstool', plantWind: 2, plantMix: 1, grown: false, growWind: null, growMix: null, growApps: [] },
          [`at://${did(3)}/${SPROUT_NSID}/c3`]: { plantedAt: '2026-10-12T00:00:00Z', species: 'prism-aster', plantWind: 2, plantMix: 4, grown: true, growWind: 1, growMix: 3, growApps: ['leaflet.pub', 'tangled.org', 'frontpage.fyi'] },
        },
      }),
    };
    const body = await (await handlersFor(net, 'index').GET(new Request('https://atpota.to/api/garden'))).json();
    const by = Object.fromEntries(body.flowers.map((f: { rkey: string }) => [f.rkey, f]));
    expect(by.a1).toMatchObject({ kind: 'seed', family: null, weather: { planted: { wind: 0, mix: 1 }, grew: null } });
    expect(by.b2).toMatchObject({ kind: 'seed', family: 'fungus' });
    expect(by.c3).toMatchObject({ kind: 'prism-aster', family: 'flower', weather: { planted: { wind: 2, mix: 4 }, grew: { wind: 1, mix: 3, apps: ['leaflet.pub', 'tangled.org', 'frontpage.fyi'] } } });
    // in bloom, but nothing settled yet: still a seed
    expect(by.d7).toMatchObject({ kind: 'seed', family: null, weather: null });
  });

  it('reads from the network when the heartbeat is old, the backfill unfinished, or the index down', async () => {
    for (const index of [fresh({ heartbeatAt: new Date(NOW - 10 * 60_000).toISOString() }), fresh({ backfilledAt: null }), fresh({ down: true })]) {
      resetDiscussionCaches();
      const net = { ...gardenNet(), index, calls: [] as string[] };
      const body = await (await handlersFor(net, 'index').GET(new Request('https://atpota.to/api/garden'))).json();
      expect(body.flowers).toEqual(autumn);
      expect(fromNetwork(net)).toBe(true);
    }
  });

  it('in shadow, serves the network’s garden and logs where the index differs', async () => {
    const logs: Array<{ event: string; [k: string]: unknown }> = [];
    const missing = `at://${did(3)}/${SPROUT_NSID}/s3`;
    const net = { ...gardenNet(), index: fresh({ missing: [missing] }), calls: [] as string[] };
    const res = await handlersFor(net, 'shadow', (f) => logs.push(f)).GET(new Request('https://atpota.to/api/garden'));
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    const body = await res.json();
    expect(body.flowers).toEqual(autumn);
    expect(body.seeds).toBe(false);
    expect(fromNetwork(net)).toBe(true);
    expect(logs.find((l) => l.event === 'garden_shadow_diff' && l.patch === patchUri('2026-autumn'))).toMatchObject({ missing: [missing], extra: [] });
    expect(logs.some((l) => l.event === 'garden_shadow' && l.patch === patchUri('2026-summer'))).toBe(true);
  });

  it('what’s settled shows from the network too, and a garden without the index just has none', async () => {
    const poppy = `at://${did(2)}/${SPROUT_NSID}/p2`;
    const net = { ...gardenNet(), index: fresh({ growth: { [poppy]: { plantedAt: '2026-10-14T00:00:00Z', species: 'poppy', plantWind: 3, plantMix: 0, grown: false, growWind: null, growMix: null, growApps: [] } } }) };
    const body = await (await handlersFor(net, 'constellation').GET(new Request('https://atpota.to/api/garden'))).json();
    expect(body.flowers.find((f: { rkey: string }) => f.rkey === 'p2').weather).toEqual({ planted: { wind: 3, mix: 0 }, grew: null });
    resetDiscussionCaches();
    const down = await (await handlersFor({ ...gardenNet(), index: fresh({ down: true }) }, 'constellation').GET(new Request('https://atpota.to/api/garden'))).json();
    expect(down.flowers).toEqual(autumn);
  });

  it('tending by accounts atpotato blocks doesn’t count towards care, from the index or the network', async () => {
    for (const source of ['index', 'constellation']) {
      resetDiscussionCaches();
      // did(6) and did(7) helped with the poppy; blocked, only did(3) and did(9) count
      const net = { ...gardenNet(), index: fresh(), blocks: [did(5), did(6), did(7)] };
      const body = await (await handlersFor(net, source).GET(new Request('https://atpota.to/api/garden'))).json();
      expect(body.flowers.find((f: { rkey: string }) => f.rkey === 'p2')).toMatchObject({ care: 0.71, helpers: 2 });
    }
  });
});

describe('anyone’s garden', () => {
  const handlers = (net = peopleNet()) => createGardenHandlers({ fetch: fakeFetch(net), now: () => NOW, log: () => undefined });
  const get = async (h: ReturnType<typeof handlers>, query: string) => {
    const res = await h.GET(new Request(`https://atpota.to/api/garden?${query}`));
    return { status: res.status, body: await res.json() };
  };

  it('shows someone’s own garden, by handle or by DID, with who it belongs to', async () => {
    const net = peopleNet();
    const h = handlers(net);
    const { status, body } = await get(h, 'owner=one.test');
    expect(status).toBe(200);
    expect(body.owner).toEqual({ did: did(1), handle: 'one.test', displayName: 'One', avatar: 'https://cdn.bsky.app/one.jpg' });
    expect(body.patch).toEqual({
      rkey: 'self',
      uri: patchUri('self', did(1)),
      cid: patchCid('self', net.gardens![did(1)]!.self!),
      name: 'one’s garden',
      note: 'plant something cheerful',
      season: null,
      cols: 6,
      rows: 4,
      opensAt: null,
      closesAt: null,
      createdAt: '2026-09-15T00:00:00.000Z',
      planting: 'one',
      open: true,
    });
    expect(body.patches).toEqual([{ rkey: 'self', name: 'one’s garden', season: null, open: true, planted: 2, plots: 24, opensAt: null, closesAt: null }]);
    expect(body.flowers.map((f: { did: string; plot: number }) => [f.did, f.plot])).toEqual([
      [did(2), 4],
      [did(7), 5],
    ]);
    expect((await get(h, `owner=${did(1)}`)).body).toEqual(body);
    // atpotato's garden doesn't mind who did(1) blocks
    expect((await get(h, 'owner=atpota.to')).body.flowers.map((f: { rkey: string }) => f.rkey)).toEqual(['u7', 'p2', 's3']);
  });

  it('a garden that takes many keeps every flower each visitor plants; one each keeps their first', async () => {
    const net = peopleNet();
    net.records[`${did(2)}/${SPROUT_NSID}/g2b`] = sprout('self', 'daisy', '2026-10-17T00:00:00Z', 4, did(1));
    const plots = (body: { flowers: Array<{ rkey: string; plot: number }> }) => body.flowers.map((f) => [f.rkey, f.plot]);
    expect(plots((await get(handlers(net), 'owner=one.test')).body)).toEqual([
      ['g2', 4],
      ['g7', 5],
    ]);
    net.gardens![did(1)]!.self = ownGarden('one’s garden', 6, 4, { planting: 'many' });
    const { body } = await get(handlers(net), 'owner=one.test');
    expect(body.patch.planting).toBe('many');
    expect(plots(body)).toEqual([
      ['g2', 4],
      ['g7', 5],
      ['g2b', 6],
    ]);
    expect(body.patches[0].planted).toBe(3);
  });

  it('someone’s garden is their record at "self", read from Slingshot; other patch records aren’t gardens', async () => {
    const net = { ...peopleNet(), calls: [] as string[] };
    const h = handlers(net);
    const { body } = await get(h, 'owner=six.test');
    expect(body.owner).toEqual({ did: did(6), handle: 'six.test', displayName: null, avatar: null });
    expect(body.patches.map((p: { rkey: string; open: boolean; planted: number }) => [p.rkey, p.open, p.planted])).toEqual([['self', true, 1]]);
    expect(body.flowers.map((f: { rkey: string }) => f.rkey)).toEqual(['s6a']);
    expect((await get(h, 'owner=six.test&patch=spare')).status).toBe(404);
    // no listing of their repo: one record from Slingshot, and who they are from Slingshot too
    expect(net.calls.filter((c) => c.endsWith('com.atproto.repo.listRecords') && c.includes('pds.test'))).toHaveLength(2); // atpotato's and six's blocks
    expect(net.calls).toContain('https://slingshot.microcosm.blue/xrpc/com.atproto.repo.getRecord');
    expect(net.calls).toContain('https://slingshot.microcosm.blue/xrpc/com.bad-example.identity.resolveMiniDoc');
    expect(net.calls.some((c) => c.startsWith('https://plc.directory'))).toBe(false);
    // did(2)'s community flower is another garden's: it stays
    expect((await get(h, '')).body.flowers.map((f: { rkey: string }) => f.rkey)).toContain('p2');
  });

  it('someone the AppView doesn’t know is found through Slingshot; a taken-down account stays missing', async () => {
    const net = peopleNet();
    net.slingshotOnly = [{ did: did(8), handle: 'eight.test' }];
    net.gardens![did(8)] = { self: ownGarden('eight’s garden', 4, 2) };
    net.takenDown = ['taken.test'];
    net.slingshotOnly.push({ did: did(9), handle: 'taken.test' });
    const h = handlers(net);
    const { status, body } = await get(h, 'owner=eight.test');
    expect(status).toBe(200);
    expect(body.owner).toEqual({ did: did(8), handle: 'eight.test', displayName: null, avatar: null });
    expect(body.patch.name).toBe('eight’s garden');
    expect((await get(h, 'owner=taken.test')).status).toBe(404);
  });

  it('right after its keeper saves it, ?v=<cid> shows the new version even before Slingshot has it', async () => {
    const net = peopleNet();
    const fresh = ownGarden('the back yard', 6, 4);
    const before = net.gardens![did(1)]!.self!;
    net.gardens![did(1)]!.self = fresh;
    net.staleGardens = { [did(1)]: before };
    const h = handlers(net);
    expect((await get(h, 'owner=one.test')).body.patch.name).toBe('one’s garden');
    const saved = await get(h, `owner=one.test&v=${patchCid('self', fresh)}`);
    expect(saved.body.patch).toMatchObject({ name: 'the back yard', cid: patchCid('self', fresh) });
    expect((await get(h, 'owner=one.test&v=not%20a%20cid')).status).toBe(404);
  });

  it('someone without a garden yet has an empty one; nobody, junk, and hidden or blocked owners are a 404', async () => {
    const h = handlers();
    expect(await get(h, 'owner=seven.test')).toEqual({
      status: 200,
      body: { owner: { did: did(7), handle: 'seven.test', displayName: null, avatar: null }, patch: null, patches: [], flowers: [], total: 0, seeds: false },
    });
    for (const q of ['owner=nobody.test', 'owner=not%20a%20handle', 'owner=bob', `owner=${did(5)}`, `owner=${did(4)}`, 'owner=one.test&patch=nope', 'owner=seven.test&patch=self']) {
      expect((await get(h, q)).status, q).toBe(404);
    }
  });

  it('says 503 when an owner’s patches can’t be read', async () => {
    expect((await get(handlers({ ...peopleNet(), slingshotDown: true }), 'owner=one.test')).status).toBe(503);
    expect((await get(handlers({ ...peopleNet(), pdsDown: true }), 'owner=atpota.to')).status).toBe(503);
  });

  it('the browser reads anyone’s garden, and checks the patch is theirs', async () => {
    const h = handlers();
    const browserFetch = (async (input: RequestInfo | URL) => h.GET(new Request(new URL(String(input), 'https://atpota.to')))) as typeof fetch;
    const view = await client.fetchGarden(browserFetch, { owner: 'one.test' });
    expect(view?.owner).toEqual({ did: did(1), handle: 'one.test', displayName: 'One', avatar: 'https://cdn.bsky.app/one.jpg' });
    expect(view?.patch).toMatchObject({ rkey: 'self', note: 'plant something cheerful', season: null, opensAt: null, closesAt: null, planting: 'one', open: true });
    expect(view?.flowers.map((f) => f.rkey)).toEqual(['g2', 'g7']);
    expect(await client.fetchGarden(browserFetch, { owner: 'six.test', rkey: 'old' })).toBeNull();
    expect((await client.fetchGarden(browserFetch, '2026-summer'))?.patch?.rkey).toBe('2026-summer');
    expect((await client.fetchGarden(browserFetch))?.owner).toEqual(ATPOTATO);
    expect(await client.fetchGarden(browserFetch, { owner: 'nobody.test' })).toBeNull();
    // an answer whose patch isn't in its owner's repo is turned down; so is a bad avatar
    const lying = (async () => Response.json({ owner: { did: did(2), handle: 'two.test', displayName: null, avatar: 'javascript:alert(1)' }, patch: { ...view!.patch }, patches: [], flowers: [] })) as typeof fetch;
    const odd = await client.fetchGarden(lying, { owner: 'two.test' });
    expect(odd?.owner?.avatar).toBeNull();
    expect(odd?.patch).toBeNull();
  });
});
