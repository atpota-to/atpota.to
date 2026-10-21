import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATPOTATO_SET, SCOPE } from '../src/blog/auth.js';
import { POE_LXM } from '../src/poe/identity.js';
import { PATCH_NSID, SPROUT_NSID, TEND_NSID } from '../src/scripts/garden-api.js';
import { PETS_NSID } from '../src/scripts/pet-sync.js';
import { OVERLAY_NSID } from '../src/overlay/config.js';
import { POE_FORGET_LXM } from '../src/scripts/settings.js';
import {
  authorityDomain,
  includedSets,
  LEXICON_DID,
  loadLexicons,
  main as publish,
  permissionSetProblems,
  SCHEMA_NSID,
  schemaRecord,
} from '../scripts/publish-lexicons.js';
import { AUTH_FULL, grants } from './lexicon-helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PDS = 'https://pds.atpota.to';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the lexicons in the repo', () => {
  it('are well formed, at the paths their ids say, and include the set the sign-in asks for', () => {
    const ids = loadLexicons(ROOT).map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining([ATPOTATO_SET, PATCH_NSID, SPROUT_NSID, TEND_NSID, PETS_NSID, OVERLAY_NSID]));
    expect(includedSets(SCOPE)).toEqual([ATPOTATO_SET]);
  });

  it("atpotato's set grants exactly what the site writes", () => {
    expect(grants(PATCH_NSID)).toEqual(['create', 'update', 'delete']);
    expect(grants(SPROUT_NSID)).toEqual(['create', 'delete']);
    expect(grants(TEND_NSID)).toEqual(['create']);
    expect(grants(PETS_NSID)).toEqual(['create', 'update']);
    expect(grants(OVERLAY_NSID)).toEqual(['create', 'update']);
    expect(AUTH_FULL.permissions.filter((p) => p.resource === 'rpc')).toEqual([{ type: 'permission', resource: 'rpc', lxm: [POE_LXM, POE_FORGET_LXM], aud: '*' }]);
    expect(AUTH_FULL.permissions).toHaveLength(6);
  });

  it('a set may only reach its own NSID group, without wildcards or resources sets cannot hold', () => {
    const set = (permissions: unknown[]) => ({ type: 'permission-set', title: 't', permissions });
    expect(permissionSetProblems('to.atpota.authFull', set([{ type: 'permission', resource: 'repo', collection: ['to.atpota.garden.tend'] }]))).toEqual([]);
    expect(permissionSetProblems('to.atpota.garden.authX', set([{ type: 'permission', resource: 'repo', collection: ['to.atpota.poe.pets'] }]))).toEqual([
      'to.atpota.poe.pets is outside to.atpota.garden',
    ]);
    expect(permissionSetProblems('to.atpota.authFull', set([{ type: 'permission', resource: 'repo', collection: ['*'] }]))[0]).toContain('not an NSID');
    expect(permissionSetProblems('to.atpota.authFull', set([{ type: 'permission', resource: 'blob', accept: ['*/*'] }]))).toContain("blob permissions can't be in a set");
    expect(permissionSetProblems('to.atpota.authFull', set([{ type: 'permission', resource: 'rpc', lxm: ['to.atpota.poe.chat'] }]))).toEqual(['rpc to.atpota.poe.chat has no aud']);
  });

  it('refuses a file in the wrong place or namespace', () => {
    const root = mkdtempSync(join(tmpdir(), 'lex-'));
    mkdirSync(join(root, 'lexicons/to/atpota'), { recursive: true });
    writeFileSync(join(root, 'lexicons/to/atpota/thing.json'), JSON.stringify({ lexicon: 1, id: 'com.example.thing', defs: { main: { type: 'record' } } }));
    expect(() => loadLexicons(root)).toThrow(/outside to\.atpota[\s\S]*belongs at lexicons\/com\/example\/thing\.json/);
  });

  it('authority domains come from all but the last NSID segment, reversed', () => {
    expect(authorityDomain('to.atpota.garden.tend')).toBe('garden.atpota.to');
    expect(authorityDomain('to.atpota.authFull')).toBe('atpota.to');
  });
});

