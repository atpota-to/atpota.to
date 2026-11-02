import { defineMemory, defineMemoryProvider } from "eve/memory";
import { isChannelKind } from "../lib/channel-kind";
import { DISPATCH_AUTHENTICATOR } from "../lib/dispatch-draft";
import { privateFileMemory } from "../lib/published-memory";

// Room for about 30 notes of a sentence or two. A full slot refuses the save,
// and Poe tells the operator it's time to fold the notes into the skill.
const base = privateFileMemory({ maxCharacters: 8_000 });

// What the operator taught Poe about writing the dispatch, kept for every issue
// after. On 2026-11-02 Poe saved a round of editing lessons in operator notes,
// which are recalled only in DMs, so the session that writes the next issue
// (channels/dispatch.ts) would never have seen them. This slot is recalled in
// that drafting session and in operator DMs, where drafts are edited, and only
// a verified operator's DM can write it. One shared scope, not one per
// operator: the notes are about the publication. Nothing here is published.
// When notes pile up, fold them into skills/dispatch-issue.md (or
// skills/dispatch-weather.md) and remove them here.
export default defineMemory({
  description:
    "The operator's standing feedback on how to write poe's atmosphere dispatch: " +
    "what to research or check, how to explain things, how a section should look. " +
    "One short rule per note, in words your drafting session can follow without " +
    "this conversation. These are the one place rules for future issues belong. Save " +
    "only what should change every future issue, not a fix to one issue. Correct or " +
    "remove outdated notes.",
  scope(ctx) {
    const caller = ctx.session.auth.current;
    const drafting = isChannelKind(ctx.channel.kind, "dispatch") &&
      caller?.authenticator === DISPATCH_AUTHENTICATOR &&
      caller.principalType === "service";
    const operator = isChannelKind(ctx.channel.kind, "operator-dm") &&
      caller?.authenticator === "atpotato-droplet-dm" &&
      caller.principalType === "user" &&
      caller.principalId === caller.attributes?.operatorDid;
    return drafting || operator ? "poe-dispatch-notes" : null;
  },
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: base.recall,
    // The drafting session reads them; only the operator, in a DM, changes them.
    async tools(ctx) {
      const caller = ctx.session.auth.current;
      if (!isChannelKind(ctx.channel.kind, "operator-dm") ||
          caller?.authenticator !== "atpotato-droplet-dm" ||
          caller.principalType !== "user" ||
          caller.principalId !== caller.attributes?.operatorDid ||
          typeof caller.principalId !== "string" ||
          !/^did:(plc|web):[^\s]+$/.test(caller.principalId)) return null;
      return (await base.tools?.(ctx)) ?? null;
    },
  }),
});
