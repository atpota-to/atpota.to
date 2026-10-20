/**
 * Reader actions on the blog: sign in with Bluesky, subscribe to the publication,
 * recommend a post, and comment (reply, delete your own). main.ts runs this on
 * <body data-page="blog"> pages.
 *
 * The server renders the pieces (server/blog/pages.ts): subscribe and recommend buttons
 * (hidden), Leaflet's email subscribe forms, account lines, and the comments section with
 * an empty compose slot. This module reveals and wires them, builds the compose form and
 * per-comment buttons, and adds the reader's own new comments to the page. DOM is built
 * with createElement and textContent only; nothing from the network becomes HTML here.
 *
 * The email forms post straight to Leaflet and work without this module. For a reader
 * signed in with Bluesky who hasn't subscribed there yet, each gets an "also subscribe
 * with bluesky" box (ticked): submitting writes the subscription record first, then sends
 * the form on to Leaflet, so one submit does both.
 *
 * Sign-in leaves the page (auth.ts). Before it does, the action that prompted it is saved
 * (state.ts); when the reader is back on that page, signed in, the action finishes.
 *
 * Poe's panel signs readers in here too, so Poe can remember them: on a blog page its link
 * fires "poe:signin" on window, elsewhere it comes to /blog#sign-in. Either opens the dialog,
 * and once the reader is back the panel opens again. The session is the page's shared one
 * (sharedAuth), and every sign-in or sign-out here is announced with SESSION_EVENT so Poe
 * never keeps using a session the reader ended.
 */

import { PrepareError, SESSION_EVENT, sharedAuth, SITE_ORIGIN, type Auth, type Prepared, type Session, type SessionEventDetail } from './auth';
import {
  cleanCommentText,
  COMMENT,
  commentRecord,
  createRecord,
  deleteRecord,
  findOwn,
  MAX_COMMENT_LENGTH,
  parseRecordUri,
  RECOMMEND,
  recommendRecord,
  RepoError,
  SUBSCRIPTION,
  subscriptionRecord,
} from './repo';
import {
  clearPending,
  HANDLE_KEY,
  loadDraft,
  loadLocal,
  localStoreFor,
  readPending,
  rememberAdded,
  rememberRemoved,
  safeReturnTo,
  saveDraft,
  savePending,
  sessionStoreFor,
  type IntentKind,
  type LocalComment,
} from './state';
import type { KeyValueStore } from '../poe/storage';

export const APPVIEW = 'https://public.api.bsky.app';
/** Matches MAX_COMMENT_DEPTH in server/blog/pages.ts. */
export const MAX_DEPTH = 4;
export const NOTICE_KEY = 'blog:notice';
/** Leaflet sends a reader back with ?subscribed=email; matches server/blog/subscribe.ts. */
export const EMAIL_RETURN = { param: 'subscribed', value: 'email' } as const;

export const COPY = {
  /** Matches SUBSCRIBE_COPY.bluesky, the label the server renders. */
  subscribe: 'subscribe with bluesky',
  subscribed: 'subscribed on bluesky',
  recommend: 'recommend',
  recommended: 'recommended',
  signedInAs: 'signed in as',
  signOut: 'sign out',
  signInToComment: 'sign in with bluesky to comment',
  otherHost: 'sign in to comment on atpota.to',
  commentLabel: 'write a comment',
  replyLabel: 'write a reply',
  post: 'post',
  reply: 'reply',
  cancel: 'cancel',
  delete: 'delete',
  deleted: 'comment deleted',
  confirmDelete: "delete this comment? it's removed from your account for good.",
  empty: 'write something first.',
  justNow: 'just now',
  signIn: {
    title: 'sign in with bluesky',
    isThisYou: 'is this you?',
    signInAt: 'sign in at',
    next: 'next',
    looking: 'looking you up…',
    where: (host: string) => `${host} is where your account lives. you'll approve atpota.to there, then come right back to this page.`,
    whereServer: (host: string) => `you'll sign in at ${host}, approve atpota.to there, then come right back to this page.`,
  },
  lede: {
    subscribe: 'sign in with your bluesky account to subscribe. the subscription is saved in your own account, where leaflet and other standard.site readers can see it.',
    recommend: 'sign in with your bluesky account to recommend this post.',
    comment: 'sign in with your bluesky account to comment.',
    poe: "sign in with your bluesky account so poe remembers you here, the same way it does when you mention it on bluesky. what poe remembers is public in its repo.",
  } satisfies Record<IntentKind, string>,
  email: {
    also: (handle: string | null) => (handle ? `also subscribe with bluesky as @${handle}` : 'also subscribe with bluesky'),
    failed: "couldn't save the bluesky subscription. try again, or untick the box to subscribe by email only.",
  },
  notices: {
    subscribed: 'subscribed! readers like leaflet will show you new issues.',
    subscribedAddEmail: 'subscribed on bluesky! to get it in your inbox too, add your email above.',
    emailSubscribed: "you're subscribed by email. see you in your inbox!",
    unsubscribed: 'unsubscribed.',
    signedOut: 'signed out.',
    cancelled: "sign-in was cancelled, so nothing changed.",
    signInFailed: "sign-in didn't finish. try again?",
    saveFailed: "that didn't save. try again in a moment?",
    expired: 'your sign-in expired. sign in again to keep going.',
    posted: 'comment posted.',
  },
  errors: {
    badHandle: "that doesn't look like a handle. try something like alice.bsky.social.",
    noAccount: "couldn't find that account. check the handle?",
    unreachable: "couldn't reach your account's server just now. try again in a bit?",
  },
} as const;

