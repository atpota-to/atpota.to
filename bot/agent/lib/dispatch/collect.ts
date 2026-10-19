/**
 * Collectors for the weekly dispatch: the posts, lexicon numbers and releases
 * an issue is written from.
 *
 * Code collects, models judge. Nothing here summarizes or ranks data away. It
 * fetches, dedupes, trims each record to the fields a writer can use, and
 * applies the privacy filter, which is the only step that removes a record.
 * See agent-spec/12-weekly-dispatch.md.
 *
 * No eve imports and no relative imports, so plain Node can run it for the
 * demo (scripts/dispatch-demo.ts) and the tests can import it directly.
 */

export type Fetch = typeof fetch;
export type Window = { since: string; until: string };
export type Log = (message: string) => void;

const APPVIEW = "https://public.api.bsky.app/xrpc";
// public.api.bsky.app answers an unauthenticated searchPosts with 403 and
// api.bsky.app did not, on 2026-10-18. Production searches through the
// droplet's authenticated /internal/bluesky-search instead; see SearchPosts.
const SEARCH_APPVIEW = "https://api.bsky.app/xrpc";
const UFOS = "https://ufos-api.microcosm.blue";
const ATURI_MCP = "https://aturi.to/api/mcp";
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Windows

/** The `days` days ending at `now`. What the demo recaps. */
export function lastDays(now: Date, days: number): Window {
  return { since: new Date(now.getTime() - days * DAY).toISOString(), until: now.toISOString() };
}

/** Monday 00:00 UTC to Monday 00:00 UTC, for the week before `now`'s week. */
export function previousWeek(now: Date): Window {
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return { since: new Date(monday.getTime() - 7 * DAY).toISOString(), until: monday.toISOString() };
}

export function inWindow(iso: string | undefined, window: Window): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at >= Date.parse(window.since) && at < Date.parse(window.until);
}

// ---------------------------------------------------------------------------
// HTTP

export class HttpError extends Error {
  readonly status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} from ${new URL(url).host}${new URL(url).pathname}`);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET JSON, retrying twice on 429 and 5xx. */
async function getJson<T>(fetchFn: Fetch, url: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 3 || (res.status !== 429 && res.status < 500)) throw new HttpError(url, res.status);
    await sleep(1000 * attempt);
  }
}

function xrpc(base: string, method: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(`${base}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Posts

/** The parts of an app.bsky.feed.defs#postView this file reads. */
export type PostView = {
  uri: string;
  author: { did: string; handle: string; displayName?: string; labels?: Array<{ val: string }> };
  record: {
    text?: string;
    createdAt?: string;
    langs?: string[];
    reply?: { parent?: { uri?: string } };
    facets?: Array<{ features?: Array<{ $type?: string; uri?: string }> }>;
  };
  embed?: EmbedView;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  labels?: Array<{ val: string }>;
};

type EmbedView = {
  $type?: string;
  images?: Array<{ alt?: string }>;
  alt?: string;
  external?: { uri?: string };
  record?: { uri?: string; record?: { uri?: string } };
  media?: EmbedView;
};

/** One post, trimmed to what the analysts and the writer use. */
export type DispatchPost = {
  uri: string;
  url: string;
  author: { did: string; handle: string; displayName?: string };
  createdAt: string;
  text: string;
  langs?: string[];
  replyTo?: string;
  quoted?: string;
  links: string[];
  imageAlts: string[];
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  /** Where it was found: list:<uri>, feed:<uri>, search:<query>, lexicon:<root>. */
  via: string[];
  /** The author carries the `!no-unauthenticated` self-label. Kept, but marked. */
  noUnauthenticated?: true;
};

