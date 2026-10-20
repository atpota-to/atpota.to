import { describe, expect, it } from 'vitest';
import { GARDEN_SUBJECT, PATCH_NSID, toPatch } from '../server/garden.js';
import { main, PATCH_COLS, PATCH_ROWS, planOverflow, planPatches, samePatch, seasonAt } from '../scripts/open-patches.js';
import { json } from './garden-net.js';

const at = (iso: string) => new Date(iso);

describe('planning the seasonal patches', () => {
  it('knows which season a day falls in, with winter named for the year it starts', () => {
    const name = (iso: string) => {
      const s = seasonAt(at(iso));
      return `${s.season} ${s.year}: ${s.opensAt.toISOString().slice(0, 10)} to ${s.closesAt.toISOString().slice(0, 10)}`;
    };
    expect(name('2026-10-20T12:00:00Z')).toBe('autumn 2026: 2026-09-01 to 2026-12-01');
    expect(name('2026-09-01T00:00:00Z')).toBe('autumn 2026: 2026-09-01 to 2026-12-01');
    expect(name('2026-08-31T23:59:59Z')).toBe('summer 2026: 2026-06-01 to 2026-09-01');
    expect(name('2026-12-01T00:00:00Z')).toBe('winter 2026: 2026-12-01 to 2027-03-01');
    expect(name('2027-02-28T23:00:00Z')).toBe('winter 2026: 2026-12-01 to 2027-03-01');
    expect(name('2027-03-01T00:00:00Z')).toBe('spring 2027: 2027-03-01 to 2027-06-01');
  });

  it('plans this season and the next three, as patches the garden accepts', () => {
    const plan = planPatches(at('2026-10-20T12:00:00Z'));
    expect(plan.map((p) => [p.rkey, p.record.name])).toEqual([
      ['2026-autumn', 'autumn 2026'],
      ['2026-winter', 'winter 2026'],
      ['2027-spring', 'spring 2027'],
      ['2027-summer', 'summer 2027'],
    ]);
    for (const p of plan) {
      expect(p.record).toMatchObject({ $type: PATCH_NSID, cols: PATCH_COLS, rows: PATCH_ROWS });
      expect(toPatch({ uri: `at://${GARDEN_SUBJECT}/${PATCH_NSID}/${p.rkey}`, cid: 'bafypatchcid', value: p.record })).not.toBeNull();
    }
    // back to back: each closes as the next opens
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.record.opensAt).toBe(plan[i - 1]!.record.closesAt);
  });

  it('adds overflow patches for a season that filled up, numbered after the ones there', () => {
    const now = at('2026-10-20T12:00:00Z');
    expect(planOverflow('2026-autumn', new Set(['2026-autumn']), now)).toMatchObject({
      rkey: '2026-autumn-2',
      record: { name: 'autumn 2026 (2)', season: 'autumn', opensAt: '2026-09-01T00:00:00.000Z', closesAt: '2026-12-01T00:00:00.000Z' },
    });
    expect(planOverflow('2026-autumn-2', new Set(['2026-autumn', '2026-autumn-2']), now)?.rkey).toBe('2026-autumn-3');
    expect(planOverflow('2026-winter', new Set(), now)?.record.closesAt).toBe('2027-03-01T00:00:00.000Z');
    expect(planOverflow('autumn', new Set(), now)).toBeNull();
  });

  it('a patch that only differs in createdAt is the same patch', () => {
    const [a] = planPatches(at('2026-10-20T12:00:00Z'));
    const [b] = planPatches(at('2026-10-21T12:00:00Z'));
    expect(samePatch(a!.record as never, b!.record as never)).toBe(true);
    expect(samePatch(a!.record as never, { ...b!.record, rows: 9 } as never)).toBe(false);
  });
});

describe('npm run garden:patches', () => {
  const PDS = 'https://pds.test';

  function network(existing: Record<string, Record<string, unknown>>, writes: Array<Record<string, unknown>>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'https://plc.directory') return json({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] });
      if (url.pathname.endsWith('listRecords')) return json({ records: Object.entries(existing).map(([rkey, value]) => ({ uri: `at://${GARDEN_SUBJECT}/${PATCH_NSID}/${rkey}`, value })) });
      if (url.pathname.endsWith('createSession')) return json({ accessJwt: 'jwt', did: GARDEN_SUBJECT });
      if (url.pathname.endsWith('putRecord')) {
        writes.push(JSON.parse(String(init!.body)));
        return json({ uri: 'at://x' });
      }
      return json({ error: 'unexpected' }, 404);
    }) as typeof fetch;
  }

  it('a dry run writes nothing', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const lines: string[] = [];
    const code = await main(['--dry-run'], { fetch: network({}, writes), log: (l) => lines.push(l), now: () => at('2026-10-20T12:00:00Z'), env: {} });
    expect(code).toBe(0);
    expect(writes).toEqual([]);
    expect(lines[0]).toBe(`dry run: 4 patches for atpota.to (${GARDEN_SUBJECT})`);
  });

  it('writes the missing patches, leaves a matching one alone, and keeps createdAt on a changed one', async () => {
    const now = at('2026-10-20T12:00:00Z');
    const [autumn, winter] = planPatches(at('2026-09-02T00:00:00Z'));
    const existing = { [autumn!.rkey]: autumn!.record, [winter!.rkey]: { ...winter!.record, rows: 4 } };
    const writes: Array<Record<string, unknown>> = [];
    const code = await main([], { fetch: network(existing as never, writes), log: () => undefined, now: () => now, env: { ATP_APP_PASSWORD: 'app-pass' } });
    expect(code).toBe(0);
    expect(writes.map((w) => w.rkey)).toEqual(['2026-winter', '2027-spring', '2027-summer']);
    expect((writes[0]!.record as Record<string, unknown>).createdAt).toBe(winter!.record.createdAt);
    expect((writes[0]!.record as Record<string, unknown>).rows).toBe(PATCH_ROWS);
  });

  it('needs an app password, and an overflow patch needs a season patch to follow', async () => {
    const log: string[] = [];
    expect(await main([], { fetch: network({}, []), log: (l) => log.push(l), env: {} })).toBe(1);
    expect(log.at(-1)).toContain('ATP_APP_PASSWORD');
    expect(await main(['--overflow', '2026-autumn'], { fetch: network({}, []), log: (l) => log.push(l), env: { ATP_APP_PASSWORD: 'x' } })).toBe(1);
    expect(log.at(-1)).toContain('no patch 2026-autumn');
  });
});