export interface BlogOptions {
  doc?: Document;
  win?: Window;
  /** Defaults to sharedAuth(win); null means sign-in isn't offered on this host. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sessionStore?: KeyValueStore;
  localStore?: KeyValueStore;
  confirm?: (message: string) => boolean;
}

interface Me {
  did: string;
  handle: string;
  name: string;
  avatar: string | null;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const HANDLE_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]+)$/;
const AUTH_ERRORS = new Set(['TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError']);

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

export function isAuthError(error: unknown): boolean {
  if (error instanceof RepoError) return error.status === 401;
  return AUTH_ERRORS.has((error as Error)?.name ?? '');
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function profileUrl(handle: string): string {
  return `https://bsky.app/profile/${encodeURIComponent(handle)}`;
}

function recordUrl(uri: string): string | null {
  const at = parseRecordUri(uri);
  return at ? `https://aturi.to/profile/${at.did}/${at.collection}/${at.rkey}` : null;
}

/** A profile from the public AppView by handle or DID, or null if it can't be read. */
async function loadProfile(fetchImpl: typeof fetch, actor: string): Promise<Me | null> {
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
async function loadMe(fetchImpl: typeof fetch, did: string): Promise<Me> {
  const p = await loadProfile(fetchImpl, did);
  return p?.did === did ? p : { did, handle: did, name: 'you', avatar: null };
}

/** A prepared sign-in is redone after this long (servers forget them after about five minutes). */
export const PREPARED_TTL_MS = 4 * 60_000;

/**
 * Wires the page. Resolves once the reader's session (if any) has been restored, the page
 * shows their state, and any action they started before signing in has run.
 */
export async function mountBlog(opts: BlogOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const store = opts.sessionStore ?? sessionStoreFor(win);
  const local = opts.localStore ?? localStoreFor(win);
  const confirmFn = opts.confirm ?? ((message: string) => win.confirm(message));

  const root = doc.querySelector<HTMLElement>('[data-blog-document], [data-blog-publication]');
  const publication = root?.getAttribute('data-blog-publication') ?? null;
  const documentUri = root?.getAttribute('data-blog-document') ?? null;
  const subscribeButtons = publication ? [...doc.querySelectorAll<HTMLButtonElement>('button[data-blog-subscribe]')] : [];
  const emailForms = publication ? [...doc.querySelectorAll<HTMLFormElement>('form[data-blog-email]')] : [];
  const recommendButton = documentUri ? doc.querySelector<HTMLButtonElement>('button[data-blog-recommend]') : null;
  const accountLines = [...doc.querySelectorAll<HTMLElement>('[data-blog-account]')];
  const talk = documentUri ? doc.querySelector<HTMLElement>('[data-blog-comments]') : null;
  const compose = talk?.querySelector<HTMLElement>('[data-comment-compose]') ?? null;
  const commentList = talk?.querySelector<HTMLOListElement>('[data-comment-list]') ?? null;
  const dialog = doc.querySelector<HTMLDialogElement>('dialog[data-blog-signin]');
  const auth = opts.auth === undefined ? sharedAuth(win) : opts.auth;

  if (!root || (!subscribeButtons.length && !recommendButton && !talk)) return;

  if (!auth) {
    // Previews and other hosts: point at the real site instead of offering a sign-in that can't work.
    if (compose) {
      const link = el(doc, 'a', { class: 'btn btn--outline btn--sm', href: `${SITE_ORIGIN}${win.location.pathname}#comments` }, COPY.otherHost);
      compose.replaceChildren(link);
      compose.hidden = false;
    }
    return;
  }
  const authed: Auth = auth;

  let session: Session | null = null;
  let me: Me | null = null;
  /** URIs of the reader's matching records; null while unknown. */
  let subscriptions: string[] | null = null;
  let recommends: string[] | null = null;
  let starting = false;
  let busySubscribe = false;
  let busyRecommend = false;
  let pendingKind: IntentKind = 'comment';
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let notice = '';
  const baseCount = Number(recommendButton?.dataset.recommendCount ?? 'NaN');
  let countDelta = 0;
  /** Announces comment changes inside the comments section. */
  const status = talk ? el(doc, 'p', { class: 'visually-hidden', role: 'status', 'data-comment-status': '' }) : null;
  if (status) talk?.append(status);

  /* ---------- account line and notices ---------- */

  function renderAccount(): void {
    for (const line of accountLines) {
      line.replaceChildren();
      if (session && me) {
        line.append(doc.createTextNode(`${COPY.signedInAs} `));
        line.append(el(doc, 'a', { class: 'blog-account__who', href: profileUrl(me.handle) }, me.handle.startsWith('did:') ? me.handle : `@${me.handle}`));
        line.append(doc.createTextNode(' · '));
        const out = el(doc, 'button', { type: 'button', class: 'blog-account__out' }, COPY.signOut);
        out.addEventListener('click', () => void signOut());
        line.append(out);
      }
      if (notice) line.append(el(doc, 'span', { class: 'blog-account__notice' }, notice));
      line.hidden = !(session && me) && !notice;
    }
  }

  function notify(message: string): void {
    notice = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = '';
      renderAccount();
    }, 10_000);
    renderAccount();
  }

