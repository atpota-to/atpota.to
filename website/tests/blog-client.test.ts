// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authMode,
  CALLBACK_PATH,
  CLIENT_ID,
  hasStoredSession,
  isCallback,
  loopbackClientId,
  PrepareError,
  SCOPE,
  SESSION_EVENT,
  SESSION_KEY,
  SITE_ORIGIN,
  type Auth,
  type Prepared,
  type Session,
  type StartResult,
} from '../src/blog/auth.js';
import { commentRecord, createRecord, deleteRecord, findOwn, MAX_COMMENT_LENGTH, RepoError } from '../src/blog/repo.js';
import {
  HANDLE_KEY,
  LOCAL_TTL_MS,
  loadLocal,
  PENDING_KEY,
  PENDING_TTL_MS,
  readPending,
  rememberAdded,
  safeReturnTo,
} from '../src/blog/state.js';
import { COPY, EMAIL_RETURN, isAuthError, mountBlog, normalizeHandle, NOTICE_KEY, PREPARED_TTL_MS } from '../src/blog/ui.js';
import { EMAIL_RETURN_PARAM, EMAIL_RETURN_VALUE, emailFormHtml, SUBSCRIBE_COPY } from '../server/blog/subscribe.js';
import { createStore, type KeyValueStore } from '../src/poe/storage.js';

// The blog's reader actions in the browser (src/blog/). The OAuth library is never
// loaded here: a fake Auth stands in, and the reader's PDS and the AppView are a fake fetch.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');
const META = JSON.parse(read('../public/oauth-client-metadata.json')) as Record<string, unknown>;

const ME = 'did:plc:mmmmmmmmmmmmmmmmmmmmmmmm';
const OTHER = 'did:plc:oooooooooooooooooooooooo';
const PDS = 'https://pds.reader.test';
const PUB = 'at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3pub';
const DOC = 'at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.document/3doc';
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

function memory(): KeyValueStore {
  return createStore(() => null);
}

describe('client metadata', () => {
  it('is a browser (public) client whose id, callback and scope match the code', () => {
    expect(META.client_id).toBe(CLIENT_ID);
    expect(CLIENT_ID).toBe('https://atpota.to/oauth-client-metadata.json');
    expect(META.redirect_uris).toEqual([`${SITE_ORIGIN}${CALLBACK_PATH}`]);
    expect(META.client_uri).toBe(SITE_ORIGIN);
    expect(META.token_endpoint_auth_method).toBe('none');
    expect(META.application_type).toBe('web');
    expect(META.dpop_bound_access_tokens).toBe(true);
    expect(META.scope).toBe(SCOPE);
    // only what the site writes: subscriptions and recommends, creating or deleting comments and flowers, tending, and your own garden, plus Poe's sign-in token
    expect(String(META.scope).split(' ').sort()).toEqual([
      'atproto',
      'include:site.standard.authSocial',
      'repo:pub.leaflet.comment?action=create&action=delete',
      'repo:to.atpota.garden.patch?action=create&action=update&action=delete',
      'repo:to.atpota.garden.sprout?action=create&action=delete',
      'repo:to.atpota.garden.tend?action=create',
      'rpc:to.atpota.poe.chat?aud=*',
    ]);
  });

  it('vercel.json serves it as JSON and keeps it out of the rewrites', () => {
    const vercel = JSON.parse(read('../vercel.json')) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>; rewrites: Array<{ source: string }> };
    const rule = vercel.headers.find((h) => h.source === '/oauth-client-metadata.json');
    expect(rule?.headers).toContainEqual({ key: 'Content-Type', value: 'application/json; charset=utf-8' });
    expect(vercel.rewrites.some((r) => r.source.startsWith('/oauth'))).toBe(false);
  });
});

