import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  atprotoKey,
  base58Decode,
  bearerToken,
  clearIdentityCache,
  identify,
  parseKey,
  POE_FORGET_LXM,
  POE_LXM,
  POE_SERVICE_DID,
  readToken,
  verifySignature,
} from '../server/identity.js';

// Real keys on both atproto curves, a Multikey for each, and service-auth JWTs signed the
// way a PDS signs them (createServiceJwt in @atproto/xrpc-server): low-S r||s over
// "<header>.<payload>". plc.directory and the AppView are a scripted fetch.

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const ORDERS = {
  secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  p256: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
} as const;

interface TestKey {
  curve: 'secp256k1' | 'p256';
  alg: 'ES256K' | 'ES256';
  privateKey: KeyObject;
  multikey: string;
  compressed: Uint8Array;
}

function makeKey(curve: 'secp256k1' | 'p256'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve === 'p256' ? 'prime256v1' : 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  const compressed = Uint8Array.from([y[y.length - 1]! & 1 ? 0x03 : 0x02, ...x]);
  const prefix = curve === 'secp256k1' ? [0xe7, 0x01] : [0x80, 0x24];
  return { curve, alg: curve === 'secp256k1' ? 'ES256K' : 'ES256', privateKey, compressed, multikey: `z${base58Encode(Uint8Array.from([...prefix, ...compressed]))}` };
}

/** r||s with s folded into the lower half, as atproto requires. */
function lowS(key: TestKey, data: Uint8Array, high = false): Buffer {
  const sig = sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  const order = ORDERS[key.curve];
  let s = BigInt(`0x${sig.subarray(32).toString('hex')}`);
  if ((s > order / 2n) !== high) s = order - s;
  return Buffer.concat([sig.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function jwt(key: TestKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}, opts: { highS?: boolean } = {}): string {
  const signed = `${b64({ typ: 'JWT', alg: key.alg, ...header })}.${b64(payload)}`;
  return `${signed}.${lowS(key, Buffer.from(signed), opts.highS).toString('base64url')}`;
}

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const claims = (over: Record<string, unknown> = {}) => ({
  iat: NOW / 1000,
  iss: DID,
  aud: POE_SERVICE_DID,
  exp: NOW / 1000 + 1800,
  lxm: POE_LXM,
  jti: 'a1b2c3',
  ...over,
});

function didDoc(did: string, key: TestKey, id = '#atproto') {
  return {
    id: did,
    alsoKnownAs: ['at://someone.example'],
    verificationMethod: [{ id, type: 'Multikey', controller: did, publicKeyMultibase: key.multikey }],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }],
  };
}

function fakeFetch(docs: Record<string, unknown>, profile: unknown = { did: DID, handle: 'Someone.Example' }) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://plc.directory/')) {
      const doc = docs[decodeURIComponent(url.slice('https://plc.directory/'.length))];
      return doc ? new Response(JSON.stringify(doc)) : new Response('{}', { status: 404 });
    }
    if (url.startsWith('https://someone.example/.well-known/did.json')) {
      const doc = docs['did:web:someone.example'];
      return doc ? new Response(JSON.stringify(doc)) : new Response('{}', { status: 404 });
    }
    if (url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile')) {
      return profile === null ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(profile));
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

beforeEach(() => clearIdentityCache());

