import { defaultNamespace, type MemoryNamespaceContext } from "eve/memory";
import { isChannelKind } from "./channel-kind";
import { DISPATCH_AUTHENTICATOR } from "./dispatch-draft";
import { WEATHER_AUTHENTICATOR } from "./weather-post";
import { isWebsiteTurn, signedInVisitor } from "./website";

/**
 * Who may read and write each of Poe's memories, in one place.
 *
 * Every memory slot used to work out for itself which channel a turn came
 * through and whether the caller was trusted, and the copies drifted: the DM
 * journal was recalled for any DM-authenticated turn while its tools checked
 * the operator, and adding the dispatch arena meant editing every slot. Now a
 * turn's caller is resolved once (callerOf), and each slot is a row in
 * MEMORY_ACCESS saying in which arenas, for which callers, it is recalled and
 * can be written. tests/memory-access.test.mjs checks every slot file against
 * every row.
 *
 * An arena is where Poe is talking; trust is who is on the other end, as the
 * service that started the turn vouched for them:
 *
 *   stranger  nobody vouched for (an anonymous website visitor, or a Bluesky
 *             turn without a DID)
 *   person    someone whose DID was verified (a signed post, a website sign-in)
 *   operator  one of the people who run Poe (an admin's post, an operator DM)
 *   service   the droplet's own sessions (drafting the dispatch, the weather)
 */

export const ARENAS = ["bluesky", "website", "operator-dm", "dispatch", "weather"] as const;
export type Arena = typeof ARENAS[number];
export const TRUSTS = ["stranger", "person", "operator", "service"] as const;
export type Trust = typeof TRUSTS[number];

export interface Caller {
  /** Where the turn came from, or null for a channel memory knows nothing about. */
  readonly arena: Arena | null;
  readonly trust: Trust;
  /** The verified DID behind the turn, when there is one. */
  readonly did: string | null;
}

const NOBODY: Caller = { arena: null, trust: "stranger", did: null };
const DID = /^did:(plc|web):[^\s]+$/;

type AuthCaller = {
  readonly authenticator?: string;
  readonly principalType?: string;
  readonly principalId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
} | null | undefined;

export interface TurnContext {
  readonly channel: { readonly kind?: string };
  readonly session: { readonly auth: { readonly current?: AuthCaller } };
}

/** The arena and trust of a turn, from what its channel's authenticator vouched for. */
export function callerOf(ctx: TurnContext): Caller {
  const kind = ctx.channel.kind;
  const caller = ctx.session.auth.current;
  const attributes = caller?.attributes ?? {};

  if (isChannelKind(kind, "bluesky") && caller?.authenticator === "atpotato-droplet") {
    const did = typeof attributes.did === "string" && attributes.did.startsWith("did:") ? attributes.did : null;
    if (attributes.operator === "true") return { arena: "bluesky", trust: "operator", did };
    if (caller.principalType === "user" && did) return { arena: "bluesky", trust: "person", did };
    return { arena: "bluesky", trust: "stranger", did: null };
  }

  if (isWebsiteTurn(ctx as Parameters<typeof isWebsiteTurn>[0])) {
    const visitor = signedInVisitor(caller);
    return visitor ? { arena: "website", trust: "person", did: visitor.did } : { arena: "website", trust: "stranger", did: null };
  }

  if (isChannelKind(kind, "operator-dm") && caller?.authenticator === "atpotato-droplet-dm") {
    const did = caller.principalId;
    const verified = caller.principalType === "user" && typeof did === "string" && DID.test(did) &&
      did === attributes.operatorDid;
    // A DM turn that isn't a verified operator is nobody: no DM memory at all.
    return verified ? { arena: "operator-dm", trust: "operator", did } : NOBODY;
  }

  if (isChannelKind(kind, "dispatch") && caller?.authenticator === DISPATCH_AUTHENTICATOR &&
      caller.principalType === "service") {
    return { arena: "dispatch", trust: "service", did: null };
  }

  if (isChannelKind(kind, "weather") && caller?.authenticator === WEATHER_AUTHENTICATOR &&
      caller.principalType === "service") {
    return { arena: "weather", trust: "service", did: null };
  }

  return NOBODY;
}

/** For each arena, the callers allowed; "everywhere" also covers turns from no known arena. */
type Rule = "everywhere" | Partial<Record<Arena, readonly Trust[]>>;

export interface SlotAccess {
  /** Whose notes these are, for the admin page and the backup log. */
  readonly about: string;
  readonly recall: Rule;
  readonly write: Rule | "nowhere";
}

const ANY: readonly Trust[] = TRUSTS;

/**
 * The table. Writing a slot is only offered where it is also recalled, since
 * eve gives a slot's tools only to a turn with a scope.
 */
export const MEMORY_ACCESS = {
  person: {
    about: "one person, by DID; published in Poe's repo",
    recall: { bluesky: ["person", "operator"], website: ["person"] },
    write: { bluesky: ["person", "operator"], website: ["person"] },
  },
  life: {
    about: "Poe's journal of what it experienced in public",
    recall: { bluesky: ANY, website: ["stranger", "person"], "operator-dm": ["operator"] },
    write: { bluesky: ANY, website: ["person"] },
  },
  "operator-dm-life": {
    about: "Poe's journal of its DMs with the people who run it",
    recall: { "operator-dm": ["operator"] },
    write: { "operator-dm": ["operator"] },
  },
  "operator-notes": {
    about: "one operator's preferences and ongoing work, by DID",
    recall: { "operator-dm": ["operator"] },
    write: { "operator-dm": ["operator"] },
  },
  self: {
    about: "lasting facts about Poe, safe to recall in public",
    recall: "everywhere",
    write: { bluesky: ["operator"], "operator-dm": ["operator"] },
  },
} as const satisfies Record<string, SlotAccess>;

export type MemorySlot = keyof typeof MEMORY_ACCESS;

function allows(rule: Rule | "nowhere", caller: Caller): boolean {
  if (rule === "nowhere") return false;
  if (rule === "everywhere") return true;
  if (!caller.arena) return false;
  const trusts: readonly Trust[] | undefined = rule[caller.arena];
  return trusts?.includes(caller.trust) ?? false;
}

/** Whether this slot is recalled for the turn. */
export function recalls(slot: MemorySlot, ctx: TurnContext): boolean {
  return allows(MEMORY_ACCESS[slot].recall, callerOf(ctx));
}

/** Whether this slot's save and remove tools are offered to the turn. */
export function writes(slot: MemorySlot, ctx: TurnContext): boolean {
  const access: SlotAccess = MEMORY_ACCESS[slot];
  return allows(access.recall, callerOf(ctx)) && allows(access.write, callerOf(ctx));
}

/**
 * The namespace eve gives a slot by default, worked out from a name fixed here
 * rather than from the file name. eve names a slot after its file and puts the
 * name in the storage key, so renaming agent/memory/life.ts would have left
 * every journal note behind under the old key, silently. Pinned to the name the
 * slot has today, the key is unchanged (tests/memory-access.test.mjs checks it
 * against eve's own), and a rename moves nothing.
 */
export function pinnedNamespace(slot: string) {
  return (ctx: MemoryNamespaceContext) => defaultNamespace({ ...ctx, slot });
}
