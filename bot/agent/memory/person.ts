import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { fileMemory } from "eve/memory/file";
import { personBackend } from "#memory/backend";

/**
 * Durable notes about one person, keyed on their DID.
 *
 * The payoff is characters. A Bluesky reply has 300 graphemes, so knowing
 * somebody already runs a labeler means skipping the paragraph explaining what
 * a labeler is and spending the whole budget on their actual question.
 *
 * The cost is that a public bot remembering you is a surveillance surface
 * nobody opted into: tagging a potato in a thread is not the same as opening a
 * panel on a website. Three things keep it defensible.
 *
 *   Nothing is captured automatically. fileMemory gives the model
 *   person__save_memory and person__remove_memory and it decides what is worth
 *   keeping, which is the property you want when the input is a stranger's
 *   post. What it should keep is in agent/instructions.md under Memory.
 *
 *   The scope is a DID asserted by the droplet over an authenticated call, not
 *   anything the model read in a post. The chain is: the record was signed into
 *   the author's repo, their PDS published it, Jetstream relayed it, the droplet
 *   read the author DID off the signed event. Nobody can make the potato
 *   remember something about a DID they cannot post as.
 *
 *   No principal, no memory. An anonymous website visitor returns null here and
 *   eve skips the provider and its tools entirely, with no shared-scope
 *   fallback.
 *
 * Key on the DID and never the handle: handles move between people, DIDs do
 * not. A handle is a fact worth storing, and a fact that can go stale.
 */
export default defineMemory({
  description:
    "Durable facts about this person that make future answers shorter: what " +
    "they build, how technical they are, their handle, and how they like to " +
    "be talked to. Never anything about a third party.",

  provider: fileMemory({ backend: personBackend }),

  scope(ctx) {
    const caller = ctx.session.auth.current;
    const did = caller?.attributes?.did;

    // Anonymous callers get no memory at all.
    if (caller?.principalType !== "user") return null;
    if (typeof did !== "string" || !did.startsWith("did:")) return null;

    const principal = byPrincipal(ctx);
    if (principal === null) return null;

    return [principal, did];
  },

  visibility: "scope",
});
