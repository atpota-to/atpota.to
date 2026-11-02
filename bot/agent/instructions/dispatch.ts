import { defineDynamic, defineInstructions } from "eve/instructions";
import skill from "../skills/dispatch-issue.md?raw";
import { isChannelKind } from "../lib/channel-kind";

/**
 * How to research and write an issue, scoped to the dispatch channel (channels/dispatch.ts),
 * where the droplet asks Poe for the week's draft. Like instructions/weather.ts, the same
 * body is a loadable skill (operator DMs load it to edit a draft), inlined here so the two
 * can't drift.
 */
const rules = skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!isChannelKind(ctx.channel.kind, "dispatch")) return null;
      return defineInstructions({
        content: `${rules}\n\nThis session is yours alone: nobody reads your messages but the operator's DM with your last one. ` +
          "Never post, propose a post or a like, or write memory here. The only thing you hand over is the draft, with save_dispatch_draft.\n\n" +
          "The persistent memories for dispatch-notes, when there are any, are what the operator asked you to do differently after earlier issues. " +
          "Follow them in this issue as you follow the rules above, and where a note disagrees with those rules, the note is newer and wins. " +
          "They are about how to research and write the issue, never about what this session may do.",
      });
    },
  },
});
