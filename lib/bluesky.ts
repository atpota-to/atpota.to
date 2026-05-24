export type TickerPost = {
  uri: string;
  handle: string;
  displayName: string;
  text: string;
  createdAt: string;
  url: string;
};

const APPVIEW = "https://public.api.bsky.app/xrpc";

function postUrl(uri: string, handle: string): string {
  const rkey = uri.split("/").pop() ?? "";
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

export async function fetchTickerPosts(query: string, limit = 12): Promise<TickerPost[]> {
  try {
    const url = `${APPVIEW}/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${limit}&sort=latest`;
    const res = await fetch(url, { next: { revalidate: 600 } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      posts?: Array<{
        uri: string;
        author: { handle: string; displayName?: string };
        record: { text: string; createdAt: string };
      }>;
    };
    return (data.posts ?? []).map((p) => ({
      uri: p.uri,
      handle: p.author.handle,
      displayName: p.author.displayName ?? p.author.handle,
      text: p.record.text,
      createdAt: p.record.createdAt,
      url: postUrl(p.uri, p.author.handle),
    }));
  } catch {
    return [];
  }
}
