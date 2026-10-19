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
 *   scope         include:site.standard.authSocial (subscriptions and recommends) and
 *                 repo:pub.leaflet.comment, create and delete only
 *
 * Handles are resolved by atpota.to's own PDS, so a typed handle isn't sent to anyone else.
 * The library is loaded on demand: a reader who never signs in never downloads it.
 *
 * Local development uses a loopback client (http://127.0.0.1:<port>, not "localhost";
 * see the library's README). Other hosts, like Vercel previews, get no sign-in at all:
 * the auth server could not fetch metadata from a protected preview anyway.
 */

import type { OAuthSession } from '@atproto/oauth-client-browser';

export const SITE_ORIGIN = 'https://atpota.to';
export const CLIENT_ID = `${SITE_ORIGIN}/oauth-client-metadata.json`;
export const CALLBACK_PATH = '/blog';
/** Subscriptions and recommends (standard.site's own permission set), and comments. */
export const SCOPE = 'atproto include:site.standard.authSocial repo:pub.leaflet.comment?action=create&action=delete';
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

export interface Auth {
  readonly mode: AuthMode;
  /** True when start() is worth calling on page load (a callback, or a remembered account). */
  readonly eager: boolean;
  /** Restores the remembered session, or finishes a sign-in. Call once per page load. */
  start(): Promise<StartResult>;
  /** Sends the reader to their auth server. Resolves only if they never leave. */
  signIn(input: string): Promise<void>;
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

export function createAuth(win: Window = window): Auth | null {
  const mode = authMode(win.location);
  if (!mode) return null;
  type Client = import('@atproto/oauth-client-browser').BrowserOAuthClient;
  let client: Promise<Client> | null = null;
  const load = (): Promise<Client> =>
    (client ??= import('@atproto/oauth-client-browser').then(({ BrowserOAuthClient }) =>
      BrowserOAuthClient.load({
        clientId: mode === 'site' ? CLIENT_ID : loopbackClientId(win.location),
        handleResolver: HANDLE_RESOLVER,
        responseMode: 'fragment',
      }),
    ));
  const callback = isCallback(win.location);

  return {
    mode,
    eager: callback || hasStoredSession(() => win.localStorage),
    async start() {
      try {
        const result = await (await load()).init();
        return { session: result ? await wrap(result.session) : null, callback, error: null };
      } catch (error) {
        // An expired or revoked session lands here too; the library has already forgotten it.
        return { session: null, callback, error: callback ? errorText(error) : null };
      }
    },
    async signIn(input) {
      await (await load()).signIn(input, { scope: SCOPE });
    },
  };
}