describe('auth helpers', () => {
  const place = (url: string) => {
    const u = new URL(url);
    return { origin: u.origin, protocol: u.protocol, hostname: u.hostname, host: u.host, port: u.port, hash: u.hash };
  };

  it('signs in on atpota.to and local dev servers only', () => {
    expect(authMode(place('https://atpota.to/blog/x'))).toBe('site');
    expect(authMode(place('http://127.0.0.1:5173/blog'))).toBe('loopback');
    expect(authMode(place('http://localhost:5173/blog'))).toBe('loopback');
    expect(authMode(place('https://atpota-abc.vercel.app/blog'))).toBeNull();
    expect(authMode(place('https://www.atpota.to/blog'))).toBeNull();
    expect(authMode(place('http://atpota.to/blog'))).toBeNull();
  });

  it('builds a loopback client id on 127.0.0.1 with the callback and scope', () => {
    const id = new URL(loopbackClientId(place('http://localhost:5173/blog/post')));
    expect(id.origin).toBe('http://localhost');
    expect(id.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5173/blog');
    expect(id.searchParams.get('scope')).toBe(SCOPE);
  });

  it('spots a callback and a remembered session without loading the library', () => {
    expect(isCallback({ hash: '#state=abc&iss=x&code=123' })).toBe(true);
    expect(isCallback({ hash: '#state=abc&error=access_denied' })).toBe(true);
    expect(isCallback({ hash: '#comments' })).toBe(false);
    const storage = { getItem: (k: string) => (k === SESSION_KEY ? ME : null) } as Storage;
    expect(hasStoredSession(() => storage)).toBe(true);
    expect(
      hasStoredSession(() => {
        throw new Error('SecurityError');
      }),
    ).toBe(false);
  });

  it('normalises handles, DIDs and PDS addresses, and refuses junk', () => {
    expect(normalizeHandle(' @Alice.Bsky.Social ')).toBe('alice.bsky.social');
    expect(normalizeHandle('alice')).toBe('alice.bsky.social');
    expect(normalizeHandle('dame.is')).toBe('dame.is');
    expect(normalizeHandle(ME)).toBe(ME);
    expect(normalizeHandle('https://pds.example.com/')).toBe('https://pds.example.com');
    for (const bad of ['', 'alice@example.com', 'javascript:alert(1)', 'a..b', '-bad.com', 'http://pds.example.com', 'x'.repeat(300)]) {
      expect(normalizeHandle(bad), bad).toBeNull();
    }
  });
});

describe('records', () => {
  it('writes comments in the shape Leaflet reads', () => {
    const at = new Date(NOW);
    expect(commentRecord(DOC, '  hi\r\nthere  ', null, at)).toEqual({ $type: 'pub.leaflet.comment', subject: DOC, plaintext: 'hi\nthere', facets: [], createdAt: '2026-10-19T12:00:00.000Z' });
    const parent = `at://${OTHER}/pub.leaflet.comment/3p`;
    expect(commentRecord(DOC, 'x'.repeat(MAX_COMMENT_LENGTH + 10), parent, at)).toMatchObject({ plaintext: 'x'.repeat(MAX_COMMENT_LENGTH), reply: { parent } });
  });

  function session(calls: Array<{ path: string; body: unknown }>, respond: (path: string) => Response): Session {
    return {
      did: ME,
      pds: PDS,
      fetch: async (path, init) => {
        calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
        return respond(path);
      },
      signOut: async () => undefined,
    };
  }

  it('creates and deletes only in the reader\'s own repo', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const s = session(calls, (path) =>
      path.endsWith('createRecord') ? Response.json({ uri: `at://${ME}/site.standard.graph.subscription/3s`, cid: 'c' }) : new Response(null, { status: 200 }),
    );
    await expect(createRecord(s, 'site.standard.graph.subscription', { $type: 'x' })).resolves.toEqual({ uri: `at://${ME}/site.standard.graph.subscription/3s`, cid: 'c' });
    await deleteRecord(s, `at://${ME}/pub.leaflet.comment/3c`);
    expect(calls).toEqual([
      { path: '/xrpc/com.atproto.repo.createRecord', body: { repo: ME, collection: 'site.standard.graph.subscription', record: { $type: 'x' } } },
      { path: '/xrpc/com.atproto.repo.deleteRecord', body: { repo: ME, collection: 'pub.leaflet.comment', rkey: '3c' } },
    ]);
    await expect(deleteRecord(s, `at://${OTHER}/pub.leaflet.comment/3c`)).rejects.toThrow('not your record');
    expect(calls).toHaveLength(2);
  });

  it('reports XRPC errors, and treats a 401 as an expired sign-in', async () => {
    const s = session([], () => Response.json({ error: 'ExpiredToken' }, { status: 401 }));
    const error = await createRecord(s, 'x.y.z', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoError);
    expect((error as RepoError).message).toBe('ExpiredToken');
    expect(isAuthError(error)).toBe(true);
    expect(isAuthError(Object.assign(new Error('x'), { name: 'TokenRefreshError' }))).toBe(true);
    expect(isAuthError(new RepoError(500, 'boom'))).toBe(false);
  });

  it('finds the reader\'s matching records across pages', async () => {
    const pages = [
      { records: [{ uri: `at://${ME}/site.standard.graph.subscription/1`, value: { publication: 'at://other' } }], cursor: 'p2' },
      { records: [{ uri: `at://${ME}/site.standard.graph.subscription/2`, value: { publication: PUB } }, { uri: `at://${OTHER}/site.standard.graph.subscription/3`, value: { publication: PUB } }] },
    ];
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json(pages[urls.length - 1]);
    }) as typeof fetch;
    const s = session([], () => new Response(null));
    expect(await findOwn(s, 'site.standard.graph.subscription', 'publication', PUB, fetchImpl)).toEqual([`at://${ME}/site.standard.graph.subscription/2`]);
    expect(urls[0]).toBe(`${PDS}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(ME)}&collection=site.standard.graph.subscription&limit=100`);
    expect(new URL(urls[1]!).searchParams.get('cursor')).toBe('p2');
  });
});

