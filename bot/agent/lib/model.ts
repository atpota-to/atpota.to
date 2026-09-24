/**
 * The model, and the reasoning effort that goes with it.
 *
 * Both are read from the environment so the model can be changed in the Vercel
 * dashboard and redeployed, without a code change or a pull request. The ids
 * are Vercel AI Gateway ids: run `curl https://ai-gateway.vercel.sh/v1/models`
 * for the full list, which was 386 entries on 2026-09-23.
 *
 * AGENT_MODEL     e.g. anthropic/claude-opus-5, deepseek/deepseek-v4.1-flash
 * AGENT_REASONING one of off | low | medium | high
 *
 * A wrong id here fails at request time rather than at boot, so it shows up as
 * every turn erroring rather than as a deploy that refuses to start. Check the
 * id against the gateway before setting it.
 *
 * The reply voice in skills/bluesky-reply.md was written against
 * anthropic/claude-opus-5 and its samples came from that model. Voice is not
 * portable between models: changing this means re-reading real drafts before
 * trusting the tone.
 *
 * Lives here rather than in agent.ts so the Bluesky channel can ask whether
 * this same model can see images.
 */
export const MODEL = process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash";
export const REASONING = (process.env.AGENT_REASONING ?? "high") as
  | "off"
  | "low"
  | "medium"
  | "high";

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
 */
export async function modelSeesImages(): Promise<boolean> {
  if (seesImages !== undefined) return seesImages;
  try {
    const res = await fetch(CATALOG, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: Array<{ id?: string; tags?: string[] }> };
    seesImages = !!body.data?.find((m) => m.id === MODEL)?.tags?.includes("vision");
    return seesImages;
  } catch {
    return false;
  }
}