  /* ---------- subscribe and recommend ---------- */

  /** Busy without `disabled`, so a keyboard reader's focus stays on the button while it saves. */
  function setBusy(button: HTMLButtonElement, busy: boolean): void {
    if (busy) {
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.removeAttribute('aria-busy');
      button.removeAttribute('aria-disabled');
    }
  }

  const isBusy = (button: HTMLButtonElement) => button.getAttribute('aria-busy') === 'true';

  function renderSubscribe(): void {
    const on = Boolean(session && subscriptions?.length);
    for (const button of subscribeButtons) {
      button.hidden = false;
      button.setAttribute('aria-pressed', String(on));
      button.classList.toggle('is-on', on);
      const label = button.querySelector('[data-blog-subscribe-label]') ?? button;
      label.textContent = on ? COPY.subscribed : COPY.subscribe;
      setBusy(button, starting || busySubscribe || Boolean(session && subscriptions === null));
    }
    renderEmailExtras();
  }

  function renderRecommend(): void {
    if (!recommendButton) return;
    const on = Boolean(session && recommends?.length);
    recommendButton.hidden = false;
    recommendButton.setAttribute('aria-pressed', String(on));
    recommendButton.classList.toggle('is-on', on);
    const label = recommendButton.querySelector('[data-blog-recommend-label]');
    if (label) label.textContent = on ? COPY.recommended : COPY.recommend;
    const count = recommendButton.querySelector('[data-blog-recommend-count]');
    if (count && Number.isFinite(baseCount)) {
      const n = Math.max(0, baseCount + countDelta);
      count.textContent = n ? String(n) : '';
    }
    setBusy(recommendButton, starting || busyRecommend || Boolean(session && recommends === null));
  }

  async function loadOwnState(): Promise<void> {
    const s = session;
    if (!s) return;
    await Promise.all([
      publication && subscribeButtons.length
        ? findOwn(s, SUBSCRIPTION, 'publication', publication, fetchImpl).then(
            (uris) => (subscriptions = uris),
            () => (subscriptions = []),
          )
        : null,
      documentUri && recommendButton
        ? findOwn(s, RECOMMEND, 'document', documentUri, fetchImpl).then(
            (uris) => (recommends = uris),
            () => (recommends = []),
          )
        : null,
    ]);
    if (session !== s) return;
    renderSubscribe();
    renderRecommend();
  }

  function failed(error: unknown): void {
    if (isAuthError(error)) {
      notify(COPY.notices.expired);
      signedOut();
    } else {
      notify(COPY.notices.saveFailed);
    }
  }

