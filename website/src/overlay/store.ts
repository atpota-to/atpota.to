/**
 * The streamer's overlay settings in their own repo: to.atpota.poe.overlay at "self"
 * (config.ts), and each scene's at to.atpota.poe.scene/<scene> (scenes.ts). The overlay
 * reads them without credentials (repos are public), from the PDS the streamer's DID
 * document names; the setup page writes them with the signed-in session. Reading never
 * throws for a record that isn't there: that's a streamer with the defaults.
 */

import type { Session } from '../blog/auth';
import { putRecord } from '../blog/repo';
import { fromRecord, OVERLAY_NSID, OVERLAY_RKEY, toRecord, type OverlayConfig } from './config';
import { fromSceneRecord, SCENE_NSID, toSceneRecord, type Scene, type SceneKind } from './scenes';

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

/** A getRecord answer's value and when it was made: null for no record, undefined when it couldn't be read. */
function valueFrom(status: number, body: unknown): { value: unknown; createdAt: string } | null | undefined {
  if (status === 400 && obj(body) && body.error === 'RecordNotFound') return null;
  if (status !== 200 || !obj(body) || !obj(body.value)) return undefined;
  const createdAt = typeof body.value.createdAt === 'string' && Number.isFinite(Date.parse(body.value.createdAt)) ? body.value.createdAt : new Date().toISOString();
  return { value: body.value, createdAt };
}

const recordQuery = (did: string, collection: string, rkey: string) => new URLSearchParams({ repo: did, collection, rkey }).toString();

/** The PDS a DID's document names, or null. */
const pdsCache = new Map<string, Promise<string | null>>();
function pdsFor(did: string, fetchImpl: typeof fetch): Promise<string | null> {
  let pds = pdsCache.get(did);
  if (!pds) {
    const docUrl = didDocumentUrl(did);
    pds = docUrl ? json(fetchImpl, docUrl).then((doc) => pdsOf(doc.body, did)) : Promise.resolve(null);
    pds.catch(() => pdsCache.delete(did));
    pdsCache.set(did, pds);
  }
  return pds;
}

/** Anyone's record, read publicly from their PDS. */
async function readPublic(did: string, collection: string, rkey: string, fetchImpl: typeof fetch) {
  try {
    const pds = await pdsFor(did, fetchImpl);
    if (!pds) return undefined;
    const rec = await json(fetchImpl, `${pds}/xrpc/com.atproto.repo.getRecord?${recordQuery(did, collection, rkey)}`);
    return valueFrom(rec.status, rec.body);
  } catch {
    pdsCache.delete(did);
    return undefined;
  }
}

/** The signed-in streamer's own record, from their PDS. */
async function readOwn(session: Session, collection: string, rkey: string, fetchImpl: typeof fetch) {
  try {
    const rec = await json(fetchImpl, `${session.pds}/xrpc/com.atproto.repo.getRecord?${recordQuery(session.did, collection, rkey)}`);
    return valueFrom(rec.status, rec.body);
  } catch {
    return undefined;
  }
}

const asConfig = (r: { value: unknown; createdAt: string } | null | undefined): Saved | null | undefined => (r ? { config: fromRecord(r.value), createdAt: r.createdAt } : r);
const asScene = (kind: SceneKind, r: { value: unknown; createdAt: string } | null | undefined): SavedScene | null | undefined => (r ? { scene: fromSceneRecord(kind, r.value), createdAt: r.createdAt } : r);

export interface SavedScene {
  scene: Scene;
  createdAt: string;
}

/** Anyone's saved settings, read publicly: null when they have none, undefined when it couldn't be read. */
export async function readPublicConfig(did: string, fetchImpl: typeof fetch = fetch): Promise<Saved | null | undefined> {
  return asConfig(await readPublic(did, OVERLAY_NSID, OVERLAY_RKEY, fetchImpl));
}

/** The signed-in streamer's own saved settings, from their PDS. */
export async function readOwnConfig(session: Session, fetchImpl: typeof fetch = fetch): Promise<Saved | null | undefined> {
  return asConfig(await readOwn(session, OVERLAY_NSID, OVERLAY_RKEY, fetchImpl));
}

/** Anyone's saved scene, read publicly. */
export async function readPublicScene(did: string, kind: SceneKind, fetchImpl: typeof fetch = fetch): Promise<SavedScene | null | undefined> {
  return asScene(kind, await readPublic(did, SCENE_NSID, kind, fetchImpl));
}

/** The signed-in streamer's own saved scene. */
export async function readOwnScene(session: Session, kind: SceneKind, fetchImpl: typeof fetch = fetch): Promise<SavedScene | null | undefined> {
  return asScene(kind, await readOwn(session, SCENE_NSID, kind, fetchImpl));
}

/** Saves a scene to the signed-in streamer's repo, at the scene's name (throws a RepoError when refused). */
export async function saveScene(session: Session, scene: Scene, createdAt: string, now = new Date()): Promise<void> {
  await putRecord(session, SCENE_NSID, scene.kind, toSceneRecord(scene, createdAt, now));
}

/** Saves the settings to the signed-in streamer's repo (throws a RepoError when refused). */
export async function saveConfig(session: Session, config: OverlayConfig, createdAt: string, now = new Date()): Promise<void> {
  await putRecord(session, OVERLAY_NSID, OVERLAY_RKEY, toRecord(config, createdAt, now));
}
