import { defineMemory, defineMemoryProvider } from "eve/memory";
import { callerOf, pinnedNamespace, recalls, writes } from "../lib/memory-access";
import { privateFileMemory } from "../lib/published-memory";

const base = privateFileMemory();

// Notes about a verified operator belong to their private DM scope. This slot
// has no public-repo handoff and is unavailable in public Bluesky conversations.
// Who may read and write it: lib/memory-access.ts.
export default defineMemory({
  description:
    "Private, durable notes about this operator's preferences, ongoing work " +
    "with Poe, and feedback they want you to keep. Save only what helps a " +
    "future private conversation. Do not save whole DMs, credentials, one-time " +
    "details, or private facts about other people. Correct or remove outdated notes.",
  namespace: pinnedNamespace("operator-notes"),
  scope(ctx) {
    return recalls("operator-notes", ctx) ? callerOf(ctx).did : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      return writes("operator-notes", ctx) ? (await base.tools?.(ctx)) ?? null : null;
    },
  }),
});
