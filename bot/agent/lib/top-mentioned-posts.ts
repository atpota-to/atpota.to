export const MENTION_PATHS = [
  "facets[app.bsky.richtext.facet].features[app.bsky.richtext.facet#mention].did",
  "facets[].features[app.bsky.richtext.facet#mention].did",
] as const;
export const MAX_POSTS = 1_000;
export const MAX_PAGES = 12;
export const PAGE_SIZE = 100;
export const HYDRATE_SIZE = 25;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 24_000_000;
export const MAX_SCAN_MS = 90_000;

const DID = /^did:(?:plc|web):[^\s/?#]+$/;
const POST_URI = /^at:\/\/(did:(?:plc|web):[^\s/?#]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9._~-]+)$/;

export function validDid(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && DID.test(value);
}

export function postLink(uri: string): string | null {
  const match = POST_URI.exec(uri);
  return match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : null;
}

export type Backlink = { did: string; collection: string; rkey: string };
export function parseBacklinks(value: unknown, limit: number): { total: number; records: Backlink[]; cursor: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Constellation page");
  const page = value as { total?: unknown; records?: unknown; cursor?: unknown };
  if (!Number.isSafeInteger(page.total) || (page.total as number) < 0 || !Array.isArray(page.records) || page.records.length > limit ||
      (page.cursor != null && (typeof page.cursor !== "string" || !page.cursor || page.cursor.length > 512)) ||
      page.records.some((r: unknown) => !r || typeof r !== "object" || Array.isArray(r) ||
        !validDid((r as Backlink).did) || (r as Backlink).collection !== "app.bsky.feed.post" ||
        typeof (r as Backlink).rkey !== "string" || !/^[a-zA-Z0-9._~-]{1,512}$/.test((r as Backlink).rkey)))
    throw new Error("Invalid Constellation page");
  return { total: page.total as number, records: page.records as Backlink[], cursor: page.cursor as string | undefined ?? null };
}

export function hasMention(record: unknown, did: string): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const facets = (record as { facets?: unknown }).facets;
  return Array.isArray(facets) && facets.some((facet: unknown) => {
    if (!facet || typeof facet !== "object") return false;
    const features = (facet as { features?: unknown }).features;
    return Array.isArray(features) && features.some((feature: unknown) =>
      feature && typeof feature === "object" &&
      (feature as { $type?: unknown }).$type === "app.bsky.richtext.facet#mention" &&
      (feature as { did?: unknown }).did === did);
  });
}

export type CompactPost = { uri: string; handle: string; likeCount: number; text: string };
export function compactPost(value: unknown, uri: string, did: string): CompactPost | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const post = value as { uri?: unknown; author?: { did?: unknown; handle?: unknown }; record?: { text?: unknown }; likeCount?: unknown };
  if (post.uri !== uri || !postLink(uri) || !validDid(post.author?.did) ||
      post.author.did !== POST_URI.exec(uri)?.[1] || !hasMention(post.record, did) ||
      typeof post.likeCount !== "number" || !Number.isSafeInteger(post.likeCount) || post.likeCount < 0) return null;
  return {
    uri,
    handle: typeof post.author.handle === "string" && post.author.handle.length <= 253 ? post.author.handle : post.author.did,
    likeCount: post.likeCount,
    text: typeof post.record?.text === "string" ? post.record.text.slice(0, 280) : "",
  };
}

export function topPosts(posts: CompactPost[], limit: number): CompactPost[] {
  return posts.sort((a, b) => b.likeCount - a.likeCount || a.uri.localeCompare(b.uri)).slice(0, limit);
}
