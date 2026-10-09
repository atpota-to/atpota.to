import type { LanguageModel } from "ai";
import { anthropic } from "eve/models/anthropic";

/**
 * The model, and the reasoning effort that goes with it.
 *
 * Both are read from the environment so the model can be changed in the Vercel
 * dashboard and redeployed, without a code change or a pull request. The ids
 * are Vercel AI Gateway ids: run `curl https://ai-gateway.vercel.sh/v1/models`
 * for the full list, which was 386 entries on 2026-09-23.
 *
 * AGENT_MODEL       e.g. anthropic/claude-opus-5, deepseek/deepseek-v4.1-flash
 * AGENT_REASONING   one of off | low | medium | high
 * ANTHROPIC_API_KEY optional: sends anthropic/ models straight to Anthropic
 *
 * With ANTHROPIC_API_KEY set, an anthropic/ model is called on Anthropic's own
 * API with that key instead of through the gateway; every other model still
 * goes through the gateway. The gateway will not use the key itself: the team
 * has zero data retention on there, and that skips a bring-your-own key with
 * no ZDR agreement behind it. Calls made with the key are under Anthropic's
 * standard API retention, not the gateway's ZDR. Unset the key to go back.
 *
 * A wrong id here fails at request time rather than at boot, so it shows up as
 * every turn erroring rather than as a deploy that refuses to start. Check the
 * id against the gateway before setting it.
 *
 * The sample replies in skills/bluesky-reply.md are real posts from
 * 2026-09-24, from whichever model was live that day. Voice is not portable
 * between models: changing this means re-reading real drafts before trusting
 * the tone.
 *
 * Lives here rather than in agent.ts so the Bluesky channel can ask whether
 * this same model can see images.
 */
export const MODEL_ID = process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash";
export const MODEL: LanguageModel = direct(MODEL_ID) ?? MODEL_ID;
export const REASONING = (process.env.AGENT_REASONING ?? "high") as
  | "off"
  | "low"
  | "medium"
  | "high";

/**
 * MODEL_ID on Anthropic's own API, or undefined without a key or for a model
 * that is not Anthropic's.
 *
 * The gateway writes versions with dots and Anthropic with dashes, so
 * anthropic/claude-opus-5.5 is claude-opus-5-5. The gateway's -fast ids have
 * no direct equivalent and fail at request time. eve reads the key again on
 * every request.
 */
function direct(id: string): LanguageModel | undefined {
  if (!id.startsWith("anthropic/") || !process.env.ANTHROPIC_API_KEY?.trim()) return undefined;
  return anthropic(id.slice("anthropic/".length).replaceAll(".", "-"));
}

const CATALOG = "https://ai-gateway.vercel.sh/v1/models";
let seesImages: boolean | undefined;

/**
 * Whether MODEL can look at images, from the AI Gateway's own catalog.
 *
 * Asked rather than assumed, because AGENT_MODEL changes from the dashboard
 * and not every model has vision: deepseek/deepseek-v4-pro does not, as of
 * 2026-09-23. An image sent to one of those fails the call. A catalog read
 * that fails is not remembered, so the next post asks again; until one
 * succeeds the answer is no, and images reach the agent as their alt text.
 * The catalog is asked by the gateway id even when the call goes direct.
 */
export async function modelSeesImages(): Promise<boolean> {
  if (seesImages !== undefined) return seesImages;
  try {
    const res = await fetch(CATALOG, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: Array<{ id?: string; tags?: string[] }> };
    seesImages = !!body.data?.find((m) => m.id === MODEL_ID)?.tags?.includes("vision");
    return seesImages;
  } catch {
    return false;
  }
}
