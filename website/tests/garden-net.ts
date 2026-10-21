// A scripted network for the garden's functions (/api/garden, /api/gardener): DID
// documents from plc.directory, one PDS for everyone (atpotato's patches and blocks, other
// people's gardens and blocks, and each person's own sprouts and tends), Constellation's
// backlinks, Slingshot's records and the AppView's profiles; and the garden index in
// Supabase (garden/supabase/garden_index.sql), which holds the same records as everyone's
// repos unless told otherwise.

import { CONSTELLATION, SLINGSHOT } from '../server/blog/discussion.js';
import { GARDEN_SUBJECT, PATCH_NSID, SPROUT_NSID, TEND_NSID } from '../server/garden.js';
import { SUPABASE_URL } from '../server/supabase-public.js';

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
  /** DIDs plc.directory doesn't know (Slingshot doesn't either). */
  unknownDids?: string[];
  /** What Slingshot still has for someone's garden, before it catches up: owner DID -> value. */
  staleGardens?: Record<string, Record<string, unknown>>;
  /** Accounts only Slingshot knows (the AppView answers "profile not found"). */
  slingshotOnly?: Array<{ did: string; handle: string }>;
  slingshotDown?: boolean;
  /** Handles the AppView answers with AccountTakedown. */
  takenDown?: string[];
  pdsDown?: boolean;
  constellationDown?: boolean;
  /** Constellation fails for tend lookups only. */
  tendsDown?: boolean;
  calls?: string[];
  /** The garden index: absent, it answers what's settled (nothing) and an empty heartbeat. */
  index?: IndexState;
}

