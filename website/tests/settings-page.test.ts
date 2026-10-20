// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_EVENT, type Auth, type Session, type StartResult } from '../src/blog/auth.js';
import { forgetMe, init, outcomeText, SETTINGS_COPY, SIGNIN_EVENT } from '../src/scripts/settings.js';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const TOKEN = 'aaa.bbb.ccc';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const PAGE = read('../settings/index.html');
const main = () => PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);

/** A session whose PDS answers getServiceAuth with `pds`. */
function fakeSession(pds: (url: URL) => Response = () => Response.json({ token: TOKEN })): Session & { asked: URL[] } {
  const asked: URL[] = [];
  return {
    did: DID,
    pds: 'https://pds.example',
    asked,
    fetch: vi.fn(async (path: string) => {
      const url = new URL(path, 'https://pds.example');
      asked.push(url);
      return pds(url);
    }),
    signOut: vi.fn(async () => undefined),
  };
}

function auth(session: Session | null, eager = true): Auth {
  const result: StartResult = { session, callback: false, error: null };
  return { mode: 'site', eager, start: vi.fn(async () => result), warm: () => undefined, prepare: vi.fn(), go: vi.fn() };
}

const PROFILE = { did: DID, handle: 'someone.example', displayName: 'Someone', avatar: 'https://cdn.example/a.jpg' };