describe('keys', () => {
  it('decodes base58btc, keeping leading zero bytes', () => {
    expect([...base58Decode('1112')!]).toEqual([0, 0, 0, 1]);
    expect(base58Decode('0OIl')).toBeNull();
  });

  it('reads Multikeys on both curves and the legacy forms, and nothing else', () => {
    for (const curve of ['secp256k1', 'p256'] as const) {
      const key = makeKey(curve);
      expect(parseKey({ type: 'Multikey', publicKeyMultibase: key.multikey })?.curve).toBe(curve);
      const legacy = curve === 'secp256k1' ? 'EcdsaSecp256k1VerificationKey2019' : 'EcdsaSecp256r1VerificationKey2019';
      expect(parseKey({ type: legacy, publicKeyMultibase: `z${base58Encode(key.compressed)}` })?.curve).toBe(curve);
    }
    const key = makeKey('p256');
    expect(parseKey({ type: 'JsonWebKey2020', publicKeyMultibase: key.multikey })).toBeNull();
    expect(parseKey({ type: 'Multikey', publicKeyMultibase: key.multikey.slice(1) })).toBeNull();
    // ed25519-pub (0xed) is not an atproto signing key.
    expect(parseKey({ type: 'Multikey', publicKeyMultibase: `z${base58Encode(Uint8Array.from([0xed, 0x01, ...new Uint8Array(32)]))}` })).toBeNull();
    // Right prefix, an x past the field prime: no such point.
    expect(parseKey({ type: 'Multikey', publicKeyMultibase: `z${base58Encode(Uint8Array.from([0x80, 0x24, 0x02, ...new Uint8Array(32).fill(0xff)]))}` })).toBeNull();
    // Right prefix, wrong length.
    expect(parseKey({ type: 'Multikey', publicKeyMultibase: `z${base58Encode(Uint8Array.from([0xe7, 0x01, ...key.compressed.subarray(1)]))}` })).toBeNull();
  });

  it("takes the document's own #atproto key, in either id form, and only for that DID", () => {
    const key = makeKey('secp256k1');
    expect(atprotoKey(didDoc(DID, key), DID)).not.toBeNull();
    expect(atprotoKey(didDoc(DID, key, `${DID}#atproto`), DID)).not.toBeNull();
    expect(atprotoKey(didDoc(DID, key, '#atproto_label'), DID)).toBeNull();
    expect(atprotoKey(didDoc('did:plc:zzzzzzzzzzzzzzzzzzzzzzzz', key), DID)).toBeNull();
  });

  it('accepts low-S signatures only', () => {
    const key = makeKey('p256');
    const pub = parseKey({ type: 'Multikey', publicKeyMultibase: key.multikey })!;
    const data = Buffer.from('hello');
    expect(verifySignature(pub, data, lowS(key, data))).toBe(true);
    expect(verifySignature(pub, data, lowS(key, data, true))).toBe(false);
    expect(verifySignature(pub, Buffer.from('hellO'), lowS(key, data))).toBe(false);
    expect(verifySignature(pub, data, lowS(key, data).subarray(1))).toBe(false);
  });
});

