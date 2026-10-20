/**
 * Who is chatting with Poe, when they signed in with Bluesky. The widget asks the
 * visitor's own PDS for an atproto service-auth token (com.atproto.server.getServiceAuth)
 * addressed to atpota.to for one method, and sends it as `Authorization: Bearer <jwt>`.
 * This checks it the way any atproto service checks inter-service auth:
 *
 *   header   alg ES256K or ES256; never an OAuth access, refresh or DPoP token
 *   payload  aud = POE_SERVICE_DID, lxm = POE_LXM, iss a did:plc or plain did:web,
 *            exp in the future and at most an hour away (the most a PDS will sign)
 *   sig      by the #atproto key in iss's DID document, low-S, as the reference
 *            verifier insists; on a miss the document is fetched again, once, in
 *            case the key rotated
 *
 * The handle is the one the Bluesky AppView reports for that DID, since the AppView
 * checks handles in both directions; without one the visitor is known by DID alone.
 *
 * The OAuth session that mints the token stays in the browser (src/blog/auth.ts); the
 * token itself proves nothing beyond "this DID's PDS signed for atpota.to's Poe chat in
 * the last hour". Any failure leaves the chat anonymous: identify() never throws, and it
 * reports a fixed reason code for the log, never the token or the DID.
 */

import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { APPVIEW, didDocumentUrl, fetchJson, TtlCache, type Fetch } from './blog/atproto.js';

/** The audience a token must name: atpota.to, as a service. */
export const POE_SERVICE_DID = 'did:web:atpota.to';
/** The one method a token must be scoped to (see the rpc: scope in src/blog/auth.ts). */
export const POE_LXM = 'to.atpota.poe.chat';
export const MAX_TOKEN_LENGTH = 4096;
export const MAX_LIFETIME_S = 3600;
export const CLOCK_SKEW_S = 60;
export const IDENTITY_TIMEOUT_MS = 3000;
export const KEY_TTL_MS = 10 * 60_000;

export interface Visitor {
  did: string;
  handle: string | null;
}

export type IdentifyResult =
  | { ok: true; visitor: Visitor }
  | { ok: false; reason: 'malformed' | 'claims' | 'expired' | 'no_key' | 'bad_signature' };

export interface IdentifyDeps {
  fetch?: Fetch;
  now?: () => number;
}

const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]{1,253})$/;
/** The handle shape the bot accepts (bot/agent/lib/website.ts), lowercased. */
const HANDLE_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/* ---------- keys ---------- */

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(text: string): Uint8Array | null {
  let n = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

type Curve = 'secp256k1' | 'p256';

const CURVES: Record<Curve, { alg: string; oid: number[]; order: bigint }> = {
  // 1.3.132.0.10
  secp256k1: { alg: 'ES256K', oid: [0x2b, 0x81, 0x04, 0x00, 0x0a], order: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n },
  // 1.2.840.10045.3.1.7
  p256: { alg: 'ES256', oid: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07], order: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n },
};
/** 1.2.840.10045.2.1, id-ecPublicKey. */
const EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];

export interface PublicKey {
  curve: Curve;
  key: KeyObject;
}

/** A SubjectPublicKeyInfo for a compressed or uncompressed EC point. Every length here is short-form. */
function spki(curve: Curve, point: Uint8Array): Buffer {
  const der = (tag: number, body: number[]) => [tag, body.length, ...body];
  const algorithm = der(0x30, [...der(0x06, EC_PUBLIC_KEY), ...der(0x06, CURVES[curve].oid)]);
  return Buffer.from(der(0x30, [...algorithm, ...der(0x03, [0x00, ...point])]));
}

/**
 * A DID document key: a Multikey (base58btc, multicodec secp256k1-pub 0xe7 or p256-pub
 * 0x1200, compressed point), or the legacy EcdsaSecp256k1/r1VerificationKey2019 forms with
 * a bare point. Null for anything else.
 */
export function parseKey(method: unknown): PublicKey | null {
  const m = method as { type?: unknown; publicKeyMultibase?: unknown } | null;
  if (typeof m?.publicKeyMultibase !== 'string' || !m.publicKeyMultibase.startsWith('z') || m.publicKeyMultibase.length > 200) return null;
  const bytes = base58Decode(m.publicKeyMultibase.slice(1));
  if (!bytes) return null;
  let curve: Curve;
  let point: Uint8Array;
  if (m.type === 'Multikey') {
    if (bytes[0] === 0xe7 && bytes[1] === 0x01) curve = 'secp256k1';
    else if (bytes[0] === 0x80 && bytes[1] === 0x24) curve = 'p256';
    else return null;
    point = bytes.slice(2);
  } else if (m.type === 'EcdsaSecp256k1VerificationKey2019' || m.type === 'EcdsaSecp256r1VerificationKey2019') {
    curve = m.type === 'EcdsaSecp256k1VerificationKey2019' ? 'secp256k1' : 'p256';
    point = bytes;
  } else {
    return null;
  }
  const compressed = point.length === 33 && (point[0] === 0x02 || point[0] === 0x03);
  const uncompressed = point.length === 65 && point[0] === 0x04;
  if (!compressed && !uncompressed) return null;
  try {
    return { curve, key: createPublicKey({ key: spki(curve, point), format: 'der', type: 'spki' }) };
  } catch {
    return null;
  }
}

