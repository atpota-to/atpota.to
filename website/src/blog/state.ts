/**
 * What the blog remembers in the browser, through the same fail-safe store as Poe
 * (src/poe/storage.ts: private windows and blocked storage fall back to memory).
 *
 *   sessionStorage "blog:pending"           the action a reader started before signing in
 *                                           ({ kind, returnTo, at }), done once they're back;
 *                                           "plant" is the home page's flower patch
 *   sessionStorage "blog:draft:<document>"  the comment being written, so the sign-in round
 *                                           trip doesn't lose it
 *   sessionStorage "blog:local:<document>"  the reader's own comments added or deleted in
 *                                           the last few minutes: post pages are cached for
 *                                           about five, so a reload re-applies these
 *   localStorage   "blog:handle"            the last handle typed into the sign-in box
 *
 * Everything read back is validated; nothing stored here is ever rendered as HTML.
 */

import { createStore, type KeyValueStore } from '../poe/storage';
import { MAX_COMMENT_LENGTH, parseRecordUri } from './repo';

export const PENDING_KEY = 'blog:pending';
export const HANDLE_KEY = 'blog:handle';
export const draftKey = (document: string) => `blog:draft:${document}`;
export const localKey = (document: string) => `blog:local:${document}`;

/** A pending action older than this is dropped (the sign-in was abandoned). */
export const PENDING_TTL_MS = 15 * 60_000;
/** How long the reader's own changes are re-applied over the cached page. */
export const LOCAL_TTL_MS = 10 * 60_000;
const MAX_LOCAL = 20;

export type IntentKind = 'subscribe' | 'recommend' | 'comment' | 'plant';
/** The intents the blog itself handles. */
export type BlogIntent = Exclude<IntentKind, 'plant'>;
const INTENTS: ReadonlySet<string> = new Set<IntentKind>(['subscribe', 'recommend', 'comment', 'plant']);

export interface Pending {
  kind: IntentKind;
  /** Same-site path to come back to, checked by safeReturnTo. */
  returnTo: string;
  at: number;
}

let sessionStore: KeyValueStore | null = null;
let localStore: KeyValueStore | null = null;

export function sessionStoreFor(win: Window = window): KeyValueStore {
  sessionStore ??= createStore(() => win.sessionStorage);
  return sessionStore;
}

export function localStoreFor(win: Window = window): KeyValueStore {
  localStore ??= createStore(() => win.localStorage);
  return localStore;
}

/** Test hook: forget the cached stores. */
export function resetBlogStoresForTests(): void {
  sessionStore = null;
  localStore = null;
}

const RETURN_RE = /^\/blog(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/;

/** The home page, or a path under /blog, to send the reader back to; null otherwise (no open redirects, no "..") */
export function safeReturnTo(path: unknown): string | null {
  if (path === '/') return path;
  if (typeof path !== 'string' || path.length > 600) return null;
  if (!RETURN_RE.test(path) || path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return path;
}

function readJson(store: KeyValueStore, key: string): unknown {
  const raw = store.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function savePending(store: KeyValueStore, pending: Pending): void {
  store.set(PENDING_KEY, JSON.stringify(pending));
}

/** The pending action if it is recent and well formed. Reading it does not remove it. */
export function readPending(store: KeyValueStore, now: number): Pending | null {
  const v = readJson(store, PENDING_KEY) as Partial<Pending> | null;
  const returnTo = safeReturnTo(v?.returnTo);
  if (!v || !returnTo || typeof v.kind !== 'string' || !INTENTS.has(v.kind)) return null;
  if (typeof v.at !== 'number' || now - v.at > PENDING_TTL_MS || v.at > now + 60_000) return null;
  return { kind: v.kind as IntentKind, returnTo, at: v.at };
}

export function clearPending(store: KeyValueStore): void {
  store.remove(PENDING_KEY);
}

export function loadDraft(store: KeyValueStore, document: string): string {
  const raw = store.get(draftKey(document));
  return raw ? raw.slice(0, MAX_COMMENT_LENGTH) : '';
}

export function saveDraft(store: KeyValueStore, document: string, text: string): void {
  if (text.trim()) store.set(draftKey(document), text.slice(0, MAX_COMMENT_LENGTH));
  else store.remove(draftKey(document));
}

/* ---------- the reader's own recent changes ---------- */

export interface LocalComment {
  uri: string;
  parent: string | null;
  text: string;
  createdAt: string;
  author: { did: string; handle: string; name: string; avatar: string | null };
}

export interface LocalChanges {
  added: LocalComment[];
  removed: string[];
  at: number;
}

const EMPTY: LocalChanges = { added: [], removed: [], at: 0 };

function isLocalComment(v: unknown): v is LocalComment {
  const c = v as LocalComment;
  return (
    typeof c?.uri === 'string' &&
    parseRecordUri(c.uri) !== null &&
    (c.parent === null || (typeof c.parent === 'string' && parseRecordUri(c.parent) !== null)) &&
    typeof c.text === 'string' &&
    typeof c.createdAt === 'string' &&
    Number.isFinite(Date.parse(c.createdAt)) &&
    typeof c.author?.did === 'string' &&
    typeof c.author.handle === 'string' &&
    typeof c.author.name === 'string' &&
    (c.author.avatar === null || (typeof c.author.avatar === 'string' && c.author.avatar.startsWith('https://')))
  );
}

export function loadLocal(store: KeyValueStore, document: string, now: number): LocalChanges {
  const v = readJson(store, localKey(document)) as Partial<LocalChanges> | null;
  if (!v || typeof v.at !== 'number' || now - v.at > LOCAL_TTL_MS) return EMPTY;
  return {
    added: Array.isArray(v.added) ? v.added.filter(isLocalComment).slice(-MAX_LOCAL).map((c) => ({ ...c, text: c.text.slice(0, MAX_COMMENT_LENGTH) })) : [],
    removed: Array.isArray(v.removed) ? v.removed.filter((u): u is string => typeof u === 'string' && parseRecordUri(u) !== null).slice(-MAX_LOCAL) : [],
    at: v.at,
  };
}

function saveLocal(store: KeyValueStore, document: string, changes: LocalChanges): void {
  if (!changes.added.length && !changes.removed.length) store.remove(localKey(document));
  else store.set(localKey(document), JSON.stringify(changes));
}

export function rememberAdded(store: KeyValueStore, document: string, comment: LocalComment, now: number): void {
  const current = loadLocal(store, document, now);
  saveLocal(store, document, { added: [...current.added, comment].slice(-MAX_LOCAL), removed: current.removed, at: now });
}

export function rememberRemoved(store: KeyValueStore, document: string, uri: string, now: number): void {
  const current = loadLocal(store, document, now);
  saveLocal(store, document, {
    added: current.added.filter((c) => c.uri !== uri),
    removed: [...current.removed.filter((u) => u !== uri), uri].slice(-MAX_LOCAL),
    at: now,
  });
}
