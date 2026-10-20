// supabase.js
// PostgREST with the service key: the garden_* functions (garden/supabase/garden_index.sql)
// through rpc, and plain upserts and patches for garden_growth and garden_status. Every
// call gives up after 10 s; a failure throws an Error carrying the HTTP status, so callers
// can tell a rejected row (4xx) from Supabase being down.

export const REQUEST_TIMEOUT_MS = 10_000;

export function supabaseRest({ url, key, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}` };

  async function call(path, init) {
    let res;
    try {
      res = await fetch(`${base}/rest/v1/${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw Object.assign(new Error(`${path.split('?')[0]}: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message ?? err}`), { status: 0 });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`), { status: res.status });
    }
    return res;
  }

  return {
    /** Calls a database function and returns what it answers, parsed (null for an empty body). */
    async rpc(name, args = {}) {
      const res = await call(`rpc/${name}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
    /** Inserts rows, merging into any with the same `conflict` columns (only the columns given change). */
    async upsert(table, conflict, rows) {
      await call(`${table}?on_conflict=${conflict}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
    },
    /** Updates the rows a filter matches, e.g. patch('garden_growth', 'sprout_uri=eq.<encoded>', {...}). */
    async patch(table, query, values) {
      await call(`${table}?${query}`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify(values),
      });
    },
  };
}