describe('tokens', () => {
  const key = makeKey('secp256k1');

  it('reads the bearer token from the Authorization header only', () => {
    const req = (value?: string) => new Request('https://atpota.to/api/poe', value ? { headers: { authorization: value } } : {});
    expect(bearerToken(req('Bearer a.b.c'))).toBe('a.b.c');
    expect(bearerToken(req('bearer a.b.c'))).toBeNull();
    expect(bearerToken(req('Bearer a b'))).toBeNull();
    expect(bearerToken(req(`Bearer ${'a'.repeat(5000)}`))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });

  it('checks audience, method, issuer, algorithm and lifetime before any network', () => {
    expect(readToken(jwt(key, claims()), NOW).ok).toBe(true);
    const reason = (token: string) => {
      const r = readToken(token, NOW);
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason('nope')).toBe('malformed');
    expect(reason(`${b64({ alg: 'ES256K' })}.not-json!.sig`)).toBe('malformed');
    expect(reason(jwt(key, claims({ aud: 'did:web:api.bsky.app' })))).toBe('claims');
    expect(reason(jwt(key, claims({ aud: `${POE_SERVICE_DID}#poe` })))).toBe('claims');
    expect(reason(jwt(key, claims({ lxm: 'app.bsky.feed.getTimeline' })))).toBe('claims');
    expect(reason(jwt(key, claims({ lxm: undefined })))).toBe('claims');
    expect(reason(jwt(key, claims({ iss: `${DID}#atproto_labeler` })))).toBe('claims');
    expect(reason(jwt(key, claims({ iss: 'did:web:someone.example:path' })))).toBe('claims');
    expect(reason(jwt(key, claims(), { alg: 'HS256' }))).toBe('claims');
    expect(reason(jwt(key, claims(), { alg: 'none' }))).toBe('claims');
    for (const typ of ['at+jwt', 'refresh+jwt', 'dpop+jwt']) expect(reason(jwt(key, claims(), { typ }))).toBe('claims');
    expect(reason(jwt(key, claims({ exp: NOW / 1000 })))).toBe('expired');
    expect(reason(jwt(key, claims({ exp: NOW / 1000 + 2 * 3600 })))).toBe('claims');
    expect(reason(jwt(key, claims({ exp: String(NOW / 1000 + 60) })))).toBe('claims');
  });
});

describe('identify', () => {
  it('takes a forget token only when asked for one, and never a chat token in its place', async () => {
    const key = makeKey('secp256k1');
    const net = fakeFetch({ [DID]: didDoc(DID, key) });
    const deps = { fetch: net.impl, now: () => NOW };
    const forget = jwt(key, claims({ lxm: POE_FORGET_LXM }));
    const chat = jwt(key, claims());
    expect(POE_FORGET_LXM).toBe('to.atpota.poe.forget');
    expect(await identify(forget, { ...deps, lxm: POE_FORGET_LXM })).toEqual({ ok: true, visitor: { did: DID, handle: 'someone.example' } });
    expect(await identify(chat, { ...deps, lxm: POE_FORGET_LXM })).toEqual({ ok: false, reason: 'claims' });
    expect(await identify(forget, deps)).toEqual({ ok: false, reason: 'claims' });
    expect(readToken(forget, NOW, POE_FORGET_LXM).ok).toBe(true);
    expect(readToken(forget, NOW).ok).toBe(false);
  });

  for (const curve of ['secp256k1', 'p256'] as const) {
    it(`verifies a ${curve} token against the DID document and names the AppView's handle`, async () => {
      const key = makeKey(curve);
      const net = fakeFetch({ [DID]: didDoc(DID, key) });
      const result = await identify(jwt(key, claims()), { fetch: net.impl, now: () => NOW });
      expect(result).toEqual({ ok: true, visitor: { did: DID, handle: 'someone.example' } });
      // Cached: a second message costs no lookups.
      const before = net.calls.length;
      await identify(jwt(key, claims({ jti: 'again' })), { fetch: net.impl, now: () => NOW });
      expect(net.calls.length).toBe(before);
    });
  }

  it('verifies a plain did:web through its own did.json', async () => {
    const key = makeKey('p256');
    const did = 'did:web:someone.example';
    const net = fakeFetch({ [did]: didDoc(did, key) }, { did, handle: 'someone.example' });
    expect(await identify(jwt(key, claims({ iss: did })), { fetch: net.impl, now: () => NOW })).toEqual({
      ok: true,
      visitor: { did, handle: 'someone.example' },
    });
  });

  it('refuses a token signed by any key but the one in the document', async () => {
    const real = makeKey('secp256k1');
    const forger = makeKey('secp256k1');
    const net = fakeFetch({ [DID]: didDoc(DID, real) });
    expect(await identify(jwt(forger, claims()), { fetch: net.impl, now: () => NOW })).toEqual({ ok: false, reason: 'bad_signature' });
    // A token claiming the other curve's alg never verifies against this key.
    const p256 = makeKey('p256');
    expect(await identify(jwt(p256, claims()), { fetch: net.impl, now: () => NOW })).toEqual({ ok: false, reason: 'bad_signature' });
    // High-S is the reference verifier's "no" too.
    expect(await identify(jwt(real, claims(), {}, { highS: true }), { fetch: net.impl, now: () => NOW })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('follows a rotated key by fetching the document again, once', async () => {
    const old = makeKey('secp256k1');
    const rotated = makeKey('secp256k1');
    const docs: Record<string, unknown> = { [DID]: didDoc(DID, old) };
    const net = fakeFetch(docs);
    expect((await identify(jwt(old, claims()), { fetch: net.impl, now: () => NOW })).ok).toBe(true);
    docs[DID] = didDoc(DID, rotated);
    const plcBefore = net.calls.filter((c) => c.startsWith('https://plc.directory/')).length;
    expect((await identify(jwt(rotated, claims()), { fetch: net.impl, now: () => NOW })).ok).toBe(true);
    expect(net.calls.filter((c) => c.startsWith('https://plc.directory/')).length).toBe(plcBefore + 1);
  });

  it('reports no key for an unknown DID or an unreachable directory, without throwing', async () => {
    const key = makeKey('secp256k1');
    expect(await identify(jwt(key, claims()), { fetch: fakeFetch({}).impl, now: () => NOW })).toEqual({ ok: false, reason: 'no_key' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await identify(jwt(key, claims()), { fetch: down, now: () => NOW })).toEqual({ ok: false, reason: 'no_key' });
  });

  it("knows a visitor by DID alone when the AppView has no valid handle for them", async () => {
    const key = makeKey('secp256k1');
    for (const profile of [null, { did: DID, handle: 'handle.invalid' }, { did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz', handle: 'someone.example' }, { did: DID, handle: 'not a handle' }]) {
      clearIdentityCache();
      const net = fakeFetch({ [DID]: didDoc(DID, key) }, profile);
      expect(await identify(jwt(key, claims()), { fetch: net.impl, now: () => NOW })).toEqual({ ok: true, visitor: { did: DID, handle: null } });
    }
  });
});
