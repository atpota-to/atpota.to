/**
 * Writes the guides' standard.site records (build/guide-records.ts) to atpota.to's repo.
 *
 *   npm run publish:guides -- --dry-run            show what would be written, touch nothing
 *   npm run publish:guides -- --dry-run --out x    also save the records as JSON
 *   ATP_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run publish:guides
 *
 * ATP_IDENTIFIER defaults to the guides account (atpota.to). Use an app password
 * (bsky.app -> settings -> privacy and security -> app passwords), never the main one.
 *
 * Safe to run again: a record that already matches is left alone, a changed document gets
 * a fresh updatedAt, and images are uploaded only for records that change (the PDS answers
 * an upload with the blob's CID, which must match the one computed locally).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { guideRecords, type PreparedRecord } from '../build/guide-records.js';
import { GUIDES, guideUrl } from '../build/guides.js';

type Fetch = typeof fetch;

export interface PublishDeps {
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
  log?: (line: string) => void;
  now?: () => Date;
  root?: string;
}

const PLC = 'https://plc.directory';

/** JSON with sorted keys, so two records compare equal whatever order their keys are in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Same content, ignoring updatedAt (which this script sets). */
export function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = ({ updatedAt: _u, ...rest }: Record<string, unknown>) => rest;
  return canonical(strip(a)) === canonical(strip(b));
}

/** One XRPC call; the parsed body whatever the status. Shared with publish-dispatch.ts. */
export async function xrpc<T>(doFetch: Fetch, url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: 'BadResponse', message: text.slice(0, 200) };
  }
  return { status: res.status, body: body as T };
}

export async function pdsFor(doFetch: Fetch, did: string): Promise<string> {
  const { status, body } = await xrpc<{ service?: { id?: string; serviceEndpoint?: string }[] }>(doFetch, `${PLC}/${did}`);
  const endpoint = status === 200 ? body?.service?.find((s) => s.id?.endsWith('#atproto_pds'))?.serviceEndpoint : undefined;
  if (!endpoint) throw new Error(`could not find the PDS for ${did}`);
  return new URL(endpoint).origin;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export async function main(args: string[], deps: PublishDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const root = deps.root ?? process.cwd();
  const dryRun = args.includes('--dry-run');
  const outAt = args.indexOf('--out');
  const out = outAt !== -1 ? args[outAt + 1] : undefined;

  const records = guideRecords(root);
  log(`${dryRun ? 'dry run: ' : ''}${records.length} records for ${GUIDES.handle} (${GUIDES.did})`);
  for (const r of records) {
    const blobBytes = r.blobs.reduce((sum, b) => sum + b.ref.size, 0);
    log(`  ${r.uri}  ${kb(canonical(r.record).length)}, ${r.blobs.length} images (${kb(blobBytes)})`);
  }

  if (dryRun) {
    if (out) {
      writeFileSync(resolve(out), JSON.stringify(records.map(({ uri, record }) => ({ uri, record })), null, 2));
      log(`wrote ${out}`);
    }
    return 0;
  }

  const password = env.ATP_APP_PASSWORD?.trim();
  if (!password) {
    log('set ATP_APP_PASSWORD (an app password for the guides account), or pass --dry-run');
    return 1;
  }
  const identifier = env.ATP_IDENTIFIER?.trim() || GUIDES.handle;
  const pds = await pdsFor(doFetch, GUIDES.did);

  const session = await xrpc<{ accessJwt?: string; did?: string; message?: string }>(doFetch, `${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (session.status !== 200 || !session.body?.accessJwt) {
    log(`sign-in failed (${session.status}): ${session.body?.message ?? 'no message'}`);
    return 1;
  }
  if (session.body.did !== GUIDES.did) {
    log(`signed in as ${session.body.did}, but the guides live in ${GUIDES.did}; nothing written`);
    return 1;
  }
  const auth = { authorization: `Bearer ${session.body.accessJwt}` };

  const publish = async (r: PreparedRecord): Promise<void> => {
    const params = new URLSearchParams({ repo: GUIDES.did, collection: r.collection, rkey: r.rkey });
    const existing = await xrpc<{ value?: Record<string, unknown> }>(doFetch, `${pds}/xrpc/com.atproto.repo.getRecord?${params}`);
    const current = existing.status === 200 ? existing.body?.value : undefined;
    if (current && sameRecord(current, r.record)) {
      log(`unchanged  ${r.uri}`);
      return;
    }
    for (const blob of r.blobs) {
      const up = await xrpc<{ blob?: { ref?: { $link?: string } }; message?: string }>(doFetch, `${pds}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: { ...auth, 'content-type': blob.ref.mimeType },
        body: readFileSync(blob.file),
      });
      const cid = up.body?.blob?.ref?.$link;
      if (up.status !== 200 || cid !== blob.ref.ref.$link) {
        throw new Error(`upload of ${blob.file} failed (${up.status}${cid ? `, got ${cid}` : ''}): ${up.body?.message ?? ''}`);
      }
    }
    const record = current && r.collection.endsWith('.document') ? { ...r.record, updatedAt: now().toISOString() } : r.record;
    const put = await xrpc<{ uri?: string; message?: string }>(doFetch, `${pds}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ repo: GUIDES.did, collection: r.collection, rkey: r.rkey, record }),
    });
    if (put.status !== 200) throw new Error(`writing ${r.uri} failed (${put.status}): ${put.body?.message ?? ''}`);
    log(`${current ? 'updated   ' : 'created   '} ${r.uri}`);
  };

  try {
    for (const r of records) await publish(r);
  } catch (error) {
    log(String((error as Error)?.message ?? error));
    return 1;
  }

  log('');
  log('check it:');
  log(`  ${GUIDES.publication.url}`);
  log(`  https://atpota.to/.well-known/site.standard.publication/guides`);
  for (const guide of GUIDES.documents) log(`  ${guideUrl(guide)}`);
  log(`  https://aturi.to/profile/${GUIDES.did}/site.standard.publication/${GUIDES.publication.rkey}`);
  return 0;
}
