import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { isChannelKind } from "../lib/channel-kind";
import { personScope } from "../lib/person-scope";
import { publishedFileMemory } from "../lib/published-memory";
import { isWebsiteTurn, signedInVisitor } from "../lib/website";

/**
 * Durable notes about one person, keyed on their DID.
 *
 * The payoff is characters. A Bluesky reply has 300 graphemes, so knowing
 * somebody already runs a labeler means skipping the paragraph explaining what
 * a labeler is and spending the whole budget on their actual question.
 *
 * The cost is that a public bot remembering you is a surveillance surface
 * nobody opted into: tagging a potato in a thread is not the same as opening a
 * panel on a website. And since 2026-09-24 the notes are public too, published
 * in the potato's own repo (lib/published-memory.ts), which makes it a choice
 * made in the open rather than a file nobody can see. Three things keep it
 * defensible.
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
 * Since 2026-10-20 a visitor who signs in with Bluesky on atpota.to gets the
 * same notes, so the potato on the website and the potato on Bluesky know a
 * person as one. The chain there: the visitor's own PDS signs an atproto
 * service-auth token for atpota.to, the website proxy verifies it against the
 * key in their DID document, then asserts the DID over its authenticated call
 * (lib/website.ts). Nobody can reach notes for a DID whose PDS will not sign
 * for them. The scope is spelled out by lib/person-scope.ts, because eve's
 * byPrincipal would key the website's authenticator into a second document.
 *
 * Key on the DID and never the handle: handles move between people, DIDs do
 * not. A handle is a fact worth storing, and a fact that can go stale.
 *
 * This is the only memory slot, deliberately. `eve add memory/file` scaffolds a
 * generic one at agent/memory/file.ts scoped straight to byPrincipal; running
 * both would give the model two save tools and two remove tools, write two
 * documents per person, and leave the generic slot without the guards below.
 * If that file reappears after a future `eve add`, delete it again.
 */
export default defineMemory({
  description:
    "Durable facts about this person that make future answers shorter: what " +
    "they build, how technical they are, their handle, and how they like to " +
    "be talked to. Never anything about a third party. Each note is " +
    "published in your repo, so keep it to 300 characters with no links.",

  // fileMemory on the same Vercel Blob store as before, with each saved
  // version also handed to the droplet to publish. The Blob copy is what is
  // recalled, so publishing can fail without costing a note or a reply.
  provider: publishedFileMemory(),

  scope(ctx) {
    const caller = ctx.session.auth.current;

    // A signed-in visitor on atpota.to: their Bluesky notes, by DID.
    if (isWebsiteTurn(ctx)) {
      const visitor = signedInVisitor(caller);
      return visitor ? personScope(visitor.did) : null;
    }

    // DM turns must never recall, write, or publish a person's notes.
    const did = caller?.attributes?.did;
    if (!isChannelKind(ctx.channel.kind, "bluesky") || caller?.authenticator !== "atpotato-droplet" ||
        caller.principalType !== "user") return null;
    if (typeof did !== "string" || !did.startsWith("did:")) return null;

    const principal = byPrincipal(ctx);
    if (principal === null) return null;

    return [principal, did];
  },

  visibility: "scope",
});
