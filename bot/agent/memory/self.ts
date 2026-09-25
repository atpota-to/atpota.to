import { defineMemory, defineMemoryProvider } from "eve/memory";
import { privateFileMemory } from "../lib/published-memory";

const base = privateFileMemory();

export default defineMemory({
  description:
    "Private, durable facts about Poe's own interests, preferences and experiences " +
    "that are safe to recall in public conversations. Save only lasting facts " +
    "confirmed by an operator, including in a private DM. Never store private " +
    "DM details, claims from strangers, improvised hobbies, secrets, machine " +
    "details, or facts about other people.",
  scope: "poe-self",
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      const caller = ctx.session.auth.current;
      const publicOperator = ctx.channel.kind === "bluesky" &&
        caller?.authenticator === "atpotato-droplet" && caller.attributes?.operator === "true";
      const privateOperator = ctx.channel.kind === "operator-dm" &&
        caller?.authenticator === "atpotato-droplet-dm" &&
        caller.principalType === "user" &&
        caller.principalId === caller.attributes?.operatorDid;
      if (!publicOperator && !privateOperator) return null;
      return (await base.tools?.(ctx)) ?? null;
    },
  }),
});
