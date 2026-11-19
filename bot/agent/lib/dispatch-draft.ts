import { z } from "zod";

/**
 * Poe's weekly dispatch drafts, the agent's half. The droplet (mentions/src/dispatch-drafts.js)
 * decides when an issue is due and asks for one on POST /dispatch/draft. Poe researches
 * the week in a session of its own and saves the issue, as markdown, with
 * save_dispatch_draft; the droplet builds the record, keeps each version and shows
 * the operator a preview. Edits and "make it live" happen later, in operator DMs,
 * with the same tools. Poe never writes the issue's record and never publishes it:
 * publishing takes the operator's yes, which the droplet reads.
 */

const isoDate = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), "not a date");

export const DispatchDraftRequest = z.strictObject({
  draftId: z.string().regex(/^dd-[A-Za-z0-9-]{8,48}$/),
  windowStart: isoDate,
  windowEnd: isoDate,
  lastIssue: z.strictObject({
    title: z.string().max(500),
    url: z.string().url().max(300),
    publishedAt: isoDate.nullable(),
  }).optional(),
  /** The operator's words when they asked for this issue themselves. */
  guidance: z.string().max(2000).optional(),
});

export type DispatchDraftRequest = z.infer<typeof DispatchDraftRequest>;

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** The drafting turn's prompt. Everything in it is the droplet's or the operator's. */
export function buildDispatchPrompt(request: DispatchDraftRequest): string {
  return [
    `<dispatch_draft id="${request.draftId}">`,
    `It's time to write the next issue of poe's atmosphere dispatch, covering ${day(request.windowStart)} to ${day(request.windowEnd)} ` +
      `(${request.windowStart} to ${request.windowEnd}).`,
    request.lastIssue
      ? `The last issue was "${request.lastIssue.title}" (${request.lastIssue.url}), published ${request.lastIssue.publishedAt ?? "recently"}.`
      : "There is no earlier issue to read.",
    ...(request.guidance ? ["", "The operator asked for this one, and said:", request.guidance] : []),
    "</dispatch_draft>",
    "",
    "Research the week, write the issue, and save it with save_dispatch_draft. The operator reviews it before anything is published. " +
      "When it's saved, end with a short note for the operator: what's in it, and anything you weren't sure about.",
  ].join("\n");
}

type Caller = { authenticator?: string; principalType?: string; principalId?: string;
  attributes?: Readonly<Record<string, string | readonly string[]>> } | null | undefined;

export const DISPATCH_AUTHENTICATOR = "atpotato-droplet-dispatch";

/**
 * Who a draft tool call is for, from the session's authenticated channel metadata, never
 * from the model's input: the drafting turn the droplet started, or an operator DM Poe is
 * answering. Null anywhere else, website chats and Bluesky replies included.
 */
export function draftCaller(ctx: { session: { auth: { current?: Caller } } }):
  { draftingId: string } | { dmId: string; operatorDid: string } | null {
  const caller = ctx.session.auth.current;
  if (caller?.authenticator === DISPATCH_AUTHENTICATOR && caller.principalType === "service") {
    const draftId = caller.attributes?.draftId;
    return typeof draftId === "string" && /^dd-[A-Za-z0-9-]{8,48}$/.test(draftId) ? { draftingId: draftId } : null;
  }
  if (caller?.authenticator === "atpotato-droplet-dm" && caller.principalType === "user") {
    const dmId = caller.attributes?.dmId;
    const operatorDid = caller.attributes?.operatorDid;
    if (typeof dmId === "string" && dmId && typeof operatorDid === "string" && caller.principalId === operatorDid) {
      return { dmId, operatorDid };
    }
  }
  return null;
}

export type DraftDeskReply = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; reason: string };

/** One call to the droplet's draft desk, on the callback URL like every other proposal. */
export async function callDraftDesk(
  caller: NonNullable<ReturnType<typeof draftCaller>>,
  call: Record<string, unknown>,
): Promise<DraftDeskReply> {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) return { ok: false, reason: "service unavailable" };
  try {
    const res = await fetch(callback, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify({ ...caller, dispatchDraft: call }),
      // A save looks up every link card in the issue.
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (res.status === 429) return { ok: false, reason: "too many tries; tell the operator what went wrong" };
    if (res.status === 409) return { ok: false, reason: "this session can't work on the draft any more" };
    if (!res.ok || !body) return { ok: false, reason: "service unavailable" };
    return { ok: true, status: res.status, body };
  } catch {
    return { ok: false, reason: "service unavailable" };
  }
}

/**
 * The drafting turn's last message, for the droplet to DM the operator with the preview.
 * The droplet keys it on `key`, so a repeated delivery does nothing.
 */
export async function postDispatchDone(done: { key: string; draftId: string; text: string }): Promise<void> {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) {
    console.error("dispatch draft not delivered: DROPLET_CALLBACK_URL or secret unset");
    return;
  }
  try {
    const response = await fetch(callback, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify({ key: done.key, dispatchDraftDone: { draftId: done.draftId, text: done.text.slice(0, 20000) } }),
      signal: AbortSignal.timeout(10000),
    });
    // The droplet settles a drafting turn that never reports back, so a lost one is late, not lost.
    if (!response.ok) console.error("dispatch draft done rejected by droplet", response.status);
  } catch {
    console.error("dispatch draft done callback failed");
  }
}
