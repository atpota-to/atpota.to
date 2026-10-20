/**
 * The settings page (settings/index.html): who the reader is signed in as, and "forget me",
 * which has Poe empty every note it keeps about them.
 *
 * Forgetting works like Poe's sign-in (src/poe/identity.ts), for a different method: this
 * asks the reader's own PDS for an atproto service-auth token addressed to atpota.to for
 * to.atpota.poe.forget, good for a minute, and sends it with DELETE /api/poe. The proxy
 * verifies it (server/identity.ts) and has the bot wipe the notes for that DID
 * (server/forget.ts). A sign-in from before that permission existed can't get the token,
 * so the page asks the reader to sign in again, which comes back here.
 *
 * Signing in is the header's (src/scripts/account.ts answers "account:signin"). The OAuth
 * library only loads for a reader with a remembered account.
 *
 * DOM is built with createElement and textContent only.
 */

import { SESSION_EVENT, sharedAuth, type Auth, type Session, type SessionEventDetail } from '../blog/auth';
import { el, isBusy, loadMe, setBusy, type Me } from '../blog/signin';

/** What a forget token is addressed to and scoped to; server/identity.ts accepts nothing else. */
export const POE_SERVICE_DID = 'did:web:atpota.to';
export const POE_FORGET_LXM = 'to.atpota.poe.forget';
/** Long enough to reach atpota.to, short enough to be useless to anyone who saw it. */
export const FORGET_TOKEN_LIFETIME_S = 60;
/** Asks the header to open the sign-in dialog, coming back to this page. */
export const SIGNIN_EVENT = 'account:signin';

export const SETTINGS_COPY = {
  lede: (who: string) => `signed in as ${who}.`,
  checkingLede: 'checking who you are…',
  signedOutLede: "you're not signed in.",
  unavailableTitle: 'settings',
  unavailableLede: 'settings need a bluesky sign-in, which only works on atpota.to itself.',
  working: 'asking poe to forget you…',
  forgotten: 'done. poe has forgotten you: its notes about you are empty, here, on bluesky and in its repo.',
  forgottenLocal: "done. poe's notes about you are empty. the public copy in its repo hasn't caught up yet, so press the button again in a little while to finish.",
  nothing: "poe didn't have any notes about you, so there was nothing to forget.",
  needsSignIn: 'poe needs your permission to forget you, and your sign-in is from before it asked for that. sign in again, then press the button once more.',
  failed: "poe couldn't finish forgetting just now. try again in a moment.",
} as const;

export type ForgetOutcome =
  | { kind: 'forgotten'; hadNotes: boolean; published: boolean }
  | { kind: 'needs-sign-in' }
  | { kind: 'failed'; message: string | null };

const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

async function errorCode(res: Response): Promise<string | null> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : null;
}

