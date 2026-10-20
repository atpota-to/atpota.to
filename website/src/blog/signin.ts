/**
 * The Bluesky sign-in dialog, shared by the blog (src/blog/ui.ts), the flower patches
 * (src/scripts/garden.ts, garden-page.ts), the header's account button and Poe's panel
 * (src/scripts/account.ts). The markup is the src/partials/signin.html partial, which the
 * header partial brings to every page. A dialog is wired once, by whoever mounts it first;
 * later mounts share that wiring and only bring their own beforeLeave.
 *
 * Step one asks for a handle. Step two shows who that is and the site the button leads to
 * ("continue at bsky.social"), so nobody is sent somewhere they didn't expect. Just before
 * leaving, beforeLeave() runs, so the caller can save what to finish once the reader is back.
 *
 * DOM is built with createElement and textContent only.
 */

import { PrepareError, type Auth, type Prepared } from './auth';
import { HANDLE_KEY } from './state';
import { focusForTyping } from '../scripts/typing-focus';
import type { KeyValueStore } from '../poe/storage';

export const APPVIEW = 'https://public.api.bsky.app';
/** A prepared sign-in is redone after this long (servers forget them after about five minutes). */
export const PREPARED_TTL_MS = 4 * 60_000;

export const SIGNIN_COPY = {
  signIn: {
    title: 'sign in with the atmosphere',
    isThisYou: 'is this you?',
    signInAt: 'sign in at',
    next: 'next',
    looking: 'looking you up…',
    where: (host: string) => `${host} is where your account lives. you'll approve atpota.to there, then come right back to this page.`,
    whereServer: (host: string) => `you'll sign in at ${host}, approve atpota.to there, then come right back to this page.`,
  },
  errors: {
    badHandle: "that doesn't look like a handle. try something like alice.bsky.social.",
    noAccount: "couldn't find that account. check the handle?",
    unreachable: "couldn't reach your account's server just now. try again in a bit?",
  },
} as const;

export interface Me {
  did: string;
  handle: string;
  name: string;
  avatar: string | null;
}

export const HANDLE_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]+)$/;

/**
 * What the reader typed, as something the OAuth client can start from: a handle ("@" and
 * case dropped; a bare name gets ".bsky.social"), a DID, or an https:// PDS address.
 */
export function normalizeHandle(raw: string): string | null {
  const v = raw.trim().replace(/^@/, '');
  if (DID_RE.test(v)) return v;
  if (/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/?$/.test(v)) return v.replace(/\/$/, '');
  const handle = v.toLowerCase();
  const full = handle.includes('.') ? handle : `${handle}.bsky.social`;
  return full.length <= 253 && HANDLE_RE.test(full) ? full : null;
}

export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Busy without `disabled`, so a keyboard reader's focus stays on the button while it works. */
export function setBusy(button: HTMLButtonElement, busy: boolean): void {
  if (busy) {
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
  } else {
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-disabled');
  }
}

export const isBusy = (button: HTMLButtonElement) => button.getAttribute('aria-busy') === 'true';

