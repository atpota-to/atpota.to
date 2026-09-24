import { defineMemoryProvider, type MemoryProvider, type MemoryScope } from "eve/memory";
import { fileMemory, inMemory, type MemoryDocumentBackend } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

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

const store: MemoryDocumentBackend = {
  read: (input) => blob().read(input),
  write: (input) => blob().write(input),
};

/** The DID a memory slot is locked to: the last DID in its scope. */
function didOf(scope: MemoryScope): string | undefined {
  const parts = typeof scope.value === "string" ? [scope.value] : [...scope.value];
  return parts.reverse().find((part) => part.startsWith("did:"));
}

/**
 * Hand one version of someone's notes to the droplet. Never throws, and gives
 * up quickly: the note is already safe in Blob, and the droplet retries its
 * own publishing.
 */
async function handOver(did: string, content: string, timeoutMs: number): Promise<void> {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) return;
  try {
    const res = await fetch(new URL("/memory", callback), {
      method: "POST",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify({ did, content }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) console.error("notes not handed to the droplet", res.status);
  } catch (err) {
    console.error("notes not handed to the droplet", String(err));
  }
}

// Both slots use the existing private Blob store, but only person memory
// hands writes to the droplet. The slot namespace keeps their documents apart.
export function privateFileMemory(): MemoryProvider {
  return fileMemory({ backend: store });
}

export function publishedFileMemory(): MemoryProvider {
  const base = privateFileMemory();
  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        const result = await base.recall["turn.started"](ctx);
        // Also hand over what is stored, so notes saved before publishing
        // began, or whose hand-off failed, reach the repo the next time the
        // person talks to the potato. The droplet ignores a version it has.
        const did = didOf(ctx.memory.scope);
        if (did) {
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
      return (await fileMemory({ backend: publishing }).tools?.(ctx)) ?? null;
    },
  });
}
