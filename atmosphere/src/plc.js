// plc.js
// Reading the PLC directory (plc.directory): the public log of every did:plc identity's
// changes, each stamped with when it happened. An operation names the account's PDS
// (services.atproto_pds.endpoint) and its handle (alsoKnownAs), so the log says where
// accounts lived on any day: the host census (hosts.js) can only say where they live now.
//
//   GET /export?count=1000&after=<createdAt>   operations in order, as JSON lines
//   GET /<did>/log/audit                       one identity's whole history
//
// Used by backfill-hosts.js. Nothing here keeps a DID beyond the run.

import { isBlueskyHost } from './hosts.js';

export const PLC_URL = 'https://plc.directory';
export const PAGE_COUNT = 1000;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Waits after a 429 or a failure, then the last one again and again; a run gives up after MAX_TRIES. */
export const BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000];
export const MAX_TRIES = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a PLC path, waiting out 429s and failures (Retry-After when it's given). */
export async function plcGet(fetchImpl, path, { base = PLC_URL, log, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let retryAfter = null;
    try {
      const res = await fetchImpl(`${base}${path}`, { headers: { 'user-agent': 'atpotato-weather backfill (+https://atpota.to/weather)' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return await res.text();
      status = res.status;
      retryAfter = Number(res.headers.get('retry-after')) * 1000 || null;
      // an identity the directory doesn't know isn't going to appear
      if (status === 404 || status === 410) return null;
    } catch (err) {
      if (attempt + 1 >= MAX_TRIES) throw err;
    }
    if (attempt + 1 >= MAX_TRIES) throw new Error(`plc.directory answered ${status} ${MAX_TRIES} times for ${path}`);
    const ms = retryAfter ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    log?.(`plc.directory ${status || 'failed'} on ${path.split('?')[0]}; waiting ${Math.round(ms / 1000)}s`);
    await wait(ms);
  }
}

/** One export page after `after` (an ISO time), slimmed (slimEntry), oldest first. */
export async function exportPage(fetchImpl, after, opts) {
  const text = await plcGet(fetchImpl, `/export?count=${PAGE_COUNT}&after=${encodeURIComponent(after)}`, opts);
  return (text ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => slimEntry(JSON.parse(line)))
    .filter((e) => e !== null);
}

/** One identity's history, slimmed, oldest first (null if the directory doesn't know it). */
export async function auditLog(fetchImpl, did, opts) {
  const text = await plcGet(fetchImpl, `/${encodeURIComponent(did)}/log/audit`, opts);
  if (text === null) return null;
  const log = JSON.parse(text);
  return Array.isArray(log) ? log.map(slimEntry).filter((e) => e !== null) : null;
}

/** The PDS hostname an operation names (lowercase, no port), or null: a tombstone, or none given. */
export function hostOfOp(op) {
  if (!op || op.type === 'plc_tombstone') return null;
  const endpoint = op.services?.atproto_pds?.endpoint ?? op.service;
  if (typeof endpoint !== 'string') return null;
  try {
    return new URL(endpoint).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The handle an operation names, without at://, or null. */
export function handleOfOp(op) {
  const aka = op?.alsoKnownAs?.find?.((a) => typeof a === 'string' && a.startsWith('at://')) ?? (typeof op?.handle === 'string' ? `at://${op.handle}` : null);
  return aka ? aka.slice(5).toLowerCase() : null;
}

/**
 * An export or audit entry as just what the backfill uses, about a fifth of its size: who,
 * when, whether it created or deleted the identity, its host and its handle.
 */
export function slimEntry(e) {
  const op = e?.operation;
  if (!op || typeof e.did !== 'string' || typeof e.createdAt !== 'string') return null;
  return {
    did: e.did,
    cid: e.cid,
    at: e.createdAt,
    genesis: op.prev === null || op.type === 'create',
    deleted: op.type === 'plc_tombstone',
    nullified: e.nullified === true,
    host: hostOfOp(op),
    handle: handleOfOp(op),
  };
}

/**
 * A handle on a domain of the account's own, rather than one its host hands out: not
 * under bsky.social, nor under the host's own domain (name.blacksky.app on blacksky.app;
 * a Bridgy Fed handle, under brid.gy, on atproto.brid.gy).
 */
export function isCustomHandle(handle, host = null) {
  if (typeof handle !== 'string' || !handle.includes('.') || handle.endsWith('.bsky.social')) return false;
  if (!host) return true;
  const labels = host.split('.');
  // the host's domain: itself, and with its first label dropped while two or more stay (pds.example.com -> example.com)
  const domains = [host, ...(labels.length > 2 ? [labels.slice(1).join('.')] : [])];
  return !domains.some((d) => handle === d || handle.endsWith(`.${d}`));
}

/**
 * Where a host sits: 'bluesky' (one of Bluesky's own), 'independent' (any other host the
 * relay lists), 'unlisted' (one it doesn't: test servers, typos, bulk sign-ups nobody
 * relays), or null for no host at all (a tombstone).
 */
export function sideOf(host, relayHosts) {
  if (host === null) return null;
  if (isBlueskyHost(host)) return 'bluesky';
  return relayHosts.has(host) ? 'independent' : 'unlisted';
}