describe('state', () => {
  it('only returns home, to the garden, or to paths under /blog', () => {
    expect(safeReturnTo('/blog')).toBe('/blog');
    expect(safeReturnTo('/blog/3myasnk4bzk22')).toBe('/blog/3myasnk4bzk22');
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/garden/')).toBe('/garden/');
    expect(safeReturnTo('/garden')).toBe('/garden');
    expect(safeReturnTo('/garden/dame.is')).toBe('/garden/dame.is');
    expect(safeReturnTo('/garden/did:plc:qntsxa2i4sb24noi45fx4np2/flowers')).toBe('/garden/did:plc:qntsxa2i4sb24noi45fx4np2/flowers');
    for (const bad of ['//evil.com', '/gardens', '/garden/a/b', '/garden/../blog', '/garden/x/flowers/y', '/garden?x=1', '/garden/a b', '/blog//evil.com', 'https://evil.com/blog', '/blog/../admin', '/blogx', '/guides', '/?x=1', '/blog/a?x=1', '/blog/a#b', 7]) {
      expect(safeReturnTo(bad), String(bad)).toBeNull();
    }
  });

  it('drops a stale or malformed pending action', () => {
    const store = memory();
    store.set(PENDING_KEY, JSON.stringify({ kind: 'subscribe', returnTo: '/blog/x', at: NOW }));
    expect(readPending(store, NOW + 1000)).toEqual({ kind: 'subscribe', returnTo: '/blog/x', at: NOW });
    expect(readPending(store, NOW + PENDING_TTL_MS + 1)).toBeNull();
    store.set(PENDING_KEY, JSON.stringify({ kind: 'delete-everything', returnTo: '/blog/x', at: NOW }));
    expect(readPending(store, NOW)).toBeNull();
    store.set(PENDING_KEY, JSON.stringify({ kind: 'comment', returnTo: 'https://evil.com', at: NOW }));
    expect(readPending(store, NOW)).toBeNull();
  });

  it('keeps the reader\'s own changes for a few minutes, validated', () => {
    const store = memory();
    const comment = { uri: `at://${ME}/pub.leaflet.comment/3n`, parent: null, text: 'hi', createdAt: new Date(NOW).toISOString(), author: { did: ME, handle: 'me.test', name: 'Me', avatar: null } };
    rememberAdded(store, DOC, comment, NOW);
    expect(loadLocal(store, DOC, NOW + 1000).added).toEqual([comment]);
    expect(loadLocal(store, DOC, NOW + LOCAL_TTL_MS + 1).added).toEqual([]);
    store.set(`blog:local:${DOC}`, JSON.stringify({ at: NOW, added: [{ ...comment, author: { ...comment.author, avatar: 'javascript:alert(1)' } }], removed: ['nope'] }));
    expect(loadLocal(store, DOC, NOW)).toEqual({ added: [], removed: [], at: NOW });
  });
});

/* ---------- the page ---------- */

const SHELL_DIALOG = (() => {
  const partial = read('../src/partials/signin.html');
  return partial.slice(partial.indexOf('<dialog'), partial.indexOf('</dialog>') + '</dialog>'.length);
})();

function postPage(opts: { email?: boolean } = {}): string {
  const comment = (did: string, rkey: string, depth: number, replies = '') =>
    `<li class="comment" data-comment="at://${did}/pub.leaflet.comment/${rkey}" data-comment-author="${did}" data-comment-depth="${depth}">` +
    `<div class="comment__head"><span class="comment__who"><a class="comment__name" href="#">x</a></span></div>` +
    `<div class="comment__body">${rkey}</div><div class="comment__actions" data-comment-actions></div>${replies}</li>`;
  return (
    `<div class="post-layout" data-blog-publication="${PUB}" data-blog-document="${DOC}">` +
    (opts.email ? emailFormHtml({ publication: PUB, redirect: 'https://atpota.to/blog/3doc' }, 'subscribe') : '') +
    `<div class="post-end__actions">` +
    `<button type="button" data-blog-subscribe aria-pressed="false" hidden><span data-blog-subscribe-label>subscribe</span></button>` +
    `<button type="button" data-blog-recommend data-recommend-count="2" aria-pressed="false" hidden><span data-blog-recommend-label>recommend</span><span data-blog-recommend-count>2</span></button>` +
    `</div><p data-blog-account hidden></p>` +
    `<section data-blog-comments><span data-comment-count="2">2 comments</span><div data-comment-compose hidden></div>` +
    `<ol class="comment-list" data-comment-list>` +
    comment(OTHER, '3o1', 1, `<ol class="comment-list comment-list--replies" role="list">${comment(ME, '3m1', 2)}</ol>`) +
    `</ol></section></div>` +
    SHELL_DIALOG
  );
}

interface FakeWin extends EventTarget {
  location: { pathname: string; search: string; hash: string; replace: ReturnType<typeof vi.fn> };
  history: { state: unknown; replaceState: ReturnType<typeof vi.fn> };
  confirm: () => boolean;
}

interface Harness {
  calls: Array<{ path: string; body: Record<string, unknown> | null }>;
  /** Inputs passed to auth.prepare, and the sign-ins auth.go left for. */
  prepares: string[];
  went: Prepared[];
  /** Moves the page's clock. */
  tick(ms: number): void;
  win: FakeWin;
  store: KeyValueStore;
  local: KeyValueStore;
  mounted: Promise<void>;
  owned: { subscription: string[]; recommend: string[] };
}

const AUTH_HOST = 'bsky.social';

