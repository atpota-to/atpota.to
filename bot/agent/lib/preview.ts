/**
 * Local Bluesky preview.
 *
 * Bluesky is where people meet Poe, but `eve dev` and a local `eve eval` talk
 * to it through the built-in eve channel, where the Bluesky reply rules would
 * never load. Running locally, that chat previews Bluesky mode instead: the
 * same reply rules, faces and 300 grapheme target. Nothing reaches Bluesky,
 * because only the bluesky channel ever hands a draft to the droplet.
 *
 * `eve dev` sets EVE_DEV and a local `eve eval` sets EVE_EVALUATION. Neither
 * is set on a deployment, so `eve dev <url>` against production still gets the
 * plain chat. POE_PREVIEW=off turns the preview off locally.
 */
export function previewsBluesky(channelKind: string | undefined): boolean {
  if (!channelKind || channelKind === "bluesky" || channelKind === "operator-dm") return false;
  if (process.env.POE_PREVIEW?.trim().toLowerCase() === "off") return false;
  return process.env.EVE_DEV === "1" || process.env.EVE_EVALUATION === "1";
}

/** Said once, above the Bluesky rules, so a typed message reads as a post. */
export const PREVIEW_NOTE =
  "Local preview of a Bluesky reply. Treat each message as a public post that " +
  "mentions you, from a stranger unless it says otherwise, and write exactly the " +
  "post you would publish.";
