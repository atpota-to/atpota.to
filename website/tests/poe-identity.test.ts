// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_EVENT, type Auth, type Session } from '../src/blog/auth.js';
import { COPY, noteCopy } from '../src/poe/copy.js';
import {
  PoeIdentity,
  POE_LXM,
  POE_SERVICE_DID,
  readWho,
  saveWho,
  TOKEN_LIFETIME_S,
  TOKEN_WAIT_MS,
  WHO_KEY,
} from '../src/poe/identity.js';
import { mountPoe, unmountPoe } from '../src/poe/index.js';
import { createStore, resetStoresForTests, session as sessionStore, type KeyValueStore } from '../src/poe/storage.js';
import { POE_LXM as SERVER_LXM, POE_SERVICE_DID as SERVER_DID } from '../server/identity.js';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const NOW = Date.parse('2026-10-20T12:00:00Z');

function memory(): KeyValueStore {
  const map = new Map<string, string>();
  return createStore(() => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }) as unknown as Storage);
}

type Mint = (path: string) => Response | Promise<Response>;

function fakeSession(mint: Mint = () => Response.json({ token: 'aaa.bbb.ccc' })) {
  const paths: string[] = [];
  const s: Session = {
    did: DID,
    pds: 'https://pds.example',
    fetch: vi.fn(async (path: string) => {
      paths.push(path);
      return mint(path);
    }),
    signOut: async () => undefined,
  };
  return { session: s, paths };
}

function fakeAuth(session: Session | null, eager = true) {
  const start = vi.fn(async () => ({ session, callback: false, error: null }));
  const auth: Auth = {
    mode: 'site',
    eager,
    start,
    warm: () => undefined,
    prepare: async () => {
      throw new Error('not in these tests');
    },
    go: () => undefined,
  };
  return { auth, start };
}

