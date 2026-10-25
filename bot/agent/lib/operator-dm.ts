import { z } from "zod";

// The service authenticates the sender and supplies a stable message ID.
export const OperatorDm = z.object({
  dmId: z.string().min(1).max(300),
  operatorDid: z.string().regex(/^did:(plc|web):[^\s]{1,290}$/),
  text: z.string().min(1).max(12000),
  guidance: z.boolean().optional(),
  /** Set while the droplet has Poe writing the dispatch (DISPATCH_DRAFTS, mentions/src/dispatch-drafts.js). */
  dispatchDrafts: z.literal(true).optional(),
  /** The dispatch draft waiting on the operator, when there is one. */
  dispatchDraft: z.object({
    id: z.string().regex(/^dd-[A-Za-z0-9-]{8,48}$/),
    status: z.enum(["asking", "drafting", "ready", "publishing"]),
    version: z.number().int().min(0),
    title: z.string().max(300),
  }).strict().optional(),
}).strict();

/** The drafts' context as auth attributes, which hold strings only. */
export function draftAttributes(dm: Pick<OperatorDm, "dispatchDrafts" | "dispatchDraft">): Record<string, string> {
  if (!dm.dispatchDrafts) return {};
  const draft = dm.dispatchDraft;
  if (!draft) return { dispatchDrafts: "true" };
  return {
    dispatchDrafts: "true",
    dispatchDraftId: draft.id,
    dispatchDraftStatus: draft.status,
    dispatchDraftVersion: String(draft.version),
    dispatchDraftTitle: draft.title,
  };
}

export type OperatorDm = z.infer<typeof OperatorDm>;

export async function postDmDraft(draft: {
  key: string;
  dmId: string;
  operatorDid: string;
  text: string;
}): Promise<void> {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) {
    console.error("DM callback unavailable");
    return;
  }
  try {
    const response = await fetch(new URL("/dm-draft", callback), {
      method: "POST",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify(draft),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) console.error("DM callback rejected", response.status);
  } catch {
    // A transport error may contain a request body; never log the error object.
    console.error("DM callback failed");
  }
}
