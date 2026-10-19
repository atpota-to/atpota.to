import { createHash } from 'node:crypto';

/**
 * Record keys and blob CIDs worked out locally, so a record's at:// URI and its image
 * references are known before anything is uploaded (the site's head tags point at them
 * at build time).
 *
 *   TID  13 characters of base32-sortable: 53 bits of microseconds since the epoch, then a
 *        10-bit clock id (https://atproto.com/specs/tid)
 *   CID  for a blob: CIDv1, raw codec, sha2-256, base32 with the "b" prefix ("bafkrei...")
 */

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

export function isTid(value: string): boolean {
  return TID_RE.test(value);
}

/** A TID for this moment (milliseconds) and clock id 0..1023. */
export function tidFromTime(ms: number, clockId = 0): string {
  let v = (BigInt(Math.trunc(ms)) * 1000n << 10n) | BigInt(clockId & 1023);
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = S32[Number(v & 31n)]! + out;
    v >>= 5n;
  }
  return out;
}

/** Milliseconds since the epoch encoded in a TID. */
export function tidTime(tid: string): number {
  if (!isTid(tid)) throw new Error(`not a TID: ${tid}`);
  let v = 0n;
  for (const ch of tid) v = (v << 5n) | BigInt(S32.indexOf(ch));
  return Number((v >> 10n) / 1000n);
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The CID a PDS gives these bytes when they are uploaded as a blob. */
export function blobCid(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest();
  // CIDv1 (0x01), raw codec (0x55), sha2-256 (0x12), 32-byte digest (0x20)
  return `b${base32(Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}