describe('PoeIdentity', () => {
  it('asks for the audience and method the proxy accepts', () => {
    expect(POE_SERVICE_DID).toBe(SERVER_DID);
    expect(POE_LXM).toBe(SERVER_LXM);
  });

  it('is unavailable without sign-in, and signed out without a remembered account (no library load)', async () => {
    expect(new PoeIdentity(null).state).toEqual({ kind: 'unavailable' });
    expect(await new PoeIdentity(null).token()).toBeNull();
    const { auth, start } = fakeAuth(null, false);
    const id = new PoeIdentity(auth);
    expect(id.state).toEqual({ kind: 'unknown' });
    expect(await id.prepare()).toEqual({ kind: 'signed-out' });
    expect(await id.token()).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('mints a half-hour token from the reader\'s own PDS and reuses it until it is nearly spent', async () => {
    let now = NOW;
    const { session, paths } = fakeSession();
    const { auth } = fakeAuth(session);
    const id = new PoeIdentity(auth, { now: () => now });
    expect(await id.prepare()).toEqual({ kind: 'signed-in', did: DID, handle: null, confirmed: false });
    expect(await id.token()).toBe('aaa.bbb.ccc');
    const url = new URL(paths[0]!, 'https://pds.example');
    expect(url.pathname).toBe('/xrpc/com.atproto.server.getServiceAuth');
    expect(url.searchParams.get('aud')).toBe('did:web:atpota.to');
    expect(url.searchParams.get('lxm')).toBe('to.atpota.poe.chat');
    expect(Number(url.searchParams.get('exp'))).toBe(NOW / 1000 + TOKEN_LIFETIME_S);
    await id.token();
    expect(paths).toHaveLength(1);
    now += (TOKEN_LIFETIME_S - 60) * 1000;
    await id.token();
    expect(paths).toHaveLength(2);
  });

  it('a session without Poe\'s permission asks the reader to sign in again', async () => {
    const { session } = fakeSession(() => Response.json({ error: 'InsufficientScope' }, { status: 403 }));
    const id = new PoeIdentity(fakeAuth(session).auth);
    const states: string[] = [];
    id.onChange((s) => states.push(s.kind));
    expect(await id.token()).toBeNull();
    expect(id.state).toEqual({ kind: 'needs-sign-in', did: DID });
    expect(states).toEqual(['signed-in', 'needs-sign-in']);
  });

  it('lets the PDS pick the lifetime when this device\'s clock is off', async () => {
    const { session, paths } = fakeSession((path) =>
      path.includes('exp=') ? Response.json({ error: 'BadExpiration' }, { status: 400 }) : Response.json({ token: 'x.y.z' }),
    );
    const id = new PoeIdentity(fakeAuth(session).auth, { now: () => NOW });
    expect(await id.token()).toBe('x.y.z');
    expect(paths).toHaveLength(2);
    expect(paths[1]).not.toContain('exp=');
  });

  it('never sends what is not a JWT, and shrugs off a failing PDS', async () => {
    for (const mint of [() => Response.json({ token: '<script>' }), () => Response.json({}), () => new Response('oops', { status: 500 })] as Mint[]) {
      const id = new PoeIdentity(fakeAuth(fakeSession(mint).session).auth);
      expect(await id.token()).toBeNull();
      expect(id.state.kind).toBe('signed-in');
    }
    const throwing = new PoeIdentity(fakeAuth(fakeSession(() => Promise.reject(new TypeError('offline'))).session).auth);
    expect(await throwing.token()).toBeNull();
  });

  it('a slow PDS never holds up a question for long', async () => {
    vi.useFakeTimers();
    try {
      const id = new PoeIdentity(fakeAuth(fakeSession(() => new Promise<Response>(() => undefined)).session).auth);
      const token = id.token();
      await vi.advanceTimersByTimeAsync(TOKEN_WAIT_MS);
      expect(await token).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the session when the blog signs the reader out on this page', async () => {
    const { session, paths } = fakeSession();
    const id = new PoeIdentity(fakeAuth(session).auth, { win: window });
    await id.token();
    window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { did: null } }));
    expect(id.state).toEqual({ kind: 'signed-out' });
    expect(await id.token()).toBeNull();
    expect(paths).toHaveLength(1);
    id.destroy();
  });

  it("takes the proxy's word: a verified token names the handle, a refused one asks to sign in again", async () => {
    const id = new PoeIdentity(fakeAuth(fakeSession().session).auth);
    await id.prepare();
    id.confirm(true, 'someone.example');
    expect(id.state).toEqual({ kind: 'signed-in', did: DID, handle: 'someone.example', confirmed: true });
    id.confirm(true, 'Not A Handle');
    expect(id.state).toEqual({ kind: 'signed-in', did: DID, handle: null, confirmed: true });
    id.confirm(false, null);
    expect(id.state).toEqual({ kind: 'needs-sign-in', did: DID });
  });

  it('remembers who asked last in this tab, and only well-formed values', async () => {
    const store = memory();
    expect(readWho(store)).toBeNull();
    saveWho(store, { did: DID, handle: 'someone.example' });
    expect(readWho(store)).toEqual({ did: DID, handle: 'someone.example' });
    const id = new PoeIdentity(fakeAuth(fakeSession().session).auth, { store });
    expect(await id.prepare()).toEqual({ kind: 'signed-in', did: DID, handle: 'someone.example', confirmed: false });
    store.set(WHO_KEY, JSON.stringify({ did: 'did:evil', handle: '<b>' }));
    expect(readWho(store)).toEqual({ did: null, handle: null });
    store.set(WHO_KEY, '{nope');
    expect(readWho(store)).toBeNull();
  });
});

/* ---------- in the widget ---------- */

function sse(events: Array<[string, unknown]>): Response {
  return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const answer = (text: string, visitor?: { signedIn: boolean; handle: string | null }) =>
  sse([
    ['ready', { conversation: 'continued' }],
    ...(visitor ? ([['visitor', visitor]] as Array<[string, unknown]>) : []),
    ['block', { text, block: 0 }],
    ['done', { text, links: [] }],
  ]);

function fakeFetch(respond: (headers: Headers) => Response) {
  const seen: Headers[] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push(headers);
    return respond(headers);
  });
  return { fn: fn as unknown as typeof fetch, seen };
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
/** Each note's visible text, without the screen-reader prefix. */
const notes = () =>
  Array.from(document.querySelectorAll('.poe-msg--note')).map((n) =>
    Array.from(n.childNodes)
      .filter((c) => !(c instanceof HTMLElement && c.classList.contains('poe-sr')))
      .map((c) => c.textContent)
      .join('')
      .trim(),
  );