/** The #atproto verification method of a DID document. */
export function atprotoKey(doc: unknown, did: string): PublicKey | null {
  const d = doc as { id?: unknown; verificationMethod?: unknown } | null;
  if (d?.id !== did || !Array.isArray(d.verificationMethod)) return null;
  const method = d.verificationMethod.find((v: { id?: unknown }) => v?.id === '#atproto' || v?.id === `${did}#atproto`);
  return method ? parseKey(method) : null;
}

/** ECDSA over SHA-256, r||s, with s in the lower half of the curve order. */
export function verifySignature(pub: PublicKey, data: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  const s = BigInt(`0x${Buffer.from(sig.subarray(32)).toString('hex')}`);
  if (s === 0n || s > CURVES[pub.curve].order / 2n) return false;
  try {
    return verify('sha256', data, { key: pub.key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

/* ---------- tokens ---------- */

function decodePart(part: string): Record<string, unknown> | null {
  if (!B64URL_RE.test(part)) return null;
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The token from `Authorization: Bearer <jwt>`, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header.trim()) : null;
  return match && match[1]!.length <= MAX_TOKEN_LENGTH ? match[1]! : null;
}

interface Claims {
  iss: string;
  alg: string;
  signed: Uint8Array;
  sig: Uint8Array;
}

/** Everything that can be checked without the network. */
export function readToken(token: string, nowMs: number): { ok: true; claims: Claims } | { ok: false; reason: 'malformed' | 'claims' | 'expired' } {
  const parts = token.split('.');
  if (parts.length !== 3 || !B64URL_RE.test(parts[2]!)) return { ok: false, reason: 'malformed' };
  const header = decodePart(parts[0]!);
  const payload = decodePart(parts[1]!);
  if (!header || !payload) return { ok: false, reason: 'malformed' };
  const alg = header.alg;
  if (alg !== 'ES256K' && alg !== 'ES256') return { ok: false, reason: 'claims' };
  if (header.typ === 'at+jwt' || header.typ === 'refresh+jwt' || header.typ === 'dpop+jwt') return { ok: false, reason: 'claims' };
  const { iss, aud, lxm, exp } = payload;
  if (typeof iss !== 'string' || !DID_RE.test(iss) || aud !== POE_SERVICE_DID || lxm !== POE_LXM) return { ok: false, reason: 'claims' };
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: 'claims' };
  const now = nowMs / 1000;
  if (exp <= now) return { ok: false, reason: 'expired' };
  if (exp > now + MAX_LIFETIME_S + CLOCK_SKEW_S) return { ok: false, reason: 'claims' };
  return {
    ok: true,
    claims: {
      iss,
      alg,
      signed: Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      sig: Buffer.from(parts[2]!, 'base64url'),
    },
  };
}

/* ---------- identify ---------- */

const keys = new TtlCache<PublicKey | null>(KEY_TTL_MS);
const handles = new TtlCache<string | null>(KEY_TTL_MS);

/** Test hook. */
export function clearIdentityCache(): void {
  keys.clear();
  handles.clear();
}

async function keyFor(doFetch: Fetch, did: string, fresh: boolean): Promise<PublicKey | null> {
  if (!fresh) {
    const hit = keys.get(did);
    if (hit !== undefined) return hit;
  }
  try {
    return keys.set(did, atprotoKey(await fetchJson(doFetch, didDocumentUrl(did), IDENTITY_TIMEOUT_MS), did));
  } catch {
    return null; // not cached: plc.directory being down is not the visitor's fault
  }
}

async function handleFor(doFetch: Fetch, did: string): Promise<string | null> {
  const hit = handles.get(did);
  if (hit !== undefined) return hit;
  try {
    const profile = (await fetchJson(doFetch, `${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`, IDENTITY_TIMEOUT_MS)) as {
      did?: unknown;
      handle?: unknown;
    };
    const handle = typeof profile?.handle === 'string' ? profile.handle.toLowerCase() : '';
    return handles.set(did, profile?.did === did && handle !== 'handle.invalid' && HANDLE_RE.test(handle) ? handle : null);
  } catch {
    return null;
  }
}

export async function identify(token: string, deps: IdentifyDeps = {}): Promise<IdentifyResult> {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const read = readToken(token, now());
  if (!read.ok) return read;
  const { iss, alg, signed, sig } = read.claims;

  let key = await keyFor(doFetch, iss, false);
  let valid = key !== null && CURVES[key.curve].alg === alg && verifySignature(key, signed, sig);
  if (!valid) {
    // A rotated key, or a document that failed to load last time.
    key = await keyFor(doFetch, iss, true);
    valid = key !== null && CURVES[key.curve].alg === alg && verifySignature(key, signed, sig);
  }
  if (!key) return { ok: false, reason: 'no_key' };
  if (!valid) return { ok: false, reason: 'bad_signature' };
  return { ok: true, visitor: { did: iss, handle: await handleFor(doFetch, iss) } };
}