export interface IndexState {
  /** garden_status: the indexer's heartbeat and its last finished backfill. */
  heartbeatAt: string | null;
  backfilledAt: string | null;
  /** garden_growth rows, as the read functions answer them: sprout URI -> growth. */
  growth?: Record<string, Record<string, unknown>>;
  /** Records the index doesn't have yet (at:// URIs), and ones it has that are gone. */
  missing?: string[];
  extra?: Record<string, Record<string, unknown>>;
  /** When Jetstream first relayed a record, by at:// URI. */
  firstSeen?: Record<string, string>;
  down?: boolean;
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

/** The version of a patch record, as its CID: changes whenever the record does. */
export function patchCid(rkey: string, value: Record<string, unknown>): string {
  let h = 0;
  for (const c of JSON.stringify(value)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `bafypatch${rkey.replace(/[^a-z0-9]/g, '')}${h.toString(36)}`;
}

/** Someone's patch record by rkey (or `stale`, what a cache still has instead). */
function gardenAnswer(net: Net, repo: string, rkey: string, stale?: Record<string, unknown>): Response {
  const patches = repo === GARDEN_SUBJECT ? net.patches : (net.gardens?.[repo] ?? {});
  const value = stale ?? patches[rkey];
  return value ? json({ uri: patchUri(rkey, repo), cid: patchCid(rkey, value), value }) : json({ error: 'RecordNotFound' }, 400);
}

/** Every record the index holds, "did/collection/rkey" -> value. */
function indexed(net: Net): Array<[string, Record<string, unknown>]> {
  const missing = new Set(net.index?.missing ?? []);
  const all: Array<[string, Record<string, unknown>]> = [
    ...Object.entries(net.patches).map(([rkey, value]): [string, Record<string, unknown>] => [`${GARDEN_SUBJECT}/${PATCH_NSID}/${rkey}`, value]),
    ...Object.entries(net.gardens ?? {}).flatMap(([owner, patches]) => Object.entries(patches).map(([rkey, value]): [string, Record<string, unknown>] => [`${owner}/${PATCH_NSID}/${rkey}`, value])),
    ...Object.entries(net.records),
    ...Object.entries(net.index?.extra ?? {}),
  ];
  return all.filter(([key]) => !missing.has(`at://${key}`));
}

/** The garden index's answers: PostgREST reads and the read functions. */
function indexAnswer(net: Net, url: URL, body: Record<string, unknown>): Response {
  const state = net.index;
  if (state?.down) return new Response('down', { status: 503 });
  const status = state ? { id: 1, heartbeat_at: state.heartbeatAt, backfilled_at: state.backfilledAt, stream_at: state.heartbeatAt } : null;
  const growth = state?.growth ?? {};
  const rows = indexed(net).map(([key, value]) => {
    const [d, c, r] = [key.slice(0, key.indexOf('/')), key.split('/')[1]!, key.split('/')[2]!];
    const ref = c === SPROUT_NSID ? (value.patch as { uri?: string })?.uri : c === TEND_NSID ? (value.subject as { uri?: string })?.uri : null;
    const uri = `at://${key}`;
    return { uri, did: d, collection: c, rkey: r, cid: c === PATCH_NSID ? patchCid(r, value) : CID, record: value, ref_uri: ref ?? null };
  });
  const path = url.pathname.replace('/rest/v1/', '');
  if (path === 'garden_status') return json(status ? [status] : []);
  if (path === 'garden_records') {
    const collection = url.searchParams.get('collection')?.replace(/^eq\./, '');
    const owner = url.searchParams.get('did')?.replace(/^eq\./, '');
    return json(rows.filter((r) => r.collection === collection && r.did === owner).map((r) => ({ uri: r.uri, cid: r.cid, record: r.record })));
  }
  if (path === 'rpc/garden_sprouts') {
    const patches = (body.p_patches as string[]) ?? [];
    const sprouts = rows
      .filter((r) => r.collection === SPROUT_NSID && patches.includes(r.ref_uri ?? ''))
      .map((r) => ({ uri: r.uri, did: r.did, rkey: r.rkey, cid: r.cid, value: r.record, patch: r.ref_uri, firstSeenAt: state?.firstSeen?.[r.uri] ?? null, growth: growth[r.uri] ?? null }));
    return json({ status, sprouts });
  }
  if (path === 'rpc/garden_tends') {
    const flowers = (body.p_flowers as string[]) ?? [];
    return json(rows.filter((r) => r.collection === TEND_NSID && flowers.includes(r.ref_uri ?? '')).map((r) => ({ flower: r.ref_uri, did: r.did, rkey: r.rkey, action: r.record.action })));
  }
  if (path === 'rpc/garden_growth_of') {
    const flowers = (body.p_flowers as string[]) ?? [];
    return json({ status, growth: Object.fromEntries(flowers.filter((u) => growth[u]).map((u) => [u, growth[u]])) });
  }
  return json({ message: 'not found' }, 404);
}

export function fakeFetch(net: Net): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    net.calls?.push(`${url.origin}${url.pathname}`);
    if (url.origin === SUPABASE_URL) {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      return indexAnswer(net, url, body);
    }
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
        return json({ records: Object.entries(patches).map(([rkey, value]) => ({ uri: patchUri(rkey, repo), cid: patchCid(rkey, value), value })) });
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
      if (net.slingshotDown) return new Response('down', { status: 503 });
      if (url.pathname.endsWith('com.bad-example.identity.resolveMiniDoc')) {
        const id = url.searchParams.get('identifier')!.toLowerCase();
        const known = [...net.profiles.map((p) => ({ did: String(p.did), handle: String(p.handle) })), ...(net.slingshotOnly ?? [])];
        const found = known.find((p) => p.did === id || p.handle.toLowerCase() === id) ?? (id.startsWith('did:plc:') ? { did: id, handle: id === GARDEN_SUBJECT ? 'atpota.to' : `doc-${id.slice(-1)}.test` } : null);
        if (!found || net.unknownDids?.includes(found.did)) return json({ error: 'InvalidRequest', message: 'Errored while trying to resolve handle to DID' }, 400);
        return json({ did: found.did, handle: found.handle, pds: PDS, signing_key: 'z' });
      }
      const [repo, collection, rkey] = [url.searchParams.get('repo')!, url.searchParams.get('collection')!, url.searchParams.get('rkey')!];
      if (collection === PATCH_NSID) return gardenAnswer(net, repo, rkey, net.staleGardens?.[repo]);
      const key = `${repo}/${collection}/${rkey}`;
      const value = net.records[key];
      return value ? json({ uri: `at://${key}`, cid: CID, value }) : json({ error: 'RecordNotFound' }, 404);
    }
    if (url.origin === PDS && url.pathname.endsWith('com.atproto.repo.getRecord')) {
      if (net.pdsDown) return new Response('down', { status: 503 });
      const [repo, collection, rkey] = [url.searchParams.get('repo')!, url.searchParams.get('collection')!, url.searchParams.get('rkey')!];
      if (collection === PATCH_NSID) return gardenAnswer(net, repo, rkey);
      const value = net.records[`${repo}/${collection}/${rkey}`];
      return value ? json({ uri: `at://${repo}/${collection}/${rkey}`, cid: CID, value }) : json({ error: 'RecordNotFound' }, 400);
    }
    if (url.pathname.endsWith('app.bsky.actor.getProfile')) {
      const actor = url.searchParams.get('actor')!.toLowerCase();
      if (net.takenDown?.includes(actor)) return json({ error: 'AccountTakedown', message: 'Account has been taken down' }, 400);
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
