import { defineTool } from "eve/tools";
import { z } from "zod";

const text = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0);
const identifier = text(300).regex(/^(?:did:(?:plc|web):[^\s/?#]+|[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+)$/);
const atUri = text(2048).regex(/^at:\/\/[^\s/?#]+\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9._~-]+$/);
const url = text(2048).url().refine((value) => {
  const parsed = new URL(value);
  return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
});
const domain = text(253).regex(/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+$/);
const hashtag = text(640).refine((value) => !value.startsWith("#") &&
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length <= 64);
const language = text(35).regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/);
const date = text(40).refine((value) => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2})))?$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, tzHour, tzMinute] = parts;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day));
  return calendar.getUTCFullYear() === +year && calendar.getUTCMonth() === +month - 1 &&
    calendar.getUTCDate() === +day && (hour === undefined || (+hour < 24 && +minute < 60 && +second < 60 &&
      (tzHour === undefined || (+tzHour <= 23 && +tzMinute < 60)))) && !Number.isNaN(Date.parse(value));
});
const group = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(5).optional();

const inputSchema = z.strictObject({
  query: text(300).optional(),
  sort: z.enum(["recent", "top"]).optional(),
  authors: group(identifier), mentions: group(identifier), domains: group(domain),
  urls: group(url), embeddedAtUris: group(atUri), hashtags: group(hashtag),
  excludeAuthors: group(identifier), excludeMentions: group(identifier), excludeDomains: group(domain),
  excludeUrls: group(url), excludeEmbeddedAtUris: group(atUri), excludeHashtags: group(hashtag),
  since: date.optional(), until: date.optional(), allTime: z.boolean().optional(),
  languages: group(language), excludeLanguages: group(language),
  hasMedia: z.boolean().optional(), hasVideo: z.boolean().optional(),
  replyParentUri: atUri.optional(), threadRootUri: atUri.optional(),
  excludeReplies: z.boolean().optional(), repliesOnly: z.boolean().optional(),
  following: z.boolean().optional(), queryLanguage: z.enum(["ja", "zh", "ko", "th", "ar"]).optional(),
  cursor: text(2048).optional(), limit: z.number().int().min(1).max(25).default(10),
}).superRefine((input, ctx) => {
  if (input.excludeReplies && input.repliesOnly)
    ctx.addIssue({ code: "custom", message: "excludeReplies and repliesOnly are mutually exclusive" });
  const filters = [input.authors, input.mentions, input.domains, input.urls, input.embeddedAtUris,
    input.hashtags, input.excludeAuthors, input.excludeMentions, input.excludeDomains,
    input.excludeUrls, input.excludeEmbeddedAtUris, input.excludeHashtags,
    input.since, input.until, input.languages, input.excludeLanguages, input.replyParentUri,
    input.threadRootUri, input.hasMedia, input.hasVideo, input.excludeReplies,
    input.repliesOnly, input.following];
  if (!input.query && !filters.some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)))
    ctx.addIssue({ code: "custom", message: "A query or substantive filter is required" });
});

type Caller = { authenticator?: string; principalType?: string; principalId?: string;
  attributes?: Readonly<Record<string, string | readonly string[]>> } | null | undefined;
type Address = { sessionId: string; postUri: string; attempt: number } | { sessionId: string };

