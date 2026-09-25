import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import {
  DEFAULT_RECORDS, HARD_RECORDS, MAX_PAGE_BYTES,
  initialScan, RateLimitError, scanBatch, scanResult, type Page, type ScanState,
} from "../lib/collection-scan";

const inputSchema = z.object({
  identifier: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:_-]+$/),
  collection: z.string().min(3).max(512).regex(/^[a-zA-Z0-9.-]+$/),
  since: z.iso.datetime({ offset: true }).optional(),
  timestampField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).default("createdAt"),
});
type Input = z.infer<typeof inputSchema>;

type Caller = { authenticator?: string; principalType?: string; principalId?: string;
  attributes?: Readonly<Record<string, string | readonly string[]>> } | null | undefined;

function scanAddress(ctx: { session: { id: string; auth: { initiator?: Caller; current?: Caller } } }) {
  for (const caller of [ctx.session.auth.initiator, ctx.session.auth.current]) {
    const postUri = caller?.attributes?.postUri;
    const rawAttempt = caller?.attributes?.attempt;
    const attempt = typeof rawAttempt === "string" ? Number(rawAttempt) : NaN;
    if (caller?.authenticator === "atpotato-droplet" && caller.principalType === "user" &&
        typeof caller.principalId === "string" && /^did:(plc|web):[^\s/]+$/.test(caller.principalId) &&
        caller.attributes?.did === caller.principalId && typeof postUri === "string" &&
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
    method: "POST",
    headers: { "content-type": "application/json", "x-atpotato-secret": secret },
    body: JSON.stringify(address),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 409) throw new Error("Scan budget spent for this turn");
  if (!response.ok || (await response.json() as { ok?: unknown }).ok !== true)
    throw new Error("Scan budget claim not accepted");
}

// Report the upstream delay in seconds without sleeping inside a workflow step.
function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

// Aturi serves Streamable HTTP as SSE; bound the wire bytes before JSON parsing.
async function fetchAturi(input: Input, cursor: string | undefined, limit: number): Promise<Page> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("https://aturi.to/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "list_records", arguments: { identifier: input.identifier,
          collection: input.collection, limit, reverse: false, ...(cursor ? { cursor } : {}) },
      } }),
      signal: controller.signal,
    });
    if (response.status === 429) throw new RateLimitError(retryAfterSeconds(response.headers.get("retry-after")));
    if (!response.ok || !response.body) throw new Error(`Aturi returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_PAGE_BYTES) throw new Error("Aturi response exceeds one megabyte");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as unknown).find((event) =>
          typeof event === "object" && event !== null && "result" in event)
      : JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("result" in payload))
      throw new Error("Invalid Aturi MCP response");
    const result = payload.result;
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid Aturi MCP response");
    const content = (result as { isError?: unknown; structuredContent?: unknown }).structuredContent;
    if ((result as { isError?: unknown }).isError === true) throw new Error("Aturi list_records failed");
    if (!content || typeof content !== "object" || Array.isArray(content))
      throw new Error("Invalid Aturi list_records page");
    const page = content as { ok?: unknown; records?: unknown; cursor?: unknown };
    if (page.ok !== true || !Array.isArray(page.records) ||
        (page.cursor !== undefined && (typeof page.cursor !== "string" || !page.cursor || page.cursor.length > 512)))
      throw new Error("Invalid Aturi list_records page");
    return { records: page.records as Page["records"], cursor: page.cursor as string | undefined, bytes };
  } finally { clearTimeout(timeout); }
}

async function scanPages(input: Input, state: ScanState, maxRecords: number): Promise<ScanState> {
  "use step";
  return scanBatch(state, (cursor, limit) => fetchAturi(input, cursor, limit), {
    since: input.since, timestampField: input.timestampField, maxRecords,
    maxPages: 10,
  });
}

export default defineWorkflowTool({
  description: "Scan a PDS collection through Aturi's read-only list_records without returning raw records. " +
    "Defaults to 1000 records / 10 pages. If more pages remain, asks the operator before " +
    "continuing, up to 10000 records. Returns counts, at most 10 URI/timestamp samples, " +
    "timestamp-field coverage and whether pagination ended. Optional since filters the " +
    "chosen timestampField (default createdAt); missing timestamps stay unknown. Never " +
    "assumes PDS pages are sorted by record timestamp.",
  inputSchema,
  async execute(input, ctx) {
    "use workflow";
    const address = scanAddress(ctx);
    await claimScanBudget(address);
    let state = initialScan();
    state = await scanPages(input, state, DEFAULT_RECORDS);
    if (!state.exhausted && state.cursor &&
            (state.stopped === "records" || state.stopped === "pages")) {
      const answer = await ctx.ask({
        prompt: `Scanned ${state.scanned} records in ${state.pages} pages of ${input.identifier}/${input.collection}. More pages remain. Approve scanning up to ${HARD_RECORDS} records total (subject to byte and time limits)?`,
        display: "confirmation",
        options: [
          { id: "approve", label: "Approve additional scan", style: "primary" },
          { id: "deny", label: "Stop scan" },
        ],
        allowFreeform: false,
      });
      if (answer.optionId === "approve") {
        while (!state.exhausted && state.scanned < HARD_RECORDS && state.pages < 100 &&
               state.stopped !== "time" && state.stopped !== "bytes" && state.stopped !== "rate_limited") {
          state = await scanPages(input, state, HARD_RECORDS);
        }
      }
    }
    return scanResult(state, input.since, input.timestampField);
  },
});
