/**
 * What the weekly dispatch reads, besides the lexicon numbers.
 *
 * Lists and feeds are at:// URIs. The builders list is a Bluesky record, so
 * adding a person to it needs no deploy; adding a list or feed here does.
 *
 * The two feeds are stand-ins for the demo until the operator picks the real
 * ones: the two most-liked atproto feeds in Bluesky's popular feed search on
 * 2026-10-18. The repos are stand-ins too.
 *
 * "atmosphere" is not a query on its own: it matches weather and moods far
 * more often than apps. Neither is "lexicon": on the 2026-10-18 demo week,
 * 115 of the 136 posts it found had nothing atproto-related in their text or
 * links. The feeds cover the community's own wording.
 */
export type DispatchSources = {
  lists: string[];
  feeds: string[];
  queries: string[];
  repos: string[];
  /** DIDs or handles whose posts are never collected. */
  optOuts: string[];
};

export const SOURCES: DispatchSources = {
  lists: [],
  feeds: [
    // ATProto﹫, by mackuba.eu
    "at://did:plc:oio4hkxaop4ao4wz2pp3f4cr/app.bsky.feed.generator/atproto",
    // AT Protocol Developers, by atproto.com
    "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.generator/atproto-devs",
  ],
  queries: ["atproto", "\"at protocol\"", "standard.site"],
  repos: ["bluesky-social/atproto", "bluesky-social/indigo", "bluesky-social/social-app"],
  optOuts: [],
};