function callerAddress(ctx: { session: { id: string; auth: { initiator?: Caller; current?: Caller } } }): Address {
  const callers = [ctx.session.auth.initiator, ctx.session.auth.current];
  const sessionId = ctx.session.id;
  if (typeof sessionId !== "string" || !sessionId.trim())
    throw new Error("search_bluesky_posts requires an authenticated caller");
  for (const caller of callers) {
    if (caller?.authenticator === "atpotato-droplet-scan-approval")
      throw new Error("search_bluesky_posts requires an authenticated caller");
    if (caller?.authenticator === "atpotato-droplet") {
      const postUri = caller.attributes?.postUri;
      const rawAttempt = caller.attributes?.attempt;
      const attempt = typeof rawAttempt === "string" ? Number(rawAttempt) : NaN;
      if (caller.principalType === "user" &&
          typeof caller.principalId === "string" && /^did:(plc|web):[^\s/]+$/.test(caller.principalId) &&
          caller.attributes?.did === caller.principalId && typeof postUri === "string" &&
          /^at:\/\/did:(plc|web):[^\s/]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._~-]+$/.test(postUri) &&
          postUri.startsWith(`at://${caller.principalId}/app.bsky.feed.post/`) &&
          Number.isSafeInteger(attempt) && attempt > 0) {
        return { sessionId, postUri, attempt };
      }
      throw new Error("search_bluesky_posts requires an authenticated caller");
    }
    if (caller?.authenticator === "atpotato-droplet-dm") {
      const dmId = caller.attributes?.dmId;
      if (caller.principalType === "user" && typeof caller.principalId === "string" &&
          /^did:(plc|web):[^\s/]+$/.test(caller.principalId) &&
          caller.attributes?.operatorDid === caller.principalId &&
          typeof dmId === "string" && dmId.length > 0 && dmId.length <= 300)
        return { sessionId };
      throw new Error("search_bluesky_posts requires an authenticated caller");
    }
  }
  for (const caller of callers) {
    if (caller?.authenticator === "oidc" &&
        (caller.principalType === "user" || caller.principalType === "runtime") &&
        typeof caller.principalId === "string" && caller.principalId.trim())
      return { sessionId };
    if (caller?.authenticator === "local-dev" &&
        typeof caller.principalId === "string" && caller.principalId.trim() &&
        (process.env.EVE_DEV === "1" ||
          (process.env.VERCEL === "1" && process.env.VERCEL_ENV === "development")))
      return { sessionId };
  }
  throw new Error("search_bluesky_posts requires an authenticated caller");
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Invalid Bluesky search response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new Error("Bluesky search response exceeds 256 KiB");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new Error("Invalid Bluesky search response"); }
}

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

const post = z.object({ uri: atUri }).passthrough();
const pageSchema = z.object({
  ok: z.literal(true), posts: z.array(post), cursor: text(2048).nullish(),
  hitsTotal: z.number().int().nonnegative().nullish(),
  detectedQueryLanguages: z.array(z.enum(["ja", "zh", "ko", "th", "ar"])).max(5).optional(),
});

export default defineTool({
  description: "Search one page of Bluesky posts with app.bsky.feed.searchPostsV2 filters. " +
    "Requires a query or substantive filter; defaults to 10 results, at most 25. " +
    "Runs through the authenticated droplet search callback for signed posts, operator DMs, or website sessions. " +
    "A cursor requests another page but does not guarantee the entire index can be paged; " +
    "hitsTotal is an estimate, not a completeness claim. Stop on 429 and honor retryAfter.",
  inputSchema,
  async execute(input, ctx) {
    const address = callerAddress(ctx);
    const params = inputSchema.parse(input);
    const callback = process.env.DROPLET_CALLBACK_URL;
    const secret = process.env.DROPLET_SHARED_SECRET;
    if (!callback || !secret) throw new Error("Bluesky search callback not configured");
    const url = new URL("/internal/bluesky-search", callback);
    if (url.protocol !== "https:") throw new Error("Bluesky search callback must use HTTPS");
    const response = await fetch(url, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify({ ...address, ...params }), signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 409) throw new Error("Bluesky search quota exhausted for this dispatch or session");
    if (response.status === 429) {
      let retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
      try {
        const body = await boundedJson(response);
        if (body && typeof body === "object" && "retryAfter" in body &&
            typeof body.retryAfter === "number" && Number.isSafeInteger(body.retryAfter) && body.retryAfter >= 0)
          retryAfter = body.retryAfter;
      } catch { /* A 429 without a JSON body still stops this search. */ }
      return { posts: [], cursor: params.cursor ?? null, retryAfter, stopped: "rate_limited" };
    }
    if (response.status !== 200) throw new Error(`Bluesky search callback returned HTTP ${response.status}`);
    const page = pageSchema.safeParse(await boundedJson(response));
    if (!page.success || page.data.posts.length > params.limit ||
        (page.data.cursor && page.data.cursor === params.cursor))
      throw new Error("Invalid Bluesky search response");
    return { posts: page.data.posts, cursor: page.data.cursor ?? null,
      hitsTotal: page.data.hitsTotal ?? null,
      ...(page.data.detectedQueryLanguages ? { detectedQueryLanguages: page.data.detectedQueryLanguages } : {}) };
  },
});
