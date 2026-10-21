/**
 * The streamer's overlay settings in their own repo: to.atpota.poe.overlay at "self"
 * (config.ts). The overlay reads it without credentials (repos are public), from the PDS
 * the streamer's DID document names; the setup page writes it with the signed-in session.
 * Neither ever throws for a record that isn't there: that's a streamer with the defaults.
 */

import type { Session } from '../blog/auth';
import { putRecord } from '../blog/repo';
import { fromRecord, OVERLAY_NSID, OVERLAY_RKEY, toRecord, type OverlayConfig } from './config';

export const PLC = 'https://plc.directory';
const TIMEOUT_MS = 8000;

export interface Saved {
  config: OverlayConfig;
  createdAt: string;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The PDS a DID document names, when it's an https address. */
export function pdsOf(doc: unknown, did: string): string | null {
  if (!obj(doc) || doc.id !== did || !Array.isArray(doc.service)) return null;
  for (const s of doc.service) {
    if (!obj(s) || s.type !== 'AtprotoPersonalDataServer' || (s.id !== '#atproto_pds' && s.id !== `${did}#atproto_pds`)) continue;
    try {
      const url = new URL(String(s.serviceEndpoint));
      return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function didDocumentUrl(did: string): string | null {
  if (did.startsWith('did:plc:')) return `${PLC}/${did}`;
  const web = /^did:web:([a-z0-9.-]+)$/i.exec(did);
  return web ? `https://${web[1]}/.well-known/did.json` : null;
}

async function json(fetchImpl: typeof fetch, url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout?.(TIMEOUT_MS) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** What a getRecord answer holds: the settings, null for no record, or undefined when it couldn't be read. */
function savedFrom(status: number, body: unknown): Saved | null | undefined {
  if (status === 400 && obj(body) && body.error === 'RecordNotFound') return null;
  if (status !== 200 || !obj(body) || !obj(body.value)) return undefined;
  const createdAt = typeof body.value.createdAt === 'string' && Number.isFinite(Date.parse(body.value.createdAt)) ? body.value.createdAt : new Date().toISOString();
  return { config: fromRecord(body.value), createdAt };
}

const recordQuery = (did: string) => new URLSearchParams({ repo: did, collection: OVERLAY_NSID, rkey: OVERLAY_RKEY }).toString();

/** Anyone's saved settings, read publicly: null when they have none, undefined when it couldn't be read. */
export async function readPublicConfig(did: string, fetchImpl: typeof fetch = fetch): Promise<Saved | null | undefined> {
  try {
    const docUrl = didDocumentUrl(did);
    if (!docUrl) return undefined;
    const doc = await json(fetchImpl, docUrl);
    const pds = pdsOf(doc.body, did);
    if (!pds) return undefined;
    const rec = await json(fetchImpl, `${pds}/xrpc/com.atproto.repo.getRecord?${recordQuery(did)}`);
    return savedFrom(rec.status, rec.body);
  } catch {
    return undefined;
  }
}

/** The signed-in streamer's own saved settings, from their PDS. */
export async function readOwnConfig(session: Session, fetchImpl: typeof fetch = fetch): Promise<Saved | null | undefined> {
  try {
    const rec = await json(fetchImpl, `${session.pds}/xrpc/com.atproto.repo.getRecord?${recordQuery(session.did)}`);
    return savedFrom(rec.status, rec.body);
  } catch {
    return undefined;
  }
}

/** Saves the settings to the signed-in streamer's repo (throws a RepoError when refused). */
export async function saveConfig(session: Session, config: OverlayConfig, createdAt: string, now = new Date()): Promise<void> {
  await putRecord(session, OVERLAY_NSID, OVERLAY_RKEY, toRecord(config, createdAt, now));
}
