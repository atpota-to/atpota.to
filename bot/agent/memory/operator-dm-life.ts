import { defineMemory, defineMemoryProvider } from "eve/memory";
import { privateFileMemory } from "../lib/published-memory";

const base = privateFileMemory();

// DM-only journal. It cannot be recalled in a public reply or published to the PDS.
export default defineMemory({
  description:
    "Private journal of meaningful moments, interests, and first-hand " +
    "observations from operator DMs. Save sparingly when something worth " +
    "revisiting happened, not on every greeting. Never save transcripts, " +
    "identities, other people's facts, secrets, or operational instructions.",
  scope(ctx) {
    return ctx.channel.kind === "operator-dm" &&
      ctx.session.auth.current?.authenticator === "atpotato-droplet-dm"
      ? "poe-operator-dm-life" : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      const caller = ctx.session.auth.current;
      if (ctx.channel.kind !== "operator-dm" ||
          caller?.authenticator !== "atpotato-droplet-dm" ||
          caller.principalId !== caller.attributes?.operatorDid) return null;
      return (await base.tools?.(ctx)) ?? null;
    },
  }),
});
