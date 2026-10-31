import { defineTool } from "eve/tools";
import { z } from "zod";
import { WEATHER_AUTHENTICATOR, WEATHER_PAGES, WEATHER_PAGE_NAMES, weatherPageUrl } from "../lib/weather-post";

// This tool only chooses; it sends and posts nothing. The weather channel
// (channels/weather.ts) reads the choice off this call's result and hands it to the
// droplet with the draft, which links that page of the report under the post and shows
// its card (mentions/src/weather-posts.js). Anywhere but a weather moment it does nothing.
export default defineTool({
  description:
    "Only when your weather station has handed you a weather moment to post about: say which page of the " +
    "weather report your post is about, so the link card under it opens that page and shows its picture " +
    "instead of the whole report. Call it when the post is mostly about one part of the report, before " +
    "you answer; if you call it again, the last call counts. Skip it for a post about the sky as a whole. " +
    "The pages: " +
    Object.entries(WEATHER_PAGES).map(([page, what]) => `"${page}" is ${what}`).join("; ") + ".",
  inputSchema: z.object({
    page: z.enum(WEATHER_PAGE_NAMES).describe("the page of the weather report the post is about"),
  }),
  async execute(input, ctx) {
    const caller = ctx.session.auth.current;
    if (caller?.authenticator !== WEATHER_AUTHENTICATOR || caller.principalType !== "service" ||
        typeof caller.attributes?.momentId !== "string") {
      return { chosen: false, reason: "only for a weather post your station asked you for" };
    }
    return { chosen: true, page: input.page, url: weatherPageUrl(input.page) };
  },
});
