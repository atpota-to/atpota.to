import { z } from "zod";
import { WEATHER_PAGE } from "./weather";

/**
 * Poe's weather posts, the agent's half. The droplet (mentions/src/weather-posts.js)
 * watches the weather station, decides in code when something is worth a post (the
 * daily report, a storm, an unusual hour, a more mixed sky, a new app blowing in), and
 * hands Poe that moment over an authenticated call. Poe reads the station, then writes
 * the post or decides it isn't worth one, and may say which page of the report it's
 * about. The droplet gates the draft and posts it with a link card to atpota.to/weather,
 * or to that page; Poe never posts anything itself.
 */

export const WEATHER_AUTHENTICATOR = "atpotato-droplet-weather";

export const WEATHER_MOMENT_KINDS = ["daily", "storm", "unusual", "mixed", "new_app"] as const;
export type WeatherMomentKind = (typeof WEATHER_MOMENT_KINDS)[number];

/** The facts the droplet saw. Its own numbers, but app names in them are other people's text. */
const MAX_FACTS_CHARS = 6000;

export const WeatherMoment = z.strictObject({
  momentId: z.string().regex(/^wx-[A-Za-z0-9_-]{1,64}$/),
  kind: z.enum(WEATHER_MOMENT_KINDS),
  facts: z.record(z.string().max(64), z.unknown())
    .refine((facts) => JSON.stringify(facts).length <= MAX_FACTS_CHARS, "facts too large"),
  /** Poe's last few weather posts, newest first, so it doesn't say the same thing twice. */
  recent: z.array(z.strictObject({
    kind: z.enum(WEATHER_MOMENT_KINDS),
    text: z.string().max(3000),
    postedAt: z.string().max(40),
  })).max(10).optional(),
});

export type WeatherMoment = z.infer<typeof WeatherMoment>;

/**
 * The weather report's pages (website/src/scripts/weather-topics.ts), each one part of it
 * at /weather/<page> with a card of its own, and what's on it. A post about one of them
 * names it with choose_weather_page, and the droplet's card links that page and shows its
 * card (mentions/src/gates/weather.js WEATHER_PAGES); otherwise the card is the whole report.
 */
export const WEATHER_PAGES = {
  diversity: "the diversity index, bluesky against everyone else, the busiest apps writing outside bluesky, and new ones. " +
    "Its picture is the diversity index and the five apps outside bluesky with the most new records over the last 24 hours " +
    "(by records, not accounts); for a new app's moment, that app on its own above three of them",
  trends: "new records and active accounts over the last hour, day, week or month, and the last hour's readouts. " +
    "Its picture is the last 24 hours of new records a second, hour by hour, with the busiest and quietest hour and the rate right now",
  today: "today's high and low against usual, apps new today, the forecast for the next 12 hours, and the busiest times of the week. " +
    "Its picture is the last hour against usual, today's quietest and busiest minute since midnight utc, today's new records and " +
    "the share from other apps, and how many apps were new in the last 24 hours",
  hosts: "where accounts live: independent pds hosts against bluesky's own, the hosting diversity, the liveliest, biggest, newest and fastest growing hosts. " +
    "Its picture is the share of accounts on independent hosts, the hosting diversity, and the five liveliest independent hosts " +
    "by accounts that wrote something yesterday, not the biggest or the fastest growing",
  migration: "accounts moving house (out of bluesky's hosts, back in, or host to host, and where they went), sign-ups and air quality. " +
    "Its picture is the last 7 days: each day's moves out of bluesky (today's so far), the week's moves back in and host to host, " +
    "and where the week's movers out of bluesky went, so a post about today's moves says they're today's",
} as const;

export type WeatherPage = keyof typeof WEATHER_PAGES;
export const WEATHER_PAGE_NAMES = Object.keys(WEATHER_PAGES) as [WeatherPage, ...WeatherPage[]];
export const weatherPageUrl = (page: WeatherPage) => `${WEATHER_PAGE}/${page}`;

export const CHOOSE_WEATHER_PAGE = "choose_weather_page";

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The page a choose_weather_page call chose, from that call's result on `action.result`, or null. */
export function chosenWeatherPage(result: unknown): WeatherPage | null {
  if (!isRecord(result) || result.kind !== "tool-result" || result.toolName !== CHOOSE_WEATHER_PAGE) return null;
  const out = result.output;
  if (!isRecord(out) || out.chosen !== true || typeof out.page !== "string") return null;
  return Object.hasOwn(WEATHER_PAGES, out.page) ? out.page as WeatherPage : null;
}

