import { z } from "zod";

// The service authenticates the sender and supplies a stable message ID.
export const OperatorDm = z.object({
  dmId: z.string().min(1).max(300),
  operatorDid: z.string().regex(/^did:(plc|web):[^\s]{1,290}$/),
  text: z.string().min(1).max(12000),
  guidance: z.boolean().optional(),
}).strict();

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
