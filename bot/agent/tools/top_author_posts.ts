import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import {
  compactAuthorPost, MAX_PAGES, MAX_POSTS, MAX_RESPONSE_BYTES, MAX_TOTAL_BYTES, MAX_SCAN_MS,
  PAGE_SIZE, parseAuthorPage, topPosts, validDid, type CompactPost,
} from "../lib/top-author-posts";

const inputSchema = z.object({ handle: z.string().min(1).max(300).refine((value) =>
  (value.length <= 253 && /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) &&
    value.includes(".") && !value.includes("..")) || validDid(value), "Expected a Bluesky handle or DID"),
  limit: z.number().int().min(5).max(10).default(5) });
type Input = z.infer<typeof inputSchema>;
type Caller = { authenticator?: string; principalType?: string; principalId?: string;
  attributes?: Readonly<Record<string, string | readonly string[]>> } | null | undefined;

function scanAddress(ctx: { session: { id: string; auth: { initiator?: Caller; current?: Caller } } }) {
  for (const caller of [ctx.session.auth.initiator, ctx.session.auth.current]) {
    const postUri = caller?.attributes?.postUri;
    const rawAttempt = caller?.attributes?.attempt;
    const attempt = typeof rawAttempt === "string" ? Number(rawAttempt) : NaN;
    if (caller?.authenticator === "atpotato-droplet" && caller.principalType === "user" &&
        validDid(caller.principalId) && caller.attributes?.did === caller.principalId &&
        typeof postUri === "string" &&
        /^at:\/\/did:(plc|web):[^\s/]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._~-]+$/.test(postUri) &&
        postUri.startsWith(`at://${caller.principalId}/app.bsky.feed.post/`) &&
        Number.isSafeInteger(attempt) && attempt > 0 && ctx.session.id) {
      return { sessionId: ctx.session.id, postUri, attempt };
    }
  }
  throw new Error("Scan requires an authenticated Bluesky post");
}

async function claimScanBudget(address: { sessionId: string; postUri: string; attempt: number }) {
  "use step";
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) throw new Error("Scan budget callback not configured");
  const url = new URL("/internal/scan-budget/claim", callback);
  if (url.protocol !== "https:") throw new Error("Scan budget callback must use HTTPS");
  const response = await fetch(url, {
    method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-atpotato-secret": secret },
    body: JSON.stringify(address), signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 409) throw new Error("Scan budget spent for this turn");
  if (!response.ok || (await response.json() as { ok?: unknown }).ok !== true)
    throw new Error("Scan budget claim not accepted");
}

class UpstreamError extends Error {
  constructor(readonly status: number, readonly retryAfter: number | null = null) {
    super(`Bluesky returned HTTP ${status}`);
  }
}
function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : null;
}

async function boundedJson(url: URL, deadline: number, budget: { bytes: number }): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Scan time limit reached");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(8_000, remaining));
  try {
    let response: Response;
    try { response = await fetch(url, { signal: controller.signal, redirect: "error" }); }
    catch { throw new Error("Bluesky request failed or timed out"); }
    if (!response.ok) throw new UpstreamError(response.status,
      response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : null);
    if (!response.body) throw new Error("Invalid Bluesky response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { controller.abort(); throw new Error("Bluesky response exceeds page byte limit"); }
        if (budget.bytes + bytes > MAX_TOTAL_BYTES) { controller.abort(); throw new Error("Scan byte limit reached"); }
        chunks.push(value);
      }
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error &&
          (error.message === "Scan byte limit reached" || error.message === "Bluesky response exceeds page byte limit")) throw error;
      if (controller.signal.aborted) throw new Error("Bluesky request timed out");
      throw error;
    } finally { await reader.cancel().catch(() => {}); }
    budget.bytes += bytes;
    try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new Error("Invalid Bluesky response"); }
  } finally { clearTimeout(timeout); }
}

