/**
 * Bluesky sign-in for the blog: an atproto OAuth public client that runs in the browser
 * (@atproto/oauth-client-browser). There is no session on atpota.to's server. Tokens and
 * their DPoP key stay in this browser's IndexedDB, and every write goes straight from
 * here to the reader's own PDS. The trade-off: the spec caps sessions for public clients
 * at two weeks, so readers sign in again after that.
 *
 *   client_id     https://atpota.to/oauth-client-metadata.json (public/). The client reads
 *                 it from there; tests/blog-client.test.ts checks it against SCOPE and
 *                 CALLBACK_PATH. (Vite won't bundle a file from public/.)
 *   redirect_uri  https://atpota.to/blog. The sign-in comes back to the blog index, and
 *                 src/blog/ui.ts sends the reader on to the page they started from.
 *   scope         include:site.standard.authSocial (subscriptions and recommends),
 *                 repo:pub.leaflet.comment, create and delete only, and
 *                 include:to.atpota.authFull, atpotato's own permission set
 *                 (lexicons/to/atpota/authFull.json, published by
 *                 scripts/publish-lexicons.ts): flowers and tending in the gardens, your
 *                 own garden, Poe's pet count (src/scripts/pet-sync.ts), and
 *                 rpc:to.atpota.poe.chat, which lets this browser ask the reader's PDS for
 *                 a short-lived token proving to atpota.to's Poe who they are, so Poe can
 *                 remember them (src/poe/identity.ts, server/identity.ts). New to.atpota
 *                 records go in the set, not here: authorization servers re-read a set
 *                 when sessions refresh, so readers don't have to sign in again for them.
 *                 A reader who signed in before the set has a session without it, and is
 *                 asked to sign in again when a write is refused.
 *
 * Handles are resolved by atpota.to's own PDS, so a typed handle isn't sent to anyone else.
 * The library is loaded on demand: a reader who never signs in never downloads it.
 *
 * Signing in is two steps, so nobody lands on a page they didn't expect: prepare() looks
 * the account up and gets the real authorization URL (without leaving), the dialog shows
 * who that is and which site comes next ("continue at bsky.social"), and go() leaves.
 *
 * Local development uses a loopback client (http://127.0.0.1:<port>, not "localhost";
 * see the library's README). Other hosts, like Vercel previews, get no sign-in at all:
 * the auth server could not fetch metadata from a protected preview anyway.
 */

import type { OAuthSession } from '@atproto/oauth-client-browser';

export const SITE_ORIGIN = 'https://atpota.to';
export const CLIENT_ID = `${SITE_ORIGIN}/oauth-client-metadata.json`;
export const CALLBACK_PATH = '/blog';
/**
 * atpotato's permission set. Its rpc permission (the one method a Poe sign-in token may
 * name) allows any audience so the set stays valid on every PDS (some don't take a
 * did#service audience yet); the token itself names atpota.to, and that is all
 * server/identity.ts accepts.
 */
export const ATPOTATO_SET = 'to.atpota.authFull';
/** Subscriptions and recommends (standard.site's own permission set), comments, and everything atpotato (its set). */
export const SCOPE = `atproto include:site.standard.authSocial include:${ATPOTATO_SET} repo:pub.leaflet.comment?action=create&action=delete`;
export const HANDLE_RESOLVER = 'https://pds.atpota.to';
/** Where the library remembers the signed-in account (localStorage). */
export const SESSION_KEY = '@@atproto/oauth-client-browser(sub)';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type AuthMode = 'site' | 'loopback';

type Place = Pick<Location, 'origin' | 'protocol' | 'hostname' | 'host' | 'port' | 'hash'>;

/** "site" on https://atpota.to, "loopback" on a local dev server, null anywhere else. */
export function authMode(loc: Place): AuthMode | null {
  if (loc.origin === SITE_ORIGIN) return 'site';
  if (loc.protocol === 'http:' && LOOPBACK.has(loc.hostname)) return 'loopback';
  return null;
}

/** The loopback client_id for a dev server: it names the callback and the scope. */
export function loopbackClientId(loc: Place): string {
  const host = loc.hostname === 'localhost' ? `127.0.0.1${loc.port ? `:${loc.port}` : ''}` : loc.host;
  const params = new URLSearchParams({ redirect_uri: `http://${host}${CALLBACK_PATH}`, scope: SCOPE });
  return `http://localhost?${params}`;
}

/** This page load is the auth server sending the reader back (fragment response mode). */
export function isCallback(loc: Pick<Location, 'hash'>): boolean {
  const params = new URLSearchParams(loc.hash.slice(1));
  return params.has('state') && (params.has('code') || params.has('error'));
}

/** True when the library has an account on record, without loading the library. */
export function hasStoredSession(storage: () => Storage | null | undefined): boolean {
  try {
    return Boolean(storage()?.getItem(SESSION_KEY));
  } catch {
    return false;
  }
}

export interface Session {
  did: string;
  /** Base URL of the account's PDS. */
  pds: string;
  /** Authenticated request to the account's PDS ("/xrpc/..."). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  signOut(): Promise<void>;
}

export interface StartResult {
  session: Session | null;
  /** This page load finished a sign-in (successfully or not). */
  callback: boolean;
  /** Set when a sign-in came back refused, cancelled or broken. */
  error: string | null;
}

