import { defineMemory, defineMemoryProvider } from "eve/memory";
import { pinnedNamespace, recalls, writes } from "../lib/memory-access";
import { privateFileMemory } from "../lib/published-memory";

const base = privateFileMemory();

// Recalled everywhere, so it holds only what is safe to say in public, and
// only an operator can change it. Who may read and write it: lib/memory-access.ts.
export default defineMemory({
  description:
    "Private, durable facts about Poe's own interests, preferences and experiences " +
    "that are safe to recall in public conversations. Save only lasting facts " +
    "confirmed by an operator, including in a private DM. Never store private " +
    "DM details, claims from strangers, improvised hobbies, secrets, machine " +
    "details, or facts about other people.",
  namespace: pinnedNamespace("self"),
  scope(ctx) {
    return recalls("self", ctx) ? "poe-self" : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      return writes("self", ctx) ? (await base.tools?.(ctx)) ?? null : null;
    },
  }),
});
