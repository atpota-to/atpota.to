import { defineAgent } from "eve";

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
 */
const model = process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash";
const reasoning = (process.env.AGENT_REASONING ?? "high") as
  | "off"
  | "low"
  | "medium"
  | "high";

export default defineAgent({ model, reasoning });
