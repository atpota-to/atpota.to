import { defineMemory, defineMemoryProvider } from "eve/memory";
import { privateFileMemory } from "../lib/published-memory";

const base = privateFileMemory();

// This slot never publishes to the PDS. It is separate from the Bluesky life
// journal so DM content cannot enter that journal or any person memory.
export default defineMemory({
  description:
    "Private notes about your own life or outlook, only when the operator explicitly " +
    "asks you to remember guidance. Never save DM transcripts, identities, " +
    "other people's facts, credentials, or operational instructions.",
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
          caller.attributes?.guidance !== "true") return null;
      return (await base.tools?.(ctx)) ?? null;
    },
  }),
});