function rkeyOf(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

function embedParts(embed: EmbedView | undefined): { links: string[]; alts: string[]; quoted?: string } {
  const links: string[] = [];
  const alts: string[] = [];
  let quoted: string | undefined;
  const visit = (e: EmbedView | undefined) => {
    if (!e) return;
    if (e.external?.uri) links.push(e.external.uri);
    for (const image of e.images ?? []) if (image.alt) alts.push(image.alt);
    if (e.$type === "app.bsky.embed.video#view" && e.alt) alts.push(e.alt);
    // record#view nests the quoted post at record; recordWithMedia#view one level deeper.
    const recordUri = e.record?.record?.uri ?? e.record?.uri;
    if (recordUri?.startsWith("at://")) quoted = recordUri;
    visit(e.media);
  };
  visit(embed);
  return { links, alts, quoted };
}

export function trimPost(view: PostView, via: string): DispatchPost {
  const facetLinks = (view.record.facets ?? [])
    .flatMap((facet) => facet.features ?? [])
    .filter((feature) => feature.$type === "app.bsky.richtext.facet#link" && feature.uri)
    .map((feature) => feature.uri as string);
  const embed = embedParts(view.embed);
  return {
    uri: view.uri,
    url: `https://bsky.app/profile/${view.author.handle}/post/${rkeyOf(view.uri)}`,
    author: { did: view.author.did, handle: view.author.handle, displayName: view.author.displayName || undefined },
    createdAt: view.record.createdAt ?? "",
    text: view.record.text ?? "",
    langs: view.record.langs,
    replyTo: view.record.reply?.parent?.uri,
    quoted: embed.quoted,
    links: [...new Set([...facetLinks, ...embed.links])],
    imageAlts: embed.alts,
    likes: view.likeCount ?? 0,
    reposts: view.repostCount ?? 0,
    replies: view.replyCount ?? 0,
    quotes: view.quoteCount ?? 0,
    via: [via],
    ...(view.author.labels?.some((label) => label.val === "!no-unauthenticated") ? { noUnauthenticated: true as const } : {}),
  };
}

/** Merge posts found by several sources into one entry per URI. */
export function dedupePosts(posts: DispatchPost[]): DispatchPost[] {
  const byUri = new Map<string, DispatchPost>();
  for (const post of posts) {
    const seen = byUri.get(post.uri);
    if (seen) seen.via = [...new Set([...seen.via, ...post.via])];
    else byUri.set(post.uri, { ...post, via: [...post.via] });
  }
  return [...byUri.values()];
}

/** Post labels that keep a post out of a public, logged-out page. */
export const EXCLUDED_POST_LABELS = new Set(["porn", "sexual", "nudity", "graphic-media", "gore"]);

export type PrivacyResult = {
  kept: PostView[];
  removed: { optOut: number; labeled: number };
};

/**
 * The only filter that removes records, applied before anything is stored so
 * no model ever sees what it removes: opt-outs, and posts with adult or
 * graphic labels.
 *
 * Authors with the `!no-unauthenticated` self-label stay in, by the operator's
 * decision on 2026-10-19 (the first demo week dropped 197 of their posts).
 * trimPost marks those posts, so treating them differently later is a change
 * to the writer, not to collection.
 */
export function privacyFilter(views: PostView[], optOuts: Iterable<string>): PrivacyResult {
  const blocked = new Set([...optOuts].map((id) => id.toLowerCase()));
  const removed = { optOut: 0, labeled: 0 };
  const kept = views.filter((view) => {
    if (blocked.has(view.author.did.toLowerCase()) || blocked.has(view.author.handle.toLowerCase())) {
      removed.optOut++;
      return false;
    }
    if (view.labels?.some((label) => EXCLUDED_POST_LABELS.has(label.val))) {
      removed.labeled++;
      return false;
    }
    return true;
  });
  return { kept, removed };
}

type FeedPage = { feed?: Array<{ post: PostView }>; cursor?: string };
type SearchPage = { posts?: PostView[]; cursor?: string };

/**
 * Page a feed or list feed back to the window start. List feeds are newest
 * first, so paging stops once a page reaches past `since`. Custom feeds can be
 * ranked rather than chronological, so they are read to `maxPages` and
 * filtered.
 */
export async function collectFeed(
  fetchFn: Fetch,
  kind: "feed" | "list",
  uri: string,
  window: Window,
  maxPages = 10,
): Promise<PostView[]> {
  const method = kind === "list" ? "app.bsky.feed.getListFeed" : "app.bsky.feed.getFeed";
  const out: PostView[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const body = await getJson<FeedPage>(fetchFn, xrpc(APPVIEW, method, { [kind]: uri, limit: 100, cursor }));
    const posts = (body.feed ?? []).map((item) => item.post);
    out.push(...posts.filter((post) => inWindow(post.record.createdAt, window)));
    const oldest = posts.at(-1)?.record.createdAt;
    if (!body.cursor || posts.length === 0) break;
    if (kind === "list" && oldest && Date.parse(oldest) < Date.parse(window.since)) break;
    cursor = body.cursor;
  }
  return out;
}

/** Search transport: the demo calls the AppView, production the droplet. */
export type SearchPosts = (query: string, sort: "top" | "latest", window: Window, cursor?: string) => Promise<SearchPage>;

/**
 * Unauthenticated search answered 403 to four queries fired at once and 200 to
 * the same queries one at a time (2026-10-18), so calls are spaced out and
 * collectWeek runs queries in sequence.
 */
export function appviewSearch(fetchFn: Fetch, spacingMs = 1500): SearchPosts {
  let last = 0;
  return async (query, sort, window, cursor) => {
    await sleep(Math.max(0, last + spacingMs - Date.now()));
    last = Date.now();
    return getJson<SearchPage>(fetchFn, xrpc(SEARCH_APPVIEW, "app.bsky.feed.searchPosts", {
      q: query, sort, since: window.since, until: window.until, limit: 100, cursor,
    }));
  };
}

/**
 * Both orderings: top finds the week's big posts, latest the long tail.
 *
 * A failed page keeps what earlier pages found. Unauthenticated search served
 * first pages but reset the connection on every cursor request (2026-10-18);
 * only a query that returns nothing at all counts as failed.
 */
export async function collectSearch(search: SearchPosts, query: string, window: Window, pagesPerSort = 2): Promise<PostView[]> {
  const out: PostView[] = [];
  let firstError: unknown;
  for (const sort of ["top", "latest"] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < pagesPerSort; page++) {
      let body: SearchPage;
      try {
        body = await search(query, sort, window, cursor);
      } catch (err) {
        firstError ??= err;
        break;
      }
      out.push(...(body.posts ?? []).filter((post) => inWindow(post.record.createdAt, window)));
      if (!body.cursor || !body.posts?.length) break;
      cursor = body.cursor;
    }
  }
  if (out.length === 0 && firstError) throw firstError;
  return out;
}