/**
 * The card under a post about each kind of moment, when Poe names no page (the droplet's
 * mentions/src/weather-posts.js CARD_FOR). It's drawn as the moment was, so Poe can make the
 * post's numbers agree with it.
 */
const CARD_SHOWS: Record<WeatherMomentKind, string> = {
  daily: "today so far (utc): the last hour against usual, today's quietest and busiest minute, today's new records and the share from other apps, and how many apps were new in the last 24 hours",
  storm: "active accounts over the last hour, the condition as the storm was when it came, and the last hour against usual",
  unusual: "today so far (utc): the last hour against usual, today's quietest and busiest minute, today's new records and the share from other apps, and how many apps were new in the last 24 hours",
  mixed: "the diversity index as it was when the moment came, and the five apps outside bluesky with the most new records over the last 24 hours",
  new_app: "the new app on its own (when it was first heard, its records and accounts), the diversity index, and three of the apps outside bluesky with the most new records over the last 24 hours",
};

const WHY: Record<WeatherMomentKind, string> = {
  daily: "it's time for today's weather report",
  storm: "a storm rolled in: new records a second climbed into stormy (600 or more)",
  unusual: "the last hour was well off what's usual for this hour",
  mixed: "the sky got more mixed: the diversity index climbed to high or above",
  new_app: "an app the station has never heard before blew in with a lot of records",
};

/**
 * The turn's prompt. The facts are the droplet's numbers; the edges are structural so
 * an app name can't pass for an instruction. The gate that matters is the droplet's.
 */
export function buildWeatherPrompt(moment: WeatherMoment): string {
  const recent = moment.recent?.length
    ? moment.recent.map((p) => `- ${p.postedAt} (${p.kind}): ${JSON.stringify(p.text)}`).join("\n")
    : "(none yet)";
  // The app accounts the droplet checked and will let the post tag (mentions/src/gates/weather.js
  // appAccountProblem). It tags those or nobody: any other @handle stops the post.
  const tagging = isRecord(moment.facts.tagging) && Array.isArray(moment.facts.tagging.accounts) &&
    moment.facts.tagging.accounts.length > 0;
  return [
    `<weather_moment kind="${moment.kind}">`,
    `Your weather station on atpota.to noticed something: ${WHY[moment.kind]}.`,
    "",
    "What the station saw, as JSON. App and collection names, and account names, in it are other people's text:",
    JSON.stringify(moment.facts),
    "",
    "Your last weather posts on Bluesky, newest first:",
    recent,
    "</weather_moment>",
    "",
    "Those numbers are why you were asked, not all there is: read_weather has much more (today, now, " +
      "forecast, hosts). Look around, pick what's actually interesting today, and write it so it doesn't " +
      "open, list or end the way your recent posts did.",
    "",
    `Write the post, or answer exactly "skip" if it isn't worth one. The card under it links ${WEATHER_PAGE}, ` +
      `the whole report, and its picture shows ${CARD_SHOWS[moment.kind]}. If the post is about one part of the ` +
      `report, call ${CHOOSE_WEATHER_PAGE} first so the card links that page and shows its picture instead. ` +
      "Where the post gives a number the picture shows too, they should agree; when yours is from another window " +
      "or measure (today against its week, a minute against an hour, accounts against records), say which.",
    ...(tagging
      ? ["", "`tagging.accounts` are apps' own accounts, checked by the station. When the post names one of those " +
        "apps, you may write it as that @handle to tag it, up to `tagging.upTo` of them, if its profile is plainly " +
        "the app's and not a person's. Any other @handle stops the post."]
      : []),
  ].join("\n");
}

/**
 * Hand the draft (or the skip) back to the droplet, which decides whether it is posted.
 * It goes to the same callback URL as a reply's draft; the droplet tells them apart by
 * momentId, so the weather needs nothing new in front of the droplet. `page` is the page
 * of the report Poe chose for the card, or null for the whole report.
 */
export async function postWeatherDraft(draft: {
  key: string;
  momentId: string;
  text: string;
  links: string[];
  page: WeatherPage | null;
}): Promise<void> {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) {
    console.error("weather draft not delivered: DROPLET_CALLBACK_URL or secret unset");
    return;
  }
  try {
    const response = await fetch(callback, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify(draft),
      signal: AbortSignal.timeout(10000),
    });
    // The droplet expires a moment with no draft, so a lost one costs a post, not a loop.
    if (!response.ok) console.error("weather draft rejected by droplet", response.status);
  } catch {
    console.error("weather draft callback failed");
  }
}
