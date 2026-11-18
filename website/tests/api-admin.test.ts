import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminHandlers, readAdminConfig } from '../server/admin.js';
import { POE_ADMIN_LXM } from '../server/identity.js';
import type { IdentifyResult } from '../server/identity.js';

const ADMIN = 'did:plc:adminadminadminadminadmi';
const STRANGER = 'did:plc:strangerstrangerstranger';
const POE = 'did:plc:6qw63oash3jfnpykvpbwnq5z';
const ENV = {
  ADMIN_DIDS: `${ADMIN}, not-a-did`,
  ADMIN_SHARED_SECRET: 'admin-secret',
  WEBSITE_SHARED_SECRET: 'chat-secret',
  POE_AGENT_URL: 'https://agent.example',
  DROPLET_ADMIN_ORIGIN: 'https://droplet.example',
};

type Call = { url: string; init: RequestInit; headers: Headers; body: unknown };

function upstreams(answer: (url: string, body: unknown) => Response = () => Response.json({ ok: true })) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, headers: new Headers(init.headers), body });
    return answer(url, body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const as = (did: string | null) => async (_token: string): Promise<IdentifyResult> =>
  did ? { ok: true, visitor: { did, handle: 'someone.example' } } : { ok: false, reason: 'bad_signature' };

function handlers(env: Record<string, string>, did: string | null, fetchImpl: typeof fetch) {
  return createAdminHandlers({ env: () => env, fetch: fetchImpl, log: () => undefined, identify: as(did) });
}

const get = (query = 'view=overview', token: string | null = 'aaa.bbb.ccc') =>
  new Request(`https://atpota.to/api/admin?${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (body: unknown, headers: Record<string, string> = {}) => new Request('https://atpota.to/api/admin', {
  method: 'POST',
  headers: { authorization: 'Bearer aaa.bbb.ccc', 'content-type': 'application/json', origin: 'https://atpota.to', ...headers },
  body: JSON.stringify(body),
});

afterEach(() => vi.restoreAllMocks());

describe('admin config', () => {
  it('keeps only DIDs, and never uses the chat secret as the admin secret', () => {
    expect(readAdminConfig(ENV).admins).toEqual([ADMIN]);
    expect(readAdminConfig({ ...ENV, ADMIN_SHARED_SECRET: 'chat-secret' }).secret).toBeNull();
    expect(readAdminConfig({ ...ENV, DROPLET_ADMIN_ORIGIN: 'http://droplet.example' }).dropletUrl).toBeNull();
    expect(readAdminConfig({ ...ENV, DROPLET_ADMIN_ORIGIN: '' }).dropletUrl).toBe('https://hook.atpota.to');
  });
});

describe('/api/admin', () => {
  it('answers 503 until it is set up, 401 without a good admin token, 403 for anyone else', async () => {
    const { fetchImpl, calls } = upstreams();
    expect((await handlers({ ...ENV, ADMIN_SHARED_SECRET: '' }, ADMIN, fetchImpl).GET(get())).status).toBe(503);
    expect((await handlers(ENV, null, fetchImpl).GET(get())).status).toBe(401);
    expect((await handlers(ENV, ADMIN, fetchImpl).GET(get('view=overview', null))).status).toBe(401);
    expect((await handlers(ENV, STRANGER, fetchImpl).GET(get())).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('checks the token for its own method, so a chat or forget token never opens it', async () => {
    const asked: string[] = [];
    const { fetchImpl } = upstreams();
    const h = createAdminHandlers({ env: () => ENV, fetch: fetchImpl, log: () => undefined,
      identify: async (token) => (asked.push(token), { ok: true, visitor: { did: ADMIN, handle: null } }) });
    await h.GET(get());
    expect(asked).toEqual(['aaa.bbb.ccc']);
    expect(POE_ADMIN_LXM).toBe('to.atpota.poe.admin');
  });

  it('gathers the overview from the droplet and the bot, each with the admin secret and the DID', async () => {
    const { fetchImpl, calls } = upstreams((url) =>
      url.endsWith('/admin/state') ? Response.json({ stage: 4 })
        : url.endsWith('/admin/guidance') ? Response.json({ active: [], retired: [] })
          : url.endsWith('/admin/people') ? new Response('{}', { status: 502 })
            : Response.json({ slots: [] }));
    const res = await handlers(ENV, ADMIN, fetchImpl).GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.me).toEqual({ did: ADMIN, handle: 'someone.example' });
    expect(body.state).toEqual({ stage: 4 });
    expect(body.people).toEqual({ error: 'answered 502' });
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://agent.example/admin/memory', 'https://droplet.example/admin/guidance',
      'https://droplet.example/admin/people', 'https://droplet.example/admin/state']);
    for (const call of calls) {
      expect(call.headers.get('x-atpotato-admin-secret')).toBe('admin-secret');
      expect(call.headers.get('x-atpotato-admin-did')).toBe(ADMIN);
      expect(call.init.redirect).toBe('error');
    }
    expect(calls.find((c) => c.url.endsWith('/admin/memory'))!.body).toEqual({ action: 'overview', operators: [ADMIN], by: ADMIN });
  });

  it('lets Poe itself in', async () => {
    const { fetchImpl } = upstreams();
    expect((await handlers(ENV, POE, fetchImpl).GET(get())).status).toBe(200);
  });

  it('passes memory changes to the bot as the admin, and refuses ones the page never makes', async () => {
    const { fetchImpl, calls } = upstreams(() => Response.json({ slot: 'self', notes: [] }));
    const h = handlers(ENV, ADMIN, fetchImpl);
    const ok = await h.POST(post({ target: 'memory', call: { action: 'remove', slot: 'self', index: 3 } }));
    expect(ok.status).toBe(200);
    expect(calls[0]!.body).toEqual({ action: 'remove', slot: 'self', index: 3, by: ADMIN });
    expect((await h.POST(post({ target: 'memory', call: { action: 'overview', slot: 'self' } }))).status).toBe(400);
    expect((await h.POST(post({ target: 'memory', call: { action: 'add', slot: 'secrets', text: 'x' } }))).status).toBe(400);
    expect((await h.POST(post({ target: 'nope' }))).status).toBe(400);
  });

  it('refuses a POST from another origin or that is not JSON', async () => {
    const { fetchImpl, calls } = upstreams();
    const h = handlers(ENV, ADMIN, fetchImpl);
    expect((await h.POST(post({ target: 'nap', text: 'wake' }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await h.POST(post({ target: 'nap', text: 'wake' }, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it('restores a version only into the document it came from', async () => {
    const version = { id: 7, slot: 'operator-notes', scope: ADMIN, content: '<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: x\n' };
    const { fetchImpl, calls } = upstreams((url) => url.includes('/admin/memory/version') ? Response.json(version) : Response.json({ ok: true }));
    const h = handlers(ENV, ADMIN, fetchImpl);
    expect((await h.POST(post({ target: 'restore', slot: 'operator-notes', did: ADMIN, versionId: 7 }))).status).toBe(200);
    expect(calls.at(-1)!.url).toBe('https://agent.example/admin/memory');
    expect(calls.at(-1)!.body).toEqual({ action: 'restore', slot: 'operator-notes', did: ADMIN, content: version.content, by: ADMIN });
    calls.length = 0;
    // The same version, asked into someone else's notes or another slot: refused before the bot hears of it.
    expect((await h.POST(post({ target: 'restore', slot: 'operator-notes', did: STRANGER, versionId: 7 }))).status).toBe(400);
    expect((await h.POST(post({ target: 'restore', slot: 'self', versionId: 7 }))).status).toBe(400);
    expect(calls.every((c) => !c.url.startsWith('https://agent.example'))).toBe(true);
  });

  it('sends guidance changes and naps to the droplet, and passes on why it refused', async () => {
    const { fetchImpl, calls } = upstreams((url) =>
      url.endsWith('/admin/guidance') ? new Response(JSON.stringify({ error: 'BadRequest', detail: 'arenas must be some of …' }), { status: 400 })
        : Response.json({ message: 'zzz', nap: { active: true } }));
    const h = handlers(ENV, ADMIN, fetchImpl);
    const bad = await h.POST(post({ target: 'guidance', action: 'add', text: 'x', arenas: ['moon'] }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toBe('arenas must be some of …');
    expect(calls[0]!.body).toEqual({ action: 'add', text: 'x', arenas: ['moon'] });
    const nap = await h.POST(post({ target: 'nap', text: 'nap: 2h' }));
    expect(await nap.json()).toEqual({ message: 'zzz', nap: { active: true } });
    expect(calls[1]!.url).toBe('https://droplet.example/admin/nap');
  });

  it('reads one person, a history, and the digest preview', async () => {
    const { fetchImpl, calls } = upstreams(() => Response.json({}));
    const h = handlers(ENV, ADMIN, fetchImpl);
    expect((await h.GET(get(`view=person&did=${STRANGER}`))).status).toBe(200);
    expect(calls[0]!.body).toEqual({ action: 'read', slot: 'person', did: STRANGER, by: ADMIN });
    expect((await h.GET(get('view=person&did=nobody'))).status).toBe(400);
    expect((await h.GET(get('view=history&slot=life&scope=poe-life'))).status).toBe(200);
    expect(calls[1]!.url).toBe('https://droplet.example/admin/memory/history?slot=life&scope=poe-life&limit=40');
    expect((await h.GET(get('view=history&slot=../etc&scope=x'))).status).toBe(400);
    expect((await h.GET(get('view=digest'))).status).toBe(200);
    expect((await h.GET(get('view=else'))).status).toBe(404);
  });
});