// ---------------------------------------------------------------------------
// Lexicons

type UfosCollection = { nsid: string; creates: number; updates: number; deletes: number; dids_estimate: number };
type UfosRecord = { did: string; collection: string; rkey: string; record: unknown; time_us: number };

export type LexiconRow = {
  nsid: string;
  accounts: number;
  creates: number;
  updates: number;
  deletes: number;
  explore: string;
};

export type NewLexicon = LexiconRow & {
  flags: string[];
  schema?: { published: boolean; authorityDid?: string; description?: string; note?: string };
  samples?: Array<{ uri: string; value: string }>;
};

export type Mover = { nsid: string; accountsBefore: number; accountsAfter: number; change: number; explore: string };

export type LexiconGroup = {
  root: string;
  count: number;
  /** How many of `count` carry the invalid-looking flag. */
  flagged: number;
  maxAccounts: number;
  creates: number;
  nsids: string[];
};

/**
 * New NSIDs grouped by their first two segments, which is usually one
 * project's domain (app.sonasky.*, dev.starhaven.*). Counted here because a
 * model counting rows in a long table miscounts: the first demo run reported
 * 12 new app.sonasky.apollo NSIDs where the table had 10. Flagged NSIDs are
 * counted too; leaving them out once turned 828 into 812.
 */
export function groupNewLexicons(lexicons: NewLexicon[]): LexiconGroup[] {
  const groups = new Map<string, LexiconGroup>();
  for (const lexicon of lexicons) {
    const root = lexicon.nsid.split(".").slice(0, 2).join(".");
    const group = groups.get(root) ?? { root, count: 0, flagged: 0, maxAccounts: 0, creates: 0, nsids: [] };
    group.count++;
    if (lexicon.flags.includes("invalid-looking")) group.flagged++;
    group.maxAccounts = Math.max(group.maxAccounts, lexicon.accounts);
    group.creates += lexicon.creates;
    group.nsids.push(lexicon.nsid);
    groups.set(root, group);
  }
  return [...groups.values()]
    .filter((g) => g.count >= 2 || g.maxAccounts >= 3)
    .sort((a, b) => b.maxAccounts - a.maxAccounts || b.count - a.count);
}

export type LexiconReport = {
  window: Window;
  source: string;
  totals: { activeThisWindow: number; seenBefore: number; newThisWindow: number; newWithThreePlusAccounts: number; newSingleAccount: number };
  newByProject: LexiconGroup[];
  newLexicons: NewLexicon[];
  movers: { up: Mover[]; down: Mover[] };
  topOutsideBluesky: LexiconRow[];
  publishedSchemas: Array<{ nsid: string; did: string; at: string }>;
  /** Posts about the apps behind the notable lexicons; filled by collectLexiconTalk. */
  talk: LexiconTalk[];
  /** Whether each notable project has a website to visit; filled by checkSites. */
  sites?: SiteCheck[];
  notes: string[];
};

export type SiteVerdict = "verified" | "likely" | "unverified" | "parked" | "unreachable";

export type SiteCheck = {
  root: string;
  host: string;
  url: string;
  verdict: SiteVerdict;
  why: string;
  title?: string;
  description?: string;
  finalHost?: string;
  handleDid?: string;
  lexiconAuthority?: string;
};

/** Verdicts the writer may link. The rest are recorded but never linked. */
export const LINKABLE_SITES: ReadonlySet<SiteVerdict> = new Set(["verified", "likely"]);

export type LexiconTalk = { root: string; domain: string; why: string; posts: string[]; notes: string[] };

