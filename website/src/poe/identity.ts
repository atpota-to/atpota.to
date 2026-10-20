/**
 * Who Poe is talking to, for a reader signed in with Bluesky on atpota.to (the blog's
 * sign-in, src/blog/auth.ts). Before a message goes out the widget asks the reader's own
 * PDS for an atproto service-auth token naming atpota.to and Poe's one method, and sends it
 * with the question; the proxy verifies it (server/identity.ts) and Poe recalls the notes
 * it keeps about them on Bluesky, and can add to them.
 *
 * The token lives in memory for at most half an hour. Nothing here holds up a question: no
 * sign-in, a session from before Poe's permission existed, a slow or failing PDS all mean
 * the question goes out anonymously, and the account line says what to do about it.
 *
 * The OAuth library only loads for a reader with a remembered account, and only once the
 * panel opens or a message is sent.
 */

import { SESSION_EVENT, type Auth, type Session, type SessionEventDetail } from '../blog/auth';
import type { KeyValueStore } from './storage';

/** What the token is addressed to and scoped to; server/identity.ts accepts nothing else. */
export const POE_SERVICE_DID = 'did:web:atpota.to';
export const POE_LXM = 'to.atpota.poe.chat';
export const TOKEN_LIFETIME_S = 30 * 60;
/** A token this close to expiring is replaced rather than sent. */
export const TOKEN_MARGIN_S = 2 * 60;
/** How long a question waits for a token before going out anonymously. */
export const TOKEN_WAIT_MS = 5000;
/** sessionStorage: who the last answered question was asked as ({ did, handle }). */
export const WHO_KEY = 'poe:who';

const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]{1,253})$/;
const HANDLE_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type IdentityState =
  /** No sign-in on this host (previews and other hosts). */
  | { kind: 'unavailable' }
  /** Not looked at yet. */
  | { kind: 'unknown' }
  | { kind: 'signed-out' }
  /** confirmed: the proxy verified a token from this session; handle as the AppView has it. */
  | { kind: 'signed-in'; did: string; handle: string | null; confirmed: boolean }
  /** Signed in, but Poe can't be told who they are: an older sign-in, or a token the proxy refused. */
  | { kind: 'needs-sign-in'; did: string };

/** Who the server knew a question's asker as. */
export interface Who {
  did: string | null;
  handle: string | null;
}

export function readWho(store: KeyValueStore): Who | null {
  try {
    const v = JSON.parse(store.get(WHO_KEY) ?? 'null') as Partial<Who> | null;
    if (!v || typeof v !== 'object') return null;
    const did = typeof v.did === 'string' && DID_RE.test(v.did) ? v.did : null;
    const handle = did && typeof v.handle === 'string' && HANDLE_RE.test(v.handle) ? v.handle : null;
    return { did, handle };
  } catch {
    return null;
  }
}

export function saveWho(store: KeyValueStore, who: Who): void {
  store.set(WHO_KEY, JSON.stringify(who));
}

export interface IdentityOptions {
  win?: Window;
  now?: () => number;
  /** Where the last confirmed handle is kept, so the account line can name it on the next page. */
  store?: KeyValueStore;
}

export class PoeIdentity {
  private current: IdentityState;
  private session: Session | null = null;
  private preparing: Promise<IdentityState> | null = null;
  private cached: { token: string; exp: number } | null = null;
  private readonly listeners = new Set<(state: IdentityState) => void>();
  private readonly now: () => number;
  private readonly store: KeyValueStore | null;
  private readonly detach: () => void;

  constructor(
    private readonly auth: Auth | null,
    options: IdentityOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? null;
    this.current = auth ? { kind: 'unknown' } : { kind: 'unavailable' };
    const win = options.win ?? (typeof window === 'undefined' ? null : window);
    const onSession = (event: Event) => this.onSession((event as CustomEvent<SessionEventDetail>).detail);
    win?.addEventListener(SESSION_EVENT, onSession);
    this.detach = () => win?.removeEventListener(SESSION_EVENT, onSession);
  }

