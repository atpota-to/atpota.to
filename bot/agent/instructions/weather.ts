import { defineDynamic, defineInstructions } from "eve/instructions";
import skill from "../skills/weather-post.md?raw";
import { isChannelKind } from "../lib/channel-kind";

/**
 * Rules for a weather post, scoped to the weather channel (channels/weather.ts), where
 * the droplet hands Poe a moment from the weather station. Like instructions/bluesky.ts,
 * the same body is a loadable skill, inlined here so the two can't drift.
 */
const rules = skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!isChannelKind(ctx.channel.kind, "weather")) return null;
      return defineInstructions({ content: rules });
    },
  },
});