/** The AppView for the profile, and /api/poe answering `api`. */
function site(api: (init: RequestInit) => Response | Promise<Response> = () => Response.json({ hadNotes: true, published: true })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/poe') return api(init);
    return Response.json(PROFILE);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function mount(a: Auth | null, fetchImpl: typeof fetch = site().fetchImpl) {
  document.body.innerHTML = main();
  await init({ auth: a, fetchImpl, now: () => NOW });
  const root = document.querySelector<HTMLElement>('[data-settings-page]')!;
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  return { root, $ };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('settings page', () => {
  it('explains that settings only work on atpota.to on hosts without sign-in', async () => {
    const { root, $ } = await mount(null);
    expect(root.dataset.state).toBe('unavailable');
    expect($('[data-settings-lede]').textContent).toBe(SETTINGS_COPY.unavailableLede);
    expect($('[data-settings-memory]').hidden).toBe(true);
    expect($('[data-settings-signin]').hidden).toBe(true);
  });

  it('asks a signed-out reader to sign in, through the header, without loading the library', async () => {
    const a = auth(null, false);
    const { root, $ } = await mount(a);
    expect(a.start).not.toHaveBeenCalled();
    expect(root.dataset.state).toBe('signed-out');
    expect($('[data-settings-memory]').hidden).toBe(true);
    const asked = vi.fn();
    window.addEventListener(SIGNIN_EVENT, asked);
    $<HTMLButtonElement>('[data-settings-signin-button]').click();
    window.removeEventListener(SIGNIN_EVENT, asked);
    expect(asked).toHaveBeenCalledOnce();
  });

  it('names a signed-in reader and offers to forget them, asking first', async () => {
    const { root, $ } = await mount(auth(fakeSession()));
    expect(root.dataset.state).toBe('signed-in');
    expect($('[data-settings-lede]').textContent).toBe(SETTINGS_COPY.lede('@someone.example'));
    expect($<HTMLImageElement>('[data-settings-avatar] img').src).toBe(PROFILE.avatar);
    expect($('[data-settings-memory]').hidden).toBe(false);
    expect($('[data-forget-confirm]').hidden).toBe(true);
    $<HTMLButtonElement>('[data-forget-start]').click();
    expect($('[data-forget-confirm]').hidden).toBe(false);
    expect($('[data-forget-start]').hidden).toBe(true);
    $<HTMLButtonElement>('[data-forget-no]').click();
    expect($('[data-forget-confirm]').hidden).toBe(true);
    expect($('[data-forget-status]').textContent).toBe('');
  });

  it('forgets: a one-minute token for the forget method, sent with DELETE /api/poe', async () => {
    const session = fakeSession();
    const s = site();
    const { $ } = await mount(auth(session), s.fetchImpl);
    $<HTMLButtonElement>('[data-forget-start]').click();
    $<HTMLButtonElement>('[data-forget-yes]').click();
    await vi.waitFor(() => expect($('[data-forget-status]').textContent).toBe(SETTINGS_COPY.forgotten));
    expect($('[data-forget-status]').dataset.outcome).toBe('forgotten');
    expect(session.asked).toHaveLength(1);
    expect(session.asked[0]!.pathname).toBe('/xrpc/com.atproto.server.getServiceAuth');
    expect(Object.fromEntries(session.asked[0]!.searchParams)).toEqual({
      aud: 'did:web:atpota.to',
      lxm: 'to.atpota.poe.forget',
      exp: String(NOW / 1000 + 60),
    });
    const api = s.calls.find((c) => c.url === '/api/poe')!;
    expect(api.init.method).toBe('DELETE');
    expect(new Headers(api.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect($('[data-forget-start]').hidden).toBe(false);
    expect($('[data-forget-signin]').hidden).toBe(true);
  });

  it('asks an older sign-in, without the forget permission, to sign in again', async () => {
    const session = fakeSession(() => Response.json({ error: 'InvalidToken' }, { status: 403 }));
    const s = site();
    const { $ } = await mount(auth(session), s.fetchImpl);
    $<HTMLButtonElement>('[data-forget-start]').click();
    $<HTMLButtonElement>('[data-forget-yes]').click();
    await vi.waitFor(() => expect($('[data-forget-status]').textContent).toBe(SETTINGS_COPY.needsSignIn));
    expect(s.calls.some((c) => c.url === '/api/poe')).toBe(false);
    expect($('[data-forget-signin]').hidden).toBe(false);
    const asked = vi.fn();
    window.addEventListener(SIGNIN_EVENT, asked);
    $<HTMLButtonElement>('[data-forget-signin]').click();
    window.removeEventListener(SIGNIN_EVENT, asked);
    expect(asked).toHaveBeenCalledOnce();
  });

  it('goes back to "sign in" when the reader signs out in the header', async () => {
    const { root, $ } = await mount(auth(fakeSession()));
    window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { did: null } }));
    expect(root.dataset.state).toBe('signed-out');
    expect($('[data-settings-memory]').hidden).toBe(true);
  });
});

describe('forgetMe', () => {
  it('lets the PDS pick the lifetime when this clock is off', async () => {
    let first = true;
    const session = fakeSession(() => {
      if (!first) return Response.json({ token: TOKEN });
      first = false;
      return Response.json({ error: 'BadExpiration' }, { status: 400 });
    });
    expect(await forgetMe(session, site().fetchImpl, () => NOW)).toEqual({ kind: 'forgotten', hadNotes: true, published: true });
    expect(session.asked[1]!.searchParams.has('exp')).toBe(false);
  });

  it("reports the proxy's answers", async () => {
    const run = (api: () => Response | Promise<Response>) => forgetMe(fakeSession(), site(api).fetchImpl, () => NOW);
    expect(await run(() => Response.json({ hadNotes: false, published: false }))).toEqual({ kind: 'forgotten', hadNotes: false, published: false });
    expect(await run(() => Response.json({ error: { code: 'bad_request', message: 'x' } }, { status: 401 }))).toEqual({ kind: 'needs-sign-in' });
    expect(await run(() => Response.json({ error: { code: 'not_configured', message: 'not now' } }, { status: 503 }))).toEqual({ kind: 'failed', message: 'not now' });
    expect(await run(() => Promise.reject(new TypeError('offline')))).toEqual({ kind: 'failed', message: null });
    expect(await run(() => new Response('<html>', { status: 500 }))).toEqual({ kind: 'failed', message: null });
  });

  it('never sends a malformed token, or anything when the PDS is down', async () => {
    for (const pds of [() => Response.json({ token: 'not a jwt' }), () => new Response(null, { status: 500 })]) {
      const s = site();
      expect(await forgetMe(fakeSession(pds), s.fetchImpl, () => NOW)).toEqual({ kind: 'failed', message: null });
      expect(s.calls).toHaveLength(0);
    }
  });

  it('says what happened in words', () => {
    expect(outcomeText({ kind: 'forgotten', hadNotes: true, published: true })).toBe(SETTINGS_COPY.forgotten);
    expect(outcomeText({ kind: 'forgotten', hadNotes: true, published: false })).toBe(SETTINGS_COPY.forgottenLocal);
    expect(outcomeText({ kind: 'forgotten', hadNotes: false, published: false })).toBe(SETTINGS_COPY.nothing);
    expect(outcomeText({ kind: 'failed', message: null })).toBe(SETTINGS_COPY.failed);
  });
});
