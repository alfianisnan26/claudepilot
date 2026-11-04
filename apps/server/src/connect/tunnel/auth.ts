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
import { connectPublicKeyProblem, connectRekeyMessage, connectSignedMessage } from '@portal/contracts';

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

/**
 * Why `publicKey` can't be a node's key, or null when it is 32 bytes that form an Ed25519 public key of large order. The check lives in the
 * contract (`connectPublicKeyProblem`, PILOT-1172) so the Worker's BRIDGE_CLUSTERS registry refuses exactly the keys the portal refuses.
 */
export const publicKeyProblem = (publicKey: unknown): string | null => connectPublicKeyProblem(publicKey);

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