/** A PDS holding `published` schema records (by NSID), and DNS pointing every _lexicon name at atpota.to unless listed in `noDns`. */
function world(published: Record<string, unknown> = {}, noDns: string[] = []) {
  const writes: { rkey: string; record: Record<string, unknown> }[] = [];
  const store = { ...published };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://plc.directory') return json(200, { service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] });
    switch (url.pathname) {
      case '/xrpc/com.atproto.server.createSession':
        return JSON.parse(String(init?.body)).password === 'good' ? json(200, { accessJwt: 'jwt', did: LEXICON_DID }) : json(401, { message: 'bad password' });
      case '/xrpc/com.atproto.repo.getRecord': {
        const value = store[url.searchParams.get('rkey')!];
        return value ? json(200, { value }) : json(400, { error: 'RecordNotFound' });
      }
      case '/xrpc/com.atproto.repo.putRecord': {
        const body = JSON.parse(String(init?.body)) as { rkey: string; collection: string; record: Record<string, unknown> };
        expect(body.collection).toBe(SCHEMA_NSID);
        store[body.rkey] = body.record;
        writes.push(body);
        return json(200, { uri: `at://${LEXICON_DID}/${SCHEMA_NSID}/${body.rkey}`, cid: 'bafy' });
      }
      case '/xrpc/com.atproto.repo.listRecords':
        return json(200, { records: Object.keys(store).map((id) => ({ uri: `at://${LEXICON_DID}/${SCHEMA_NSID}/${id}` })) });
    }
    return json(404, {});
  }) as typeof globalThis.fetch;
  const txt = async (name: string) => (noDns.includes(name) ? Promise.reject(new Error('ENODATA')) : [[`did=${LEXICON_DID}`]]);
  const lines: string[] = [];
  return { fetch, txt, writes, lines, log: (l: string) => lines.push(l) };
}

describe('publish-lexicons', () => {
  const all = () => Object.fromEntries(loadLexicons(ROOT).map((l) => [l.id, schemaRecord(l.doc)]));

  it('publishes what changed and leaves the rest', async () => {
    const current = all();
    delete current[PETS_NSID];
    current[TEND_NSID] = { ...current[TEND_NSID]!, description: 'old words' };
    current['to.atpota.retired'] = { $type: SCHEMA_NSID, id: 'to.atpota.retired' };
    const w = world(current);
    expect(await publish([], { ...w, root: ROOT, env: { ATP_APP_PASSWORD: 'good' } })).toBe(0);
    expect(w.writes.map((x) => x.rkey).sort()).toEqual([PETS_NSID, TEND_NSID].sort());
    expect(w.writes[0]!.record.$type).toBe(SCHEMA_NSID);
    expect(w.lines.join('\n')).toContain('to.atpota.retired: published, but no longer in lexicons/ (left as is)');

    const again = world(all());
    expect(await publish([], { ...again, root: ROOT, env: { ATP_APP_PASSWORD: 'good' } })).toBe(0);
    expect(again.writes).toHaveLength(0);
    expect(again.lines.at(-1)).toBe('all published and resolvable');
  });

  it('does nothing outside production builds', async () => {
    const w = world();
    expect(await publish(['--vercel'], { ...w, root: ROOT, env: { VERCEL_ENV: 'preview', ATP_APP_PASSWORD: 'good' } })).toBe(0);
    expect(w.writes).toHaveLength(0);
  });

  it('fails a production build when the sign-in set would not resolve, and only warns for the rest', async () => {
    const missingSet = world({}, ['_lexicon.atpota.to']);
    expect(await publish(['--vercel'], { ...missingSet, root: ROOT, env: { VERCEL_ENV: 'production' } })).toBe(1);
    expect(missingSet.lines).toContain(`error     add DNS  _lexicon.atpota.to  TXT  "did=${LEXICON_DID}"  (for ${ATPOTATO_SET})`);
    expect(missingSet.lines).toContain(`error     ${ATPOTATO_SET}: not published`);

    const gardenDnsOnly = world({}, ['_lexicon.garden.atpota.to']);
    expect(await publish(['--vercel'], { ...gardenDnsOnly, root: ROOT, env: { VERCEL_ENV: 'production', ATP_APP_PASSWORD: 'good' } })).toBe(0);
    expect(gardenDnsOnly.lines.some((l) => l.startsWith('warning   add DNS  _lexicon.garden.atpota.to'))).toBe(true);
  });

  it('stops on a bad password', async () => {
    const w = world();
    expect(await publish([], { ...w, root: ROOT, env: { ATP_APP_PASSWORD: 'nope' } })).toBe(1);
    expect(w.lines.join('\n')).toContain('sign-in failed (401): bad password');
    expect(w.writes).toHaveLength(0);
  });
});
