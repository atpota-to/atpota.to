import { afterEach, describe, expect, it, vi } from 'vitest';

// The OAuth library, stood in for: init() answers only when the test says so, the way it
// does when another tab is holding the lock on the account.
const lib = vi.hoisted(() => {
  let answer: (value: unknown) => void = () => undefined;
  const init = vi.fn(() => new Promise((resolve) => (answer = resolve)));
  return { init, answer: (value: unknown) => answer(value) };
});
vi.mock('@atproto/oauth-client-browser', () => ({
  BrowserOAuthClient: { load: async () => ({ init: lib.init }) },
}));

import { createAuth, RESTORE_TIMEOUT_MS, SESSION_KEY } from '../src/blog/auth.js';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

function fakeWindow(hash = ''): Window {
  const u = new URL(`https://atpota.to/garden${hash}`);
  return {
    location: { origin: u.origin, protocol: u.protocol, hostname: u.hostname, host: u.host, port: u.port, hash: u.hash },
    localStorage: { getItem: (k: string) => (k === SESSION_KEY ? DID : null) },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  } as unknown as Window;
}

const oauthSession = {
  did: DID,
  getTokenInfo: async () => ({ aud: 'https://pds.example/' }),
  fetchHandler: vi.fn(),
  signOut: vi.fn(),
};

describe('restoring a remembered session', () => {
  afterEach(() => {
    vi.useRealTimers();
    lib.init.mockClear();
  });

  it("goes on without it when it doesn't answer in time, and hands it over once it does", async () => {
    vi.useFakeTimers();
    const auth = createAuth(fakeWindow())!;
    expect(auth.eager).toBe(true);
    const first = auth.start();
    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS);
    expect(await first).toEqual({ session: null, callback: false, error: null, stalled: true });
    // the restore is still going: asking again doesn't start another
    const second = auth.start();
    lib.answer({ session: oauthSession });
    const result = await second;
    expect(result.stalled).toBeUndefined();
    expect(result.session).toMatchObject({ did: DID, pds: 'https://pds.example' });
    expect(lib.init).toHaveBeenCalledOnce();
    // and from then on, straight away
    expect((await auth.start()).session?.did).toBe(DID);
  });

  it('waits for a sign-in coming back, however long it takes', async () => {
    vi.useFakeTimers();
    const auth = createAuth(fakeWindow('#state=abc&iss=x&code=123'))!;
    let done = false;
    const started = auth.start().then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS * 3);
    expect(done).toBe(false);
    lib.answer({ session: oauthSession });
    expect((await started).session?.did).toBe(DID);
  });
});
