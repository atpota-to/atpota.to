import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api/garden.js';
import { CONSTELLATION, resetDiscussionCaches, SLINGSHOT } from '../server/blog/discussion.js';
import { CACHE_OK, createGardenHandlers, FLOWER_KINDS, GARDEN_SUBJECT, SPROUT_NSID, toSprout } from '../server/garden.js';
import * as client from '../src/scripts/garden.js';

// /api/garden against a scripted network: Constellation lists the sprouts, Slingshot
// serves each record, the AppView names the accounts, and atpotato's PDS has its blocks.

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const PDS = 'https://pds.test';
const did = (n: number) => `did:plc:${'a'.repeat(23)}${'bcdefghij'[n]}`; // base32, like a real did:plc

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Net {
  links: Array<{ did: string; rkey: string }>;
  records: Record<string, Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  blocks?: string[];
  constellationDown?: boolean;
}

function fakeFetch(net: Net): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin === 'https://plc.directory') {
      return json({ id: GARDEN_SUBJECT, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    }
    if (url.origin === PDS) {
      const records = (net.blocks ?? []).map((subject, i) => ({ uri: `at://${GARDEN_SUBJECT}/app.bsky.graph.block/b${i}`, cid: 'c', value: { subject } }));
      return json({ records });
    }
    if (url.origin === CONSTELLATION) {
      if (net.constellationDown) return new Response('down', { status: 503 });
      expect(url.searchParams.get('target')).toBe(GARDEN_SUBJECT);
      expect(url.searchParams.get('collection')).toBe(SPROUT_NSID);
      expect(url.searchParams.get('path')).toBe('.subject');
      return json({ total: net.links.length, linking_records: net.links.map((l) => ({ ...l, collection: SPROUT_NSID })) });
    }
    if (url.origin === SLINGSHOT) {
      const key = `${url.searchParams.get('repo')}/${url.searchParams.get('rkey')}`;
      const value = net.records[key];
      return value ? json({ uri: `at://${key}`, cid: 'c', value }) : json({ error: 'RecordNotFound' }, 404);
    }
    if (url.pathname.endsWith('app.bsky.actor.getProfiles')) {
      const wanted = url.searchParams.getAll('actors');
      return json({ profiles: net.profiles.filter((p) => wanted.includes(p.did as string)) });
    }
    return json({ error: 'unexpected' }, 404);
  }) as typeof fetch;
}

const sprout = (kind: string, createdAt = '2026-10-19T10:00:00Z') => ({ $type: SPROUT_NSID, subject: GARDEN_SUBJECT, kind, createdAt });

beforeEach(() => resetDiscussionCaches());

describe('sprout records', () => {
  it('accepts only flowers planted here, of a known kind, not from the future', () => {
    expect(toSprout({ value: sprout('rose') }, NOW)).toEqual({ kind: 'rose', plantedAt: '2026-10-19T10:00:00.000Z' });
    expect(toSprout({ value: { ...sprout('rose'), subject: did(9) } }, NOW)).toBeNull();
    expect(toSprout({ value: sprout('cactus') }, NOW)).toBeNull();
    expect(toSprout({ value: sprout('rose', '2027-01-01T00:00:00Z') }, NOW)).toBeNull();
    expect(toSprout({ value: { ...sprout('rose'), createdAt: 'yesterday' } }, NOW)).toBeNull();
  });

  it('the lexicon describes the same record', () => {
    const lexicon = JSON.parse(readFileSync(fileURLToPath(new URL('../lexicons/to/atpota/garden/sprout.json', import.meta.url)), 'utf8'));
    expect(lexicon.id).toBe(SPROUT_NSID);
    expect(lexicon.defs.main.record.properties.kind.knownValues).toEqual([...FLOWER_KINDS]);
    expect(lexicon.defs.main.record.properties.subject.description).toContain(GARDEN_SUBJECT);
  });

  it('the browser and the server agree on the record', () => {
    expect(client.SPROUT_NSID).toBe(SPROUT_NSID);
    expect(client.GARDEN_SUBJECT).toBe(GARDEN_SUBJECT);
    expect([...client.FLOWER_KINDS]).toEqual([...FLOWER_KINDS]);
    expect(toSprout({ value: client.sproutRecord('tulip', new Date(NOW - 1000)) }, NOW)?.kind).toBe('tulip');
  });
});

describe('/api/garden', () => {
  it('shows one flower per account, oldest first, and leaves out the ones it should', async () => {
    const net: Net = {
      // newest index entries first: did(1)'s current flower is "n1"
      links: [
        { did: did(1), rkey: 'n1' },
        { did: did(2), rkey: 'r2' },
        { did: did(1), rkey: 'o1' },
        { did: did(3), rkey: 'r3' },
        { did: did(4), rkey: 'r4' },
        { did: did(5), rkey: 'r5' },
        { did: did(6), rkey: 'r6' },
      ],
      records: {
        [`${did(1)}/n1`]: sprout('tulip', '2026-10-19T12:00:00Z'),
        [`${did(1)}/o1`]: sprout('rose', '2026-10-01T12:00:00Z'),
        [`${did(2)}/r2`]: sprout('daisy', '2026-10-18T12:00:00Z'),
        [`${did(3)}/r3`]: sprout('cactus'),
        [`${did(4)}/r4`]: sprout('poppy'),
        [`${did(5)}/r5`]: sprout('violet'),
        // did(6)'s record is gone
      },
      profiles: [
        { did: did(1), handle: 'one.test' },
        { did: did(2), handle: 'two.test' },
        { did: did(3), handle: 'three.test' },
        { did: did(4), handle: 'four.test', labels: [{ val: '!hide' }] },
        { did: did(5), handle: 'five.test' },
      ],
      blocks: [did(5)],
    };
    const h = createGardenHandlers({ fetch: fakeFetch(net), now: () => NOW, log: () => undefined });
    const res = await h.GET(new Request('https://atpota.to/api/garden'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    expect(await res.json()).toEqual({
      flowers: [
        { did: did(2), handle: 'two.test', kind: 'daisy', plantedAt: '2026-10-18T12:00:00.000Z' },
        { did: did(1), handle: 'one.test', kind: 'tulip', plantedAt: '2026-10-19T12:00:00.000Z' },
      ],
      total: 2,
    });
  });

  it('says 503 when the index is down, and is fine with an empty patch', async () => {
    const down = createGardenHandlers({ fetch: fakeFetch({ links: [], records: {}, profiles: [], constellationDown: true }), now: () => NOW, log: () => undefined });
    const res = await down.GET(new Request('https://atpota.to/api/garden'));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const empty = createGardenHandlers({ fetch: fakeFetch({ links: [], records: {}, profiles: [] }), now: () => NOW, log: () => undefined });
    expect(await (await empty.GET(new Request('https://atpota.to/api/garden'))).json()).toEqual({ flowers: [], total: 0 });
  });

  it('only takes GET and HEAD', async () => {
    const res = await api.DELETE(new Request('https://atpota.to/api/garden', { method: 'DELETE' }));
    expect(res.status).toBe(405);
  });
});
