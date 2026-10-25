export type ChannelName = "bluesky" | "dispatch" | "operator-dm" | "website" | "weather";

/**
 * True when a turn came through the named channel. At runtime eve spells an
 * authored channel's kind "channel:<file stem>", so agent/channels/bluesky.ts
 * arrives as "channel:bluesky" (runtime/resolve-channel.js in eve 0.58.1), and
 * it normalizes any other spelling to "unknown". A check against the bare stem
 * therefore never matches on a real turn. The bare stem is still accepted, as
 * lib/website.ts already does, so test fixtures and an eve that drops the
 * prefix keep working.
 */
export function isChannelKind(kind: string | undefined, name: ChannelName): boolean {
  return kind === name || kind === `channel:${name}`;
}
