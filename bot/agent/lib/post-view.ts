/**
 * One Bluesky post, read whole: its text, what it carries (images with their
 * alt text, a video, a link card, a quoted post) and its counts, from the
 * public AppView's view of it. Pure, so look_at_post's parsing can be tested
 * without the network. Everything in a post is a stranger's words.
 */
import type { EventImage } from "./bluesky";

const APPVIEW = "https://public.api.bsky.app/xrpc";
const DID = /^did:(plc|web):[a-zA-Z0-9._:%-]{1,200}$/;
const HANDLE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
const RKEY = /^[a-zA-Z0-9._~:-]{1,512}$/;
/** The appview's own image thumbnails; lib/vision.ts describes only these. */
const THUMB = /^https:\/\/cdn\.bsky\.app\/img\/feed_thumbnail\//;
const MAX_TEXT = 3000;
const MAX_ALT = 2000;

export type PostRef = { repo: string; rkey: string };

/**
 * The post a link or at-uri names: bsky.app/profile/<handle or did>/post/<rkey>
 * (with or without the scheme, as the app shortens it) or
 * at://<did or handle>/app.bsky.feed.post/<rkey>. Null for anything else.
 */
export function parsePostRef(input: string): PostRef | null {
  const value = input.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(value) ??
    /^(?:https?:\/\/)?(?:www\.)?bsky\.app\/profile\/([^/]+)\/post\/([^/]+)$/i.exec(value);
  if (!m) return null;
  const repo = decodeURIComponent(m[1]);
  if (!(DID.test(repo) || HANDLE.test(repo)) || !RKEY.test(m[2])) return null;
  return { repo: DID.test(repo) ? repo : repo.toLowerCase(), rkey: m[2] };
}

export function resolveHandleUrl(handle: string): URL {
  const url = new URL(`${APPVIEW}/com.atproto.identity.resolveHandle`);
  url.searchParams.set("handle", handle);
  return url;
}

export function getPostsUrl(did: string, rkey: string): URL {
  const url = new URL(`${APPVIEW}/app.bsky.feed.getPosts`);
  url.searchParams.set("uris", `at://${did}/app.bsky.feed.post/${rkey}`);
  return url;
}

export function validDid(value: unknown): value is string {
  return typeof value === "string" && DID.test(value);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const num = (v: unknown): number | undefined => (Number.isSafeInteger(v) ? (v as number) : undefined);

export type QuotedPost = {
  uri?: string;
  author?: string;
  text?: string;
  /** Why the quoted post can't be read: not found, blocked, detached. */
  missing?: string;
  images?: { alt?: string }[];
};

export type PostSummary = {
  uri: string;
  link: string;
  author: { handle?: string; did?: string; displayName?: string };
  text: string;
  createdAt?: string;
  counts: { likes?: number; reposts?: number; replies?: number; quotes?: number };
  images: { alt?: string; source: string }[];
  video?: { alt?: string };
  card?: { uri?: string; title?: string; description?: string };
  quote?: QuotedPost;
  /** Feeds, lists, starter packs and the like, by at-uri. */
  other?: string;
};

function imagesOf(view: Obj | null, source: string, out: EventImage[]): { alt?: string; source: string }[] {
  if (!view || !String(view.$type ?? "").startsWith("app.bsky.embed.images")) return [];
  const list = Array.isArray(view.images) ? view.images : [];
  return list.slice(0, 4).flatMap((raw) => {
    const image = obj(raw);
    if (!image) return [];
    const alt = str(image.alt, MAX_ALT);
    const thumb = typeof image.thumb === "string" && THUMB.test(image.thumb) ? image.thumb : null;
    if (thumb) out.push({ url: thumb, ...(alt ? { alt } : {}), source });
    return [{ ...(alt ? { alt } : {}), source }];
  });
}

function quoteOf(view: Obj | null, out: EventImage[]): QuotedPost | undefined {
  const record = obj(view?.record);
  // recordWithMedia nests the record view one level deeper.
  const inner = record?.$type === "app.bsky.embed.record#view" ? obj(record.record) : record;
  if (!inner) return undefined;
  const type = String(inner.$type ?? "");
  const uri = str(inner.uri, 600);
  if (type === "app.bsky.embed.record#viewRecord") {
    if (!uri?.includes("/app.bsky.feed.post/")) return undefined;
    const author = obj(inner.author);
    const value = obj(inner.value);
    const embeds = Array.isArray(inner.embeds) ? inner.embeds : [];
    const images = embeds.flatMap((e) => {
      const embed = obj(e);
      return [
        ...imagesOf(embed, "the post it quotes", out),
        ...imagesOf(obj(embed?.media), "the post it quotes", out),
      ];
    }).map(({ alt }) => (alt ? { alt } : {}));
    return {
      uri,
      author: str(author?.handle, 253),
      text: str(value?.text, MAX_TEXT) ?? "",
      ...(images.length ? { images } : {}),
    };
  }
  const missing = { "app.bsky.embed.record#viewNotFound": "not found",
    "app.bsky.embed.record#viewBlocked": "blocked", "app.bsky.embed.record#viewDetached": "detached by its author" }[type];
  return missing ? { uri, missing } : undefined;
}

/**
 * The post from a getPosts answer, in words and alt text, and the images a
 * model may look at (appview thumbnails only, at most eight: four of the post's
 * and four of the post it quotes). Null when the answer holds no post.
 */
export function summarizePost(body: unknown): { post: PostSummary; images: EventImage[] } | null {
  const view = obj(Array.isArray(obj(body)?.posts) ? (obj(body)!.posts as unknown[])[0] : null);
  const uri = str(view?.uri, 600);
  const m = uri ? /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri) : null;
  if (!view || !uri || !m) return null;
  const author = obj(view.author);
  const record = obj(view.record);
  const embed = obj(view.embed);
  const images: EventImage[] = [];
  const type = String(embed?.$type ?? "");
  const media = type.startsWith("app.bsky.embed.recordWithMedia") ? obj(embed?.media) : embed;
  const mediaType = String(media?.$type ?? "");
  const external = mediaType.startsWith("app.bsky.embed.external") ? obj(media?.external) : null;
  const quote = type.startsWith("app.bsky.embed.record") ? quoteOf(embed, images) : undefined;
  const ownImages = imagesOf(media, "the post", images);
  const recordUri = type === "app.bsky.embed.record#view" ? str(obj(embed?.record)?.uri, 600) : undefined;
  const handle = str(author?.handle, 253);
  return {
    post: {
      uri,
      link: `https://bsky.app/profile/${handle && handle !== "handle.invalid" ? handle : m[1]}/post/${m[2]}`,
      author: { handle, did: str(author?.did, 300), displayName: str(author?.displayName, 200) },
      text: str(record?.text, MAX_TEXT) ?? "",
      createdAt: str(record?.createdAt, 40),
      counts: { likes: num(view.likeCount), reposts: num(view.repostCount),
        replies: num(view.replyCount), quotes: num(view.quoteCount) },
      images: ownImages,
      ...(mediaType.startsWith("app.bsky.embed.video") ? { video: { alt: str(media?.alt, MAX_ALT) } } : {}),
      ...(external ? { card: { uri: str(external.uri, 1000), title: str(external.title, 300),
        description: str(external.description, 1000) } } : {}),
      ...(quote ? { quote } : {}),
      ...(!quote && recordUri ? { other: recordUri } : {}),
    },
    images: images.slice(0, 8),
  };
}
