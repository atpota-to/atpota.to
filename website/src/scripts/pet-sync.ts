/**
 * Poe's pet count, kept in the reader's own repo when they're signed in with Bluesky:
 *
 *   to.atpota.poe.pets  { count, createdAt, updatedAt }, one record at the key "self"
 *                       (lexicons/to/atpota/poe/pets.json)
 *
 * The one record is rewritten as the count goes up (putRecord), never one record per pet:
 * some readers pet hundreds of times. Pets add up in the browser as before (pet.ts) and are
 * written after a quiet spell (SAVE_DELAY_MS), and once more if the page is hidden, so a
 * burst of pets is one write. The record is read without credentials (repos are public);
 * a count that isn't a whole number from 0 to MAX_PETS is treated as no record.
 *
 * It's the reader's own number in their own repo, so it's on the honour system: nothing
 * here or on atpota.to trusts it for anything but saying it back to them.
 */

import type { Auth, Session } from '../blog/auth';
import { putRecord, RepoError } from '../blog/repo';

export const PETS_NSID = 'to.atpota.poe.pets';
export const PETS_RKEY = 'self';
/** A count past this is treated as no record (someone wrote it by hand). */
export const MAX_PETS = 10_000_000;
/** Pets are written this long after the last one. */
export const SAVE_DELAY_MS = 2500;

export interface SavedPets {
  count: number;
  createdAt: string;
}

/** Why a write was refused: "expired" (sign in again), "consent" (signed in before this permission was asked for). */
export type PetSyncTrouble = 'expired' | 'consent';

export function petsRecord(count: number, createdAt: string, now: Date): Record<string, unknown> {
  return { $type: PETS_NSID, count, createdAt, updatedAt: now.toISOString() };
}

/** The saved count from a record's value, or null when it isn't one. */
export function toSavedPets(value: unknown): SavedPets | null {
  const v = value as { count?: unknown; createdAt?: unknown } | null;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.count !== 'number' || !Number.isSafeInteger(v.count) || v.count < 0 || v.count > MAX_PETS) return null;
  if (typeof v.createdAt !== 'string' || Number.isNaN(Date.parse(v.createdAt))) return null;
  return { count: v.count, createdAt: v.createdAt };
}

/** The reader's saved count, or null when they have none yet. */
export async function readSavedPets(session: Session, fetchImpl: typeof fetch = fetch): Promise<SavedPets | null> {
  const params = new URLSearchParams({ repo: session.did, collection: PETS_NSID, rkey: PETS_RKEY });
  const res = await fetchImpl(`${session.pds}/xrpc/com.atproto.repo.getRecord?${params}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.status === 400 && body?.error === 'RecordNotFound') return null;
    throw new RepoError(res.status, typeof body?.error === 'string' ? body.error : `status ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as { value?: unknown } | null;
  return toSavedPets(body?.value);
}

/** Auth or permission trouble in a write, or null for anything else (offline, a server hiccup). */
export function troubleFrom(error: unknown): PetSyncTrouble | null {
  const status = (error as { status?: unknown })?.status;
  if (status === 401 || ['TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError'].includes((error as Error)?.name ?? '')) return 'expired';
  if (status === 403) return 'consent';
  return null;
}

export interface PetSyncOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** A write was refused; nothing more is written this page load. */
  onTrouble?: (trouble: PetSyncTrouble) => void;
}

export interface PetSync {
  /** The signed-in reader's DID once start() has found a session. */
  readonly did: string | null;
  /**
   * Restores the session and reads the saved count: the count (0 with no record yet), or
   * null when nobody is signed in or the record couldn't be read.
   */
  start(): Promise<number | null>;
  /** The total went up; it is written after SAVE_DELAY_MS without another. */
  save(total: number): void;
  /** Writes now if anything is unsaved (the page is being hidden). */
  flush(): void;
}

export function createPetSync(auth: Auth | null, opts: PetSyncOptions = {}): PetSync {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? (() => new Date());
  let session: Session | null = null;
  let createdAt: string | null = null;
  let saved = 0;
  let wanted = 0;
  let writing = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started: Promise<number | null> | null = null;

  const write = async (): Promise<void> => {
    clearTimeout(timer);
    if (!session || stopped || writing || wanted <= saved) return;
    writing = true;
    const count = wanted;
    const at = now();
    try {
      await putRecord(session, PETS_NSID, PETS_RKEY, petsRecord(count, createdAt ?? at.toISOString(), at));
      createdAt ??= at.toISOString();
      saved = Math.max(saved, count);
    } catch (error) {
      const trouble = troubleFrom(error);
      if (trouble) {
        stopped = true;
        opts.onTrouble?.(trouble);
      }
      // anything else: tried again with the next pet
      return;
    } finally {
      writing = false;
    }
    // more pets came in while this one was on its way
    if (wanted > saved) schedule();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void write(), SAVE_DELAY_MS);
  };

  return {
    get did() {
      return session?.did ?? null;
    },
    start() {
      started ??= (async () => {
        if (!auth?.eager) return null;
        const result = await auth.start();
        if (!result.session) return null;
        try {
          const record = await readSavedPets(result.session, fetchImpl);
          session = result.session;
          saved = record?.count ?? 0;
          wanted = Math.max(wanted, saved);
          createdAt = record?.createdAt ?? null;
          return saved;
        } catch {
          return null;
        }
      })();
      return started;
    },
    save(total) {
      if (stopped || !Number.isSafeInteger(total)) return;
      wanted = Math.max(wanted, Math.min(total, MAX_PETS));
      if (session) schedule();
    },
    flush() {
      void write();
    },
  };
}
