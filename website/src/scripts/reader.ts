/**
 * Who the visitor is, as far as the site knows: the Bluesky handle of a reader who
 * signed in on the blog (src/blog/ui.ts saves it, and forgets it on sign-out). The home
 * page uses it to say hi by name. It is only a greeting: nothing is trusted or sent
 * because of it, and the real session stays with the OAuth library.
 */

export const READER_KEY = 'atpotato:reader';

const HANDLE_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function rememberReader(handle: string): void {
  if (!HANDLE_RE.test(handle)) return;
  try {
    storage()?.setItem(READER_KEY, handle);
  } catch {
    // storage full or blocked: no greeting next time, which is fine
  }
}

export function forgetReader(): void {
  try {
    storage()?.removeItem(READER_KEY);
  } catch {
    // nothing to forget
  }
}

/** The remembered handle, or null. */
export function readReader(): string | null {
  try {
    const value = storage()?.getItem(READER_KEY) ?? null;
    return value && HANDLE_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}
