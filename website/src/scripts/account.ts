/**
 * The reader's account in the header, on every page: a "sign in" button when nobody is
 * signed in, and their avatar once they are, which opens a little card with their name, a
 * link to their garden and to their Bluesky profile, and "sign out".
 *
 * Signing in uses the same dialog and session as everything else (src/blog/signin.ts,
 * src/blog/auth.ts); the header partial brings the dialog to every page. Before leaving,
 * this saves an "account" intent (state.ts) so the blog's callback page sends the reader
 * back here. This module also answers Poe's "poe:signin" (src/poe/ui.ts), saving a "poe"
 * intent, so the panel's sign-in link opens the dialog in place on any page.
 *
 * Back from signing in on a page that isn't the blog: an "account" intent just ends with a
 * little cheer, a "poe" one opens the panel again. On blog pages src/blog/ui.ts does that.
 *
 * The OAuth library only loads for a reader with a remembered account. Their avatar is
 * drawn straight away from the handle the site remembers (src/scripts/reader.ts), and the
 * session itself is checked once the page is idle, so an expired sign-in turns back into
 * "sign in" without holding anything up.
 *
 * DOM is built with createElement and textContent only.
 */

import { SESSION_EVENT, sharedAuth, type Auth, type Session, type SessionEventDetail } from '../blog/auth';
import { el, loadMe, loadProfile, mountSignIn, type Me, type SignIn } from '../blog/signin';
import { clearPending, localStoreFor, readPending, safeReturnTo, savePending, sessionStoreFor, type IntentKind } from '../blog/state';
import type { KeyValueStore } from '../poe/storage';
import { cheer } from './burst';
import { forgetReader, readReader, rememberReader } from './reader';

export const ACCOUNT_COPY = {
  signIn: 'sign in',
  signInLabel: 'sign in with bluesky',
  lede: 'sign in with your bluesky account to plant flowers, comment on the blog, and let poe remember you.',
  poeLede: "sign in with your bluesky account so poe remembers you, the same way it does when you mention it on bluesky. what poe remembers is public in its repo.",
  menuLabel: (who: string) => `your account, ${who}`,
  garden: 'your garden',
  profile: 'bluesky profile',
  signOut: 'sign out',
  signingOut: 'signing out…',
} as const;

/** How long after load the remembered session is checked, when nothing else needs it sooner. */
export const VERIFY_DELAY_MS = 2500;

export interface AccountOptions {
  doc?: Document;
  win?: Window;
  /** Defaults to sharedAuth(win); null means signing in isn't offered on this host. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sessionStore?: KeyValueStore;
  localStore?: KeyValueStore;
  /** Reloads the page after a sign-out, so every part of it forgets the reader. */
  reload?: () => void;
}

type View = { kind: 'signed-out' } | { kind: 'signed-in'; me: Me };

const PENDING_HERE: ReadonlySet<IntentKind> = new Set<IntentKind>(['account', 'poe']);

function display(me: Me): string {
  return me.handle.startsWith('did:') ? me.handle : `@${me.handle}`;
}

