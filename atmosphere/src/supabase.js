// supabase.js
// PostgREST with the service key: upserts for the writer, and paged reads for the
// account rollups (rollup.js), which reload what they already wrote after a restart.

export const REQUEST_TIMEOUT_MS = 10_000;
/** Supabase answers at most this many rows at a time. */
export const PAGE_ROWS = 1000;
export const MAX_PAGES = 50;

export function supabaseRest({ url, key, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}` };

  async function call(path, init) {
    const res = await fetch(`${base}/rest/v1/${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`), { status: res.status });
    }
    return res;
  }

  return {
    /** Inserts rows, replacing any with the same `conflict` columns. */
    async upsert(table, conflict, rows) {
      await call(`${table}?on_conflict=${conflict}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
    },
    /** Every row a query answers, a page at a time (the query needs an `order`, so pages don't overlap). */
    async getAll(query) {
      const rows = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await call(`${query}&limit=${PAGE_ROWS}&offset=${page * PAGE_ROWS}`, { headers: { ...headers, accept: 'application/json' } });
        const got = await res.json();
        if (!Array.isArray(got)) throw new Error(`${query.split('?')[0]}: not rows`);
        rows.push(...got);
        if (got.length < PAGE_ROWS) return rows;
      }
      throw new Error(`${query.split('?')[0]}: more than ${MAX_PAGES * PAGE_ROWS} rows`);
    },
  };
}