const BLUESKY_PREFIXES = ["app.bsky.", "chat.bsky.", "com.atproto.", "tools.ozone."];
const explore = (nsid: string) => `https://aturi.to/explore/lexicons/${nsid}`;

/**
 * A heuristic flag, never a filter: odd-looking NSIDs are mostly tests and
 * fuzzing. Follows the NSID syntax where it matters here: the first segment and
 * the final name start with a letter, but the domain segments between them may
 * start with a digit (store.lexicon.app.2ndscreen.log is valid). "--" is not
 * banned by the spec; it is flagged because the fuzzing names repeat it.
 */
export function looksLikeNsid(nsid: string): boolean {
  const segments = nsid.split(".");
  const name = segments.at(-1) ?? "";
  return segments.length >= 3 && nsid.length <= 317 && !nsid.includes("--") &&
    /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(segments[0]) &&
    segments.slice(1, -1).every((segment) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(segment)) &&
    /^[a-zA-Z][a-zA-Z0-9]{0,62}$/.test(name);
}

async function ufosCollections(fetchFn: Fetch, range: { since?: string; until?: string }): Promise<UfosCollection[]> {
  const out: UfosCollection[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3000; page++) {
    const url = new URL(`${UFOS}/collections`);
    url.searchParams.set("limit", "100");
    if (range.since) url.searchParams.set("since", range.since);
    if (range.until) url.searchParams.set("until", range.until);
    if (cursor) url.searchParams.set("cursor", cursor);
    const body = await getJson<{ collections: UfosCollection[]; cursor?: string }>(fetchFn, url.toString());
    out.push(...body.collections);
    if (!body.cursor || body.collections.length === 0) break;
    cursor = body.cursor;
  }
  return out;
}

const row = (c: UfosCollection): LexiconRow => ({
  nsid: c.nsid, accounts: c.dids_estimate, creates: c.creates, updates: c.updates, deletes: c.deletes, explore: explore(c.nsid),
});

/** Call one of Aturi's MCP tools over plain JSON-RPC and return its structured result. */
export async function aturiTool(fetchFn: Fetch, name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const res = await fetchFn(ATURI_MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const text = await res.text();
  // Streamable HTTP answers as server-sent events; plain JSON is accepted too.
  const payload = text.trim().startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!payload) return null;
  const message = JSON.parse(payload) as { result?: { structuredContent?: Record<string, unknown> } };
  return message.result?.structuredContent ?? null;
}

/**
 * New NSIDs, movers and the largest lexicons outside Bluesky's own, from
 * microcosm's UFOs index. Production reads the same report from Aturi once it
 * has the endpoint (agent-spec/12-weekly-dispatch.md, "Lexicon data in Aturi").
 *
 * "New" means not seen by UFOs before the window started, so it is only as
 * complete as UFOs' history. Account counts are HyperLogLog estimates.
 */
