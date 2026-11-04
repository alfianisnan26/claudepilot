// The Connect handshake's signature on WebCrypto (PILOT-1144): the same bytes as apps/server/src/connect/tunnel/auth.ts (node:crypto), but
// runnable in Node 22, browsers and Cloudflare Workers alike, so the Worker's /bridge endpoint (apps/core-worker) and any client can share it.
// Ed25519, no prehash, over `connectSignedMessage(connId, nonce, nodeId)`. Wire forms as in auth.ts: the public key is the raw 32 bytes,
// the private key is PKCS8 DER and a signature is the raw 64 bytes, all base64url. `CONNECT_TEST_VECTORS.handshake` fixes the bytes.
//
// Portable on purpose: no Buffer, no atob, no DOM or Node types (this package's typecheck has neither); WebCrypto is reached through
// `globalThis.crypto` with the small structural type below.

import { connectSignedMessage } from './connect.js';

interface SubtleLike {
  importKey(format: 'raw' | 'pkcs8', key: Uint8Array, algorithm: { name: 'Ed25519' }, extractable: boolean, usages: string[]): Promise<unknown>;
  sign(algorithm: { name: 'Ed25519' }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: { name: 'Ed25519' }, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

const subtle = (): SubtleLike => {
  const c = (globalThis as unknown as { crypto?: { subtle?: SubtleLike } }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available here.');
  return c.subtle;
};

const ED25519 = { name: 'Ed25519' } as const;
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes to base64url without padding. */
export function connectB64u(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64U[n >> 18]! + B64U[(n >> 12) & 63]! + B64U[(n >> 6) & 63]! + B64U[n & 63]!;
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i]! << 16;
    out += B64U[n >> 18]! + B64U[(n >> 12) & 63]!;
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64U[n >> 18]! + B64U[(n >> 12) & 63]! + B64U[(n >> 6) & 63]!;
  }
  return out;
}

/** Strict base64url (no padding, canonical) to bytes; null when it isn't. */
export function connectFromB64u(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of s) {
    acc = ((acc << 6) | B64U.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, so one value has one spelling (a replayed signature can't be re-spelled to look new).
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/** UTF-8 bytes of a string (TextEncoder through globalThis; every runtime this module targets has it). */
const utf8 = (s: string): Uint8Array => new (globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }).TextEncoder().encode(s);

const PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** PKCS8 DER (base64url) for a 32-byte Ed25519 seed: what auth.ts `keyPairFromSeed` makes. */
export function connectPkcs8FromSeed(seed: Uint8Array): string {
  if (seed.length !== 32) throw new Error('An Ed25519 seed is 32 bytes.');
  const der = new Uint8Array(48);
  der.set(PKCS8_PREFIX, 0);
  der.set(seed, 16);
  return connectB64u(der);
}

/** Checks the handshake signature; false for anything wrong with the key, the signature or the message, never an exception. */
export async function connectVerifyChallenge(publicKey: string, signature: string, connId: string, nonce: string, nodeId: string): Promise<boolean> {
  try {
    const raw = connectFromB64u(publicKey);
    const sig = connectFromB64u(signature);
    if (!raw || raw.length !== 32 || !sig || sig.length !== 64) return false;
    const s = subtle();
    const key = await s.importKey('raw', raw, ED25519, false, ['verify']);
    return await s.verify(ED25519, key, sig, utf8(connectSignedMessage(connId, nonce, nodeId)));
  } catch {
    return false;
  }
}

/** Signs the handshake with a PKCS8 private key (base64url): the agent's side, and tests. */
export async function connectSignChallenge(privateKey: string, connId: string, nonce: string, nodeId: string): Promise<string> {
  const der = connectFromB64u(privateKey);
  if (!der) throw new Error('The private key is not base64url.');
  const s = subtle();
  const key = await s.importKey('pkcs8', der, ED25519, false, ['sign']);
  return connectB64u(new Uint8Array(await s.sign(ED25519, key, utf8(connectSignedMessage(connId, nonce, nodeId)))));
}

/** SHA-256 of a string's UTF-8 bytes, lowercase hex. */
export async function connectSha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await subtle().digest('SHA-256', utf8(text)));
  let out = '';
  for (const b of d) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Equal-length strings compared without an early exit (different lengths are unequal at once: compare fixed-length digests). */
export function connectTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
