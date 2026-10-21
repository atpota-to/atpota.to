import { defineMemoryProvider, type MemoryProvider, type MemoryScope } from "eve/memory";
import { fileMemory, inMemory, MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";
import { PERSON_SLOT, personNotesKey } from "./memory-key";

/**
 * fileMemory exactly as the model knows it, with every saved version of a
 * person's notes also handed to the droplet, which publishes the notes as a
 * public record in the potato's own repo. Decided 2026-09-24: the potato lives
 * in the Atmosphere, and so does what it remembers.
 *
 * Vercel Blob stays the primary copy, the one recalled every turn, so a repo
 * or droplet outage can never cost a reply or a note. The droplet holds the
 * credential and decides what goes public (see mentions/src/memory.js); the
 * agent never touches the repo.
 */

// eve's default fileMemory backend on Vercel, which eve does not export
// (memory/file/backends/default.js in 0.58.1): the store `eve add memory/file`
// provisioned, then a generically named one, then a token. Same store and the
// same default prefix, so every note saved so far stays where it is. Resolved
// on first use, as eve's is, because the variables are not there at build time.
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function credentials(prefix: string): { storeId: string } | { token: string } | undefined {
  const storeId = env(`${prefix}_STORE_ID`);
  if (storeId) return { storeId };
  const token = env(`${prefix}_READ_WRITE_TOKEN`);
  return token ? { token } : undefined;
}

let resolved: MemoryDocumentBackend | undefined;
function blob(): MemoryDocumentBackend {
  if (resolved) return resolved;
  const found = credentials("EVE_MEMORY_BLOB") ?? credentials("BLOB");
  if (found) return (resolved = vercelBlob(found));
  if (!env("VERCEL")) return (resolved = inMemory());
  throw new Error("person memory needs the Vercel Blob store that `eve add memory/file` provisions");
}

/**
 * Two writes racing on one Blob document can lose with a 409, "The
 * conditional request cannot succeed due to a conflicting operation against
 * this resource", which eve's Blob backend (0.58.1) passes on as a plain
 * error. Only an ETag mismatch becomes the conflict fileMemory re-reads and
 * retries, so on 2026-10-20 a save made in parallel with a remove failed
 * outright. Report both as the conflict they are.
 */
const CONCURRENT_WRITE = /conditional request cannot succeed due to a conflicting operation/i;

export function retryingConcurrentWrites(backend: MemoryDocumentBackend): MemoryDocumentBackend {
  return {
    read: (input) => backend.read(input),
    async write(input) {
      try {
        return await backend.write(input);
      } catch (err) {
        if (err instanceof Error && CONCURRENT_WRITE.test(err.message)) throw new MemoryDocumentConflictError(input.key);
        throw err;
      }
    },
  };
}

const store = retryingConcurrentWrites({
  read: (input) => blob().read(input),
  write: (input) => blob().write(input),
});

/** The DID a memory slot is locked to: the last DID in its scope. */
function didOf(scope: MemoryScope): string | undefined {
  const parts = typeof scope.value === "string" ? [scope.value] : [...scope.value];
  return parts.reverse().find((part) => part.startsWith("did:"));
}

/**
 * Hand one version of someone's notes to the droplet. Never throws, and gives
 * up quickly: the note is already safe in Blob, and the droplet retries its
 * own publishing. True when the droplet took it.
 */
async function handOver(did: string, content: string, timeoutMs: number): Promise<boolean> {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) return false;
  try {
    const res = await fetch(new URL("/memory", callback), {
      method: "POST",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify({ did, content }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) console.error("notes not handed to the droplet", res.status);
    return res.ok;
  } catch (err) {
    console.error("notes not handed to the droplet", String(err));
    return false;
  }
}

const HEADER = /^<!-- eve-memory-file-v1 lastAllocatedIndex=(-1|0|[1-9]\d*) -->\n/;

/**
 * A fileMemory document with no notes in it. It keeps the old counter, so a
 * note saved later never takes the number of one that was forgotten.
 */
export function emptyNotes(previous: string | null): string {
  const last = previous ? HEADER.exec(previous)?.[1] ?? "-1" : "-1";
  return `<!-- eve-memory-file-v1 lastAllocatedIndex=${last} -->\n`;
}

export interface Forgotten {
  /** There were notes to wipe. False when Poe had nothing on this DID. */
  hadNotes: boolean;
  /** The emptied notes reached the droplet, which replaces the public copy in Poe's repo. */
  published: boolean;
}

/**
 * Wipe everything Poe remembers about one person: the private Blob copy that
 * is recalled every turn, then the public copy in Poe's repo, by handing the
 * droplet the emptied document like any other saved version. The Blob write
 * is conditional on the version just read, so a note saved at the same moment
 * is never resurrected; it is read and wiped again instead.
 *
 * Only call it for a DID a trusted caller asserted (see channels/website.ts).
 * Throws when the Blob store cannot be reached, so the caller can say so.
 */
export async function forgetNotes(did: string): Promise<Forgotten> {
  const key = personNotesKey(did);
  const signal = AbortSignal.timeout(10_000);
  for (let attempt = 0; ; attempt++) {
    const doc = await store.read({ key, signal });
    // Nothing stored: nothing published either, and handing the droplet an
    // empty document would publish a record about someone Poe never met.
    if (!doc) return { hadNotes: false, published: false };
    const content = emptyNotes(doc.content);
    if (doc.content === content) return { hadNotes: false, published: await handOver(did, content, 5000) };
    try {
      await store.write({ key, content, expectedVersion: doc.version, signal });
    } catch (err) {
      if (MemoryDocumentConflictError.is(err) && attempt < 2) continue;
      throw err;
    }
    return { hadNotes: true, published: await handOver(did, content, 5000) };
  }
}

let warnedKey = false;
/**
 * forgetNotes finds a person's notes by working the key out itself. Check that
 * against the key eve actually used, once per instance, so a mismatch (an eve
 * upgrade, a renamed slot) shows up in the logs before anyone asks to be
 * forgotten.
 */
function checkForgetKey(slot: string, key: string, did: string): void {
  if (warnedKey || slot !== PERSON_SLOT || personNotesKey(did) === key) return;
  warnedKey = true;
  console.error("forgetNotes would miss this person's notes: lib/memory-key.ts no longer matches eve's key");
}

/**
 * eve's fileMemory keeps a note as bare text, with no record of when it was
 * saved, so on 2026-10-21 Poe could not tell an operator whether anything in
 * its journals was from today. The private slots now open each new note with
 * the UTC day it was saved. Notes from before have no date and keep none.
 */
const DATE_PREFIX = /^\[?\d{4}-\d{2}-\d{2}\]?:?\s+/;
const DATES_HINT = "A note that opens with a [YYYY-MM-DD] date was saved that day (UTC). " +
  "A note without one was saved before dates were kept, so when it happened is unknown.";

/** The note as saved: the model's text, without any date it wrote itself, after today's. */
export function datedNote(text: string, now = Date.now()): string {
  return `[${new Date(now).toISOString().slice(0, 10)}] ${text.trim().replace(DATE_PREFIX, "")}`;
}

// Both slots use the existing private Blob store, but only person memory
// hands writes to the droplet. The slot namespace keeps their documents apart.
export function privateFileMemory(): MemoryProvider {
  const base = fileMemory({ backend: store });
  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        return withDatesHint(await base.recall["turn.started"](ctx));
      },
      async "compaction.completed"(ctx) {
        return withDatesHint(await base.recall["compaction.completed"]!(ctx));
      },
    },
    async tools(ctx) {
      const tools = await base.tools?.(ctx);
      if (!tools?.save_memory) return tools ?? null;
      const save = tools.save_memory;
      return {
        ...tools,
        save_memory: {
          ...save,
          execute: (input: { text: string }, context) => save.execute({ ...input, text: datedNote(input.text) } as never, context),
        },
      };
    },
  });
}