function setup(
  opts: {
    start?: StartResult | null;
    path?: string;
    search?: string;
    hash?: string;
    store?: KeyValueStore;
    owned?: Harness['owned'];
    failWrites?: number;
    prepare?: (input: string, at: number) => Promise<Prepared>;
  } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const prepares: string[] = [];
  const went: Prepared[] = [];
  let clock = NOW;
  const owned = opts.owned ?? { subscription: [], recommend: [] };
  let n = 0;
  const session: Session = {
    did: ME,
    pds: PDS,
    fetch: async (path, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ path, body });
      if (opts.failWrites) return Response.json({ error: 'Nope' }, { status: opts.failWrites });
      const list = (collection: unknown) => (String(collection).endsWith('subscription') ? owned.subscription : String(collection).endsWith('recommend') ? owned.recommend : null);
      if (path.endsWith('createRecord')) {
        const created = `at://${ME}/${String(body!.collection)}/3new${++n}`;
        list(body!.collection)?.push(created);
        return Response.json({ uri: created, cid: 'c' });
      }
      const mine = list(body!.collection);
      if (mine) mine.splice(mine.indexOf(`at://${ME}/${String(body!.collection)}/${String(body!.rkey)}`), 1);
      return new Response(null, { status: 200 });
    },
    signOut: vi.fn(async () => undefined),
  };
  const start = opts.start === undefined ? { session, callback: false, error: null } : opts.start;
  const auth: Auth = {
    mode: 'site',
    eager: start !== null,
    start: async () => start ?? { session: null, callback: false, error: null },
    warm: () => undefined,
    prepare: async (input) => {
      prepares.push(input);
      if (opts.prepare) return opts.prepare(input, clock);
      return {
        url: `https://${AUTH_HOST}/oauth/authorize?client_id=x&request_uri=urn:${prepares.length}`,
        host: AUTH_HOST,
        account: input.startsWith('https://') ? null : { did: ME, handle: 'me.test' },
        at: clock,
      };
    },
    go: (prepared) => {
      went.push(prepared);
    },
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin === 'https://public.api.bsky.app') {
      const actor = url.searchParams.get('actor');
      if (actor !== ME && actor !== 'me.test') return Response.json({ error: 'InvalidRequest' }, { status: 400 });
      return Response.json({ did: ME, handle: 'me.test', displayName: 'Me', avatar: 'https://cdn.bsky.app/me.jpg' });
    }
    if (url.origin === PDS) {
      const collection = url.searchParams.get('collection')!;
      const list = collection.endsWith('subscription') ? owned.subscription : owned.recommend;
      const field = collection.endsWith('subscription') ? 'publication' : 'document';
      return Response.json({ records: list.map((u) => ({ uri: u, value: { [field]: collection.endsWith('subscription') ? PUB : DOC } })) });
    }
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
  // An EventTarget, for Poe's "poe:signin" and the session announcements.
  const win: FakeWin = Object.assign(new EventTarget(), {
    location: { pathname: opts.path ?? '/blog/3doc', search: opts.search ?? '', hash: opts.hash ?? '', replace: vi.fn() },
    history: { state: null, replaceState: vi.fn() },
    confirm: () => true,
  });
  const store = opts.store ?? memory();
  const local = memory();
  const mounted = mountBlog({ doc: document, win: win as unknown as Window, auth, fetchImpl, now: () => clock, sessionStore: store, localStore: local, confirm: () => win.confirm() });
  return { calls, prepares, went, tick: (ms) => (clock += ms), win, store, local, mounted, owned };
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('mountBlog', () => {
  beforeEach(() => {
    document.body.innerHTML = postPage();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const submitHandle = async (value: string) => {
    $<HTMLInputElement>('input[name="handle"]').value = value;
    $('form[data-blog-signin-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  };
  const step = () => ($('form[data-blog-signin-form]').hidden ? 'confirm' : 'ask');

  it('signed out: shows the buttons and a sign-in prompt', async () => {
    const h = setup({ start: null });
    await h.mounted;
    expect($('button[data-blog-subscribe]').hidden).toBe(false);
    expect($('button[data-blog-recommend]').hidden).toBe(false);
    expect($('[data-blog-account]').hidden).toBe(true);
    expect($('[data-comment-compose] button').textContent).toBe(COPY.signInToComment);
    expect(document.querySelectorAll('.comment__action')).toHaveLength(0);
  });

  it('sign-in asks for a handle, then shows who it found and the exact site the button leads to', async () => {
    const h = setup({ start: null });
    await h.mounted;
    $('button[data-blog-subscribe]').click();
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').hasAttribute('open')).toBe(true);
    expect($('[data-blog-signin-lede]').textContent).toBe(COPY.lede.subscribe);
    expect(step()).toBe('ask');

    await submitHandle('not a handle!');
    expect($('[data-blog-signin-error]').textContent).toBe(COPY.errors.badHandle);
    expect(h.prepares).toEqual([]);

    await submitHandle('@Me.Test');
    expect(h.prepares).toEqual(['me.test']);
    expect(step()).toBe('confirm');
    expect($('[data-blog-signin-title]').textContent).toBe(COPY.signIn.isThisYou);
    expect($('.blog-signin__name').textContent).toBe('Me');
    expect($('.blog-signin__handle').textContent).toBe('@me.test');
    expect($('img.blog-signin__avatar').getAttribute('src')).toBe('https://cdn.bsky.app/me.jpg');
    expect($('[data-blog-signin-go]').textContent!.replace(/\s+/g, ' ').trim()).toBe('continue at bsky.social');
    expect($('[data-blog-signin-where]').textContent).toBe(COPY.signIn.where('bsky.social'));
    expect(document.activeElement).toBe($('[data-blog-signin-go]'));
    // nothing is saved and nobody leaves until the reader says yes
    expect(h.store.get(PENDING_KEY)).toBeNull();
    expect(h.went).toEqual([]);
    expect(h.local.get(HANDLE_KEY)).toBe('me.test');

    $('[data-blog-signin-go]').click();
    await flush();
    expect(h.went.map((p) => p.url)).toEqual(['https://bsky.social/oauth/authorize?client_id=x&request_uri=urn:1']);
    expect(JSON.parse(h.store.get(PENDING_KEY)!)).toEqual({ kind: 'subscribe', returnTo: '/blog/3doc', at: NOW });
    expect($('[data-blog-signin-go]').getAttribute('aria-busy')).toBe('true');
  });

  it('"not you?" goes back to the handle, and a late answer after that is ignored', async () => {
    let release: (p: Prepared) => void = () => undefined;
    const h = setup({
      start: null,
      prepare: (input, at) =>
        input === 'slow.test'
          ? new Promise<Prepared>((r) => (release = r))
          : Promise.resolve({ url: 'https://pds.example/oauth/authorize?x', host: 'pds.example', account: { did: ME, handle: 'me.test' }, at }),
    });
    await h.mounted;
    $('[data-comment-compose] button').click();
    await submitHandle('me.test');
    expect(step()).toBe('confirm');
    $('[data-blog-signin-back]').click();
    expect(step()).toBe('ask');
    expect($('[data-blog-signin-title]').textContent).toBe(COPY.signIn.title);
    expect(document.activeElement).toBe($('input[name="handle"]'));

    await submitHandle('slow.test');
    expect($('[data-blog-signin-submit]').textContent).toBe(COPY.signIn.looking);
    $('[data-blog-signin-close]').click();
    release({ url: 'https://late.example/oauth/authorize', host: 'late.example', account: { did: ME, handle: 'slow.test' }, at: NOW });
    await flush();
    expect(step()).toBe('ask');
    expect($('[data-blog-signin-submit]').textContent).toBe(COPY.signIn.next);
    expect(h.went).toEqual([]);
  });

  it('a bare server address skips the account card and names the server', async () => {
    const h = setup({ start: null });
    await h.mounted;
    $('button[data-blog-recommend]').click();
    await submitHandle('https://pds.example.com');
    expect(h.prepares).toEqual(['https://pds.example.com']);
    expect($('[data-blog-signin-who]').hidden).toBe(true);
    expect($('[data-blog-signin-title]').textContent).toBe('sign in at bsky.social');
    expect($('[data-blog-signin-where]').textContent).toBe(COPY.signIn.whereServer('bsky.social'));
  });

  it('says which part failed: the account, or its server', async () => {
    const failures: PrepareError[] = [new PrepareError('not_found', 'x'), new PrepareError('unreachable', 'y')];
    const h = setup({ start: null, prepare: async () => Promise.reject(failures.shift()) });
    await h.mounted;
    $('button[data-blog-subscribe]').click();
    await submitHandle('nobody.test');
    expect($('[data-blog-signin-error]').textContent).toBe(COPY.errors.noAccount);
    await submitHandle('me.test');
    expect($('[data-blog-signin-error]').textContent).toBe(COPY.errors.unreachable);
    expect(step()).toBe('ask');
  });

  it('asks the server again before leaving if the prepared sign-in has gone stale', async () => {
    const h = setup({ start: null });
    await h.mounted;
    $('button[data-blog-subscribe]').click();
    await submitHandle('me.test');
    h.tick(PREPARED_TTL_MS + 1000);
    $('[data-blog-signin-go]').click();
    await vi.waitFor(() => expect(h.went).toHaveLength(1));
    expect(h.prepares).toEqual(['me.test', 'me.test']);
    expect(h.went[0]!.url).toContain('request_uri=urn:2');
  });

  it('signed in: shows who, reads subscription state from the repo, and toggles it', async () => {
    const h = setup({ owned: { subscription: [`at://${ME}/site.standard.graph.subscription/3old`], recommend: [] } });
    await h.mounted;
    expect($('[data-blog-account]').hidden).toBe(false);
    expect($('[data-blog-account] .blog-account__who').textContent).toBe('@me.test');
    const sub = $<HTMLButtonElement>('button[data-blog-subscribe]');
    expect(sub.getAttribute('aria-pressed')).toBe('true');
    expect(sub.textContent).toBe(COPY.subscribed);
    expect(sub.hasAttribute('aria-busy')).toBe(false);
    expect(sub.disabled).toBe(false);

    sub.click();
    await vi.waitFor(() => expect(sub.getAttribute('aria-pressed')).toBe('false'));
    expect(h.calls).toEqual([{ path: '/xrpc/com.atproto.repo.deleteRecord', body: { repo: ME, collection: 'site.standard.graph.subscription', rkey: '3old' } }]);

    sub.click();
    await vi.waitFor(() => expect(sub.getAttribute('aria-pressed')).toBe('true'));
    expect(h.calls[1]).toEqual({
      path: '/xrpc/com.atproto.repo.createRecord',
      body: { repo: ME, collection: 'site.standard.graph.subscription', record: { $type: 'site.standard.graph.subscription', publication: PUB, createdAt: '2026-10-19T12:00:00.000Z' } },
    });
    expect($('[data-blog-account] .blog-account__notice').textContent).toBe(COPY.notices.subscribed);
  });

  it('never writes a duplicate when the page is stale', async () => {
    const owned = { subscription: [] as string[], recommend: [] as string[] };
    const h = setup({ owned });
    await h.mounted;
    // subscribed in another tab after this page read the repo
    owned.subscription.push(`at://${ME}/site.standard.graph.subscription/3elsewhere`);
    const sub = $<HTMLButtonElement>('button[data-blog-subscribe]');
    sub.click();
    await vi.waitFor(() => expect(sub.getAttribute('aria-pressed')).toBe('true'));
    expect(h.calls).toEqual([]);
  });

  it('recommends the post and moves the count', async () => {
    const h = setup();
    await h.mounted;
    const rec = $<HTMLButtonElement>('button[data-blog-recommend]');
    rec.click();
    await vi.waitFor(() => expect(rec.getAttribute('aria-pressed')).toBe('true'));
    expect($('[data-blog-recommend-count]').textContent).toBe('3');
    expect(h.calls[0]!.body!.record).toEqual({ $type: 'site.standard.graph.recommend', document: DOC, createdAt: '2026-10-19T12:00:00.000Z' });
    rec.click();
    await vi.waitFor(() => expect(rec.getAttribute('aria-pressed')).toBe('false'));
    expect($('[data-blog-recommend-count]').textContent).toBe('2');
  });

  it('posts a comment, shows it at once, and re-applies it over a cached page', async () => {
    const h = setup();
    await h.mounted;
    const area = $<HTMLTextAreaElement>('[data-comment-compose] textarea');
    $('[data-comment-compose] form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect($('[data-comment-compose] .comment-form__error').textContent).toBe(COPY.empty);

    area.value = 'hello <b>there</b>\nsecond line';
    area.dispatchEvent(new Event('input'));
    expect(h.store.get(`blog:draft:${DOC}`)).toBe('hello <b>there</b>\nsecond line');
    $('[data-comment-compose] form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelectorAll('li.comment')).toHaveLength(3));
    expect(h.calls[0]!.body).toEqual({
      repo: ME,
      collection: 'pub.leaflet.comment',
      record: { $type: 'pub.leaflet.comment', subject: DOC, plaintext: 'hello <b>there</b>\nsecond line', facets: [], createdAt: '2026-10-19T12:00:00.000Z' },
    });
    const added = [...document.querySelectorAll<HTMLLIElement>('li.comment')].at(-1)!;
    expect(added.dataset.comment).toBe(`at://${ME}/pub.leaflet.comment/3new1`);
    expect(added.querySelector('.comment__body')!.innerHTML).toBe('hello &lt;b&gt;there&lt;/b&gt;<br>second line');
    expect(added.querySelector('time')!.textContent).toBe(COPY.justNow);
    expect($('[data-comment-count]').textContent).toBe('3 comments');
    expect(area.value).toBe('');
    expect(h.store.get(`blog:draft:${DOC}`)).toBeNull();
    expect($('[data-comment-status]').textContent).toBe(COPY.notices.posted);

    // a reload within the CDN cache window: the server's page doesn't have it yet
    document.body.innerHTML = postPage();
    const again = setup({ store: h.store });
    await again.mounted;
    expect([...document.querySelectorAll<HTMLLIElement>('li.comment')].map((li) => li.dataset.comment)).toContain(`at://${ME}/pub.leaflet.comment/3new1`);
  });

  it('replies under a comment and deletes only the reader\'s own', async () => {
    const h = setup();
    await h.mounted;
    const [theirs, mine] = [...document.querySelectorAll<HTMLLIElement>('li.comment')];
    expect([...theirs!.querySelector(':scope > [data-comment-actions]')!.children].map((b) => b.textContent)).toEqual([COPY.reply]);
    expect([...mine!.querySelector(':scope > [data-comment-actions]')!.children].map((b) => b.textContent)).toEqual([COPY.reply, COPY.delete]);

    (theirs!.querySelector(':scope > [data-comment-actions] button') as HTMLButtonElement).click();
    const replyForm = theirs!.querySelector<HTMLFormElement>(':scope > .comment-form--reply')!;
    replyForm.querySelector('textarea')!.value = 'a reply';
    replyForm.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(theirs!.querySelector(':scope > .comment-form--reply')).toBeNull());
    expect((h.calls[0]!.body!.record as Record<string, unknown>).reply).toEqual({ parent: `at://${OTHER}/pub.leaflet.comment/3o1` });
    const replies = [...theirs!.querySelectorAll<HTMLLIElement>(':scope > ol > li.comment')];
    expect(replies.map((li) => [li.dataset.commentAuthor, li.dataset.commentDepth])).toEqual([
      [ME, '2'],
      [ME, '2'],
    ]);

    (mine!.querySelector('.comment__action--delete') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector(`li[data-comment="at://${ME}/pub.leaflet.comment/3m1"]`)).toBeNull());
    expect(h.calls[1]).toEqual({ path: '/xrpc/com.atproto.repo.deleteRecord', body: { repo: ME, collection: 'pub.leaflet.comment', rkey: '3m1' } });
    expect($('[data-comment-count]').textContent).toBe('2 comments');
  });

  it('keeps everything under a fourth-level comment in its one flat list, like the server', async () => {
    document.body.innerHTML = postPage().replace('data-comment-depth="2"', 'data-comment-depth="4"');
    const h = setup();
    await h.mounted;
    const deep = document.querySelector<HTMLLIElement>(`li[data-comment="at://${ME}/pub.leaflet.comment/3m1"]`)!;
    const reply = async (li: HTMLLIElement, text: string) => {
      (li.querySelector(':scope > [data-comment-actions] .comment__action') as HTMLButtonElement).click();
      const form = li.querySelector<HTMLFormElement>(':scope > .comment-form--reply')!;
      form.querySelector('textarea')!.value = text;
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await vi.waitFor(() => expect(li.querySelector(':scope > .comment-form--reply')).toBeNull());
    };
    await reply(deep, 'fifth level');
    const flat = deep.querySelector<HTMLOListElement>(':scope > ol.comment-list--replies')!;
    const fifth = flat.querySelector<HTMLLIElement>(':scope > li')!;
    expect(fifth.dataset.commentDepth).toBe('4');
    await reply(fifth, 'sixth level');
    expect([...flat.querySelectorAll<HTMLLIElement>(':scope > li')].map((li) => [li.querySelector('.comment__body')!.textContent, li.dataset.commentDepth])).toEqual([
      ['fifth level', '4'],
      ['sixth level', '4'],
    ]);
    expect(fifth.querySelector('ol')).toBeNull();
    expect(h.calls).toHaveLength(2);
  });

  it('back from the auth server on /blog: goes on to the page the reader started from', async () => {
    const store = memory();
    store.set(PENDING_KEY, JSON.stringify({ kind: 'subscribe', returnTo: '/blog/3doc', at: NOW - 1000 }));
    const h = setup({ path: '/blog', store, start: { session: null, callback: true, error: null } });
    await h.mounted;
    expect(h.win.location.replace).toHaveBeenCalledWith('/blog/3doc');
    expect(store.get(PENDING_KEY)).not.toBeNull();
  });

  it('back on the page, signed in: finishes the pending action once', async () => {
    const store = memory();
    store.set(PENDING_KEY, JSON.stringify({ kind: 'subscribe', returnTo: '/blog/3doc', at: NOW - 1000 }));
    const h = setup({ store });
    await h.mounted;
    expect(h.calls.map((c) => c.path)).toEqual(['/xrpc/com.atproto.repo.createRecord']);
    expect($('button[data-blog-subscribe]').getAttribute('aria-pressed')).toBe('true');
    expect(store.get(PENDING_KEY)).toBeNull();
  });

  it('a cancelled sign-in goes back with a note and changes nothing', async () => {
    const store = memory();
    store.set(PENDING_KEY, JSON.stringify({ kind: 'recommend', returnTo: '/blog/3doc', at: NOW - 1000 }));
    const h = setup({ path: '/blog', store, start: { session: null, callback: true, error: 'cancelled' } });
    await h.mounted;
    expect(h.win.location.replace).toHaveBeenCalledWith('/blog/3doc');
    expect(store.get(PENDING_KEY)).toBeNull();
    expect(store.get(NOTICE_KEY)).toBe('cancelled');

    document.body.innerHTML = postPage();
    const back = setup({ store, start: null });
    await back.mounted;
    expect($('[data-blog-account]').textContent).toBe(COPY.notices.cancelled);
    expect(back.calls).toEqual([]);
  });

  it('an expired sign-in on a write drops back to signed out', async () => {
    const h = setup({ failWrites: 401 });
    await h.mounted;
    $('button[data-blog-recommend]').click();
    await vi.waitFor(() => expect($('[data-blog-account]').textContent).toBe(COPY.notices.expired));
    expect($('[data-comment-compose] button').textContent).toBe(COPY.signInToComment);
    expect(document.querySelectorAll('.comment__action')).toHaveLength(0);
  });

  it('signs out in place', async () => {
    const h = setup();
    await h.mounted;
    $('.blog-account__out').click();
    await flush();
    expect($('[data-blog-account]').textContent).toBe(COPY.notices.signedOut);
    expect($('button[data-blog-subscribe]').getAttribute('aria-pressed')).toBe('false');
    expect(h.calls).toEqual([]);
  });

  it("opens the sign-in dialog for Poe's panel, from its event or from /blog#sign-in", async () => {
    const h = setup({ start: null });
    await h.mounted;
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').dataset.poeReady).toBe('');
    h.win.dispatchEvent(new Event('poe:signin'));
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').hasAttribute('open')).toBe(true);
    expect($('[data-blog-signin-lede]').textContent).toBe(COPY.lede.poe);

    document.body.innerHTML = postPage();
    const linked = setup({ start: null, path: '/blog', hash: '#sign-in' });
    await linked.mounted;
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').hasAttribute('open')).toBe(true);
    expect($('[data-blog-signin-lede]').textContent).toBe(COPY.lede.poe);
    // The marker comes off the address, so a reload doesn't open it again.
    expect(linked.win.history.replaceState).toHaveBeenCalledWith(null, '', '/blog');
  });

  it("back from a sign-in for Poe, opens Poe's panel once", async () => {
    const store = memory();
    store.set(PENDING_KEY, JSON.stringify({ kind: 'poe', returnTo: '/blog/3doc', at: NOW - 1000 }));
    const h = setup({ store });
    const opened = vi.fn();
    h.win.addEventListener('poe:open', opened);
    await h.mounted;
    expect(opened).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
    expect(store.get(PENDING_KEY)).toBeNull();
  });

  it('tells the page when the reader signs in or out, so Poe follows', async () => {
    const seen: Array<string | null> = [];
    document.body.innerHTML = postPage();
    const h = setup();
    h.win.addEventListener(SESSION_EVENT, (e) => seen.push((e as CustomEvent<{ did: string | null }>).detail.did));
    await h.mounted;
    expect(seen).toEqual([ME]);
    $('.blog-account__out').click();
    await flush();
    expect(seen).toEqual([ME, null]);
  });

  it('on hosts without sign-in, points comments at atpota.to and keeps the buttons hidden', async () => {
    await mountBlog({ doc: document, win: { location: { pathname: '/blog/3doc' } } as unknown as Window, auth: null, sessionStore: memory(), localStore: memory() });
    expect($('button[data-blog-subscribe]').hidden).toBe(true);
    expect($('[data-comment-compose] a').getAttribute('href')).toBe('https://atpota.to/blog/3doc#comments');
  });
});

describe('email subscribe forms', () => {
  beforeEach(() => {
    document.body.innerHTML = postPage({ email: true });
  });

  const form = () => $<HTMLFormElement>('form[data-blog-email]');
  const also = () => $<HTMLLabelElement>('.blog-email__also');
  const box = () => also().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const submit = () => {
    const event = new Event('submit', { cancelable: true });
    form().dispatchEvent(event);
    return event;
  };
  const SUBSCRIBED = { subscription: [`at://${ME}/site.standard.graph.subscription/3old`], recommend: [] };

  it('uses the labels and return marker the server renders', () => {
    expect(COPY.subscribe).toBe(SUBSCRIBE_COPY.bluesky);
    expect(EMAIL_RETURN).toEqual({ param: EMAIL_RETURN_PARAM, value: EMAIL_RETURN_VALUE });
  });

  it('signed out: no box, and the form goes straight to Leaflet', async () => {
    const h = setup({ start: null });
    await h.mounted;
    expect(also().hidden).toBe(true);
    expect(submit().defaultPrevented).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('signed in and not subscribed on bluesky: one submit saves that subscription, then goes to Leaflet', async () => {
    const h = setup();
    await h.mounted;
    expect(also().hidden).toBe(false);
    expect(also().textContent).toBe(COPY.email.also('me.test'));
    expect(box().checked).toBe(true);
    const sent = vi.spyOn(form(), 'submit').mockImplementation(() => undefined);
    expect(submit().defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(h.calls).toEqual([
      {
        path: '/xrpc/com.atproto.repo.createRecord',
        body: { repo: ME, collection: 'site.standard.graph.subscription', record: { $type: 'site.standard.graph.subscription', publication: PUB, createdAt: '2026-10-19T12:00:00.000Z' } },
      },
    ]);
    expect($('button[data-blog-subscribe]').getAttribute('aria-pressed')).toBe('true');
    expect(also().hidden).toBe(true);
  });

  it('unticked, or already subscribed on bluesky: the form goes straight to Leaflet', async () => {
    const h = setup();
    await h.mounted;
    box().checked = false;
    expect(submit().defaultPrevented).toBe(false);
    expect(h.calls).toEqual([]);

    document.body.innerHTML = postPage({ email: true });
    const subscribed = setup({ owned: SUBSCRIBED });
    await subscribed.mounted;
    expect(also().hidden).toBe(true);
    expect(submit().defaultPrevented).toBe(false);
    expect(subscribed.calls).toEqual([]);
  });

  it('a failed save keeps the reader here, with a way forward', async () => {
    setup({ failWrites: 500 });
    await flush();
    await vi.waitFor(() => expect(also().hidden).toBe(false));
    const sent = vi.spyOn(form(), 'submit').mockImplementation(() => undefined);
    expect(submit().defaultPrevented).toBe(true);
    await vi.waitFor(() => expect($('.blog-email__error').hidden).toBe(false));
    expect($('.blog-email__error').textContent).toBe(COPY.email.failed);
    expect(sent).not.toHaveBeenCalled();
    expect(form().querySelector('button[type="submit"]')!.hasAttribute('aria-busy')).toBe(false);
  });

  it('points a new bluesky subscriber at the email form', async () => {
    const h = setup();
    await h.mounted;
    $('button[data-blog-subscribe]').click();
    await vi.waitFor(() => expect($('[data-blog-account] .blog-account__notice').textContent).toBe(COPY.notices.subscribedAddEmail));
  });

  it('back from Leaflet: says so, and takes the marker off the address', async () => {
    const h = setup({ start: null, search: '?subscribed=email', hash: '#subscribe' });
    await h.mounted;
    expect($('[data-blog-account]').textContent).toBe(COPY.notices.emailSubscribed);
    expect(h.win.history.replaceState).toHaveBeenCalledWith(null, '', '/blog/3doc#subscribe');
  });
});