/** A profile from the public AppView by handle or DID, or null if it can't be read. */
export async function loadProfile(fetchImpl: typeof fetch, actor: string): Promise<Me | null> {
  try {
    const res = await fetchImpl(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const p = (await res.json()) as { did?: unknown; handle?: unknown; displayName?: unknown; avatar?: unknown };
    if (typeof p.did !== 'string' || !DID_RE.test(p.did)) return null;
    const handle = typeof p.handle === 'string' && HANDLE_RE.test(p.handle.toLowerCase()) ? p.handle.toLowerCase() : null;
    const name = typeof p.displayName === 'string' ? p.displayName.trim().slice(0, 64) : '';
    const avatar = typeof p.avatar === 'string' && p.avatar.startsWith('https://') ? p.avatar : null;
    return { did: p.did, handle: handle ?? p.did, name: name || (handle ? `@${handle}` : 'you'), avatar };
  } catch {
    return null;
  }
}

/** The signed-in reader's name and avatar; their DID if the profile can't be read. */
export async function loadMe(fetchImpl: typeof fetch, did: string): Promise<Me> {
  const p = await loadProfile(fetchImpl, did);
  return p?.did === did ? p : { did, handle: did, name: 'you', avatar: null };
}

export interface SignInOptions {
  doc: Document;
  win: Window;
  dialog: HTMLDialogElement | null;
  auth: Auth;
  fetchImpl: typeof fetch;
  local: KeyValueStore;
  now: () => number;
  /** Runs just before the reader leaves for their sign-in page. */
  beforeLeave: () => void;
}

export interface OpenOptions {
  /** Replaces the mount's beforeLeave for this opening. */
  beforeLeave?: () => void;
  /** Runs when the reader closes the dialog without leaving to sign in. */
  onDismiss?: () => void;
}

export interface SignIn {
  /** Opens the dialog with `lede` as its opening line. */
  open(lede: string, options?: OpenOptions): void;
  close(): void;
}

const mounted = new WeakMap<HTMLDialogElement, SignIn>();

export function mountSignIn(opts: SignInOptions): SignIn {
  const shared = opts.dialog ? mounted.get(opts.dialog) : undefined;
  const signIn = shared ?? wire(opts);
  if (!shared && opts.dialog) mounted.set(opts.dialog, signIn);
  return {
    open: (lede, options = {}) => signIn.open(lede, { beforeLeave: opts.beforeLeave, ...options }),
    close: () => signIn.close(),
  };
}

function wire(opts: SignInOptions): SignIn {
  const { doc, win, dialog, auth, fetchImpl, local, now } = opts;

  const q = <T extends Element = HTMLElement>(sel: string) => dialog?.querySelector<T>(sel) ?? null;
  const title = q('[data-blog-signin-title]');
  const form = q<HTMLFormElement>('[data-blog-signin-form]');
  const input = q<HTMLInputElement>('input[name="handle"]');
  const lede = q('[data-blog-signin-lede]');
  const dialogError = q('[data-blog-signin-error]');
  const submit = q<HTMLButtonElement>('[data-blog-signin-submit]');
  const confirmStep = q('[data-blog-signin-confirm]');
  const who = q('[data-blog-signin-who]');
  const goButton = q<HTMLButtonElement>('[data-blog-signin-go]');
  const hostLabel = q('[data-blog-signin-host]');
  const where = q('[data-blog-signin-where]');
  const goError = q('[data-blog-signin-go-error]');
  const back = q<HTMLButtonElement>('[data-blog-signin-back]');

  let opener: HTMLElement | null = null;
  let beforeLeave: () => void = opts.beforeLeave;
  let onDismiss: (() => void) | null = null;
  /** The input that was looked up, and what came back. */
  let prepared: { input: string; ready: Prepared } | null = null;
  /** Bumped whenever a lookup's answer would no longer be wanted (back, close). */
  let lookup = 0;

  function showDialogError(target: HTMLElement | null, message: string): void {
    if (!target) return;
    target.textContent = message;
    target.hidden = !message;
    if (target === dialogError) input?.setAttribute('aria-invalid', String(Boolean(message)));
  }

  function showStep(step: 'ask' | 'confirm'): void {
    if (form) form.hidden = step !== 'ask';
    if (confirmStep) confirmStep.hidden = step !== 'confirm';
    if (title) {
      const ready = prepared?.ready;
      title.textContent = step === 'ask' || !ready ? SIGNIN_COPY.signIn.title : ready.account ? SIGNIN_COPY.signIn.isThisYou : `${SIGNIN_COPY.signIn.signInAt} ${ready.host}`;
    }
  }

  function reset(): void {
    lookup++;
    prepared = null;
    showDialogError(dialogError, '');
    showDialogError(goError, '');
    if (submit) {
      setBusy(submit, false);
      submit.textContent = SIGNIN_COPY.signIn.next;
    }
    if (goButton) setBusy(goButton, false);
    showStep('ask');
  }

  // Engines without showModal/close (old Safari, jsdom) get a plain open attribute.
  function close(): void {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    if (typeof dialog.showModal !== 'function') onClosed();
  }

  /** Esc, the close button or a backdrop click: focus goes back to the button that opened it. */
  function onClosed(): void {
    reset();
    const dismissed = onDismiss;
    onDismiss = null;
    if (dismissed) dismissed();
    else if (opener?.isConnected) opener.focus();
    opener = null;
  }

  function open(text: string, options: OpenOptions = {}): void {
    if (!dialog || !form || !input) return;
    auth.warm();
    reset();
    beforeLeave = options.beforeLeave ?? opts.beforeLeave;
    onDismiss = options.onDismiss ?? null;
    if (lede) lede.textContent = text;
    if (!input.value) input.value = local.get(HANDLE_KEY) ?? '';
    opener = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    if (!dialog.hasAttribute('open')) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    focusForTyping(input, win, { select: true });
  }

  dialog?.querySelector('[data-blog-signin-close]')?.addEventListener('click', close);
  dialog?.addEventListener('close', onClosed);
  dialog?.addEventListener('click', (event) => {
    // A click on the backdrop lands on the <dialog> itself.
    if (event.target === dialog) close();
  });
  dialog?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && typeof dialog.showModal !== 'function') close();
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void lookUp();
  });
  back?.addEventListener('click', () => {
    reset();
    focusForTyping(input, win, { select: true });
  });
  goButton?.addEventListener('click', () => void leave());
  // Back from the sign-in page through the browser's back/forward cache: the button works again.
  win.addEventListener?.('pageshow', (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    if (goButton) setBusy(goButton, false);
  });

  function renderConfirm(ready: Prepared, profile: Me | null): void {
    if (who) {
      who.replaceChildren();
      who.hidden = !ready.account;
      if (ready.account) {
        const handle = profile?.handle && !profile.handle.startsWith('did:') ? profile.handle : ready.account.handle;
        who.append(
          profile?.avatar
            ? el(doc, 'img', { class: 'blog-signin__avatar', src: profile.avatar, alt: '', width: '48', height: '48' })
            : el(doc, 'span', { class: 'blog-signin__avatar blog-signin__avatar--blank', 'aria-hidden': 'true' }),
        );
        const names = el(doc, 'span', { class: 'blog-signin__names' });
        names.append(el(doc, 'span', { class: 'blog-signin__name' }, profile?.name ?? (handle ? `@${handle}` : ready.account.did)));
        names.append(el(doc, 'span', { class: 'blog-signin__handle' }, handle ? `@${handle}` : ready.account.did));
        who.append(names);
      }
    }
    if (hostLabel) hostLabel.textContent = ready.host;
    if (where) where.textContent = ready.account ? SIGNIN_COPY.signIn.where(ready.host) : SIGNIN_COPY.signIn.whereServer(ready.host);
    showDialogError(goError, '');
  }

  async function lookUp(): Promise<void> {
    if (!input || !submit || isBusy(submit)) return;
    const value = normalizeHandle(input.value);
    if (!value) {
      showDialogError(dialogError, SIGNIN_COPY.errors.badHandle);
      focusForTyping(input, win);
      return;
    }
    showDialogError(dialogError, '');
    local.set(HANDLE_KEY, value);
    setBusy(submit, true);
    submit.textContent = SIGNIN_COPY.signIn.looking;
    const ticket = ++lookup;
    // The profile is only for the "is this you?" card; it is fetched alongside, by what was typed.
    const typed = value.startsWith('https://') ? Promise.resolve(null) : loadProfile(fetchImpl, value);
    try {
      const ready = await auth.prepare(value);
      let profile = ready.account ? await typed : null;
      if (ready.account && profile?.did !== ready.account.did) profile = await loadProfile(fetchImpl, ready.account.did);
      if (ticket !== lookup) return;
      prepared = { input: value, ready };
      renderConfirm(ready, profile?.did === ready.account?.did ? profile : null);
      showStep('confirm');
      goButton?.focus();
    } catch (error) {
      if (ticket !== lookup) return;
      showDialogError(dialogError, error instanceof PrepareError && error.code === 'unreachable' ? SIGNIN_COPY.errors.unreachable : SIGNIN_COPY.errors.noAccount);
      focusForTyping(input, win);
    } finally {
      if (ticket === lookup) {
        setBusy(submit, false);
        submit.textContent = SIGNIN_COPY.signIn.next;
      }
    }
  }

  async function leave(): Promise<void> {
    if (!prepared || !goButton || isBusy(goButton)) return;
    setBusy(goButton, true);
    const ticket = lookup;
    let ready = prepared.ready;
    if (now() - ready.at > PREPARED_TTL_MS) {
      // The server has likely forgotten this sign-in by now: ask again, quietly.
      try {
        ready = await auth.prepare(prepared.input);
      } catch {
        if (ticket === lookup) {
          showDialogError(goError, SIGNIN_COPY.errors.unreachable);
          setBusy(goButton, false);
        }
        return;
      }
      if (ticket !== lookup) return;
      prepared = { input: prepared.input, ready };
      if (hostLabel) hostLabel.textContent = ready.host;
    }
    beforeLeave();
    auth.go(ready);
  }

  return { open, close };
}
