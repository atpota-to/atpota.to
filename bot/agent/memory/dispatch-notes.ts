import { defineMemory, defineMemoryProvider } from "eve/memory";
import { pinnedNamespace, recalls, writes } from "../lib/memory-access";
import { privateFileMemory } from "../lib/published-memory";

// Room for about 30 notes of a sentence or two. A full slot refuses the save,
// and Poe tells the operator it's time to fold the notes into the skill.
const base = privateFileMemory({ maxCharacters: 8_000 });

// What the operator taught Poe about writing the dispatch, kept for every issue
// after. Recalled in the drafting session (channels/dispatch.ts) and in operator
// DMs; only a verified operator's DM can write it. One shared scope: the notes
// are about the publication. Nothing here is published. Who may read and write
// it: lib/memory-access.ts.
export default defineMemory({
  description:
    "The operator's standing feedback on how to write poe's atmosphere dispatch: " +
    "what to research or check, how to explain things, how a section should look. " +
    "One short rule per note, in words your drafting session can follow without " +
    "this conversation. These are the one place rules for future issues belong. Save " +
    "only what should change every future issue, not a fix to one issue. Correct or " +
    "remove outdated notes.",
  namespace: pinnedNamespace("dispatch-notes"),
  scope(ctx) {
    return recalls("dispatch-notes", ctx) ? "poe-dispatch-notes" : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      return writes("dispatch-notes", ctx) ? (await base.tools?.(ctx)) ?? null : null;
    },
  }),
});
