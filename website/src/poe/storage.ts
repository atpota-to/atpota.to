/**
 * Storage for the widget, safe in private windows, sandboxed iframes and when
 * site data is blocked: every access to localStorage/sessionStorage is wrapped in
 * try/catch, and when the real store is unusable an in-memory map takes its place
 * for the rest of the page view (so the widget keeps working, it just forgets on
 * reload).
 *
 * Keys:
 *   sessionStorage "poe:transcript"  last 20 bubbles, so home -> guide keeps the chat visible
 *   sessionStorage "poe:nudged"      "1" once the nudge bubble has shown this visit
 *   localStorage   "poe:tucked"      "1" while Poe is tucked into the edge tab
 */

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  remove(key: string): void;
}

export const TRANSCRIPT_KEY = 'poe:transcript';
export const NUDGED_KEY = 'poe:nudged';
export const TUCKED_KEY = 'poe:tucked';
export const MAX_TRANSCRIPT = 20;

const MAX_ENTRY_TEXT = 12_000;
const MAX_QUOTE = 300;
const MAX_LINKS_PER_ENTRY = 3;

class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  has(key: string): boolean {
    return this.map.has(key);
  }
  get(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  set(key: string, value: string): boolean {
    this.map.set(key, value);
    return true;
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

/**
 * Wraps a Storage getter. The getter itself may throw (SecurityError when cookies
 * are blocked), and so may getItem/setItem (QuotaExceededError, Safari private
 * mode on old versions). On the first failure the store switches to memory and
 * keeps whatever it could not persist there.
 */
export function createStore(getStorage: () => Storage | null | undefined): KeyValueStore {
  const memory = new MemoryStore();
  let broken = false;

  const storage = (): Storage | null => {
    if (broken) return null;
    try {
      const s = getStorage();
      if (!s) {
        broken = true;
        return null;
      }
      return s;
    } catch {
      broken = true;
      return null;
    }
  };

  return {
    get(key) {
      // A value that could not be persisted (quota) lives in memory and wins.
      if (memory.has(key)) return memory.get(key);
      const s = storage();
      if (s) {
        try {
          return s.getItem(key);
        } catch {
          broken = true;
        }
      }
      return memory.get(key);
    },
    set(key, value) {
      const s = storage();
      if (s) {
        try {
          s.setItem(key, value);
          memory.remove(key);
          return true;
        } catch {
          // Quota or access failure: keep it for this page view at least.
        }
      }
      memory.set(key, value);
      return false;
    },
    remove(key) {
      memory.remove(key);
      const s = storage();
      if (!s) return;
      try {
        s.removeItem(key);
      } catch {
        broken = true;
      }
    },
  };
}

let sessionStore: KeyValueStore | null = null;
let localStore: KeyValueStore | null = null;

export function session(): KeyValueStore {
  sessionStore ??= createStore(() => window.sessionStorage);
  return sessionStore;
}

export function local(): KeyValueStore {
  localStore ??= createStore(() => window.localStorage);
  return localStore;
}

/** Test hook: forget the cached stores so a test can swap window storage. */
export function resetStoresForTests(): void {
  sessionStore = null;
  localStore = null;
}

/* ---------- transcript ---------- */

export type NoteCode =
  | 'not_configured'
  | 'rate_limited'
  | 'bad_request'
  | 'upstream'
  | 'timeout'
  | 'conversation_over'
  | 'busy'
  | 'offline'
  | 'network'
  | 'interrupted'
  | 'cut_off'
  | 'empty';

export const NOTE_CODES: readonly NoteCode[] = [
  'not_configured',
  'rate_limited',
  'bad_request',
  'upstream',
  'timeout',
  'conversation_over',
  'busy',
  'offline',
  'network',
  'interrupted',
  'cut_off',
  'empty',
];

export type TranscriptEntry =
  | { role: 'you'; text: string; quote?: string }
  | { role: 'poe'; text: string; links: string[] }
  | { role: 'note'; code: NoteCode; retryAfter?: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates one stored entry; anything unexpected is dropped, never repaired into HTML. */
export function parseEntry(value: unknown): TranscriptEntry | null {
  if (!isObject(value)) return null;
  if (value.role === 'you') {
    if (typeof value.text !== 'string' || value.text.length === 0) return null;
    const entry: TranscriptEntry = { role: 'you', text: value.text.slice(0, MAX_ENTRY_TEXT) };
    if (typeof value.quote === 'string' && value.quote.length > 0) entry.quote = value.quote.slice(0, MAX_QUOTE);
    return entry;
  }
  if (value.role === 'poe') {
    if (typeof value.text !== 'string' || value.text.length === 0) return null;
    const links = Array.isArray(value.links)
      ? value.links.filter((l): l is string => typeof l === 'string' && l.startsWith('https://') && l.length <= 2048).slice(0, MAX_LINKS_PER_ENTRY)
      : [];
    return { role: 'poe', text: value.text.slice(0, MAX_ENTRY_TEXT), links };
  }
  if (value.role === 'note') {
    if (typeof value.code !== 'string' || !(NOTE_CODES as readonly string[]).includes(value.code)) return null;
    const entry: TranscriptEntry = { role: 'note', code: value.code as NoteCode };
    if (typeof value.retryAfter === 'number' && Number.isFinite(value.retryAfter) && value.retryAfter > 0) {
      entry.retryAfter = Math.min(Math.round(value.retryAfter), 86_400);
    }
    return entry;
  }
  return null;
}

export function loadTranscript(store: KeyValueStore = session()): TranscriptEntry[] {
  const raw = store.get(TRANSCRIPT_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: TranscriptEntry[] = [];
  for (const item of parsed) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  return entries.slice(-MAX_TRANSCRIPT);
}

export function saveTranscript(entries: readonly TranscriptEntry[], store: KeyValueStore = session()): void {
  const trimmed = entries.slice(-MAX_TRANSCRIPT);
  if (trimmed.length === 0) {
    store.remove(TRANSCRIPT_KEY);
    return;
  }
  store.set(TRANSCRIPT_KEY, JSON.stringify(trimmed));
}

export function clearTranscript(store: KeyValueStore = session()): void {
  store.remove(TRANSCRIPT_KEY);
}

/* ---------- flags ---------- */

export function isTucked(store: KeyValueStore = local()): boolean {
  return store.get(TUCKED_KEY) === '1';
}

export function setTucked(tucked: boolean, store: KeyValueStore = local()): void {
  if (tucked) store.set(TUCKED_KEY, '1');
  else store.remove(TUCKED_KEY);
}

export function wasNudged(store: KeyValueStore = session()): boolean {
  return store.get(NUDGED_KEY) === '1';
}

export function markNudged(store: KeyValueStore = session()): void {
  store.set(NUDGED_KEY, '1');
}
