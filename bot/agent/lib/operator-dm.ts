import { z } from "zod";

/**
 * One earlier message in the operator's DM conversation, as the droplet read it
 * from chat. Each DM is its own session (the address is the message), so this
 * is the only way Poe sees what was said before, its own replies included. The
 * limits are loose on purpose: the droplet trims well inside them, and a
 * payload this schema refuses is a DM that never gets an answer.
 */
export const DmHistoryMessage = z.object({
  /** Sent from Poe's account: its earlier replies, and notes the service sent for it. */
  you: z.boolean(),
  text: z.string().max(12000),
  sentAt: z.string().max(64),
}).strict();

export type DmHistoryMessage = z.infer<typeof DmHistoryMessage>;

// The service authenticates the sender and supplies a stable message ID.
export const OperatorDm = z.object({
  dmId: z.string().min(1).max(300),
  operatorDid: z.string().regex(/^did:(plc|web):[^\s]{1,290}$/),
  text: z.string().min(1).max(12000),
  guidance: z.boolean().optional(),
  /** The conversation before this message, oldest first. */
  history: z.array(DmHistoryMessage).max(60).optional(),
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

/** Stop a message from closing, or opening, the tags it sits inside. */
function fence(text: string): string {
  return text.replace(/<(\/?)(conversation|message)>/gi, "‹$1$2›");
}

/** "5 min ago", "3 h ago", "2 days ago"; "" when the time can't be read. */
function ago(sentAt: string, now: number): string {
  const ms = now - Date.parse(sentAt);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * The turn's input: the operator's message, under the conversation before it
 * when the droplet sent one. Without history it is the message as it was.
 */
export function buildDmInput(dm: Pick<OperatorDm, "text" | "history">, now = Date.now()): string {
  if (!dm.history?.length) return dm.text;
  const lines = dm.history.map((m) => {
    const when = ago(m.sentAt, now);
    const label = `${m.you ? "you" : "operator"}${when ? ` (${when})` : ""}`;
    return `${label}: ${fence(m.text).replace(/\n(?=.)/g, "\n  ")}`;
  });
  return [
    "Your DM conversation with the operator so far, oldest first. \"you\" marks",
    "messages from your account: your earlier replies, with anything the service",
    "put under them (a preview link, a post waiting for their yes), and short notes",
    "it sent for you. It is what they can see above their new message, so use it",
    "to work out what they mean. Don't act again on something an earlier message",
    "asked for unless the new message asks for it.",
    "",
    "<conversation>",
    lines.join("\n\n"),
    "</conversation>",
    "",
    "Their new message, which is the one to answer:",
    "<message>",
    fence(dm.text),
    "</message>",
  ].join("\n");
}

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