export function mountAccount(opts: AccountOptions = {}): void {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const slot = doc.querySelector<HTMLElement>('[data-site-account]');
  const auth = opts.auth === undefined ? sharedAuth(win) : opts.auth;
  if (!slot || !auth || slot.dataset.accountReady === 'true') return;
  slot.dataset.accountReady = 'true';

  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const store = opts.sessionStore ?? sessionStoreFor(win);
  const local = opts.localStore ?? localStoreFor(win);
  const reload = opts.reload ?? (() => win.location.reload());
  const onBlog = doc.body?.dataset.page === 'blog';
  const here = () => safeReturnTo(win.location.pathname);

  const dialog = doc.querySelector<HTMLDialogElement>('dialog[data-blog-signin]');
  const leaveAs = (kind: IntentKind) => () => savePending(store, { kind, returnTo: here() ?? '/blog', at: now() });
  const signIn: SignIn = mountSignIn({ doc, win, dialog, auth, fetchImpl, local, now, beforeLeave: leaveAs('account') });

  let view: View = { kind: 'signed-out' };
  let session: Session | null = null;
  let menuOpen = false;
  let verified: Promise<void> | null = null;

  /* ---------- drawing ---------- */

  function avatar(me: Me, className: string, size: string): HTMLElement {
    return me.avatar
      ? el(doc, 'img', { class: className, src: me.avatar, alt: '', width: size, height: size, decoding: 'async' })
      : el(doc, 'span', { class: `${className} ${className}--blank`, 'aria-hidden': 'true' }, (me.handle.replace(/^did:[a-z]+:/, '')[0] ?? '?').toUpperCase());
  }

  function render(): void {
    slot!.replaceChildren();
    slot!.dataset.state = view.kind;
    menuOpen = false;
    if (view.kind === 'signed-out') {
      const button = el(doc, 'button', { type: 'button', class: 'btn btn--outline site-account__signin', 'aria-label': ACCOUNT_COPY.signInLabel });
      button.append(butterfly(), el(doc, 'span', {}, ACCOUNT_COPY.signIn));
      button.addEventListener('click', () => openSignIn('account'));
      slot!.append(button);
      return;
    }
    const me = view.me;
    const toggle = el(doc, 'button', {
      type: 'button',
      class: 'site-account__toggle',
      'aria-expanded': 'false',
      'aria-controls': 'site-account-card',
      'aria-label': ACCOUNT_COPY.menuLabel(display(me)),
    });
    toggle.append(avatar(me, 'site-account__avatar', '40'), el(doc, 'span', { class: 'site-account__name' }, display(me)));

    const card = el(doc, 'div', { class: 'site-account__card', id: 'site-account-card', 'data-account-card': '' });
    card.hidden = true;
    const who = el(doc, 'div', { class: 'site-account__who' });
    const names = el(doc, 'span', { class: 'site-account__names' });
    names.append(el(doc, 'span', { class: 'site-account__display' }, me.name));
    if (me.name !== display(me)) names.append(el(doc, 'span', { class: 'site-account__handle' }, display(me)));
    who.append(avatar(me, 'site-account__avatar site-account__avatar--big', '48'), names);

    const list = el(doc, 'ul', { class: 'site-account__links', role: 'list' });
    const garden = el(doc, 'a', { class: 'site-account__link', href: `/garden/${encodeURIComponent(me.handle)}` }, ACCOUNT_COPY.garden);
    const profile = el(doc, 'a', { class: 'site-account__link', href: `https://bsky.app/profile/${encodeURIComponent(me.handle)}`, target: '_blank', rel: 'noopener' }, ACCOUNT_COPY.profile);
    const out = el(doc, 'button', { type: 'button', class: 'site-account__link site-account__out' }, ACCOUNT_COPY.signOut);
    out.addEventListener('click', () => void signOut(out));
    for (const item of [garden, profile, out]) {
      const li = el(doc, 'li');
      li.append(item);
      list.append(li);
    }
    card.append(who, list);

    toggle.addEventListener('click', () => setMenu(!menuOpen));
    slot!.append(toggle, card);
  }

  function butterfly(): SVGSVGElement {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', fill: 'currentColor', class: 'site-account__icon' })) svg.setAttribute(k, v);
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute(
      'd',
      'M6.3 4.2C8.6 5.9 11 9.4 12 11.4c1-2 3.4-5.5 5.7-7.2 1.6-1.2 4.3-2.2 4.3.9 0 .6-.4 5.2-.6 5.9-.7 2.6-3.3 3.2-5.7 2.8 4.1.7 5.2 3 2.9 5.3-4.3 4.4-6.2-1.1-6.6-2.5l-.1-.3-.1.3c-.4 1.4-2.3 6.9-6.6 2.5-2.3-2.3-1.2-4.6 2.9-5.3-2.4.4-5-.2-5.7-2.8C2.4 10.3 2 5.7 2 5.1c0-3.1 2.7-2.1 4.3-.9z',
    );
    svg.append(path);
    return svg as SVGSVGElement;
  }

  /* ---------- the little card ---------- */

  const onOutside = (event: Event) => {
    const target = event.target instanceof Node ? event.target : null;
    if (target && !slot!.contains(target)) setMenu(false);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setMenu(false);
    slot!.querySelector<HTMLElement>('.site-account__toggle')?.focus();
  };

  function setMenu(open: boolean): void {
    const toggle = slot!.querySelector<HTMLButtonElement>('.site-account__toggle');
    const card = slot!.querySelector<HTMLElement>('[data-account-card]');
    if (!toggle || !card || open === menuOpen) return;
    menuOpen = open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      card.hidden = false;
      void card.offsetWidth;
      card.classList.add('is-open');
      doc.addEventListener('pointerdown', onOutside, true);
      doc.addEventListener('focusin', onOutside);
      slot!.addEventListener('keydown', onKey);
    } else {
      card.classList.remove('is-open');
      card.hidden = true;
      doc.removeEventListener('pointerdown', onOutside, true);
      doc.removeEventListener('focusin', onOutside);
      slot!.removeEventListener('keydown', onKey);
    }
  }

  /* ---------- signing in and out ---------- */

  function openSignIn(kind: 'account' | 'poe'): void {
    // The phone menu sheet traps focus; it closes first, and focus comes back to its toggle.
    const navToggle = doc.querySelector<HTMLElement>('[data-nav-toggle][aria-expanded="true"]');
    navToggle?.click();
    signIn.open(kind === 'poe' ? ACCOUNT_COPY.poeLede : ACCOUNT_COPY.lede, {
      beforeLeave: leaveAs(kind),
      onDismiss: navToggle ? () => navToggle.focus() : undefined,
    });
  }

  async function show(s: Session): Promise<void> {
    session = s;
    const me = await loadMe(fetchImpl, s.did);
    if (session !== s) return;
    if (!me.handle.startsWith('did:')) rememberReader(me.handle);
    view = { kind: 'signed-in', me };
    render();
  }

  function forget(): void {
    session = null;
    forgetReader();
    view = { kind: 'signed-out' };
    render();
  }

  async function signOut(button: HTMLButtonElement): Promise<void> {
    button.setAttribute('aria-busy', 'true');
    button.textContent = ACCOUNT_COPY.signingOut;
    const s = session ?? (await auth!.start().catch(() => null))?.session ?? null;
    forget();
    win.dispatchEvent(new CustomEvent<SessionEventDetail>(SESSION_EVENT, { detail: { did: null } }));
    await s?.signOut().catch(() => undefined);
    reload();
  }

  /** Checks the remembered session once; never throws. */
  function verify(): Promise<void> {
    verified ??= (async () => {
      const result = await auth!.start().catch(() => null);
      if (result?.session) await show(result.session);
      else forget();
      if (onBlog || !result?.session) return;
      const pending = readPending(store, now());
      if (!pending || !PENDING_HERE.has(pending.kind) || pending.returnTo !== here()) return;
      clearPending(store);
      if (pending.kind === 'poe') win.dispatchEvent(new Event('poe:open'));
      else {
        slot!.classList.add('is-new');
        cheer(win);
      }
    })();
    return verified;
  }

  // Poe's panel: its sign-in link opens this dialog in place. On blog pages too: the blog
  // finishes a "poe" sign-in itself once the reader is back.
  win.addEventListener('poe:signin', () => openSignIn('poe'));
  if (dialog) dialog.dataset.poeReady = '';

  win.addEventListener(SESSION_EVENT, (event) => {
    const did = (event as CustomEvent<SessionEventDetail>).detail?.did;
    if (!did) {
      if (view.kind === 'signed-in') forget();
      return;
    }
    if (session?.did === did) return;
    void auth.start().then((result) => {
      if (result.session?.did === did) void show(result.session);
    });
  });

  if (!auth.eager) {
    render();
    return;
  }
  // A remembered handle draws the avatar now; the session is checked when the page is idle,
  // or right away when this load is a sign-in coming back.
  const remembered = readReader();
  if (remembered) {
    view = { kind: 'signed-in', me: { did: '', handle: remembered, name: `@${remembered}`, avatar: null } };
    void loadProfile(fetchImpl, remembered).then((p) => {
      if (p && view.kind === 'signed-in' && view.me.handle === remembered && !session) {
        view = { kind: 'signed-in', me: p };
        render();
      }
    });
  } else slot.dataset.state = 'checking';
  if (view.kind === 'signed-in') render();
  const soon = !remembered || readPending(store, now()) !== null;
  if (soon) void verify();
  else win.setTimeout(() => void verify(), VERIFY_DELAY_MS);
}
