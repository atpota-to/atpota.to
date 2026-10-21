/**
 * Who Poe has said hello to, kept in this browser source's localStorage per streamer, so
 * a regular gets "welcome back" instead of a first hello, and a reload of the source in
 * the middle of a stream doesn't greet the whole chat again:
 *
 *   never seen          a first hello
 *   seen in the last    nothing: they were greeted this stream (or the source reloaded)
 *   AGAIN_MS
 *   seen before that    welcome back
 *
 * At most MAX_KEPT people, the least recently seen going first. Without storage (a private
 * window) it remembers for the visit only.
 */

export const AGAIN_MS = 4 * 60 * 60_000;
export const MAX_KEPT = 2000;

export type Greeting = 'hello' | 'welcome-back' | null;

export interface Regulars {
  /** Called for each of their messages: how to greet `did` now (null after the first), and remember they were here. */
  greet(did: string): Greeting;
}

const keyFor = (streamer: string) => `overlay:regulars:${streamer}`;

function load(storage: Storage | null, key: string): Map<string, number> {
  try {
    const raw = storage?.getItem(key);
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return new Map();
    return new Map(Object.entries(data).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
  } catch {
    return new Map();
  }
}

export function createRegulars(streamer: string, storage: Storage | null = safeStorage(), now: () => number = () => Date.now()): Regulars {
  const key = keyFor(streamer);
  const seen = load(storage, key);
  const greeted = new Set<string>();
  const save = () => {
    const kept = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_KEPT);
    try {
      storage?.setItem(key, JSON.stringify(Object.fromEntries(kept)));
    } catch {
      // full or blocked: remembered for this visit only
    }
  };
  return {
    greet(did) {
      const t = now();
      const last = seen.get(did);
      seen.set(did, t);
      save();
      if (greeted.has(did)) return null;
      greeted.add(did);
      if (last === undefined) return 'hello';
      return t - last >= AGAIN_MS ? 'welcome-back' : null;
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