/** A token for one "forget me", or the reason there isn't one. Never throws. */
async function forgetToken(session: Session, now: () => number): Promise<string | 'needs-sign-in' | null> {
  const ask = (exp: number | null) => {
    const params = new URLSearchParams({ aud: POE_SERVICE_DID, lxm: POE_FORGET_LXM });
    if (exp !== null) params.set('exp', String(exp));
    return session.fetch(`/xrpc/com.atproto.server.getServiceAuth?${params}`, { method: 'GET' });
  };
  try {
    let res = await ask(Math.floor(now() / 1000) + FORGET_TOKEN_LIFETIME_S);
    // This device's clock is off; let the PDS pick its own short lifetime.
    if (res.status === 400 && (await errorCode(res)) === 'BadExpiration') res = await ask(null);
    // Most likely a sign-in from before the forget permission was part of it.
    if (res.status === 400 || res.status === 401 || res.status === 403) return 'needs-sign-in';
    if (!res.ok) return null;
    const token = ((await res.json().catch(() => null)) as { token?: unknown } | null)?.token;
    return typeof token === 'string' && token.length <= 4096 && TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Has Poe forget the signed-in reader. Never throws. */
export async function forgetMe(session: Session, fetchImpl: typeof fetch, now: () => number = () => Date.now()): Promise<ForgetOutcome> {
  const token = await forgetToken(session, now);
  if (token === 'needs-sign-in') return { kind: 'needs-sign-in' };
  if (token === null) return { kind: 'failed', message: null };
  let res: Response;
  try {
    res = await fetchImpl('/api/poe', { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin' });
  } catch {
    return { kind: 'failed', message: null };
  }
  const body = (await res.json().catch(() => null)) as { hadNotes?: unknown; published?: unknown; error?: { message?: unknown } } | null;
  if (res.status === 401) return { kind: 'needs-sign-in' };
  if (res.ok && typeof body?.hadNotes === 'boolean' && typeof body.published === 'boolean') {
    return { kind: 'forgotten', hadNotes: body.hadNotes, published: body.published };
  }
  const message = body?.error?.message;
  return { kind: 'failed', message: typeof message === 'string' && message.length <= 300 ? message : null };
}

/** The line shown once Poe has answered. */
export function outcomeText(outcome: ForgetOutcome): string {
  switch (outcome.kind) {
    case 'forgotten':
      if (!outcome.hadNotes) return SETTINGS_COPY.nothing;
      return outcome.published ? SETTINGS_COPY.forgotten : SETTINGS_COPY.forgottenLocal;
    case 'needs-sign-in':
      return SETTINGS_COPY.needsSignIn;
    case 'failed':
      return outcome.message ?? SETTINGS_COPY.failed;
  }
}

export interface SettingsOptions {
  doc?: Document;
  win?: Window;
  /** Defaults to sharedAuth(win); null means signing in isn't offered on this host. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type State = 'checking' | 'unavailable' | 'signed-out' | 'signed-in';

export async function init(opts: SettingsOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const root = doc.querySelector<HTMLElement>('[data-settings-page]');
  if (!root || root.dataset.settingsReady === 'true') return;
  root.dataset.settingsReady = 'true';
  const auth = opts.auth === undefined ? sharedAuth(win) : opts.auth;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const title = q<HTMLElement>('[data-settings-title]');
  const lede = q<HTMLElement>('[data-settings-lede]');
  const avatarSlot = q<HTMLElement>('[data-settings-avatar]');
  const signinCard = q<HTMLElement>('[data-settings-signin]');
  const memoryCard = q<HTMLElement>('[data-settings-memory]');
  const start = q<HTMLButtonElement>('[data-forget-start]');
  const confirm = q<HTMLElement>('[data-forget-confirm]');
  const yes = q<HTMLButtonElement>('[data-forget-yes]');
  const no = q<HTMLButtonElement>('[data-forget-no]');
  const status = q<HTMLElement>('[data-forget-status]');
  const again = q<HTMLButtonElement>('[data-forget-signin]');

  let session: Session | null = null;

  const askSignIn = () => win.dispatchEvent(new Event(SIGNIN_EVENT));
  q<HTMLButtonElement>('[data-settings-signin-button]').addEventListener('click', askSignIn);
  again.addEventListener('click', askSignIn);

  function setState(state: State, me?: Me): void {
    root!.dataset.state = state;
    signinCard.hidden = state !== 'signed-out';
    memoryCard.hidden = state !== 'signed-in';
    avatarSlot.replaceChildren();
    if (state === 'unavailable') {
      title.textContent = SETTINGS_COPY.unavailableTitle;
      lede.textContent = SETTINGS_COPY.unavailableLede;
    } else if (state === 'signed-out') lede.textContent = SETTINGS_COPY.signedOutLede;
    else if (state === 'checking') lede.textContent = SETTINGS_COPY.checkingLede;
    else if (me) {
      const who = me.handle.startsWith('did:') ? me.handle : `@${me.handle}`;
      lede.textContent = SETTINGS_COPY.lede(who);
      avatarSlot.append(
        me.avatar
          ? el(doc, 'img', { class: 'settings-head__img', src: me.avatar, alt: '', width: '72', height: '72', decoding: 'async' })
          : el(doc, 'span', { class: 'settings-head__blank' }, (me.handle.replace(/^did:[a-z]+:/, '')[0] ?? '?').toUpperCase()),
      );
    }
  }

  function showConfirm(open: boolean): void {
    start.hidden = open;
    confirm.hidden = !open;
    (open ? yes : start).focus();
  }

  start.addEventListener('click', () => {
    status.textContent = '';
    again.hidden = true;
    showConfirm(true);
  });
  no.addEventListener('click', () => showConfirm(false));
  yes.addEventListener('click', async () => {
    const s = session;
    if (!s || isBusy(yes)) return;
    setBusy(yes, true);
    no.disabled = true;
    status.textContent = SETTINGS_COPY.working;
    const outcome = await forgetMe(s, fetchImpl, now);
    setBusy(yes, false);
    no.disabled = false;
    if (session !== s) return; // signed out meanwhile
    showConfirm(false);
    status.textContent = outcomeText(outcome);
    status.dataset.outcome = outcome.kind;
    again.hidden = outcome.kind !== 'needs-sign-in';
  });

  // Signing out in the header ends it here too.
  win.addEventListener(SESSION_EVENT, (event) => {
    if ((event as CustomEvent<SessionEventDetail>).detail?.did) return;
    session = null;
    setState('signed-out');
  });

  if (!auth) return setState('unavailable');
  if (!auth.eager) return setState('signed-out');
  setState('checking');
  const result = await auth.start().catch(() => null);
  if (!result?.session) return setState('signed-out');
  session = result.session;
  const me = await loadMe(fetchImpl, session.did);
  if (session) setState('signed-in', me);
}