  /**
   * Makes the reader's repo match what the button promised: the shown state decides the
   * direction, and a fresh read decides what to write, so a stale page (another tab, a
   * failed first read) never creates a duplicate or deletes the wrong thing.
   */
  async function ensure(collection: string, field: string, value: string, on: boolean, record: () => Record<string, unknown>): Promise<string[]> {
    const s = session!;
    const existing = await findOwn(s, collection, field, value, fetchImpl);
    if (!on) {
      for (const uri of existing) await deleteRecord(s, uri);
      return [];
    }
    if (existing.length) return existing;
    return [(await createRecord(s, collection, record())).uri];
  }

  async function toggleSubscribe(): Promise<void> {
    if (starting) return;
    if (!session) return openSignIn('subscribe');
    if (!publication || subscriptions === null || busySubscribe) return;
    busySubscribe = true;
    renderSubscribe();
    const on = subscriptions.length === 0;
    try {
      subscriptions = await ensure(SUBSCRIPTION, 'publication', publication, on, () => subscriptionRecord(publication, new Date(now())));
      notify(on ? (emailForms.length ? COPY.notices.subscribedAddEmail : COPY.notices.subscribed) : COPY.notices.unsubscribed);
    } catch (error) {
      failed(error);
    } finally {
      busySubscribe = false;
      renderSubscribe();
    }
  }

  async function toggleRecommend(): Promise<void> {
    if (starting) return;
    if (!session) return openSignIn('recommend');
    if (!documentUri || recommends === null || busyRecommend) return;
    busyRecommend = true;
    renderRecommend();
    const on = recommends.length === 0;
    try {
      recommends = await ensure(RECOMMEND, 'document', documentUri, on, () => recommendRecord(documentUri, new Date(now())));
      countDelta += on ? 1 : -1;
    } catch (error) {
      failed(error);
    } finally {
      busyRecommend = false;
      renderRecommend();
    }
  }

  /* ---------- email subscribe forms ---------- */

  interface EmailExtras {
    form: HTMLFormElement;
    send: HTMLButtonElement | null;
    also: HTMLLabelElement;
    box: HTMLInputElement;
    alsoText: HTMLSpanElement;
    error: HTMLElement;
  }

  const emailExtras: EmailExtras[] = emailForms.map((form) => {
    const box = el(doc, 'input', { type: 'checkbox', class: 'blog-email__box' });
    box.checked = true;
    const alsoText = el(doc, 'span', {});
    const also = el(doc, 'label', { class: 'blog-email__also', hidden: '' });
    also.append(box, alsoText);
    const error = el(doc, 'p', { class: 'blog-email__error', role: 'alert', hidden: '' });
    const row = form.querySelector('.blog-email__row');
    if (row) row.after(also, error);
    else form.append(also, error);
    const x: EmailExtras = { form, send: form.querySelector<HTMLButtonElement>('button[type="submit"]'), also, box, alsoText, error };
    form.addEventListener('submit', (event) => void sendEmail(x, event));
    return x;
  });

  /** The "also subscribe with bluesky" box shows only while it would add something. */
  function renderEmailExtras(): void {
    const offer = Boolean(session && me && subscriptions && !subscriptions.length);
    for (const x of emailExtras) {
      x.also.hidden = !offer;
      if (offer && me) x.alsoText.textContent = COPY.email.also(me.handle.startsWith('did:') ? null : me.handle);
    }
  }

  /**
   * Lets the form go to Leaflet as is, unless the box is ticked: then the Bluesky
   * subscription is saved first. If that fails, the reader stays here to retry or untick.
   */
  async function sendEmail(x: EmailExtras, event: Event): Promise<void> {
    if (x.send && isBusy(x.send)) {
      event.preventDefault();
      return;
    }
    if (x.also.hidden || !x.box.checked || !session || !publication || !subscriptions || subscriptions.length || busySubscribe) return;
    event.preventDefault();
    x.error.hidden = true;
    busySubscribe = true;
    if (x.send) setBusy(x.send, true);
    renderSubscribe();
    try {
      subscriptions = await ensure(SUBSCRIPTION, 'publication', publication, true, () => subscriptionRecord(publication, new Date(now())));
    } catch (error) {
      x.error.textContent = isAuthError(error) ? COPY.notices.expired : COPY.email.failed;
      x.error.hidden = false;
      if (x.send) setBusy(x.send, false);
      if (isAuthError(error)) signedOut();
      return;
    } finally {
      busySubscribe = false;
      renderSubscribe();
    }
    // submit() skips the submit event (and validation, which already passed to get here).
    x.form.submit();
  }

