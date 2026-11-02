// agent-memory.js
// The droplet's calls into the agent's memory routes (bot/agent/channels/memory.ts),
// on the same shared secret as every other call to the agent:
//
//   /memory/forget    "forget me", done in code: the person's notes and any
//                     journal note naming them
//   /memory/rollup    write each finished month's journal summary
//   /memory/snapshot  every private document as it stands, to seed the backup log

import { config } from './config.js';

async function call(path, body, timeoutMs, fetcher = fetch) {
  if (!config.agentUrl || !config.sharedSecret) return { ok: false, status: 0, body: null };
  try {
    const res = await fetcher(`${config.agentUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atpotato-secret': config.sharedSecret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
  }
}

export const forgetOnAgent = (did, handle, fetcher) => call('/memory/forget', { did, handle: handle ?? null }, 30000, fetcher);
export const rollUpOnAgent = (fetcher) => call('/memory/rollup', {}, 15000, fetcher);
export const snapshotFromAgent = (operators, fetcher) => call('/memory/snapshot', { operators }, 30000, fetcher);
