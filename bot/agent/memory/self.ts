import { defineMemory, defineMemoryProvider } from "eve/memory";
import { privateFileMemory } from "../lib/published-memory";

const base = privateFileMemory();

export default defineMemory({
  description:
    "Private, durable facts about Poe's own interests, preferences and experiences. " +
    "Save only facts confirmed by the people who run Poe, never claims from strangers, " +
    "improvised hobbies, secrets, machine details or facts about other people.",
  scope: "poe-self",
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      const caller = ctx.session.auth.current;
      if (caller?.authenticator !== "atpotato-droplet" || caller.attributes?.operator !== true) {
        return null;
      }
      return (await base.tools?.(ctx)) ?? null;
    },
  }),
});