  /* ---------- sign-in dialog ---------- */
  // Step one asks for a handle. Step two shows who that is and the site the button leads
  // to ("continue at bsky.social"), so nobody is sent somewhere they didn't expect.

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
      title.textContent = step === 'ask' || !ready ? COPY.signIn.title : ready.account ? COPY.signIn.isThisYou : `${COPY.signIn.signInAt} ${ready.host}`;
    }
  }

  function reset(): void {
    lookup++;
    prepared = null;
    showDialogError(dialogError, '');
    showDialogError(goError, '');
    if (submit) {
      setBusy(submit, false);
      submit.textContent = COPY.signIn.next;
    }
    if (goButton) setBusy(goButton, false);
    showStep('ask');
  }

  // Engines without showModal/close (old Safari, jsdom) get a plain open attribute.
  function closeSignIn(): void {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    if (typeof dialog.showModal !== 'function') onClosed();
  }

  /** Esc, the close button or a backdrop click: focus goes back to the button that opened it. */
  function onClosed(): void {
    reset();
    if (opener?.isConnected) opener.focus();
    opener = null;
  }

  function openSignIn(kind: IntentKind): void {
    pendingKind = kind;
    if (!dialog || !form || !input) return;
    authed.warm();
    reset();
    if (lede) lede.textContent = COPY.lede[kind];
    if (!input.value) input.value = local.get(HANDLE_KEY) ?? '';
    opener = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    if (!dialog.hasAttribute('open')) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    input.focus();
    input.select();
  }

  dialog?.querySelector('[data-blog-signin-close]')?.addEventListener('click', closeSignIn);
  dialog?.addEventListener('close', onClosed);
  dialog?.addEventListener('click', (event) => {
    // A click on the backdrop lands on the <dialog> itself.
    if (event.target === dialog) closeSignIn();
  });
  dialog?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && typeof dialog.showModal !== 'function') closeSignIn();
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void lookUp();
  });
  back?.addEventListener('click', () => {
    reset();
    input?.focus();
    input?.select();
  });
  goButton?.addEventListener('click', () => void leave());
  // Back from the sign-in page through the browser's back/forward cache: the button works again.
  win.addEventListener?.('pageshow', (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    if (goButton) setBusy(goButton, false);
    for (const x of emailExtras) if (x.send) setBusy(x.send, false);
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
    if (where) where.textContent = ready.account ? COPY.signIn.where(ready.host) : COPY.signIn.whereServer(ready.host);
    showDialogError(goError, '');
  }

  async function lookUp(): Promise<void> {
    if (!input || !submit || isBusy(submit)) return;
    const value = normalizeHandle(input.value);
    if (!value) {
      showDialogError(dialogError, COPY.errors.badHandle);
      input.focus();
      return;
    }
    showDialogError(dialogError, '');
    local.set(HANDLE_KEY, value);
    setBusy(submit, true);
    submit.textContent = COPY.signIn.looking;
    const ticket = ++lookup;
    // The profile is only for the "is this you?" card; it is fetched alongside, by what was typed.
    const typed = value.startsWith('https://') ? Promise.resolve(null) : loadProfile(fetchImpl, value);
    try {
      const ready = await authed.prepare(value);
      let profile = ready.account ? await typed : null;
      if (ready.account && profile?.did !== ready.account.did) profile = await loadProfile(fetchImpl, ready.account.did);
      if (ticket !== lookup) return;
      prepared = { input: value, ready };
      renderConfirm(ready, profile?.did === ready.account?.did ? profile : null);
      showStep('confirm');
      goButton?.focus();
    } catch (error) {
      if (ticket !== lookup) return;
      showDialogError(dialogError, error instanceof PrepareError && error.code === 'unreachable' ? COPY.errors.unreachable : COPY.errors.noAccount);
      input.focus();
    } finally {
      if (ticket === lookup) {
        setBusy(submit, false);
        submit.textContent = COPY.signIn.next;
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
        ready = await authed.prepare(prepared.input);
      } catch {
        if (ticket === lookup) {
          showDialogError(goError, COPY.errors.unreachable);
          setBusy(goButton, false);
        }
        return;
      }
      if (ticket !== lookup) return;
      prepared = { input: prepared.input, ready };
      if (hostLabel) hostLabel.textContent = ready.host;
    }
    savePending(store, { kind: pendingKind, returnTo: safeReturnTo(win.location.pathname) ?? '/blog', at: now() });
    authed.go(ready);
  }

  /* ---------- comments ---------- */

  function comments(): HTMLLIElement[] {
    return talk ? [...talk.querySelectorAll<HTMLLIElement>('li.comment')] : [];
  }

  function findComment(uri: string): HTMLLIElement | null {
    return comments().find((li) => li.dataset.comment === uri) ?? null;
  }

  function updateCount(): void {
    if (!talk) return;
    const n = comments().filter((li) => !li.classList.contains('is-deleted')).length;
    const count = talk.querySelector<HTMLElement>('[data-comment-count]');
    if (count) {
      count.dataset.commentCount = String(n);
      count.textContent = n === 1 ? '1 comment' : `${n} comments`;
      count.hidden = n === 0;
    }
    const empty = talk.querySelector<HTMLElement>('[data-comment-empty]');
    if (empty) empty.hidden = n > 0;
    if (commentList) commentList.hidden = commentList.children.length === 0;
  }

  function textWithBreaks(target: HTMLElement, text: string): void {
    text.split('\n').forEach((line, i) => {
      if (i) target.append(el(doc, 'br'));
      target.append(doc.createTextNode(line));
    });
  }

  /** The same markup the server renders for a comment (server/blog/pages.ts commentHtml). */
  function buildComment(c: LocalComment, depth: number): HTMLLIElement {
    const li = el(doc, 'li', { class: 'comment is-new', 'data-comment': c.uri, 'data-comment-author': c.author.did, 'data-comment-depth': String(depth) });
    const head = el(doc, 'div', { class: 'comment__head' });
    head.append(
      c.author.avatar
        ? el(doc, 'img', { class: 'comment__avatar', src: c.author.avatar, alt: '', width: '36', height: '36', decoding: 'async' })
        : el(doc, 'span', { class: 'comment__avatar comment__avatar--blank', 'aria-hidden': 'true' }),
    );
    const who = el(doc, 'span', { class: 'comment__who' });
    who.append(el(doc, 'a', { class: 'comment__name', href: profileUrl(c.author.handle) }, c.author.name));
    if (!c.author.handle.startsWith('did:')) who.append(el(doc, 'span', { class: 'comment__handle' }, `@${c.author.handle}`));
    head.append(who);
    const time = el(doc, 'time', { datetime: c.createdAt }, now() - Date.parse(c.createdAt) < 60_000 ? COPY.justNow : DATE_FORMAT.format(Date.parse(c.createdAt)).toLowerCase());
    const href = recordUrl(c.uri);
    const timeWrap = href ? el(doc, 'a', { class: 'comment__time', href }) : el(doc, 'span', { class: 'comment__time' });
    timeWrap.append(time);
    head.append(timeWrap);
    const body = el(doc, 'div', { class: 'comment__body' });
    textWithBreaks(body, c.text);
    li.append(head, body, el(doc, 'div', { class: 'comment__actions', 'data-comment-actions': '' }));
    return li;
  }

  function insertComment(c: LocalComment): HTMLLIElement | null {
    if (!commentList || findComment(c.uri)) return null;
    const parent = c.parent ? findComment(c.parent) : null;
    let list: HTMLOListElement = commentList;
    let depth = 1;
    if (parent) {
      const parentDepth = Number(parent.dataset.commentDepth) || 1;
      let owner = parent;
      depth = Math.min(parentDepth + 1, MAX_DEPTH);
      if (parentDepth >= MAX_DEPTH) {
        // As deep as threads go. Like the server, everything under a fourth-level comment
        // sits in that comment's one flat list.
        const outer = parent.parentElement?.closest<HTMLLIElement>('li.comment');
        if (outer && (Number(outer.dataset.commentDepth) || 1) >= MAX_DEPTH) owner = outer;
      }
      let replies = owner.querySelector<HTMLOListElement>(':scope > ol.comment-list--replies');
      if (!replies) {
        replies = el(doc, 'ol', { class: 'comment-list comment-list--replies', role: 'list' });
        owner.append(replies);
      }
      list = replies;
    }
    const li = buildComment(c, depth);
    list.append(li);
    decorate(li);
    updateCount();
    return li;
  }

  /** A deleted comment with replies keeps its place (so the replies make sense); otherwise it goes. */
  function dropComment(li: HTMLLIElement): void {
    if (li.querySelector(':scope > ol.comment-list--replies > li')) {
      li.classList.add('is-deleted');
      li.querySelector('.comment__head')?.remove();
      li.querySelector(':scope > [data-comment-actions]')?.replaceChildren();
      const body = li.querySelector<HTMLElement>(':scope > .comment__body');
      if (body) body.replaceChildren(el(doc, 'em', {}, COPY.deleted));
    } else {
      li.remove();
    }
    updateCount();
  }

  function applyLocal(): void {
    if (!documentUri || !talk) return;
    const changes = loadLocal(store, documentUri, now());
    for (const uri of changes.removed) {
      const li = findComment(uri);
      if (li) dropComment(li);
    }
    for (const c of changes.added) if (!changes.removed.includes(c.uri)) insertComment(c);
  }

  function composer(parent: string | null, onDone?: () => void): HTMLFormElement {
    const f = el(doc, 'form', { class: parent ? 'comment-form comment-form--reply' : 'comment-form', novalidate: '' });
    const id = `comment-text-${Math.random().toString(36).slice(2, 8)}`;
    f.append(el(doc, 'label', { class: 'visually-hidden', for: id }, parent ? COPY.replyLabel : COPY.commentLabel));
    const area = el(doc, 'textarea', { id, class: 'comment-form__text', name: 'text', rows: parent ? '3' : '4', maxlength: String(MAX_COMMENT_LENGTH) });
    if (!parent && documentUri) area.value = loadDraft(store, documentUri);
    const error = el(doc, 'p', { class: 'comment-form__error', role: 'alert', hidden: '' });
    const row = el(doc, 'div', { class: 'comment-form__row' });
    const send = el(doc, 'button', { type: 'submit', class: 'btn btn--primary btn--sm' }, parent ? COPY.reply : COPY.post);
    row.append(send);
    if (onDone) {
      const cancel = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, COPY.cancel);
      cancel.addEventListener('click', onDone);
      row.append(cancel);
    }
    if (!parent && me) row.append(el(doc, 'span', { class: 'comment-form__as' }, me.handle.startsWith('did:') ? '' : `as @${me.handle}`));
    f.append(area, error, row);
    if (!parent) area.addEventListener('input', () => documentUri && saveDraft(store, documentUri, area.value));
    f.addEventListener('submit', (event) => {
      event.preventDefault();
      void postComment(area, error, send, parent, onDone);
    });
    return f;
  }

  async function postComment(area: HTMLTextAreaElement, error: HTMLElement, send: HTMLButtonElement, parent: string | null, onDone?: () => void): Promise<void> {
    const s = session;
    const author = me;
    if (!s || !author || !documentUri || isBusy(send)) return;
    const text = cleanCommentText(area.value);
    if (!text) {
      error.textContent = COPY.empty;
      error.hidden = false;
      area.focus();
      return;
    }
    error.hidden = true;
    setBusy(send, true);
    const createdAt = new Date(now());
    try {
      const ref = await createRecord(s, COMMENT, commentRecord(documentUri, text, parent, createdAt));
      const c: LocalComment = { uri: ref.uri, parent, text, createdAt: createdAt.toISOString(), author };
      rememberAdded(store, documentUri, c, now());
      area.value = '';
      if (!parent) saveDraft(store, documentUri, '');
      insertComment(c);
      if (status) status.textContent = COPY.notices.posted;
      onDone?.();
    } catch (err) {
      error.textContent = isAuthError(err) ? COPY.notices.expired : COPY.notices.saveFailed;
      error.hidden = false;
      if (isAuthError(err)) signedOut();
    } finally {
      setBusy(send, false);
    }
  }

  async function removeComment(li: HTMLLIElement): Promise<void> {
    const uri = li.dataset.comment;
    const s = session;
    if (!s || !uri || !documentUri || !confirmFn(COPY.confirmDelete)) return;
    try {
      await deleteRecord(s, uri);
      rememberRemoved(store, documentUri, uri, now());
      dropComment(li);
    } catch (error) {
      failed(error);
    }
  }

  /** Reply and delete buttons for one comment, for the signed-in reader. */
  function decorate(li: HTMLLIElement): void {
    const actions = li.querySelector<HTMLElement>(':scope > [data-comment-actions]');
    if (!actions || li.classList.contains('is-deleted')) return;
    actions.replaceChildren();
    if (!session) return;
    const reply = el(doc, 'button', { type: 'button', class: 'comment__action', 'aria-expanded': 'false' }, COPY.reply);
    reply.addEventListener('click', () => {
      const open = li.querySelector(':scope > .comment-form--reply');
      if (open) return (open.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
      const close = () => {
        f.remove();
        reply.setAttribute('aria-expanded', 'false');
        reply.focus();
      };
      const f = composer(li.dataset.comment ?? null, close);
      actions.after(f);
      reply.setAttribute('aria-expanded', 'true');
      f.querySelector('textarea')?.focus();
    });
    actions.append(reply);
    if (li.dataset.commentAuthor === session.did) {
      const del = el(doc, 'button', { type: 'button', class: 'comment__action comment__action--delete' }, COPY.delete);
      del.addEventListener('click', () => void removeComment(li));
      actions.append(del);
    }
  }

  function renderCompose(): void {
    if (!compose) return;
    compose.hidden = false;
    if (session && me) {
      compose.replaceChildren(composer(null));
    } else {
      const button = el(doc, 'button', { type: 'button', class: 'btn btn--outline btn--sm' }, COPY.signInToComment);
      setBusy(button, starting);
      button.addEventListener('click', () => !starting && openSignIn('comment'));
      compose.replaceChildren(button);
    }
    for (const li of comments()) decorate(li);
  }

  /* ---------- session ---------- */

  function renderAll(): void {
    renderAccount();
    renderSubscribe();
    renderRecommend();
    renderCompose();
  }

  function announceSession(did: string | null): void {
    win.dispatchEvent(new CustomEvent<SessionEventDetail>(SESSION_EVENT, { detail: { did } }));
  }

  async function signedIn(s: Session): Promise<void> {
    session = s;
    announceSession(s.did);
    subscriptions = null;
    recommends = null;
    me = await loadMe(fetchImpl, s.did);
    renderAll();
    await loadOwnState();
  }

  function signedOut(): void {
    session = null;
    announceSession(null);
    me = null;
    subscriptions = null;
    recommends = null;
    for (const f of talk?.querySelectorAll('.comment-form--reply') ?? []) f.remove();
    renderAll();
  }

  async function signOut(): Promise<void> {
    const s = session;
    signedOut();
    notify(COPY.notices.signedOut);
    await s?.signOut().catch(() => undefined);
  }

  async function perform(kind: IntentKind): Promise<void> {
    if (kind === 'subscribe' && subscriptions && !subscriptions.length) await toggleSubscribe();
    else if (kind === 'recommend' && recommends && !recommends.length) await toggleRecommend();
    else if (kind === 'poe') win.dispatchEvent(new Event('poe:open'));
    else if (kind === 'comment') {
      const area = compose?.querySelector('textarea');
      area?.scrollIntoView?.({ block: 'center' });
      area?.focus();
    }
  }

  for (const button of subscribeButtons) button.addEventListener('click', () => void toggleSubscribe());
  recommendButton?.addEventListener('click', () => void toggleRecommend());
  applyLocal();

  // Back from Leaflet with the email confirmed. The marker comes off the address so a
  // reload or a shared link doesn't say it again.
  const search = new URLSearchParams(win.location.search ?? '');
  if (search.get(EMAIL_RETURN.param) === EMAIL_RETURN.value) {
    search.delete(EMAIL_RETURN.param);
    const rest = search.toString();
    win.history?.replaceState?.(win.history.state, '', `${win.location.pathname}${rest ? `?${rest}` : ''}${win.location.hash ?? ''}`);
    notify(COPY.notices.emailSubscribed);
  }

  // Poe's panel: "sign in with bluesky so poe can remember you". The marker tells it the
  // dialog is wired; without it the panel's link just comes to /blog#sign-in.
  win.addEventListener('poe:signin', () => openSignIn('poe'));
  if (dialog) dialog.dataset.poeReady = '';
  if (win.location.hash === '#sign-in') {
    win.history?.replaceState?.(win.history.state, '', `${win.location.pathname}${win.location.search ?? ''}`);
    openSignIn('poe');
  }

  const leftover = store.get(NOTICE_KEY);
  if (leftover) {
    store.remove(NOTICE_KEY);
    if (leftover === 'cancelled' || leftover === 'failed') notify(leftover === 'cancelled' ? COPY.notices.cancelled : COPY.notices.signInFailed);
  }

  if (!authed.eager) {
    renderAll();
    return;
  }

  starting = true;
  renderAll();
  const result = await authed.start();
  starting = false;
  const pending = readPending(store, now());
  const here = win.location.pathname;

  if (result.callback && pending && pending.returnTo !== here) {
    // Back from the auth server on /blog: carry on to the page the reader started from.
    if (result.error) {
      clearPending(store);
      store.set(NOTICE_KEY, result.error === 'cancelled' ? 'cancelled' : 'failed');
    }
    win.location.replace(pending.returnTo);
    return;
  }
  if (result.error) {
    clearPending(store);
    notify(result.error === 'cancelled' ? COPY.notices.cancelled : COPY.notices.signInFailed);
  }
  if (!result.session) {
    renderAll();
    return;
  }
  await signedIn(result.session);
  if (pending && pending.returnTo === here) {
    clearPending(store);
    await perform(pending.kind);
  }
}