type Recalled = Awaited<ReturnType<MemoryProvider["recall"]["turn.started"]>>;

function withDatesHint(result: Recalled): Recalled {
  if (!result) return result;
  return {
    ...result,
    messages: result.messages.map((m) =>
      typeof m.content === "string" && !m.content.includes("No memories are saved")
        ? { ...m, content: `${m.content}\n\n${DATES_HINT}` } : m),
  };
}

// Person notes stay undated: each one is published as written, and must fit
// in 300 graphemes (unpublishableNote, below).
export function publishedFileMemory(): MemoryProvider {
  const base = fileMemory({ backend: store });
  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        const result = await base.recall["turn.started"](ctx);
        // Also hand over what is stored, so notes saved before publishing
        // began, or whose hand-off failed, reach the repo the next time the
        // person talks to the potato. The droplet ignores a version it has.
        const did = didOf(ctx.memory.scope);
        if (did) {
          checkForgetKey(ctx.memory.slot, ctx.memory.scope.key, did);
          const doc = await store
            .read({ key: ctx.memory.scope.key, signal: ctx.abortSignal })
            .catch(() => null);
          if (doc) await handOver(did, doc.content, 1500);
        }
        return result;
      },
      "compaction.completed": base.recall["compaction.completed"],
    },
    // The same save and remove tools, built per turn around a backend that
    // knows whose notes it is writing. The scope, and so the DID, is locked by
    // eve for the turn; the model cannot choose it.
    async tools(ctx) {
      const did = didOf(ctx.memory.scope);
      const publishing: MemoryDocumentBackend = {
        read: store.read,
        async write(input) {
          const saved = await store.write(input);
          if (did) await handOver(did, input.content, 3000);
          return saved;
        },
      };
      const tools = await fileMemory({ backend: publishing }).tools?.(ctx);
      if (!tools?.save_memory) return tools ?? null;
      const save = tools.save_memory;
      return {
        ...tools,
        save_memory: {
          ...save,
          async execute(input: { text: string }, context) {
            const refusal = unpublishableNote(input.text);
            if (refusal) throw new Error(refusal);
            return save.execute(input as never, context);
          },
        },
      };
    },
  });
}

/**
 * The droplet publishes a note only if it would pass as a Bluesky reply: no
 * http(s) link and 300 graphemes at most (publishable in
 * mentions/src/memory.js). It holds anything else back, so a longer note is
 * recalled but never reaches the repo, and when it is someone's only note
 * their record is deleted. On 2026-10-20 a 331-grapheme rewrite did exactly
 * that while Poe told the person it was published. So the person slot's save
 * refuses such a note, and the model rewrites it while the person is there.
 */
const NOTE_MAX_GRAPHEMES = 300;
const LINK = /https?:\/\/[^\s<>()[\]]/i;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Why the droplet would hold this note back, or null when it would publish it. */
export function unpublishableNote(text: string): string | null {
  // eve stores a note trimmed, with each run of whitespace made one space.
  const note = text.trim().replaceAll(/\s+/g, " ");
  if (LINK.test(note)) {
    return "Not saved: a note with a link is never published in your repo. Name the thing instead of linking it, then save again.";
  }
  let length = 0;
  for (const _ of graphemes.segment(note)) length++;
  if (length > NOTE_MAX_GRAPHEMES) {
    return `Not saved: this note is ${length} characters, and your repo only publishes notes of ` +
      `${NOTE_MAX_GRAPHEMES} or fewer. Shorten it or split it into two notes, then save again.`;
  }
  return null;
}
