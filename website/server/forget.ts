/**
 * "Forget me", from the settings page: DELETE /api/poe with `Authorization: Bearer <jwt>`.
 *
 * The token is an atproto service-auth token the reader's own PDS signed for atpota.to and
 * the method to.atpota.poe.forget (server/identity.ts checks it exactly as it checks a chat
 * token, but for this method only). The verified DID goes to the bot's website channel,
 * POST {agentUrl}/website/forget, over the same secret as a chat; the bot empties the notes
 * Poe keeps for that DID and hands the empty version to the droplet, which replaces the
 * public copy in Poe's repo (bot/agent/lib/published-memory.ts).
 *
 * The bot answers { hadNotes, published }: whether there was anything to wipe, and whether
 * the public copy was replaced straight away. Both are passed on as they are.
 */

import { SECRET_HEADER } from './upstream.js';

export const FORGET_TIMEOUT_MS = 15_000;

export interface Forgotten {
  hadNotes: boolean;
  published: boolean;
}

export type ForgetResult = { ok: true; forgotten: Forgotten } | { ok: false; status?: number; error?: unknown };

export async function forgetOnBot(opts: { agentUrl: string; secret: string; did: string; fetch: typeof fetch }): Promise<ForgetResult> {
  let res: Response;
  try {
    res = await opts.fetch(`${opts.agentUrl}/website/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: opts.secret },
      body: JSON.stringify({ did: opts.did }),
      redirect: 'error',
      signal: AbortSignal.timeout(FORGET_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: res.status };
  }
  const body = (await res.json().catch(() => null)) as Partial<Forgotten> | null;
  if (typeof body?.hadNotes !== 'boolean' || typeof body.published !== 'boolean') return { ok: false, status: res.status };
  return { ok: true, forgotten: { hadNotes: body.hadNotes, published: body.published } };
}
