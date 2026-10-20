// A scripted network for the garden's functions (/api/garden, /api/gardener): DID
// documents from plc.directory, one PDS for everyone (atpotato's patches and blocks, other
// people's gardens and blocks, and each person's own sprouts and tends), Constellation's
// backlinks, Slingshot's records and the AppView's profiles.

import { CONSTELLATION, SLINGSHOT } from '../server/blog/discussion.js';
import { GARDEN_SUBJECT, PATCH_NSID, SPROUT_NSID, TEND_NSID } from '../server/garden.js';

export const PDS = 'https://pds.test';
export const did = (n: number) => `did:plc:${'a'.repeat(23)}${'bcdefghijklmnopqrstuvwxyz'[n]}`; // base32, like a real did:plc
export const CID = 'bafyreigardencid';
export const DAY = 24 * 60 * 60 * 1000;

const S32 = '234567abcdefghijklmnopqrstuvwxyz';

/** A TID record key for a time (ms), like a PDS makes. */
export function tid(ms: number, clock = 0): string {
  let n = ((BigInt(ms) * 1000n) << 10n) | BigInt(clock);
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = S32[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface Net {
  /** atpotato's patch records, by rkey. */
  patches: Record<string, Record<string, unknown>>;
  /** Other people's patch records: owner DID -> rkey -> value. */
  gardens?: Record<string, Record<string, Record<string, unknown>>>;
  /** Accounts other owners block: owner DID -> blocked DIDs. */
  ownerBlocks?: Record<string, string[]>;
  /** Every record anyone has, "did/collection/rkey" -> value. */
  records: Record<string, Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  blocks?: string[];
  /** Index entries whose records say something else (or are gone). */
  extraLinks?: Array<{ target: string; did: string; collection: string; rkey: string }>;
  /** DIDs plc.directory doesn't know. */
  unknownDids?: string[];
  pdsDown?: boolean;
  constellationDown?: boolean;
  /** Constellation fails for tend lookups only. */
  tendsDown?: boolean;
  calls?: string[];
}

export const patchRecord = (name: string, opensAt: string, closesAt: string, cols = 12, rows = 8, season = 'autumn') => ({
  $type: PATCH_NSID,
  name,
  season,
  cols,
  rows,
  opensAt,
  closesAt,
  createdAt: '2026-08-01T00:00:00Z',
});

/** A garden of someone's own: no season, no dates, maybe a note. */
export const gardenRecord = (name: string, cols = 6, rows = 4, extra: Record<string, unknown> = {}) => ({
  $type: PATCH_NSID,
  name,
  cols,
  rows,
  createdAt: '2026-09-15T00:00:00Z',
  ...extra,
});

export const patchUri = (rkey: string, owner: string = GARDEN_SUBJECT) => `at://${owner}/${PATCH_NSID}/${rkey}`;

export const sprout = (patch: string, kind: string, createdAt: string, plot: unknown = 0, owner: string = GARDEN_SUBJECT) => ({
  $type: SPROUT_NSID,
  patch: { uri: patchUri(patch, owner), cid: CID },
  kind,
  plot,
  createdAt,
});

export const tendOf = (flowerUri: string, action = 'water') => ({
  $type: TEND_NSID,
  subject: { uri: flowerUri, cid: CID },
  action,
  createdAt: '2026-10-01T00:00:00Z',
});

/** Constellation's view of `records`: who links to `target` from `collection` through `path`. */
function linksTo(net: Net, target: string, collection: string, path: string): Array<{ did: string; collection: string; rkey: string }> {
  const out: Array<{ did: string; collection: string; rkey: string }> = [];
  for (const [key, value] of Object.entries(net.records)) {
    const [d, c, r] = [key.slice(0, key.indexOf('/')), key.split('/')[1]!, key.split('/')[2]!];
    if (c !== collection) continue;
    const field = path === '.patch.uri' ? (value.patch as { uri?: string })?.uri : path === '.subject.uri' ? (value.subject as { uri?: string })?.uri : undefined;
    if (field === target) out.push({ did: d, collection: c, rkey: r });
  }
  for (const l of net.extraLinks ?? []) if (l.target === target && l.collection === collection) out.push({ did: l.did, collection: l.collection, rkey: l.rkey });
  // newest index entries first
  return out.reverse();
}

export function fakeFetch(net: Net): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    net.calls?.push(`${url.origin}${url.pathname}`);
    if (url.origin === 'https://plc.directory') {
      const id = decodeURIComponent(url.pathname.slice(1));
      if (net.unknownDids?.includes(id)) return json({ message: 'DID not registered' }, 404);
      return json({ id, alsoKnownAs: [`at://${id === GARDEN_SUBJECT ? 'atpota.to' : `doc-${id.slice(-1)}.test`}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    }
    if (url.origin === PDS && url.pathname.endsWith('com.atproto.repo.listRecords')) {
      if (net.pdsDown) return new Response('down', { status: 503 });
      const repo = url.searchParams.get('repo')!;
      const collection = url.searchParams.get('collection')!;
      if (collection === PATCH_NSID) {
        const patches = repo === GARDEN_SUBJECT ? net.patches : (net.gardens?.[repo] ?? {});
        return json({ records: Object.entries(patches).map(([rkey, value]) => ({ uri: patchUri(rkey, repo), cid: `bafypatch${rkey.replace(/[^a-z0-9]/g, '')}`, value })) });
      }
      if (collection === 'app.bsky.graph.block') {
        const blocked = repo === GARDEN_SUBJECT ? (net.blocks ?? []) : (net.ownerBlocks?.[repo] ?? []);
        return json({ records: blocked.map((subject, i) => ({ uri: `at://${repo}/app.bsky.graph.block/b${i}`, cid: CID, value: { subject } })) });
      }
      const records = Object.entries(net.records)
        .filter(([key]) => key.startsWith(`${repo}/${collection}/`))
        .map(([key, value]) => ({ uri: `at://${key}`, cid: CID, value }))
        .reverse();
      return json({ records });
    }
    if (url.origin === CONSTELLATION) {
      if (net.constellationDown || (net.tendsDown && url.searchParams.get('collection') === TEND_NSID)) return new Response('down', { status: 503 });
      const links = linksTo(net, url.searchParams.get('target')!, url.searchParams.get('collection')!, url.searchParams.get('path')!);
      return json({ total: links.length, linking_records: links, cursor: null });
    }
    if (url.origin === SLINGSHOT) {
      const key = `${url.searchParams.get('repo')}/${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`;
      const value = net.records[key];
      return value ? json({ uri: `at://${key}`, cid: CID, value }) : json({ error: 'RecordNotFound' }, 404);
    }
    if (url.pathname.endsWith('app.bsky.actor.getProfile')) {
      const actor = url.searchParams.get('actor')!.toLowerCase();
      const found = net.profiles.find((p) => p.did === actor || String(p.handle).toLowerCase() === actor);
      return found ? json(found) : json({ error: 'InvalidRequest', message: 'Profile not found' }, 400);
    }
    if (url.pathname.endsWith('app.bsky.actor.getProfiles')) {
      const wanted = url.searchParams.getAll('actors');
      return json({ profiles: net.profiles.filter((p) => wanted.includes(p.did as string)) });
    }
    return json({ error: 'unexpected' }, 404);
  }) as typeof fetch;
}