describe('the widget, signed in or not', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="main"></main>';
    document.body.dataset.page = 'home';
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    resetStoresForTests();
    window.sessionStorage.clear();
  });
  afterEach(() => unmountPoe());

  it('offers a sign-in link when nobody is signed in, and asks without a token', async () => {
    const net = fakeFetch(() => answer('hi!'));
    const widget = mountPoe({ fetchImpl: net.fn, identity: new PoeIdentity(fakeAuth(null, false).auth) })!;
    widget.open();
    await vi.waitFor(() => expect(widget.account.hidden).toBe(false));
    const link = widget.account.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/blog#sign-in');
    expect(widget.account.textContent).toBe(`${COPY.signInLink}${COPY.signInAfter}`);
    await widget.send('hello');
    expect(net.seen[0]!.has('authorization')).toBe(false);
  });

  it('hands over to the sign-in dialog in place, and comes back when it is closed', async () => {
    document.body.insertAdjacentHTML('beforeend', '<dialog data-blog-signin data-poe-ready></dialog>');
    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-blog-signin]')!;
    const asked = vi.fn(() => dialog.setAttribute('open', ''));
    window.addEventListener('poe:signin', asked);
    const widget = mountPoe({ identity: new PoeIdentity(fakeAuth(null, false).auth) })!;
    widget.open();
    await vi.waitFor(() => expect(widget.account.querySelector('a')).not.toBeNull());
    widget.account.querySelector('a')!.click();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(widget.opened).toBe(false);
    expect(dialog.dataset.from).toBe('poe');
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));
    expect(widget.opened).toBe(true);
    expect(dialog.dataset.from).toBeUndefined();
    window.removeEventListener('poe:signin', asked);
  });

  it("opens the page's sign-in dialog instead of leaving", async () => {
    document.body.insertAdjacentHTML('beforeend', '<dialog data-blog-signin data-poe-ready></dialog>');
    const asked = vi.fn();
    window.addEventListener('poe:signin', asked);
    const widget = mountPoe({ identity: new PoeIdentity(fakeAuth(null, false).auth) })!;
    widget.open();
    await vi.waitFor(() => expect(widget.account.querySelector('a')).not.toBeNull());
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    widget.account.querySelector('a')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(widget.opened).toBe(false);
    window.removeEventListener('poe:signin', asked);
  });

  it('sends the token with the question and names the reader once the proxy verified them', async () => {
    const net = fakeFetch(() => answer('hi again!', { signedIn: true, handle: 'someone.example' }));
    const widget = mountPoe({ fetchImpl: net.fn, identity: new PoeIdentity(fakeAuth(fakeSession().session).auth, { store: sessionStore() }) })!;
    widget.open();
    await vi.waitFor(() => expect(widget.account.textContent).toBe(COPY.signedIn));
    await widget.send('remember me?');
    expect(net.seen[0]!.get('authorization')).toBe('Bearer aaa.bbb.ccc');
    expect(widget.account.textContent).toBe(COPY.knownAs('someone.example'));
    expect(readWho(sessionStore())).toEqual({ did: DID, handle: 'someone.example' });
    expect(notes()).toEqual([]);
  });

  it('says so when a chat goes from anonymous to signed in, and back', async () => {
    let signedIn = false;
    const net = fakeFetch(() => answer('ok', signedIn ? { signedIn: true, handle: 'someone.example' } : undefined));
    const anon = mountPoe({ fetchImpl: net.fn, identity: new PoeIdentity(fakeAuth(null, false).auth) })!;
    await anon.send('first, anonymously');
    unmountPoe();

    // Back from signing in: the same transcript, a new conversation for the bot.
    signedIn = true;
    const known = mountPoe({ fetchImpl: net.fn, identity: new PoeIdentity(fakeAuth(fakeSession().session).auth, { store: sessionStore() }) })!;
    await known.send('now signed in');
    expect(notes()).toEqual([noteCopy('signed_in').text]);
    unmountPoe();

    signedIn = false;
    const out = mountPoe({ fetchImpl: net.fn, identity: new PoeIdentity(fakeAuth(null, false).auth) })!;
    await out.send('signed out again');
    expect(notes()).toEqual([noteCopy('signed_in').text, noteCopy('signed_out').text]);
    expect(out.opened).toBe(false);
  });

  it('a token the proxy refuses leaves the chat anonymous and asks to sign in again', async () => {
    const net = fakeFetch(() => answer('ok', { signedIn: false, handle: null }));
    const widget = mountPoe({ fetchImpl: net.fn, identity: new PoeIdentity(fakeAuth(fakeSession().session).auth) })!;
    widget.open();
    await widget.send('hi');
    expect(widget.account.querySelector('a')!.textContent).toBe(COPY.signInAgainLink);
    expect(readWho(sessionStore())).toEqual({ did: null, handle: null });
  });

  it('shows nothing about accounts where sign-in is not offered', async () => {
    const widget = mountPoe({ identity: null })!;
    widget.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(widget.account.hidden).toBe(true);
    expect($('.poe-account')).toBe(widget.account);
  });
});
