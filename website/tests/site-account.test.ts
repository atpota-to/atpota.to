// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_EVENT, type Auth, type Prepared, type Session, type StartResult } from '../src/blog/auth.js';
import { PENDING_KEY, readPending, savePending } from '../src/blog/state.js';
import { createStore, type KeyValueStore } from '../src/poe/storage.js';
import { ACCOUNT_COPY, mountAccount, VERIFY_DELAY_MS } from '../src/scripts/account.js';
import { READER_KEY } from '../src/scripts/reader.js';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const NOW = Date.parse('2026-10-20T12:00:00Z');

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
function dialogMarkup(): string {
  const partial = read('../src/partials/signin.html');
  return partial.slice(partial.indexOf('<dialog'), partial.indexOf('</dialog>') + '</dialog>'.length);
}

function memory(): KeyValueStore {
  const map = new Map<string, string>();
  return createStore(() => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }) as unknown as Storage);
}

function fakeSession(): Session {
  return { did: DID, pds: 'https://pds.example', fetch: vi.fn(), signOut: vi.fn(async () => undefined) };
}

function setup(opts: { session?: Session | null; eager?: boolean; page?: string; callback?: boolean } = {}) {
  document.body.innerHTML = `<header data-site-header><div data-site-account></div></header>${dialogMarkup()}`;
  document.body.dataset.page = opts.page ?? 'home';
  const result: StartResult = { session: opts.session ?? null, callback: opts.callback ?? false, error: null };
  const start = vi.fn(async () => result);
  const go = vi.fn();
  const ready: Prepared = { url: 'https://bsky.social/oauth/authorize?x=1', host: 'bsky.social', account: { did: DID, handle: 'someone.example' }, at: NOW };
  const auth: Auth = { mode: 'site', eager: opts.eager ?? false, start, warm: () => undefined, prepare: async () => ready, go };
  const profile = { did: DID, handle: 'someone.example', displayName: 'Someone', avatar: 'https://cdn.example/a.jpg' };
  const fetchImpl = vi.fn(async () => Response.json(profile)) as unknown as typeof fetch;
  const store = memory();
  const reload = vi.fn();
  const mount = () => mountAccount({ auth, fetchImpl, now: () => NOW, sessionStore: store, localStore: memory(), reload });
  return { auth, start, go, store, reload, mount, slot: () => document.querySelector<HTMLElement>('[data-site-account]')! };
}

