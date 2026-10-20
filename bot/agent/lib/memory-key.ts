import { createHash } from "node:crypto";
import { defaultNamespace } from "eve/memory";
import { personScope } from "./person-scope";

/**
 * Where eve keeps one person's notes, worked out without a turn.
 *
 * Forgetting someone happens outside any turn (channels/website.ts, from the
 * settings page on atpota.to), so there is no ctx.memory.scope.key to read.
 * This spells out the key eve derives for the person slot: its default
 * namespace for the root agent's "person" slot, and the scope
 * memory/person.ts resolves for that DID. tests/memory-key.test.mjs holds it to
 * eve's own derivation, and publishedFileMemory checks it against the real key
 * on every person turn, so an eve upgrade that moves the key is logged rather
 * than quietly turning "forget me" into a no-op.
 */

/** eve's id for the root agent node (0.58.1). */
const ROOT_NODE = "__root__";
/** The slot memory/person.ts defines: its file name. */
export const PERSON_SLOT = "person";

const uint32 = (n: number) => {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(n);
  return bytes;
};
const lengthPrefix = (bytes: Buffer) => Buffer.concat([uint32(bytes.byteLength), bytes]);
const scalar = (label: string, value: string) =>
  Buffer.concat([Buffer.from(`${label}-v1\0`), lengthPrefix(Buffer.from(value, "utf8"))]);
const digest = (prefix: string, bytes: Buffer) =>
  `${prefix}${createHash("sha256").update(bytes).digest("base64url")}`;

/** eve's composite key for a namespace and scope (createMemoryLock in 0.58.1). */
export function memoryKey(namespace: string, scope: string | readonly string[]): string {
  const encodedScope = typeof scope === "string"
    ? scalar("scope-scalar", scope)
    : Buffer.concat([Buffer.from("scope-tuple-v1\0"), uint32(scope.length),
      ...scope.map((part) => lengthPrefix(Buffer.from(part, "utf8")))]);
  const composite = Buffer.concat([
    Buffer.from("eve-memory-composite-v1\0"),
    lengthPrefix(Buffer.from(digest("memns1_", scalar("namespace", namespace)))),
    lengthPrefix(Buffer.from(digest("memscope1_", encodedScope))),
  ]);
  return digest("memscope1_", composite);
}

/** The key of the document holding this DID's notes. Only for a DID a trusted caller asserted. */
export function personNotesKey(did: string): string {
  const namespace = defaultNamespace({ appRoot: process.cwd(), node: ROOT_NODE, slot: PERSON_SLOT });
  return memoryKey(namespace, personScope(did));
}
