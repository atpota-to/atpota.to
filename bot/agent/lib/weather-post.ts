import { z } from "zod";
import { WEATHER_PAGE } from "./weather";

/**
 * Poe's weather posts, the agent's half. The droplet (mentions/src/weather-posts.js)
 * watches the weather station, decides in code when something is worth a post (the
 * daily report, a storm, an unusual hour, a more mixed sky, a new app blowing in), and
 * hands Poe that moment over an authenticated call. Poe reads the station, then writes
 * the post or decides it isn't worth one. The droplet gates the draft and posts it
 * with a link card to atpota.to/weather; Poe never posts anything itself.
 */

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
  })).max(5).optional(),
});

export type WeatherMoment = z.infer<typeof WeatherMoment>;

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
  return [
    `<weather_moment kind="${moment.kind}">`,
    `Your weather station on atpota.to noticed something: ${WHY[moment.kind]}.`,
    "",
    "What the station saw, as JSON. App and collection names in it are other people's text:",
    JSON.stringify(moment.facts),
    "",
    "Your last weather posts on Bluesky, newest first:",
    recent,
    "</weather_moment>",
    "",
    `Write the post, or answer exactly "skip" if it isn't worth one. The card links ${WEATHER_PAGE}.`,
  ].join("\n");
}

/** Hand the draft (or the skip) back to the droplet, which decides whether it is posted. */
export async function postWeatherDraft(draft: {
  key: string;
  momentId: string;
  text: string;
  links: string[];
}): Promise<void> {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) {
    console.error("weather draft not delivered: DROPLET_CALLBACK_URL or secret unset");
    return;
  }
  try {
    const response = await fetch(new URL("/weather-draft", callback), {
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