const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-blog-signin]')!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('header account', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it('stays out of the way on hosts without sign-in', () => {
    document.body.innerHTML = `<header data-site-header><div data-site-account></div></header>${dialogMarkup()}`;
    mountAccount({ auth: null });
    expect(document.querySelector('[data-site-account]')!.childElementCount).toBe(0);
    expect(dialog().dataset.poeReady).toBeUndefined();
  });

  it('offers "sign in" without loading the library, and opens the dialog in place', () => {
    const h = setup();
    h.mount();
    expect(h.start).not.toHaveBeenCalled();
    const button = h.slot().querySelector<HTMLButtonElement>('.site-account__signin')!;
    expect(button.getAttribute('aria-label')).toBe(ACCOUNT_COPY.signInLabel);
    button.click();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(document.querySelector('[data-blog-signin-lede]')!.textContent).toBe(ACCOUNT_COPY.lede);
  });

  it("answers Poe's sign-in link on any page, and comes back here to finish", async () => {
    const h = setup();
    h.mount();
    expect(dialog().dataset.poeReady).toBe('');
    window.dispatchEvent(new Event('poe:signin'));
    expect(document.querySelector('[data-blog-signin-lede]')!.textContent).toBe(ACCOUNT_COPY.poeLede);
    document.querySelector<HTMLInputElement>('#blog-signin-handle')!.value = 'someone.example';
    document.querySelector<HTMLFormElement>('[data-blog-signin-form]')!.requestSubmit();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-blog-signin-confirm]')!.hidden).toBe(false));
    document.querySelector<HTMLButtonElement>('[data-blog-signin-go]')!.click();
    await vi.waitFor(() => expect(h.go).toHaveBeenCalled());
    expect(readPending(h.store, NOW)).toEqual({ kind: 'poe', returnTo: '/', at: NOW });
  });

  it('draws a remembered reader right away and checks the session once the page is idle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    localStorage.setItem(READER_KEY, 'someone.example');
    const h = setup({ eager: true, session: null });
    h.mount();
    expect(h.slot().querySelector('.site-account__toggle')!.getAttribute('aria-label')).toBe(ACCOUNT_COPY.menuLabel('@someone.example'));
    expect(h.start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(VERIFY_DELAY_MS);
    await vi.waitFor(() => expect(h.slot().querySelector('.site-account__signin')).not.toBeNull());
    // The sign-in had expired: the greeting goes too.
    expect(localStorage.getItem(READER_KEY)).toBeNull();
  });

  it('opens a card with the garden, the profile and sign out; Esc closes it', async () => {
    const session = fakeSession();
    const h = setup({ eager: true, session });
    h.mount();
    await vi.waitFor(() => expect(h.slot().querySelector('img.site-account__avatar')).not.toBeNull());
    const toggle = h.slot().querySelector<HTMLButtonElement>('.site-account__toggle')!;
    const card = h.slot().querySelector<HTMLElement>('[data-account-card]')!;
    expect(card.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(card.hidden).toBe(false);
    expect([...card.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/garden/someone.example', 'https://bsky.app/profile/someone.example']);
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);

    const ended = vi.fn();
    window.addEventListener(SESSION_EVENT, ended);
    toggle.click();
    card.querySelector<HTMLButtonElement>('.site-account__out')!.click();
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalled());
    expect(session.signOut).toHaveBeenCalled();
    expect((ended.mock.calls[0]![0] as CustomEvent).detail).toEqual({ did: null });
    window.removeEventListener(SESSION_EVENT, ended);
  });

  it('back from signing in for Poe, opens the panel again; a plain sign-in says hello', async () => {
    const opened = vi.fn();
    window.addEventListener('poe:open', opened);
    let h = setup({ eager: true, session: fakeSession() });
    savePending(h.store, { kind: 'poe', returnTo: '/', at: NOW });
    h.mount();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(h.store.get(PENDING_KEY)).toBeNull();
    window.removeEventListener('poe:open', opened);

    h = setup({ eager: true, session: fakeSession() });
    savePending(h.store, { kind: 'account', returnTo: '/', at: NOW });
    h.mount();
    await vi.waitFor(() => expect(h.slot().classList.contains('is-new')).toBe(true));
    expect(h.store.get(PENDING_KEY)).toBeNull();
  });

  it('leaves finishing to the blog on blog pages', async () => {
    const h = setup({ eager: true, session: fakeSession(), page: 'blog' });
    savePending(h.store, { kind: 'poe', returnTo: '/', at: NOW });
    h.mount();
    await vi.waitFor(() => expect(h.slot().querySelector('.site-account__toggle')).not.toBeNull());
    await flush();
    expect(readPending(h.store, NOW)?.kind).toBe('poe');
  });

  it('turns back into "sign in" when the blog signs the reader out', async () => {
    const h = setup({ eager: true, session: fakeSession() });
    h.mount();
    await vi.waitFor(() => expect(h.slot().querySelector('.site-account__toggle')).not.toBeNull());
    window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { did: null } }));
    expect(h.slot().querySelector('.site-account__signin')).not.toBeNull();
  });
});

describe('one sign-in dialog, many callers', () => {
  it('wires the dialog once; each caller brings its own beforeLeave', async () => {
    const h = setup();
    const prepare = vi.spyOn(h.auth, 'prepare');
    const { mountSignIn } = await import('../src/blog/signin.js');
    const base = { doc: document, win: window, dialog: dialog(), auth: h.auth, fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch, local: memory(), now: () => NOW };
    const first = vi.fn();
    const second = vi.fn();
    mountSignIn({ ...base, beforeLeave: first });
    const other = mountSignIn({ ...base, beforeLeave: second });
    other.open('hi');
    document.querySelector<HTMLInputElement>('#blog-signin-handle')!.value = 'someone.example';
    document.querySelector<HTMLFormElement>('[data-blog-signin-form]')!.requestSubmit();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-blog-signin-confirm]')!.hidden).toBe(false));
    expect(prepare).toHaveBeenCalledTimes(1);
    document.querySelector<HTMLButtonElement>('[data-blog-signin-go]')!.click();
    await vi.waitFor(() => expect(h.go).toHaveBeenCalledTimes(1));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
