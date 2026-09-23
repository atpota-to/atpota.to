import { vercelBlob } from "eve/memory/file/vercel";
import type { MemoryDocumentBackend } from "eve/memory/file";

/**
 * The store behind person memory, shared between the memory slot and the
 * forget-me route.
 *
 * It lives in lib/ rather than memory/ because eve treats every file under
 * agent/memory as a slot and requires a defineMemory() default export from it.
 * A helper there fails the build with "Expected the memory export default to be
 * created with defineMemory()".
 *
 * It is exported rather than constructed inline in person.ts because "forget
 * me" has to reach it from outside a turn. The backend interface is read and
 * write only; there is no delete. Forgetting is therefore a write of an empty
 * document, which leaves the object in place and its contents gone. Anyone
 * promising deletion to a person should know that is what it means.
 */
export const personBackend: MemoryDocumentBackend = vercelBlob();
