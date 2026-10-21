import { defineTool } from "eve/tools";
import { z } from "zod";
import { readWeather, timeZoneOf } from "../lib/weather";

// Read-only and public: the same numbers atpota.to/weather shows, from atpota.to's own
// endpoints (lib/weather.ts). Open to every channel, website visitors included.
export default defineTool({
  description:
    "Read your weather station: the Atmosphere's weather, as atpota.to/weather reports it, never the " +
    "weather outside. The station counts every new record on the network, Bluesky's and every other " +
    "app's. The condition is its busyness by new records a second (calm under 300, light, breezy from " +
    "400, gusty from 500, stormy from 600). The diversity index is how much of the network isn't " +
    "Bluesky by who's writing, not how much: the percent of active accounts that wrote with other apps, " +
    "times the square root of how many apps' worth they're spread across, so one account writing a " +
    "thousand records counts once. It has a level like the UV index (low under 3, moderate, high from " +
    "6, very high from 8, extreme from 11); `mix` says how it compares with the window before " +
    "(diversityIndexBefore, when that window was heard live). Apps are named by their namespace as a domain: " +
    "sh.tangled.* is tangled.sh. report \"now\" is the last 60 seconds. \"today\" is today so far in " +
    "timeZone: the busiest and quietest minute, the last hour against usual, apps the station heard " +
    "for the first time, and the last 24 hours' busiest apps. \"week\" is the past 7 days for your " +
    "dispatch: the week's weather, the week before, the busiest and quietest hour, each day, the " +
    "busiest apps against the week before, the month, and an outlook from the station's usual week; " +
    "`archive` says how much of it came from Jetstream's archive, before the station listened live. " +
    "Every report says how much of its window the station heard (heardPercent); its numbers cover " +
    "only that. A comparison it leaves out could not be made. `page` is the weather report's link.",
  inputSchema: z.object({
    report: z.enum(["now", "today", "week"]).default("now")
      .describe('"now" (the default) for the last minute, "today" for today against usual, "week" for the dispatch'),
    timeZone: z.string().max(64).optional()
      .describe('an IANA time zone for hours, days and the outlook, like "America/New_York"; UTC if not given'),
  }),
  async execute(input) {
    const tz = timeZoneOf(input.timeZone);
    if (!tz) return { available: false, reason: "timeZone must be an IANA time zone, like Europe/London" };
    try {
      return { available: true, ...(await readWeather(input.report, tz)) };
    } catch {
      return { available: false, reason: "the weather station could not be read right now" };
    }
  },
});
