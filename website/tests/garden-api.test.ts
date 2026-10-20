import { describe, expect, it } from 'vitest';
import { SCOPE, type Session } from '../src/blog/auth.js';
import { grants } from './lexicon-helpers.js';
import { putRecord, RepoError } from '../src/blog/repo.js';
import { gardenRecord, OWN_PATCH_RKEY, PATCH_NSID, saveGarden } from '../src/scripts/garden-api.js';

// Writing your own garden: putRecord at a record key you choose, in your own repo only.

const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';

function session(calls: Array<{ path: string; body: unknown }>, respond: (path: string, body: Record<string, unknown>) => Response): Session {
  return {
    did: ME,
    pds: 'https://pds.me.test',
    fetch: async (path, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      return respond(path, body);
    },
    signOut: async () => undefined,
  };
}

describe('your own garden', () => {
  it('putRecord writes at the record key asked for, and checks the answer is that record', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const s = session(calls, (_path, body) => Response.json({ uri: `at://${ME}/${String(body.collection)}/${String(body.rkey)}`, cid: 'bafynew' }));
    await expect(putRecord(s, 'x.y.z', 'self', { $type: 'x.y.z' })).resolves.toEqual({ uri: `at://${ME}/x.y.z/self`, cid: 'bafynew' });
    expect(calls).toEqual([{ path: '/xrpc/com.atproto.repo.putRecord', body: { repo: ME, collection: 'x.y.z', rkey: 'self', record: { $type: 'x.y.z' } } }]);

    for (const uri of [`at://${OTHER}/x.y.z/self`, `at://${ME}/x.y.z/other`, `at://${ME}/a.b.c/self`, 'nonsense']) {
      const odd = session([], () => Response.json({ uri, cid: 'bafynew' }));
      await expect(putRecord(odd, 'x.y.z', 'self', {}), uri).rejects.toThrow('bad putRecord response');
    }
    const refused = session([], () => Response.json({ error: 'InvalidRequest' }, { status: 400 }));
    const error = await putRecord(refused, 'x.y.z', 'self', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoError);
    expect((error as RepoError).message).toBe('InvalidRequest');
  });

  it('saveGarden puts the garden record at "self"', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const s = session(calls, (_path, body) => Response.json({ uri: `at://${ME}/${String(body.collection)}/${String(body.rkey)}`, cid: 'bafygarden' }));
    const record = gardenRecord({ name: 'my patch', note: 'say hi', cols: 8, rows: 6 }, new Date('2026-10-20T12:00:00Z'));
    expect(await saveGarden(s, record)).toEqual({ uri: `at://${ME}/${PATCH_NSID}/${OWN_PATCH_RKEY}`, cid: 'bafygarden' });
    expect(calls[0]!.body).toEqual({
      repo: ME,
      collection: PATCH_NSID,
      rkey: 'self',
      record: { $type: PATCH_NSID, name: 'my patch', note: 'say hi', cols: 8, rows: 6, createdAt: '2026-10-20T12:00:00.000Z' },
    });
  });

  it('signing in asks to keep a garden: create, update and delete', () => {
    expect(SCOPE.split(' ')).toContain('include:to.atpota.authFull');
    expect(grants(PATCH_NSID)).toEqual(['create', 'update', 'delete']);
  });
});