export async function collectLexicons(fetchFn: Fetch, window: Window, log: Log = () => {}): Promise<LexiconReport> {
  const previous = { since: new Date(Date.parse(window.since) - 7 * DAY).toISOString(), until: window.since };
  log("lexicons: reading UFOs (this window, the week before, and all earlier history)");
  const [current, before, history] = await Promise.all([
    ufosCollections(fetchFn, window),
    ufosCollections(fetchFn, previous),
    ufosCollections(fetchFn, { until: window.since }),
  ]);
  const seen = new Set(history.map((c) => c.nsid));
  const beforeByNsid = new Map(before.map((c) => [c.nsid, c]));

  const fresh: NewLexicon[] = current
    .filter((c) => !seen.has(c.nsid))
    .map((c) => ({
      ...row(c),
      flags: [
        ...(looksLikeNsid(c.nsid) ? [] : ["invalid-looking"]),
        ...(c.dids_estimate <= 1 ? ["single-account"] : []),
      ],
    }))
    .sort((a, b) => b.accounts - a.accounts || b.creates - a.creates);

  // Look closer at the new ones that more than a couple of accounts use.
  const notable = fresh.filter((n) => n.accounts >= 3 && !n.flags.includes("invalid-looking")).slice(0, 40);
  log(`lexicons: ${fresh.length} new, checking schemas and samples for ${notable.length}`);
  await Promise.all(notable.map(async (lexicon) => {
    const schema = await aturiTool(fetchFn, "get_lexicon_schema", { nsid: lexicon.nsid }).catch(() => null);
    if (schema) {
      const value = schema.value as { defs?: { main?: { description?: string } } } | undefined;
      lexicon.schema = schema.ok
        ? { published: true, authorityDid: schema.authorityDid as string, description: value?.defs?.main?.description }
        : { published: false, note: String(schema.error ?? schema.code ?? "not found") };
    }
    const records = await getJson<UfosRecord[]>(fetchFn, `${UFOS}/records?collection=${encodeURIComponent(lexicon.nsid)}`).catch(() => []);
    lexicon.samples = records.slice(0, 3).map((r) => ({
      uri: `at://${r.did}/${r.collection}/${r.rkey}`,
      value: JSON.stringify(r.record).slice(0, 1200),
    }));
  }));

  const outsideBluesky = (nsid: string) => !BLUESKY_PREFIXES.some((prefix) => nsid.startsWith(prefix));
  const movers: Mover[] = current
    .filter((c) => outsideBluesky(c.nsid))
    .map((c) => {
      const accountsBefore = beforeByNsid.get(c.nsid)?.dids_estimate ?? 0;
      return { nsid: c.nsid, accountsBefore, accountsAfter: c.dids_estimate, change: c.dids_estimate - accountsBefore, explore: explore(c.nsid) };
    })
    .filter((m) => Math.max(m.accountsBefore, m.accountsAfter) >= 50 && m.accountsBefore > 0);
  const byRatio = (m: Mover) => m.accountsAfter / m.accountsBefore;

  const schemaRecords = await getJson<UfosRecord[]>(fetchFn, `${UFOS}/records?collection=com.atproto.lexicon.schema`).catch(() => []);

  return {
    window,
    source: "ufos-api.microcosm.blue, with schema lookups from Aturi",
    totals: {
      activeThisWindow: current.length,
      seenBefore: seen.size,
      newThisWindow: fresh.length,
      newWithThreePlusAccounts: fresh.filter((n) => n.accounts >= 3).length,
      newSingleAccount: fresh.filter((n) => n.accounts <= 1).length,
    },
    newByProject: groupNewLexicons(fresh),
    newLexicons: fresh,
    movers: {
      up: [...movers].filter((m) => m.change > 0).sort((a, b) => byRatio(b) - byRatio(a)).slice(0, 25),
      down: [...movers].filter((m) => m.change < 0).sort((a, b) => byRatio(a) - byRatio(b)).slice(0, 15),
    },
    topOutsideBluesky: current.filter((c) => outsideBluesky(c.nsid))
      .sort((a, b) => b.dids_estimate - a.dids_estimate).slice(0, 40).map(row),
    publishedSchemas: schemaRecords
      .filter((r) => inWindow(new Date(r.time_us / 1000).toISOString(), window))
      .map((r) => ({ nsid: r.rkey, did: r.did, at: new Date(r.time_us / 1000).toISOString() })),
    talk: [],
    notes: [
      "Account counts are HyperLogLog estimates; write them as approximate.",
      "Movers compare this window with the 7 days before it, for lexicons outside Bluesky's own namespaces with at least 50 accounts in one of the two.",
      "publishedSchemas comes from UFOs' recent-records sample, so it is a sample, not every schema published in the window.",
    ],
  };
}

/** The domain an NSID's first two segments name: so.sprk is sprk.so. */
export function domainFor(nsid: string): string {
  return nsid.split(".").slice(0, 2).reverse().join(".");
}

/**
 * The projects worth asking about: the biggest movers each way, then new
 * projects that more than a couple of accounts use. One entry per domain.
 */
export function talkTargets(report: LexiconReport, max = 15): Array<{ root: string; why: string }> {
  const rootOf = (nsid: string) => nsid.split(".").slice(0, 2).join(".");
  const out = new Map<string, string>();
  const add = (root: string, why: string) => {
    if (out.size < max && !out.has(root) && !BLUESKY_PREFIXES.some((prefix) => `${root}.`.startsWith(prefix))) out.set(root, why);
  };
  for (const m of report.movers.up.slice(0, 8)) add(rootOf(m.nsid), `${m.nsid} up from about ${m.accountsBefore} to about ${m.accountsAfter} accounts`);
  for (const m of report.movers.down.slice(0, 3)) add(rootOf(m.nsid), `${m.nsid} down from about ${m.accountsBefore} to about ${m.accountsAfter} accounts`);
  for (const g of report.newByProject.filter((g) => g.maxAccounts >= 3)) add(g.root, `${g.count} new NSIDs, up to about ${g.maxAccounts} accounts`);
  return [...out].map(([root, why]) => ({ root, why }));
}

/**
 * What people said about the apps behind the week's notable lexicons, so a
 * jump in the numbers can sit next to the app's own announcement. Two reads
 * per project: the posts of the account at the app's domain (most apps post
 * from one, like sonasky.app), and a search for the domain, which finds links
 * and mentions.
 *
 * Search by author or domain needs authentication; unauthenticated search
 * rejected `from:`, `author` without a query word, and `domain` on 2026-10-19,
 * so the author's posts come from getAuthorFeed instead.
 */
