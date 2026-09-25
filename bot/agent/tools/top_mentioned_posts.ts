import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import {
  compactPost, HYDRATE_SIZE, MAX_PAGES, MAX_POSTS, MAX_RESPONSE_BYTES, MAX_TOTAL_BYTES, MAX_SCAN_MS,
  MENTION_PATHS, PAGE_SIZE, parseBacklinks, topPosts, validDid, type CompactPost,
} from "../lib/top-mentioned-posts";

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
  constructor(readonly service: string, readonly status: number, readonly retryAfter: number | null = null) {
    super(`${service} returned HTTP ${status}`);
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

async function boundedJson(url: URL, service: string, deadline: number, budget: { bytes: number }): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Scan time limit reached");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(8_000, remaining));
  try {
    let response: Response;
    try { response = await fetch(url, { signal: controller.signal, redirect: "error" }); }
    catch { throw new Error(`${service} request failed or timed out`); }
    if (!response.ok) throw new UpstreamError(service, response.status,
      response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : null);
    if (!response.body) throw new Error(`Invalid ${service} response`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { controller.abort(); throw new Error(`${service} response exceeds one megabyte`); }
        if (budget.bytes + bytes > MAX_TOTAL_BYTES) { controller.abort(); throw new Error("Scan byte limit reached"); }
        chunks.push(value);
      }
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error &&
          (error.message === "Scan byte limit reached" || error.message.endsWith("response exceeds one megabyte"))) throw error;
      if (controller.signal.aborted) throw new Error(`${service} request timed out`);
      throw error;
    } finally { await reader.cancel().catch(() => {}); }
    budget.bytes += bytes;
    try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new Error(`Invalid ${service} response`); }
  } finally { clearTimeout(timeout); }
}

async function findTopPosts(input: Input) {
  "use step";
  const deadline = Date.now() + MAX_SCAN_MS;
  const budget = { bytes: 0 };
  const uris = new Set<string>();
  const states = MENTION_PATHS.map((path) => ({ path, cursor: null as string | null,
    exhausted: false, pages: 0, total: null as number | null, seen: new Set<string>() }));
  const posts: CompactPost[] = [];
  const errors: { service: string; status: number | null; retryAfter: number | null; message: string }[] = [];
  let pages = 0;
  let missingHydration = 0;
  let discardedNonMentions = 0;
  let stopped: string | null = null;
  let did: string | null = null;
  const fail = (error: unknown, service: string) => {
    const upstream = error instanceof UpstreamError ? error : null;
    errors.push({ service, status: upstream?.status ?? null, retryAfter: upstream?.retryAfter ?? null,
      message: upstream?.message ?? (error instanceof Error && /^(Scan time limit reached|Scan byte limit reached|.*response exceeds one megabyte|Invalid .* (page|response)|.*request (failed or timed out|timed out))$/.test(error.message)
        ? error.message : `${service} request failed`) });
    stopped = upstream?.status === 429 ? "rate_limited" :
      error instanceof Error && error.message === "Scan byte limit reached" ? "bytes" :
      error instanceof Error && error.message === "Scan time limit reached" ? "time" : "upstream_error";
  };
  try {
    if (validDid(input.handle)) did = input.handle;
    else {
      const url = new URL("https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle");
      url.searchParams.set("handle", input.handle);
      const resolved = await boundedJson(url, "Bluesky identity", deadline, budget) as { did?: unknown };
      if (!validDid(resolved?.did)) throw new Error("Invalid Bluesky identity response");
      did = resolved.did;
    }
  } catch (error) { fail(error, "Bluesky identity"); }

  if (did) {
    scan: while (pages < MAX_PAGES && uris.size < MAX_POSTS && states.some((s) => !s.exhausted)) {
      for (const state of states) {
        if (state.exhausted) continue;
        if (Date.now() >= deadline) { stopped = "time"; break scan; }
        if (pages >= MAX_PAGES || uris.size >= MAX_POSTS) break scan;
        const url = new URL("https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks");
        url.searchParams.set("subject", did);
        url.searchParams.set("source", `app.bsky.feed.post:${state.path}`);
        url.searchParams.set("limit", String(Math.min(PAGE_SIZE, MAX_POSTS - uris.size)));
        if (state.cursor) url.searchParams.set("cursor", state.cursor);
        try {
          const page = parseBacklinks(await boundedJson(url, "Constellation", deadline, budget),
            Math.min(PAGE_SIZE, MAX_POSTS - uris.size));
          pages++;
          state.pages++;
          state.total = page.total;
          for (const record of page.records) uris.add(`at://${record.did}/${record.collection}/${record.rkey}`);
          if (page.cursor) {
            if (!page.records.length || state.seen.has(page.cursor)) throw new Error("Invalid Constellation page");
            state.seen.add(page.cursor);
          }
          state.cursor = page.cursor;
          state.exhausted = !page.cursor;
        } catch (error) { fail(error, "Constellation"); break scan; }
      }
    }
    if (!stopped && states.some((s) => !s.exhausted)) stopped = uris.size >= MAX_POSTS ? "posts" : "pages";
    const addresses = [...uris];
    for (let i = 0; i < addresses.length; i += HYDRATE_SIZE) {
      if (Date.now() >= deadline || budget.bytes >= MAX_TOTAL_BYTES) {
        stopped = Date.now() >= deadline ? "time" : "bytes";
        missingHydration += addresses.length - i;
        break;
      }
      const batch = addresses.slice(i, i + HYDRATE_SIZE);
      const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts");
      for (const uri of batch) url.searchParams.append("uris", uri);
      try {
        const data = await boundedJson(url, "Bluesky posts", deadline, budget) as { posts?: unknown };
        if (!Array.isArray(data?.posts) || data.posts.length > batch.length) throw new Error("Invalid Bluesky posts response");
        const returned = new Map<string, unknown>();
        for (const post of data.posts) {
          if (!post || typeof post !== "object" || typeof post.uri !== "string" ||
              !batch.includes(post.uri) || returned.has(post.uri)) throw new Error("Invalid Bluesky posts response");
          returned.set(post.uri, post);
        }
        for (const uri of batch) {
          if (!returned.has(uri)) { missingHydration++; continue; }
          const compact = compactPost(returned.get(uri), uri, did);
          if (compact) posts.push(compact);
          else discardedNonMentions++;
        }
      } catch (error) { missingHydration += addresses.length - i; fail(error, "Bluesky posts"); break; }
    }
  }
  const complete = states.every((s) => s.exhausted) && !stopped && !missingHydration && !errors.length;
  return { targetDid: did, posts: topPosts(posts, input.limit), scanned: uris.size, pages, bytes: budget.bytes,
    total: states.map((s) => ({ source: s.path, count: s.total })),
    totalNote: "Constellation index coverage may be incomplete; per-path counts can overlap. This is the most liked among hydrated verified mentions, not necessarily all posts.",
    hydrated: posts.length, missingHydration, discardedNonMentions,
    complete, partial: !complete, stopped, errors };
}

export default defineWorkflowTool({
  description: "Find the most liked posts by any author that facet-mention a Bluesky handle or DID. Claims the same one-scan-per-turn budget as scan_collection before any public API calls. Scans up to 1000 unique posts across both Constellation mention paths and 12 pages, hydrates via Bluesky, then ranks globally by likes. Returns compact links and explicit partial/error counts; it never returns raw post records.",
  inputSchema,
  async execute(input, ctx) {
    "use workflow";
    await claimScanBudget(scanAddress(ctx));
    return findTopPosts(input);
  },
});
