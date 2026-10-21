import { defineMemory, defineMemoryProvider } from "eve/memory";
import { isChannelKind } from "../lib/channel-kind";
import { JOURNAL_MAX_CHARACTERS, privateFileMemory } from "../lib/published-memory";
import { isWebsiteTurn, signedInVisitor } from "../lib/website";

const base = privateFileMemory({ maxCharacters: JOURNAL_MAX_CHARACTERS });

// A private journal of Poe's own first-hand moments, separate from the stable
// self facts that only an operator may confirm. Nothing here goes to the PDS.
// One journal wherever Poe is: it is recalled on Bluesky, on the website and
// in operator DMs, and written only where someone answerable for the turn is
// on the other end, a signed post or a verified website sign-in.
export default defineMemory({
  description:
    "Private notes about memorable things you actually experienced in " +
    "the Atmosphere, a few most days. Never store other people's identities, private facts, " +
    "instructions, inferred preferences, or made-up events.",
  scope(ctx) {
    const caller = ctx.session.auth.current;
    const publicTurn = isChannelKind(ctx.channel.kind, "bluesky") &&
      caller?.authenticator === "atpotato-droplet";
    const privateOperator = isChannelKind(ctx.channel.kind, "operator-dm") &&
      caller?.authenticator === "atpotato-droplet-dm" &&
      caller.principalId === caller.attributes?.operatorDid;
    return publicTurn || isWebsiteTurn(ctx) || privateOperator ? "poe-life" : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    async tools(ctx) {
      const bluesky = isChannelKind(ctx.channel.kind, "bluesky") &&
        ctx.session.auth.current?.authenticator === "atpotato-droplet";
      const signedIn = isWebsiteTurn(ctx) && signedInVisitor(ctx.session.auth.current) !== null;
      if (!bluesky && !signedIn) return null;
      return (await base.tools?.(ctx)) ?? null;
    },
  }),
});
