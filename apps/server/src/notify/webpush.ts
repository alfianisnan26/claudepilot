// Web Push with node:crypto only, no dependency (docs/prd/web-app-pwa.md §11.3, §11.4):
// - RFC 8291 message encryption over RFC 8188 `aes128gcm` (one record; the Appendix A vector is a test),
// - RFC 8292 VAPID: an ES256 JWT (`aud` the push service's origin, `exp` at most 12 hours ahead, `sub` a contact) and the raw public key,
// - RFC 8030 headers: `TTL` (required), `Urgency`, and `Topic` (at most 32 URL-safe Base64 characters: the first 32 of
//   base64url(HMAC-SHA256(topic key, tag)), which also keeps ids away from push services).
// Pure functions; the keys come from vapid.ts.

import { createCipheriv, createDecipheriv, createECDH, createHmac, createPublicKey, sign, type KeyObject } from 'node:crypto';

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The most a push service must accept as a body (RFC 8030 §7.2). */
export const PUSH_BODY_MAX = 4096;
/** One record: 86 bytes of header (16 salt, 4 rs, 1 idlen, 65 key), a 16-byte tag and the 1-byte padding delimiter. */
export const PUSH_PLAINTEXT_MAX = PUSH_BODY_MAX - 86 - 16 - 1;
/** VAPID tokens live 12 hours (RFC 8292: at most 24). */
export const VAPID_TTL_S = 12 * 3600;

export interface EncryptInput {
  plaintext: Buffer;
  /** The browser's `p256dh`: an uncompressed P-256 point, 65 bytes. */
  uaPublic: Buffer;
  /** The browser's `auth`: 16 bytes. */
  authSecret: Buffer;
  /** Fixed only by the known-answer test; random otherwise. */
  asPrivate?: Buffer;
  salt?: Buffer;
}

export interface Encrypted {
  body: Buffer;
  /** Intermediate values, for the known-answer test. */
  debug: { ecdhSecret: Buffer; prkKey: Buffer; ikm: Buffer; prk: Buffer; cek: Buffer; nonce: Buffer; header: Buffer; ciphertext: Buffer };
}

/** RFC 8291 §3.4 and RFC 8188 §2: the `aes128gcm` body for one push message. */
export function encrypt(input: EncryptInput, random: (n: number) => Buffer): Encrypted {
  if (input.uaPublic.length !== 65 || input.uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point');
  if (input.authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  if (input.plaintext.length > PUSH_PLAINTEXT_MAX) throw new Error('payload too large');
  const ecdh = createECDH('prime256v1');
  if (input.asPrivate) ecdh.setPrivateKey(input.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = input.salt ?? random(16);
  const ecdhSecret = ecdh.computeSecret(input.uaPublic);
  const prkKey = hmac(input.authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), input.uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const header = Buffer.concat([salt, Buffer.from([0, 0, 0x10, 0]), Buffer.from([asPublic.length]), asPublic]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([input.plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  return { body: Buffer.concat([header, ciphertext]), debug: { ecdhSecret, prkKey, ikm, prk, cek, nonce, header, ciphertext } };
}

/** What a browser does with a push (RFC 8291 §3.4 from the receiving side): used by tests and the stand-in push service. */
export function decrypt(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  const end = padded.lastIndexOf(2);
  if (end < 0) throw new Error('no padding delimiter');
  return padded.subarray(0, end);
}

/** Whether `p256dh` is a P-256 point a key agreement accepts (the curve check is the ECDH computation itself). */
export function validP256(point: Buffer): boolean {
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(point);
    return true;
  } catch {
    return false;
  }
}

/** The raw uncompressed public point (65 bytes) of a P-256 key. */
export function rawPublicKey(key: KeyObject): Buffer {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

/** RFC 8292 §2: the JWT and the `Authorization: vapid t=…, k=…` header for one push service origin. */
export function vapidAuthorization(opts: { endpoint: string; privateKey: KeyObject; publicKey: Buffer; subject: string | null; nowS: number; ttlS?: number }): { header: string; claims: { aud: string; exp: number; sub?: string } } {
  const aud = new URL(opts.endpoint).origin;
  const exp = opts.nowS + Math.min(opts.ttlS ?? VAPID_TTL_S, 24 * 3600);
  const claims = { aud, exp, ...(opts.subject ? { sub: opts.subject } : {}) };
  const input = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify(claims))}`;
  const sig = sign('sha256', Buffer.from(input), { key: opts.privateKey, dsaEncoding: 'ieee-p1363' });
  return { header: `vapid t=${input}.${b64u(sig)}, k=${b64u(opts.publicKey)}`, claims };
}

/** RFC 8030 §5.4: at most 32 characters of the URL-safe Base64 alphabet, derived so it hides the tag. */
export function topicOf(topicKey: Buffer, tag: string): string {
  return createHmac('sha256', topicKey).update(tag).digest('base64url').slice(0, 32);
}

/** The request headers of one push. */
export function pushHeaders(opts: { authorization: string; ttlS: number; urgency: string; topic: string }): Record<string, string> {
  return {
    TTL: String(Math.max(0, Math.floor(opts.ttlS))),
    Urgency: opts.urgency,
    Topic: opts.topic,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: opts.authorization,
  };
}

/** Push services this version knows (from third-party descriptions, not a vendor list): anything else is flagged, never refused. */
const KNOWN_PUSH = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export const knownPushService = (host: string | null): boolean => !!host && KNOWN_PUSH.some((re) => re.test(host));