/** A sign-in that is ready to go: the reader has not left the page yet. */
export interface Prepared {
  /** The authorization page on the reader's own server. */
  url: string;
  /** Its host, shown on the button ("continue at bsky.social"). */
  host: string;
  /** The account the input named, as the library resolved it; null for a bare server address. */
  account: { did: string; handle: string | null } | null;
  /** When the server was told to expect this sign-in (it forgets after about five minutes). */
  at: number;
}

export type PrepareErrorCode = 'not_found' | 'unreachable';

export class PrepareError extends Error {
  override name = 'PrepareError';
  constructor(
    readonly code: PrepareErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Auth {
  readonly mode: AuthMode;
  /** True when start() is worth calling on page load (a callback, or a remembered account). */
  readonly eager: boolean;
  /**
   * Restores the remembered session, or finishes a sign-in. Runs once per page load: later
   * calls (the blog and Poe both ask) get the same answer.
   */
  start(): Promise<StartResult>;
  /** Starts loading the OAuth library (when the sign-in dialog opens). */
  warm(): void;
  /**
   * Looks up the account and asks its server to expect a sign-in (a pushed authorization
   * request), without leaving the page, so the reader can see where they are going first.
   */
  prepare(input: string): Promise<Prepared>;
  /** Leaves for the prepared sign-in page. */
  go(prepared: Prepared): void;
}

async function wrap(session: OAuthSession): Promise<Session> {
  const info = await session.getTokenInfo(false);
  return {
    did: session.did,
    pds: info.aud.replace(/\/+$/, ''),
    fetch: (path, init) => session.fetchHandler(path, init),
    signOut: () => session.signOut(),
  };
}

function errorText(error: unknown): string {
  const params = (error as { params?: URLSearchParams })?.params;
  const code = params instanceof URLSearchParams ? params.get('error') : null;
  if (code === 'access_denied') return 'cancelled';
  return code ?? ((error as Error)?.name || 'error');
}

const HANDLE_INVALID = 'handle.invalid';

export function createAuth(win: Window = window, now: () => number = () => Date.now()): Auth | null {
  const mode = authMode(win.location);
  if (!mode) return null;
  type Client = import('@atproto/oauth-client-browser').BrowserOAuthClient;
  let client: Promise<Client> | null = null;
  const load = (): Promise<Client> => {
    client ??= import('@atproto/oauth-client-browser').then(({ BrowserOAuthClient }) =>
      BrowserOAuthClient.load({
        clientId: mode === 'site' ? CLIENT_ID : loopbackClientId(win.location),
        handleResolver: HANDLE_RESOLVER,
        responseMode: 'fragment',
      }),
    );
    // A failed load (offline, a deploy replaced the chunk) is retried next time.
    client.catch(() => (client = null));
    return client;
  };
  const callback = isCallback(win.location);
  let started: Promise<StartResult> | null = null;

  return {
    mode,
    eager: callback || hasStoredSession(() => win.localStorage),
    start() {
      // A callback's code can only be redeemed once, so the second caller must not try.
      started ??= (async () => {
        try {
          const result = await (await load()).init();
          return { session: result ? await wrap(result.session) : null, callback, error: null };
        } catch (error) {
          // An expired or revoked session lands here too; the library has already forgotten it.
          return { session: null, callback, error: callback ? errorText(error) : null };
        }
      })();
      return started;
    },
    warm() {
      void load().catch(() => undefined);
    },
    async prepare(input) {
      let c: Client;
      try {
        c = await load();
      } catch {
        throw new PrepareError('unreachable', 'oauth client did not load');
      }
      let account: Prepared['account'] = null;
      if (!input.startsWith('https://')) {
        // The same resolver (and cache) authorize() uses, so this is the account it signs in.
        const info = await c.identityResolver.resolve(input).catch(() => null);
        if (!info) throw new PrepareError('not_found', 'account not found');
        account = { did: info.did, handle: info.handle !== HANDLE_INVALID ? info.handle : null };
      }
      let url: URL;
      try {
        url = await c.authorize(input, { scope: SCOPE });
      } catch {
        throw new PrepareError('unreachable', 'authorization server did not answer');
      }
      return { url: url.href, host: url.host, account, at: now() };
    },
    go(prepared) {
      win.location.assign(prepared.url);
    },
  };
}

const shared = new WeakMap<Window, Auth | null>();

/**
 * The page's one Auth, for the blog's reader actions and for Poe alike, so a sign-in is
 * finished and a session restored exactly once whichever asks first.
 */
export function sharedAuth(win: Window = window): Auth | null {
  if (!shared.has(win)) shared.set(win, createAuth(win));
  return shared.get(win)!;
}

/**
 * Fired on window when the reader signs in or out on this page, so Poe can stop using a
 * session the blog just ended. detail.did is null after a sign-out.
 */
export const SESSION_EVENT = 'atpotato:session';
export type SessionEventDetail = { did: string | null };
