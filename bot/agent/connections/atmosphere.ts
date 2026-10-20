import { defineMcpClientConnection } from "eve/connections";

/**
 * Aturi's Atmosphere MCP server: https://aturi.to/mcp
 *
 * Public and intentionally unauthenticated, which is why there is no `auth`.
 * Read-only. Aturi's raw list_records is blocked from model discovery;
 * the authored list_records tool allows up to 10 pages / 1,000 requested
 * records per dispatch or session (at most 100 per page). Use scan_collection
 * for counts and top_mentioned_posts for network-wide mention rankings.
 *
 * Aturi's read_atmosphere_dispatch is blocked too: it reads the same records
 * as the authored read_dispatch, which is the one the instructions name and
 * the one whose links Poe is told to share. Two tools for one job only gives
 * the model a choice to get wrong.
 */
export default defineMcpClientConnection({
  url: "https://aturi.to/api/mcp",
  tools: { block: ["list_records", "read_atmosphere_dispatch"] },
  description:
    "The Atmosphere: AT Protocol identity, repositories, records, backlinks, " +
    "the Bluesky app layer, feeds, lists, labelers, lexicon schemas and " +
    "activity, atproto documentation, and a Jetstream sample. Use for any " +
    "question about a handle, DID, at:// URI, PDS, record, feed, labeler, " +
    "lexicon, or how the protocol works. Read-only.",
});