  get state(): IdentityState {
    return this.current;
  }

  onChange(fn: (state: IdentityState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    this.detach();
    this.listeners.clear();
  }

  private set(state: IdentityState): void {
    this.current = state;
    for (const fn of this.listeners) fn(state);
  }

  /** The handle last confirmed for this DID in this tab, so the line names them before a message. */
  private knownHandle(did: string): string | null {
    const who = this.store ? readWho(this.store) : null;
    return who?.did === did ? who.handle : null;
  }

  /** Looks at the remembered account once. Never throws. */
  prepare(): Promise<IdentityState> {
    if (!this.auth) return Promise.resolve(this.current);
    if (this.current.kind !== 'unknown') return Promise.resolve(this.current);
    const auth = this.auth;
    this.preparing ??= (async () => {
      if (!auth.eager) {
        this.set({ kind: 'signed-out' });
        return this.current;
      }
      const result = await auth.start().catch(() => null);
      // A sign-out on this page while the library was loading wins.
      if (this.current.kind !== 'unknown') return this.current;
      this.session = result?.session ?? null;
      const did = this.session?.did;
      this.set(did && DID_RE.test(did) ? { kind: 'signed-in', did, handle: this.knownHandle(did), confirmed: false } : { kind: 'signed-out' });
      return this.current;
    })();
    return this.preparing;
  }

  /**
   * A token for the next question, or null to ask anonymously. Reuses one until it is
   * nearly spent. Gives up after TOKEN_WAIT_MS; never throws.
   */
  async token(): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TOKEN_WAIT_MS);
    });
    try {
      return await Promise.race([this.mint().catch(() => null), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async mint(): Promise<string | null> {
    await this.prepare();
    const session = this.session;
    if (!session || (this.current.kind !== 'signed-in' && this.current.kind !== 'needs-sign-in')) return null;
    const nowS = Math.floor(this.now() / 1000);
    if (this.cached && this.cached.exp - TOKEN_MARGIN_S > nowS) return this.cached.token;

    const ask = (exp: number | null) => {
      const params = new URLSearchParams({ aud: POE_SERVICE_DID, lxm: POE_LXM });
      if (exp !== null) params.set('exp', String(exp));
      return session.fetch(`/xrpc/com.atproto.server.getServiceAuth?${params}`, { method: 'GET' });
    };
    let exp: number = nowS + TOKEN_LIFETIME_S;
    let res = await ask(exp);
    if (res.status === 400 && (await errorCode(res)) === 'BadExpiration') {
      // This device's clock is off; let the PDS pick its own short lifetime.
      exp = nowS + 50;
      res = await ask(null);
    }
    if (this.session !== session) return null; // signed out meanwhile
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // Most likely a sign-in from before Poe's permission was part of it.
      this.cached = null;
      this.set({ kind: 'needs-sign-in', did: session.did });
      return null;
    }
    if (!res.ok) return null;
    const token = ((await res.json().catch(() => null)) as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || token.length > 4096 || !TOKEN_RE.test(token)) return null;
    this.cached = { token, exp };
    return token;
  }

  /** The proxy's answer about the token sent with the last question. */
  confirm(signedIn: boolean, handle: string | null): void {
    const did = this.current.kind === 'signed-in' || this.current.kind === 'needs-sign-in' ? this.current.did : null;
    if (!did) return;
    if (signedIn) {
      this.set({ kind: 'signed-in', did, handle: handle && HANDLE_RE.test(handle) ? handle : null, confirmed: true });
    } else {
      this.cached = null;
      this.set({ kind: 'needs-sign-in', did });
    }
  }

  private onSession(detail: SessionEventDetail | undefined): void {
    if (detail?.did) return; // a sign-in finishes on page load, which prepare() already reads
    this.session = null;
    this.cached = null;
    this.preparing = null;
    if (this.auth) this.set({ kind: 'signed-out' });
  }
}

async function errorCode(res: Response): Promise<string | null> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : null;
}
