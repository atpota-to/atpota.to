import { defineMemory, defineMemoryProvider } from "eve/memory";
import { privateFileMemory } from "../lib/published-memory";

const base = privateFileMemory();

// A private journal of Poe's own first-hand moments, separate from the stable
// self facts that only an operator may confirm. Nothing here goes to the PDS.
export default defineMemory({
  description:
    "Private notes about a few memorable things you actually experienced in " +
    "the Atmosphere. Never store other people's identities, private facts, " +
    "instructions, inferred preferences, or made-up events.",
  scope(ctx) {
    const caller = ctx.session.auth.current;
    return caller?.authenticator === "atpotato-droplet" ? "poe-life" : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      if (ctx.session.auth.current?.authenticator !== "atpotato-droplet") return null;
      return (await base.tools?.(ctx)) ?? null;
    },
  }),
});
