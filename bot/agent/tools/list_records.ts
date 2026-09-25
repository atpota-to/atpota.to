import { defineTool } from "eve/tools";
import { z } from "zod";

const MAX_PAGE_BYTES = 64 * 1024;
const inputSchema = z.object({
  identifier: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:_-]+$/),
  collection: z.string().min(3).max(512).regex(/^[a-zA-Z0-9.-]+$/),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  reverse: z.boolean().default(false),
});
type Input = z.infer<typeof inputSchema>;
type Caller = { authenticator?: string; principalType?: string; principalId?: string;
  attributes?: Readonly<Record<string, string | readonly string[]>> } | null | undefined;
type Address = { sessionId: string; postUri: string; attempt: number } | { sessionId: string };
type RecordEntry = { uri: string; value: Record<string, unknown> };

function callerAddress(ctx: { session: { id: string; auth: { initiator?: Caller; current?: Caller } } }): Address {
  const callers = [ctx.session.auth.initiator, ctx.session.auth.current];
  const sessionId = ctx.session.id;
  if (typeof sessionId !== "string" || !sessionId.trim())
    throw new Error("list_records requires an authenticated caller");
  for (const caller of callers) {
    if (caller?.authenticator === "atpotato-droplet-scan-approval")
      throw new Error("list_records requires an authenticated caller");
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
      throw new Error("list_records requires an authenticated caller");
    }
    if (caller?.authenticator === "atpotato-droplet-dm") {
      const dmId = caller.attributes?.dmId;
      if (caller.principalType === "user" && typeof caller.principalId === "string" &&
          /^did:(plc|web):[^\s/]+$/.test(caller.principalId) &&
          caller.attributes?.operatorDid === caller.principalId &&
          typeof dmId === "string" && dmId.length > 0 && dmId.length <= 300)
        return { sessionId };
      throw new Error("list_records requires an authenticated caller");
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
  throw new Error("list_records requires an authenticated caller");
}

async function claimBudget(address: Address, limit: number) {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) throw new Error("list_records budget callback not configured");
  const url = new URL("/internal/list-records-budget/claim", callback);
  if (url.protocol !== "https:") throw new Error("list_records budget callback must use HTTPS");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-atpotato-secret": secret },
    body: JSON.stringify({ ...address, limit }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 409) throw new Error("list_records budget exhausted for this dispatch or session");
  if (response.status !== 200 || (await response.json() as { ok?: unknown }).ok !== true)
    throw new Error("list_records budget claim not accepted");
}

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

async function fetchPage(input: Input): Promise<{ records: RecordEntry[]; cursor: string | null; retryAfter: number | null; rateLimited: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("https://aturi.to/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "list_records", arguments: { identifier: input.identifier, collection: input.collection,
          limit: input.limit, reverse: input.reverse, ...(input.cursor ? { cursor: input.cursor } : {}) },
      } }),
      signal: controller.signal,
    });
    if (response.status === 429) return { records: [], cursor: input.cursor ?? null,
      retryAfter: retryAfterSeconds(response.headers.get("retry-after")), rateLimited: true };
    if (!response.ok || !response.body) throw new Error(`Aturi returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_PAGE_BYTES) {
          controller.abort();
          throw new Error("Aturi response exceeds 64 KiB; try a smaller limit");
        }
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    let payload: unknown;
    try {
      payload = response.headers.get("content-type")?.includes("text/event-stream")
        ? text.split(/\r?\n/).filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as unknown).find((event) =>
            typeof event === "object" && event !== null && "result" in event)
        : JSON.parse(text) as unknown;
    } catch { throw new Error("Invalid Aturi MCP response"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("result" in payload))
      throw new Error("Invalid Aturi MCP response");
    const result = payload.result;
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        (result as { isError?: unknown }).isError === true)
      throw new Error("Aturi list_records failed");
    const content = (result as { structuredContent?: unknown }).structuredContent;
    if (!content || typeof content !== "object" || Array.isArray(content))
      throw new Error("Invalid Aturi list_records page");
    const page = content as { ok?: unknown; records?: unknown; cursor?: unknown };
    if (page.ok !== true || !Array.isArray(page.records) || page.records.length > input.limit ||
        (page.cursor !== undefined && (typeof page.cursor !== "string" || !page.cursor || page.cursor.length > 512)))
      throw new Error("Invalid Aturi list_records page");
    if (page.records.some((record) => !record || typeof record !== "object" || Array.isArray(record) ||
        typeof record.uri !== "string" || !record.uri.startsWith("at://") || record.uri.length > 2048 ||
        !record.value || typeof record.value !== "object" || Array.isArray(record.value)))
      throw new Error("Invalid Aturi record");
    if (page.cursor && (!page.records.length || page.cursor === input.cursor))
      throw new Error("Aturi cursor did not advance");
    return { records: page.records as RecordEntry[], cursor: page.cursor as string | undefined ?? null,
      retryAfter: null, rateLimited: false };
  } finally { clearTimeout(timeout); }
}

export default defineTool({
  description: "Read one page of full records from a PDS collection. Defaults to 50, at most 100 per page; " +
    "raw responses are capped at 64 KiB, so request fewer records if a page is too large. " +
    "Accepts a cursor and reverse ordering. Returns full record values, next cursor, and explicit " +
    "partial/end status. Available for signed Bluesky posts, authenticated operator DMs, " +
    "and authenticated website sessions. Budget: at most 10 page claims and 1,000 requested " +
    "records per Bluesky attempt or DM/website session, with no automatic approval to continue. " +
    "Stop on 429; label results incomplete if a cursor remains or a request stops early. " +
    "Use scan_collection for counts or date-window scans. To rank posts mentioning a handle " +
    "across authors, use top_mentioned_posts when available, not one account's list_records.",
  inputSchema,
  async execute(input, ctx) {
    const address = callerAddress(ctx);
    const limit = input.limit ?? 50;
    const pageInput = { ...input, limit, reverse: input.reverse ?? false };
    await claimBudget(address, limit);
    const page = await fetchPage(pageInput);
    return { records: page.records, cursor: page.cursor, complete: !page.rateLimited && page.cursor === null,
      partial: page.rateLimited || page.cursor !== null, retryAfter: page.retryAfter,
      stopped: page.rateLimited ? "rate_limited" : page.cursor === null ? "end" : "page" };
  },
});
