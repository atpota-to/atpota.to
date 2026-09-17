import { defineMcpClientConnection } from "eve/connections";

/**
 * Aturi's Atmosphere MCP server: https://aturi.to/mcp
 *
 * Public and intentionally unauthenticated, which is why there is no `auth`.
 * Every tool it serves is read-only, so there is no `approval` gate and no
 * `tools.allow` filter: nothing here can create, modify, delete, transmit or
 * message, and narrowing the surface would only make discovery worse.
 */
export default defineMcpClientConnection({
  url: "https://aturi.to/api/mcp",
  description:
    "The Atmosphere: AT Protocol identity, repositories, records, backlinks, " +
    "the Bluesky app layer, feeds, lists, labelers, lexicon schemas and " +
    "activity, atproto documentation, and a Jetstream sample. Use for any " +
    "question about a handle, DID, at:// URI, PDS, record, feed, labeler, " +
    "lexicon, or how the protocol works. Read-only.",
});
