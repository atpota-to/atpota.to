export const PAGE_SIZE = 100;
export const DEFAULT_RECORDS = 1_000;
export const HARD_RECORDS = 10_000;
export const MAX_PAGE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 24_000_000;
export const MAX_TOTAL_MS = 90_000;

export type Page = {
  records: { uri: string; value: Record<string, unknown> }[];
  cursor?: string;
  bytes: number;
};
export type ScanState = {
  scanned: number;
  pages: number;
  bytes: number;
  elapsedMs: number;
  cursor?: string;
  exhausted: boolean;
  matching: number;
  beforeSince: number;
  unknownTimestamp: number;
  timestampFields: Record<string, { present: number; valid: number }>;
  sample: { uri: string; timestamp: string | null }[];
  stopped?: "records" | "pages" | "bytes" | "time" | "rate_limited";
  retryAfter?: number;
};
export function initialScan(): ScanState {
  return { scanned: 0, pages: 0, bytes: 0, elapsedMs: 0, exhausted: false, matching: 0,
    beforeSince: 0, unknownTimestamp: 0, timestampFields: {}, sample: [] };
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 40 ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export type FetchPage = (cursor: string | undefined, limit: number) => Promise<Page>;

export class RateLimitError extends Error {
  constructor(readonly retryAfter?: number) {
    super("Aturi returned HTTP 429");
  }
}

// The page contents never leave this function; only bounded aggregates are retained.
export async function scanBatch(
  state: ScanState, fetchPage: FetchPage, options: {
    since?: string; timestampField: string; maxRecords: number; maxPages: number;
    now?: () => number;
  },
): Promise<ScanState> {
  const now = options.now ?? Date.now;
  const started = now();
  const since = options.since === undefined ? undefined : timestamp(options.since);
  if (options.since !== undefined && since === undefined) throw new Error("since must be an ISO 8601 timestamp with timezone");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(options.timestampField)) throw new Error("invalid timestamp field");
  const next: ScanState = { ...state, sample: [...state.sample],
    timestampFields: Object.fromEntries(Object.entries(state.timestampFields).map(([k, v]) => [k, { ...v }])) };
  let batchPages = 0;
  const seenCursors = new Set<string>();
  while (next.scanned < options.maxRecords && batchPages < options.maxPages && !next.exhausted) {
    if (next.elapsedMs + (now() - started) >= MAX_TOTAL_MS) { next.stopped = "time"; break; }
    if (next.bytes + MAX_PAGE_BYTES > MAX_TOTAL_BYTES) { next.stopped = "bytes"; break; }
    const limit = Math.min(PAGE_SIZE, options.maxRecords - next.scanned);
    const previousCursor = next.cursor;
    let page: Page;
    try {
      page = await fetchPage(previousCursor, limit);
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      next.stopped = "rate_limited";
      next.retryAfter = error.retryAfter;
      break;
    }
    if (!Number.isSafeInteger(page.bytes) || page.bytes < 0 || page.bytes > MAX_PAGE_BYTES ||
        !Array.isArray(page.records) || page.records.length > limit ||
        (page.cursor !== undefined && (typeof page.cursor !== "string" || page.cursor.length > 512))) {
      throw new Error("Aturi page exceeded scan bounds");
    }
    if (page.records.some((record) => !record || typeof record.uri !== "string" ||
        !record.uri.startsWith("at://") || record.uri.length > 2048 ||
        !record.value || typeof record.value !== "object" || Array.isArray(record.value))) {
      throw new Error("Invalid Aturi record");
    }
    next.pages++;
    batchPages++;
    next.bytes += page.bytes;
    for (const record of page.records) {
      next.scanned++;
      for (const [key, value] of Object.entries(record.value)) {
        if (!/^(?:[A-Za-z][A-Za-z0-9_]{0,63})(?:At|Timestamp)$/.test(key) && key !== options.timestampField) continue;
        if (!next.timestampFields[key] && Object.keys(next.timestampFields).length >= 32) continue;
        const coverage = next.timestampFields[key] ??= { present: 0, valid: 0 };
        coverage.present++;
        if (timestamp(value) !== undefined) coverage.valid++;
      }
      const raw = record.value[options.timestampField];
      const ms = timestamp(raw);
      if (ms === undefined) next.unknownTimestamp++;
      if (since !== undefined && ms !== undefined && ms < since) next.beforeSince++;
      if (since === undefined || (ms !== undefined && ms >= since)) {
        next.matching++;
        if (next.sample.length < 10) next.sample.push({ uri: record.uri, timestamp: ms === undefined ? null : String(raw) });
      }
    }
    // An empty page with a cursor cannot prove that pagination is complete.
    if (!page.records.length && page.cursor) throw new Error("Aturi returned an empty page with a cursor");
    if (!page.cursor) { next.cursor = undefined; next.exhausted = true; break; }
    if (page.cursor === previousCursor || seenCursors.has(page.cursor)) throw new Error("Aturi cursor did not advance");
    seenCursors.add(page.cursor);
    next.cursor = page.cursor;
  }
  next.elapsedMs += Math.max(0, now() - started);
  if (!next.exhausted && next.stopped !== "rate_limited") {
    if (next.elapsedMs >= MAX_TOTAL_MS) next.stopped = "time";
    else if (next.bytes + MAX_PAGE_BYTES > MAX_TOTAL_BYTES) next.stopped = "bytes";
    else next.stopped = next.scanned >= options.maxRecords ? "records" : "pages";
  } else if (next.exhausted) next.stopped = undefined;
  return next;
}

export function scanResult(state: ScanState, since?: string, timestampField = "createdAt") {
  return { scanned: state.scanned, pages: state.pages, matching: state.matching,
    beforeSince: state.beforeSince, unknownTimestamp: state.unknownTimestamp,
    timestampField, timestampFields: state.timestampFields, since: since ?? null,
    sample: state.sample, complete: state.exhausted, stopped: state.stopped ?? null,
    retryAfter: state.retryAfter ?? null,
    note: "since filters only records with a valid chosen timestamp. Unknown timestamps are not counted as matches when since is set. Pagination is not assumed to be sorted by timestamp; every scanned page is examined. Complete means the PDS returned no next cursor, not a stable snapshot." };
}