export async function collectLexiconTalk(
  fetchFn: Fetch,
  search: SearchPosts,
  report: LexiconReport,
  window: Window,
  log: Log = () => {},
): Promise<{ talk: LexiconTalk[]; found: Array<{ view: PostView; via: string }> }> {
  const talk: LexiconTalk[] = [];
  const found: Array<{ view: PostView; via: string }> = [];
  for (const { root, why } of talkTargets(report)) {
    const domain = domainFor(root);
    const via = `lexicon:${root}`;
    const notes: string[] = [];
    const views: PostView[] = [];
    try {
      const body = await getJson<{ feed?: Array<{ post: PostView; reason?: unknown }> }>(fetchFn,
        xrpc(APPVIEW, "app.bsky.feed.getAuthorFeed", { actor: domain, limit: 100, filter: "posts_no_replies" }));
      views.push(...(body.feed ?? []).filter((item) => !item.reason && inWindow(item.post.record.createdAt, window)).map((item) => item.post));
    } catch {
      notes.push(`no account at ${domain}`);
    }
    try {
      views.push(...await collectSearch(search, domain, window, 1));
    } catch (err) {
      notes.push(`search for ${domain} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The most-engaged 20, so one busy domain cannot crowd out the rest.
    const unique = [...new Map(views.map((view) => [view.uri, view])).values()]
      .sort((a, b) => (b.likeCount ?? 0) + (b.repostCount ?? 0) - (a.likeCount ?? 0) - (a.repostCount ?? 0))
      .slice(0, 20);
    found.push(...unique.map((view) => ({ view, via })));
    talk.push({ root, domain, why, posts: unique.map((view) => view.uri), notes });
    log(`${via}: ${unique.length} posts${notes.length ? ` (${notes.join("; ")})` : ""}`);
  }
  return { talk, found };
}

// ---------------------------------------------------------------------------
// App sites

/** An NSID's authority domain, where its _lexicon record lives: app.bsky.actor.link is actor.bsky.app. */
export function nsidAuthority(nsid: string): string {
  return nsid.split(".").slice(0, -1).reverse().join(".");
}

const PARKED = /(this domain|domain) (is |may be )?for sale|buy this domain|domain parking|parked (free|domain)|hugedomains|afternic|sedo\.com|dan\.com/i;
// Not "atmosphere": it matches weather sites as readily as the network.
const ATPROTO = /atproto|at protocol|bluesky|bsky\.(app|social)/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) =>
    code[0] === "#" ? String.fromCodePoint(Number(code[1] === "x" || code[1] === "X" ? `0${code.slice(1)}` : code.slice(1)))
      : ENTITIES[code.toLowerCase()] ?? whole);
}

type Probe = { status?: number; finalHost?: string; title?: string; description?: string; body?: string; error?: string };

/**
 * Whether a project's site can be linked. A site that loads is not enough: a
 * domain can be parked, for sale, or unrelated to whoever minted records
 * under its name. Linking needs a sign that the lexicon's owner controls it.
 *
 * verified: the domain is an atproto handle whose DID is the lexicon's DNS
 *   authority, or writes the lexicon's records.
 * likely: the site loads, is not parked, and is a handle or talks about
 *   atproto or Bluesky.
 */
export function judgeSite(probe: Probe, evidence: { handleDid?: string; lexiconAuthority?: string; writers: Set<string> }): { verdict: SiteVerdict; why: string } {
  if (probe.error || !probe.status || probe.status >= 400) return { verdict: "unreachable", why: probe.error ?? `HTTP ${probe.status}` };
  const text = `${probe.title ?? ""} ${probe.description ?? ""} ${probe.body ?? ""}`;
  if (PARKED.test(text)) return { verdict: "parked", why: "looks parked or for sale" };
  const { handleDid, lexiconAuthority, writers } = evidence;
  if (handleDid && handleDid === lexiconAuthority) return { verdict: "verified", why: "the domain's handle is the lexicon's DNS authority" };
  if (handleDid && writers.has(handleDid)) return { verdict: "verified", why: "the domain's handle writes these records" };
  if (handleDid) return { verdict: "likely", why: "the domain is an atproto handle" };
  if (ATPROTO.test(text)) return { verdict: "likely", why: "the site talks about atproto or Bluesky" };
  return { verdict: "unverified", why: "loads, but nothing ties it to the lexicon's owner" };
}

async function probeSite(fetchFn: Fetch, host: string): Promise<Probe> {
  try {
    const res = await fetchFn(`https://${host}/`, {
      redirect: "follow",
      headers: { "user-agent": "atpotato-dispatch (+https://atpota.to)", accept: "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.text()).slice(0, 50_000);
    const meta = (name: string) => body.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)`, "i"))?.[1];
    return {
      status: res.status,
      finalHost: new URL(res.url).host,
      title: decodeEntities(body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim().slice(0, 120) || undefined,
      description: decodeEntities(meta("description") ?? meta("og:description") ?? "").trim().slice(0, 240) || undefined,
      body: body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").slice(0, 20_000),
    };
  } catch (err) {
    return { error: String((err as { cause?: { code?: string } }).cause?.code ?? (err instanceof Error ? err.message : err)).slice(0, 80) };
  }
}

/** A handle's DID, or undefined when the host is not a handle. */
async function handleDid(fetchFn: Fetch, host: string): Promise<string | undefined> {
  const body = await getJson<{ did?: string }>(fetchFn, xrpc(APPVIEW, "com.atproto.identity.resolveHandle", { handle: host })).catch(() => null);
  return body?.did;
}

/**
 * The DID in an authority's _lexicon TXT record, over DNS-over-HTTPS. Plain
 * TXT lookups returned nothing in the demo container even for records that
 * exist (2026-10-19), so this does not depend on the host's resolver.
 */
async function lexiconAuthorityDid(fetchFn: Fetch, authority: string): Promise<string | undefined> {
  const body = await getJson<{ Answer?: Array<{ data?: string }> }>(fetchFn,
    `https://cloudflare-dns.com/dns-query?name=_lexicon.${encodeURIComponent(authority)}&type=TXT`).catch(() => null);
  for (const answer of body?.Answer ?? []) {
    const did = answer.data?.match(/did=(did:[a-z]+:[^\s"]+)/)?.[1];
    if (did) return did;
  }
  return undefined;
}

/**
 * Check a site for each notable project, so the issue can link the app and a
 * reader can see whether it exists. Tries the project's domain (so.sprk is
 * sprk.so) and, when the busiest NSID has a longer authority, that too
 * (app.sonasky.apollo.page is apollo.sonasky.app).
 */
export async function checkSites(fetchFn: Fetch, report: LexiconReport, log: Log = () => {}, max = 30): Promise<SiteCheck[]> {
  const rootOf = (nsid: string) => nsid.split(".").slice(0, 2).join(".");
  const roots = [...new Set([
    ...talkTargets(report).map((t) => t.root),
    ...report.newByProject.filter((g) => g.maxAccounts >= 3).map((g) => g.root),
    ...report.topOutsideBluesky.slice(0, 15).map((r) => rootOf(r.nsid)),
  ])].filter((root) => !BLUESKY_PREFIXES.some((prefix) => `${root}.`.startsWith(prefix))).slice(0, max);

  const nsidsOf = (root: string) => [
    ...report.newLexicons.filter((n) => n.nsid.startsWith(`${root}.`)).map((n) => ({ nsid: n.nsid, accounts: n.accounts })),
    ...report.topOutsideBluesky.filter((r) => r.nsid.startsWith(`${root}.`)).map((r) => ({ nsid: r.nsid, accounts: r.accounts })),
    ...[...report.movers.up, ...report.movers.down].filter((m) => m.nsid.startsWith(`${root}.`)).map((m) => ({ nsid: m.nsid, accounts: m.accountsAfter })),
  ].sort((a, b) => b.accounts - a.accounts);

  const checks: SiteCheck[] = [];
  for (let i = 0; i < roots.length; i += 5) {
    await Promise.all(roots.slice(i, i + 5).map(async (root) => {
      const busiest = nsidsOf(root)[0]?.nsid;
      const writers = new Set(report.newLexicons.filter((n) => n.nsid.startsWith(`${root}.`))
        .flatMap((n) => (n.samples ?? []).map((s) => s.uri.split("/")[2])));
      const authority = busiest ? nsidAuthority(busiest) : domainFor(root);
      const lexiconAuthority = await lexiconAuthorityDid(fetchFn, authority);
      // The project's own domain first: it is the one likely to be a handle.
      const hosts = [...new Set([domainFor(root), authority])].filter((host) => host.split(".").length >= 2);
      const seenFinal = new Set<string>();
      for (const host of hosts) {
        const [probe, did] = await Promise.all([probeSite(fetchFn, host), handleDid(fetchFn, host)]);
        // mod.starhaven.dev redirects to starhaven.dev: one site, checked once.
        if (probe.finalHost && seenFinal.has(probe.finalHost)) continue;
        if (probe.finalHost) seenFinal.add(probe.finalHost);
        const { verdict, why } = judgeSite(probe, { handleDid: did, lexiconAuthority, writers });
        if (verdict === "unreachable" && host !== domainFor(root)) continue;
        checks.push({ root, host, url: `https://${host}`, verdict, why, title: probe.title, description: probe.description,
          finalHost: probe.finalHost, handleDid: did, lexiconAuthority });
      }
    }));
  }
  log(`sites: ${checks.filter((c) => LINKABLE_SITES.has(c.verdict)).length} linkable of ${checks.length} checked`);
  return checks.sort((a, b) => roots.indexOf(a.root) - roots.indexOf(b.root));
}

// ---------------------------------------------------------------------------
// Releases

export type Release = { repo: string; tag: string; name: string; url: string; publishedAt: string; notes: string };
export type ReleaseResult = { repo: string; ok: boolean; error?: string; releases: Release[] };

export async function collectReleases(fetchFn: Fetch, repo: string, window: Window): Promise<ReleaseResult> {
  try {
    const items = await getJson<Array<{ tag_name: string; name?: string; html_url: string; published_at?: string; body?: string; draft?: boolean }>>(
      fetchFn, `https://api.github.com/repos/${repo}/releases?per_page=30`);
    return {
      repo,
      ok: true,
      releases: items
        .filter((r) => !r.draft && inWindow(r.published_at, window))
        .map((r) => ({ repo, tag: r.tag_name, name: r.name || r.tag_name, url: r.html_url, publishedAt: r.published_at ?? "", notes: (r.body ?? "").slice(0, 2000) })),
    };
  } catch (err) {
    return { repo, ok: false, error: String(err instanceof Error ? err.message : err), releases: [] };
  }
}

// ---------------------------------------------------------------------------
// The whole week

export type DispatchDataset = {
  manifest: {
    window: Window;
    collectedAt: string;
    sources: { lists: string[]; feeds: string[]; queries: string[]; repos: string[] };
    counts: Record<string, number>;
    privacy: PrivacyResult["removed"];
    notes: string[];
  };
  posts: DispatchPost[];
  lexicons: LexiconReport | null;
  releases: ReleaseResult[];
};

export async function collectWeek(
  fetchFn: Fetch,
  sources: { lists: string[]; feeds: string[]; queries: string[]; repos: string[]; optOuts: string[] },
  window: Window,
  options: { search?: SearchPosts; log?: Log } = {},
): Promise<DispatchDataset> {
  const log = options.log ?? (() => {});
  const search = options.search ?? appviewSearch(fetchFn);
  const notes: string[] = [];
  const found: Array<{ view: PostView; via: string }> = [];
  const counts: Record<string, number> = {};

  const gather = async (label: string, run: () => Promise<PostView[]>) => {
    try {
      const views = await run();
      counts[label] = views.length;
      found.push(...views.map((view) => ({ view, via: label })));
      log(`${label}: ${views.length} posts`);
    } catch (err) {
      notes.push(`${label} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      log(`${label}: failed`);
    }
  };

  const [lexicons, releases] = await Promise.all([
    collectLexicons(fetchFn, window, log).catch((err) => {
      notes.push(`lexicons unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
    Promise.all(sources.repos.map((repo) => collectReleases(fetchFn, repo, window))),
    Promise.all([
      ...sources.lists.map((uri) => gather(`list:${uri}`, () => collectFeed(fetchFn, "list", uri, window, 30))),
      ...sources.feeds.map((uri) => gather(`feed:${uri}`, () => collectFeed(fetchFn, "feed", uri, window))),
      (async () => {
        for (const query of sources.queries) await gather(`search:${query}`, () => collectSearch(search, query, window));
      })(),
    ]),
  ]);
  for (const result of releases) if (!result.ok) notes.push(`releases for ${result.repo} unavailable: ${result.error}`);

  // After the lexicon report, because it decides which apps to ask about.
  if (lexicons) {
    const { talk, found: talkPosts } = await collectLexiconTalk(fetchFn, search, lexicons, window, log);
    lexicons.talk = talk;
    found.push(...talkPosts);
    counts.lexiconTalk = talkPosts.length;
    lexicons.sites = await checkSites(fetchFn, lexicons, log);
  }

  const unique = [...new Map(found.map((f) => [f.view.uri, f.view])).values()];
  const privacy = privacyFilter(unique, sources.optOuts);
  const keptUris = new Set(privacy.kept.map((view) => view.uri));
  const posts = dedupePosts(found.filter((f) => keptUris.has(f.view.uri)).map((f) => trimPost(f.view, f.via)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  counts.uniquePosts = posts.length;
  counts.noUnauthenticatedKept = posts.filter((p) => p.noUnauthenticated).length;

  return {
    manifest: {
      window,
      collectedAt: new Date().toISOString(),
      sources: { lists: sources.lists, feeds: sources.feeds, queries: sources.queries, repos: sources.repos },
      counts,
      privacy: privacy.removed,
      notes,
    },
    posts,
    lexicons,
    releases,
  };
}
