/**
 * The streamer's overlay settings in their own repo: to.atpota.poe.overlay, a record per
 * layout ("self" the main one, config.ts), and each screen's at to.atpota.poe.scene/<screen id> (scenes.ts). The overlay
 * reads them without credentials (repos are public), from the PDS the streamer's DID
 * document names; the setup page writes them with the signed-in session. Reading never
 * throws for a record that isn't there: that's a streamer with the defaults.
 */

import type { Session } from '../blog/auth';
import { deleteRecord, putRecord } from '../blog/repo';
import { fromRecord, isLayoutId, layoutNameOf, MAX_LAYOUTS, OVERLAY_NSID, OVERLAY_RKEY, toRecord, type OverlayConfig } from './config';
import { fromSceneRecord, isSceneKind, isScreenId, MAX_SCREENS, SCENE_NSID, toSceneRecord, type Scene, type SceneKind } from './scenes';

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
const asScene = (hint: SceneKind, r: { value: unknown; createdAt: string } | null | undefined): SavedScene | null | undefined => (r ? { scene: fromSceneRecord(hint, r.value), createdAt: r.createdAt } : r);

export interface SavedScene {
  scene: Scene;
  createdAt: string;
}

/** Anyone's saved layout ("self" unless named), read publicly: null when they have none, undefined when it couldn't be read. */
export async function readPublicConfig(did: string, fetchImpl: typeof fetch = fetch, layout: string = OVERLAY_RKEY): Promise<Saved | null | undefined> {
  return asConfig(await readPublic(did, OVERLAY_NSID, layout, fetchImpl));
}

/** The signed-in streamer's own saved settings, from their PDS. */
export async function readOwnConfig(session: Session, fetchImpl: typeof fetch = fetch): Promise<Saved | null | undefined> {
  return asConfig(await readOwn(session, OVERLAY_NSID, OVERLAY_RKEY, fetchImpl));
}

/** The kind a screen is before its record says: its id's, when the id is a kind. */
const hintFor = (id: string): SceneKind => (isSceneKind(id) ? id : 'starting');

/** Anyone's saved screen, read publicly. */
export async function readPublicScene(did: string, id: string, fetchImpl: typeof fetch = fetch, hint: SceneKind = hintFor(id)): Promise<SavedScene | null | undefined> {
  return asScene(hint, await readPublic(did, SCENE_NSID, id, fetchImpl));
}

/** The signed-in streamer's own saved screen. */
export async function readOwnScene(session: Session, id: string, fetchImpl: typeof fetch = fetch): Promise<SavedScene | null | undefined> {
  return asScene(hintFor(id), await readOwn(session, SCENE_NSID, id, fetchImpl));
}

export interface SavedScreen extends SavedScene {
  id: string;
}

/** All of the signed-in streamer's saved screens, oldest first: undefined when they couldn't be read. */
export async function listOwnScenes(session: Session, fetchImpl: typeof fetch = fetch): Promise<SavedScreen[] | undefined> {
  try {
    const q = new URLSearchParams({ repo: session.did, collection: SCENE_NSID, limit: String(MAX_SCREENS * 2) });
    const res = await json(fetchImpl, `${session.pds}/xrpc/com.atproto.repo.listRecords?${q}`);
    if (res.status !== 200 || !obj(res.body) || !Array.isArray(res.body.records)) return undefined;
    const out: SavedScreen[] = [];
    for (const r of res.body.records) {
      if (!obj(r) || typeof r.uri !== 'string') continue;
      const id = r.uri.slice(r.uri.lastIndexOf('/') + 1);
      const saved = isScreenId(id) ? valueFrom(200, r) : undefined;
      if (saved) out.push({ id, scene: fromSceneRecord(hintFor(id), saved.value), createdAt: saved.createdAt });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, MAX_SCREENS);
  } catch {
    return undefined;
  }
}

/** Saves a screen to the signed-in streamer's repo, at its id (throws a RepoError when refused). */
export async function saveScene(session: Session, id: string, scene: Scene, createdAt: string, now = new Date()): Promise<void> {
  await putRecord(session, SCENE_NSID, id, toSceneRecord(scene, createdAt, now));
}

/** Removes a screen from the signed-in streamer's repo (throws a RepoError when refused). */
export async function deleteScene(session: Session, id: string): Promise<void> {
  await deleteRecord(session, `at://${session.did}/${SCENE_NSID}/${id}`);
}

export interface SavedLayout extends Saved {
  id: string;
  name: string;
}

/** All of the signed-in streamer's saved layouts, the main one first, then oldest first: undefined when they couldn't be read. */
export async function listOwnLayouts(session: Session, fetchImpl: typeof fetch = fetch): Promise<SavedLayout[] | undefined> {
  try {
    const q = new URLSearchParams({ repo: session.did, collection: OVERLAY_NSID, limit: String(MAX_LAYOUTS * 2) });
    const res = await json(fetchImpl, `${session.pds}/xrpc/com.atproto.repo.listRecords?${q}`);
    if (res.status !== 200 || !obj(res.body) || !Array.isArray(res.body.records)) return undefined;
    const out: SavedLayout[] = [];
    for (const r of res.body.records) {
      if (!obj(r) || typeof r.uri !== 'string') continue;
      const id = r.uri.slice(r.uri.lastIndexOf('/') + 1);
      const saved = isLayoutId(id) ? valueFrom(200, r) : undefined;
      if (saved) out.push({ id, name: layoutNameOf(saved.value, id), config: fromRecord(saved.value), createdAt: saved.createdAt });
    }
    const main = (l: SavedLayout) => (l.id === OVERLAY_RKEY ? 0 : 1);
    return out.sort((a, b) => main(a) - main(b) || a.createdAt.localeCompare(b.createdAt)).slice(0, MAX_LAYOUTS);
  } catch {
    return undefined;
  }
}

/** Saves a layout to the signed-in streamer's repo, at its id (throws a RepoError when refused). */
export async function saveConfig(session: Session, config: OverlayConfig, createdAt: string, now = new Date(), id: string = OVERLAY_RKEY, name?: string): Promise<void> {
  await putRecord(session, OVERLAY_NSID, id, toRecord(config, createdAt, now, name));
}

/** Removes a layout from the signed-in streamer's repo (throws a RepoError when refused). */
export async function deleteLayout(session: Session, id: string): Promise<void> {
  await deleteRecord(session, `at://${session.did}/${OVERLAY_NSID}/${id}`);
}
