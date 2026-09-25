export const PAGE_SIZE = 50;
export const MAX_PAGES = 20;
export const MAX_POSTS = 1_000;
export const MAX_RESPONSE_BYTES = 2_000_000;
export const MAX_TOTAL_BYTES = 20_000_000;
export const MAX_SCAN_MS = 90_000;

const DID = /^did:(?:plc|web):[^\s/?#]+$/;
const POST_URI = /^at:\/\/(did:(?:plc|web):[^\s/?#]+)\/app\.bsky\.feed\.post\/[a-zA-Z0-9._~-]+$/;

export function validDid(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && DID.test(value);
}

export type CompactPost = { uri: string; handle: string; likeCount: number; excerpt: string };

export function parseAuthorPage(value: unknown, limit: number): { feed: unknown[]; cursor: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Bluesky author page");
  const page = value as { feed?: unknown; cursor?: unknown };
  if (!Array.isArray(page.feed) || page.feed.length > limit ||
      page.feed.some((item: unknown) => !item || typeof item !== "object" || Array.isArray(item) ||
        !(item as { post?: unknown }).post || typeof (item as { post: unknown }).post !== "object" ||
        Array.isArray((item as { post: unknown }).post)) ||
      (page.cursor != null && (typeof page.cursor !== "string" || !page.cursor || page.cursor.length > 512)))
    throw new Error("Invalid Bluesky author page");
  return { feed: page.feed, cursor: page.cursor as string | undefined ?? null };
}

export function compactAuthorPost(value: unknown, did: string): CompactPost | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const post = value as { uri?: unknown; author?: { did?: unknown; handle?: unknown };
    record?: { $type?: unknown; text?: unknown }; likeCount?: unknown };
  if (typeof post.uri !== "string" || !POST_URI.test(post.uri) ||
      POST_URI.exec(post.uri)?.[1] !== did || post.author?.did !== did ||
      post.record?.$type !== "app.bsky.feed.post" ||
      typeof post.likeCount !== "number" || !Number.isSafeInteger(post.likeCount) || post.likeCount < 0) return null;
  return { uri: post.uri,
    handle: typeof post.author.handle === "string" && post.author.handle.length <= 253 ? post.author.handle : did,
    likeCount: post.likeCount,
    excerpt: typeof post.record.text === "string" ? post.record.text.slice(0, 280) : "" };
}

export function topPosts(posts: CompactPost[], limit: number): CompactPost[] {
  return posts.sort((a, b) => b.likeCount - a.likeCount || a.uri.localeCompare(b.uri)).slice(0, limit);
}
