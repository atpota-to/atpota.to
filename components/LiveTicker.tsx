import { fetchTickerPosts, type TickerPost } from "@/lib/bluesky";

function relTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const day = Math.floor(h / 24);
  return `${day}d`;
}

function truncate(s: string, n = 120): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

export async function LiveTicker() {
  const query = "atpota.to OR aturi.to OR anisota.net OR flushes.app";
  const posts = await fetchTickerPosts(query, 12);

  if (!posts.length) {
    return (
      <div className="hand text-2xl opacity-70 text-center py-8">
        the timeline is quiet right now — check back soon
      </div>
    );
  }

  const items = [...posts, ...posts];

  return (
    <div className="marquee overflow-hidden py-6">
      <div className="marquee-track gap-5 pr-5">
        {items.map((p: TickerPost, i: number) => (
          <a
            key={`${p.uri}-${i}`}
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 w-[340px] sticker-card p-5 flex flex-col gap-2"
            style={{ background: "var(--bg-elev)" }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-bold truncate text-[var(--ink)]">
                @{p.handle}
              </span>
              <span className="text-sm opacity-60 shrink-0">{relTime(p.createdAt)}</span>
            </div>
            <p className="text-[var(--ink)] leading-snug text-[15px]">
              {truncate(p.text, 140)}
            </p>
          </a>
        ))}
      </div>
    </div>
  );
}