async function findTopPosts(input: Input) {
  "use step";
  const deadline = Date.now() + MAX_SCAN_MS;
  const budget = { bytes: 0 };
  const posts: CompactPost[] = [];
  const uris = new Set<string>();
  const cursors = new Set<string>();
  const errors: { status: number | null; retryAfter: number | null; message: string }[] = [];
  let did: string | null = null;
  let pages = 0;
  let inspected = 0;
  let skipped = 0;
  let duplicates = 0;
  let stopped: string | null = null;
  let cursor: string | null = null;
  let exhausted = false;
  const fail = (error: unknown) => {
    const upstream = error instanceof UpstreamError ? error : null;
    errors.push({ status: upstream?.status ?? null, retryAfter: upstream?.retryAfter ?? null,
      message: upstream?.message ?? (error instanceof Error &&
        /^(Scan time limit reached|Scan byte limit reached|Bluesky response exceeds page byte limit|Invalid Bluesky (author page|response)|Bluesky request (failed or timed out|timed out))$/.test(error.message)
        ? error.message : "Bluesky request failed") });
    stopped = upstream?.status === 429 ? "rate_limited" :
      error instanceof Error && error.message === "Scan byte limit reached" ? "bytes" :
      error instanceof Error && error.message === "Scan time limit reached" ? "time" : "upstream_error";
  };
  try {
    if (validDid(input.handle)) did = input.handle;
    else {
      const url = new URL("https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle");
      url.searchParams.set("handle", input.handle);
      const resolved = await boundedJson(url, deadline, budget) as { did?: unknown };
      if (!validDid(resolved?.did)) throw new Error("Invalid Bluesky response");
      did = resolved.did;
    }
  } catch (error) { fail(error); }

  while (did && !stopped && !exhausted && pages < MAX_PAGES && uris.size < MAX_POSTS) {
    if (Date.now() >= deadline) { stopped = "time"; break; }
    if (budget.bytes >= MAX_TOTAL_BYTES) { stopped = "bytes"; break; }
    const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
    url.searchParams.set("actor", did);
    url.searchParams.set("filter", "posts_with_replies");
    url.searchParams.set("limit", String(Math.min(PAGE_SIZE, MAX_POSTS - uris.size)));
    if (cursor) url.searchParams.set("cursor", cursor);
    try {
      const page = parseAuthorPage(await boundedJson(url, deadline, budget),
        Math.min(PAGE_SIZE, MAX_POSTS - uris.size));
      pages++;
      inspected += page.feed.length;
      for (const item of page.feed) {
        const compact = compactAuthorPost((item as { post: unknown }).post, did);
        if (!compact) { skipped++; continue; }
        if (uris.has(compact.uri)) { duplicates++; continue; }
        uris.add(compact.uri);
        posts.push(compact);
      }
      if (page.cursor && (!page.feed.length || cursors.has(page.cursor)))
        throw new Error("Invalid Bluesky author page");
      if (page.cursor) cursors.add(page.cursor);
      cursor = page.cursor;
      exhausted = !cursor;
    } catch (error) { fail(error); break; }
  }
  if (!stopped && !exhausted && did) stopped = uris.size >= MAX_POSTS ? "posts" : "pages";
  const complete = exhausted && !stopped && !errors.length;
  return { targetDid: did, posts: topPosts(posts, input.limit), scanned: uris.size, inspected,
    skipped, duplicates, pages, bytes: budget.bytes, complete, partial: !complete, stopped, errors };
}

export default defineWorkflowTool({
  description: "Rank one Bluesky author's own posts by likes, including replies. Claims the shared one-scan-per-turn budget before public API calls. Inspects up to 1000 feed entries across 20 pages, returns 5-10 compact posts and explicit partial status; never returns the full feed.",
  inputSchema,
  async execute(input, ctx) {
    "use workflow";
    await claimScanBudget(scanAddress(ctx));
    return findTopPosts(input);
  },
});
