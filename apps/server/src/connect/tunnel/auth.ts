// Node keys and the handshake's signature (docs/prd/targets-connect.md §9.2, §10): an agent makes an Ed25519 key pair, keeps the private half
// and sends the public half with its enrollment token; every tunnel connection is then authenticated by signing the portal's challenge,
// so no clock is involved. The wire forms are base64url throughout: the public key is the raw 32 bytes, the private key is PKCS8 DER
// (`identity.json`, §10.3) and a signature is the raw 64 bytes. `CONNECT_TEST_VECTORS.handshake` fixes the bytes; auth.test.ts checks them.
//
// Shared by the portal and the agent: only `node:*` and the contract are imported.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { connectRekeyMessage, connectSignedMessage } from '@portal/contracts';

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export interface NodeKeyPair {
  /** Ed25519 public key, the raw 32 bytes, base64url. */
  publicKey: string;
  /** PKCS8 DER, base64url (what `identity.json` keeps). */
  privateKey: string;
}

export function generateNodeKeyPair(): NodeKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { publicKey: b64u(spki.subarray(spki.length - 32)), privateKey: b64u(privateKey.export({ format: 'der', type: 'pkcs8' })) };
}

/** The key pair for a 32-byte seed (the contract's vectors use bytes 0..31). */
export function keyPairFromSeed(seed: Uint8Array): NodeKeyPair {
  const der = Buffer.concat([PKCS8_PREFIX, seed]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return { publicKey: publicKeyOf(b64u(der)), privateKey: b64u(priv.export({ format: 'der', type: 'pkcs8' })) };
}

const privateKeyObject = (privateKey: string): KeyObject => createPrivateKey({ key: fromB64u(privateKey), format: 'der', type: 'pkcs8' });

const publicCache = new Map<string, KeyObject>();
function publicKeyObject(publicKey: string): KeyObject {
  let k = publicCache.get(publicKey);
  if (!k) {
    k = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, fromB64u(publicKey)]), format: 'der', type: 'spki' });
    if (publicCache.size >= 256) publicCache.delete(publicCache.keys().next().value as string);
    publicCache.set(publicKey, k);
  }
  return k;
}

/** The public key (raw 32 bytes, base64url) of a PKCS8 private key. */
export function publicKeyOf(privateKey: string): string {
  const spki = createPublicKey(privateKeyObject(privateKey)).export({ format: 'der', type: 'spki' });
  return b64u(spki.subarray(spki.length - 32));
}

/** First 32 hex characters of SHA-256 over the raw public key: shown on the portal and by `pilot-agent doctor`, so a person can compare. */
export function keyFingerprint(publicKey: string): string {
  return sha256Hex(fromB64u(publicKey)).slice(0, 32);
}

/** Whether 32 bytes encode a point of the Ed25519 curve (RFC 8032 §5.1.3). Any 32 bytes load as a key; most are not on the curve. */
function onCurve(raw: Buffer): boolean {
  const P = (1n << 255n) - 19n;
  const D = (((-121665n * modInv(121666n, P)) % P) + P) % P;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(raw[i]!);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  // x = u v^3 (u v^7)^((p-5)/8)
  const v3 = (v * v * v) % P;
  const v7 = (v3 * v3 * v) % P;
  let x = (((u * v3) % P) * modPow((u * v7) % P, (P - 5n) / 8n, P)) % P;
  const vx2 = (v * x * x) % P;
  if (vx2 !== u) {
    if (vx2 !== (P - u) % P) return false;
    x = (x * modPow(2n, (P - 1n) / 4n, P)) % P;
  }
  if (x === 0n && sign === 1n) return false;
  return true;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

const modInv = (a: bigint, mod: bigint): bigint => modPow(a, mod - 2n, mod);

/** Why `publicKey` can't be a node's key, or null when it is 32 bytes that form an Ed25519 public key. */
export function publicKeyProblem(publicKey: unknown): string | null {
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(publicKey)) return 'The key must be 32 bytes, base64url.';
  const raw = fromB64u(publicKey);
  if (raw.length !== 32 || b64u(raw) !== publicKey) return 'The key must be 32 bytes, base64url.';
  if (!onCurve(raw)) return 'That is not an Ed25519 public key.';
  return null;
}

/** Signs `message` (UTF-8) with an Ed25519 key, no prehash. */
export const signMessage = (privateKey: string, message: string): string => b64u(edSign(null, Buffer.from(message, 'utf8'), privateKeyObject(privateKey)));

/** Checks a signature; false for anything wrong with the key, the signature or the message, never an exception. */
export function verifyMessage(publicKey: string, signature: string, message: string): boolean {
  try {
    const sig = fromB64u(signature);
    if (sig.length !== 64) return false;
    return edVerify(null, Buffer.from(message, 'utf8'), publicKeyObject(publicKey), sig);
  } catch {
    return false;
  }
}

export const signChallenge = (privateKey: string, connId: string, nonce: string, nodeId: string): string => signMessage(privateKey, connectSignedMessage(connId, nonce, nodeId));
export const verifyChallenge = (publicKey: string, signature: string, connId: string, nonce: string, nodeId: string): boolean =>
  verifyMessage(publicKey, signature, connectSignedMessage(connId, nonce, nodeId));

/** A key rotation: the NEW public key, signed with the OLD private key. */
export const signRekey = (oldPrivateKey: string, nodeId: string, newPublicKey: string): string => signMessage(oldPrivateKey, connectRekeyMessage(nodeId, newPublicKey));
export const verifyRekey = (oldPublicKey: string, signature: string, nodeId: string, newPublicKey: string): boolean =>
  verifyMessage(oldPublicKey, signature, connectRekeyMessage(nodeId, newPublicKey));

/** 32 random bytes, base64url: good for one connection and ten seconds. */
export const newNonce = (): string => b64u(randomBytes(32));
export const newConnId = (): string => randomUUID();
/** 8 hex characters to follow a request across the tunnel in both sides' logs. */
export const newTrace = (): string => randomBytes(4).toString('hex');

/** A public key that exists only to spend the same time when a node is unknown as when its signature is checked. */
const DUMMY = generateNodeKeyPair();
const DUMMY_SIG = signMessage(DUMMY.privateKey, 'claudepilot-connect-dummy');
export function spendVerifyTime(): void {
  verifyMessage(DUMMY.publicKey, DUMMY_SIG, 'claudepilot-connect-dummy');
}
