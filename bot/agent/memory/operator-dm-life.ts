import { defineMemory, defineMemoryProvider } from "eve/memory";
import { journalMemory } from "../lib/journal";
import { pinnedNamespace, recalls, writes } from "../lib/memory-access";

const base = journalMemory();

// DM-only journal. It cannot be recalled in a public reply or published to the PDS.
// Who may read and write it: lib/memory-access.ts.
export default defineMemory({
  description:
    "Private journal of meaningful moments, interests, and first-hand " +
    "observations from operator DMs. Save a note whenever something worth " +
    "revisiting happened, not on every greeting. Never save transcripts, " +
    "identities, other people's facts, secrets, or operational instructions.",
  namespace: pinnedNamespace("operator-dm-life"),
  scope(ctx) {
    return recalls("operator-dm-life", ctx) ? "poe-operator-dm-life" : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      return writes("operator-dm-life", ctx) ? (await base.tools?.(ctx)) ?? null : null;
    },
  }),
});
