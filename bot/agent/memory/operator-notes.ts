import { defineMemory } from "eve/memory";
import { privateFileMemory } from "../lib/published-memory";

// Notes about a verified operator belong to their private DM scope. This slot
// has no public-repo handoff and is unavailable in public Bluesky conversations.
export default defineMemory({
  description:
    "Private, durable notes about this operator's preferences, ongoing work " +
    "with Poe, and feedback they want you to keep. Save only what helps a " +
    "future private conversation. Do not save whole DMs, credentials, one-time " +
    "details, or private facts about other people. Correct or remove outdated notes.",
  scope(ctx) {
    const caller = ctx.session.auth.current;
    if (ctx.channel.kind !== "operator-dm" ||
        caller?.authenticator !== "atpotato-droplet-dm" ||
        caller.principalType !== "user" ||
        caller.principalId !== caller.attributes?.operatorDid ||
        typeof caller.principalId !== "string" ||
        !/^did:(plc|web):[^\s]+$/.test(caller.principalId)) return null;
    return caller.principalId;
  },
  visibility: "scope",
  provider: privateFileMemory(),
});
