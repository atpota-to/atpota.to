/**
 * Friendly status labels for the tools Poe calls (SPEC 4.1 `status`). The browser only
 * ever sees these labels, never a raw tool name, input or output. The widget adds "…".
 *
 * Names come from the bot's Aturi MCP connection (bot/agent/connections/atmosphere.ts,
 * agent-spec/04-aturi-connection.md: eve calls them "<connection>__<tool>", e.g.
 * "atmosphere__resolve_identity"), its authored tools (bot/agent/tools/*.ts) and eve's
 * built-in tools. Anything unknown gets FALLBACK_LABEL.
 */

export const FALLBACK_LABEL = 'looking that up';

export const TOOL_LABELS: Readonly<Record<string, string>> = {
  // Aturi: resolve and open
  resolve_link: 'opening that link',
  list_waypoints: 'finding apps that open it',
  // Aturi: identity
  resolve_identity: 'resolving a handle',
  resolve_identities: 'resolving some handles',
  get_identity_history: "checking an account's history",
  describe_pds: 'checking a pds',
  // Aturi: repositories and records
  describe_repo: 'looking around a repo',
  get_record: 'looking up a record',
  list_records: 'listing records',
  get_backlinks: 'finding what points here',
  sample_recent_records: 'sampling recent records',
  sample_jetstream: 'listening to the firehose',
  // Aturi: bluesky app layer
  get_profile: 'looking at a profile',
  get_posts: 'reading some posts',
  get_thread: 'reading a thread',
  get_author_feed: "reading an account's posts",
  get_post_engagement: 'checking likes and reposts',
  search_posts: 'searching posts',
  search_actors: 'searching for accounts',
  get_followers: 'checking followers',
  get_follows: 'checking follows',
  get_suggested_follows: 'finding similar accounts',
  get_starter_packs: 'looking at starter packs',
  get_trends: "checking what's trending",
  // Aturi: feeds, lists, labelers
  get_feed: 'checking a feed',
  get_feed_info: 'checking a feed',
  list_feeds: 'looking at feeds',
  get_list: 'checking a list',
  get_list_feed: 'reading a list feed',
  list_lists: 'looking at lists',
  get_labeler_services: 'checking labelers',
  // Aturi: lexicons
  get_lexicon_schema: 'reading a lexicon',
  search_lexicons: 'searching lexicons',
  get_lexicon_activity: 'checking lexicon activity',
  list_trending_lexicons: 'checking trending lexicons',
  list_new_lexicons: 'checking new lexicons',
  list_lexicon_movers: 'checking lexicon activity',
  // Aturi: docs and api reference
  search_atproto_docs: 'searching the atproto docs',
  read_atproto_doc: 'reading the atproto docs',
  search_api_methods: 'searching the api docs',
  get_api_method: 'reading the api docs',
  // Authored tools (bot/agent/tools)
  scan_collection: 'counting records',
  search_bluesky_posts: 'searching posts',
  top_author_posts: 'finding top posts',
  top_mentioned_posts: 'finding the most mentioned posts',
  read_dispatch: 'reading the dispatch',
  // Memory slots (person__save_memory, life__save_memory, ...): a signed-in visitor sees these
  save_memory: 'making a note',
  remove_memory: 'crossing out a note',
  // eve built-ins that make sense to name
  web_search: 'searching the web',
  web_fetch: 'reading a web page',
};

/**
 * "atmosphere__resolve_identity" -> "resolve_identity"; also tolerates "mcp__x__y",
 * "x.y", "x/y" and "x:y" spellings and any letter case.
 */
export function baseToolName(name: string): string {
  const parts = name.trim().toLowerCase().split(/__|[./:]/);
  return parts[parts.length - 1] ?? '';
}

export function toolLabel(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return FALLBACK_LABEL;
  const key = baseToolName(name);
  // hasOwn: a name like "constructor" must not reach Object.prototype.
  return Object.hasOwn(TOOL_LABELS, key) ? TOOL_LABELS[key]! : FALLBACK_LABEL;
}
