import { defineMemory, defineMemoryProvider } from "eve/memory";
import { journalMemory } from "../lib/journal";
import { pinnedNamespace, recalls, writes } from "../lib/memory-access";

const base = journalMemory();

// A private journal of Poe's own first-hand moments, separate from the stable
// self facts that only an operator may confirm. Nothing here goes to the PDS.
// One journal wherever Poe is: it is recalled on Bluesky, on the website and
// in operator DMs, and written only where someone answerable for the turn is
// on the other end, a signed post or a verified website sign-in.
// Who may read and write it: lib/memory-access.ts.
export default defineMemory({
  description:
    "Private notes about memorable things you actually experienced in " +
    "the Atmosphere, a few most days. Never store other people's identities, private facts, " +
    "instructions, inferred preferences, or made-up events.",
  namespace: pinnedNamespace("life"),
  scope(ctx) {
    return recalls("life", ctx) ? "poe-life" : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      return writes("life", ctx) ? (await base.tools?.(ctx)) ?? null : null;
    },
  }),
});
