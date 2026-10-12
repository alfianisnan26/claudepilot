// Signature checks for the receiver (docs/prd/triggers.md FR5, §9). Every check runs over the RAW body bytes before anything is parsed and
// compares with `timingSafeEqual` on buffers of equal length. A missing, empty, malformed or truncated header is a failure, never a pass.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HOOK_TIMESTAMP_SKEW_S } from '@portal/contracts';

/** Lowercase header name to value; null when absent. */
export type HeaderGet = (name: string) => string | null;

/** Equal-length constant-time compare; different lengths are a failure (the length of a digest is public). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** A hex digest of exactly `bytes` bytes, any case; null for anything else (truncated, odd length, other characters). */
function hexDigest(v: string, bytes: number): Buffer | null {
  if (v.length !== bytes * 2 || !/^[0-9a-fA-F]+$/.test(v)) return null;
  return Buffer.from(v, 'hex');
}

export const hmacSha256 = (key: Buffer | string, data: Buffer | string): Buffer => createHmac('sha256', key).update(data).digest();

/**
 * `sha256=<hex>` (GitHub's `X-Hub-Signature-256`, also sent by Gitea): the prefix exactly, then 64 hex characters. `sha1=` and a bare
 * digest are failures.
 */
export function verifyPrefixedHmac(header: string | null, raw: Buffer, secret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const got = hexDigest(header.slice('sha256='.length), 32);
  return !!got && safeEqual(got, hmacSha256(secret, raw));
}

/** A bare hex HMAC-SHA256 (Gitea's `X-Gitea-Signature`). An empty value is a failure (Gitea sends empty headers when no secret is set). */
export function verifyBareHmac(header: string | null, raw: Buffer, secret: string): boolean {
  if (!header) return false;
  const got = hexDigest(header, 32);
  return !!got && safeEqual(got, hmacSha256(secret, raw));
}

/** A shared token sent as is (GitLab's older `X-Gitlab-Token`): both sides hashed first so the compare is of equal length. */
export function verifyPlainToken(header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return safeEqual(h(header), h(secret));
}

/** The key bytes of a `whsec_` signing token, or null when it is not `whsec_` + base64 of 16 to 128 bytes. */
export function signingKey(secret: string): Buffer | null {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) return null;
  const b64 = secret.slice('whsec_'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  const key = Buffer.from(b64, 'base64');
  return key.length >= 16 && key.length <= 128 ? key : null;
}

/**
 * The Standard Webhooks scheme GitLab's signing token uses: `webhook-signature: v1,<base64>` (several, space-separated, any may match) over
 * `{webhook-id}.{webhook-timestamp}.{body}`, keyed with the decoded token; the timestamp within ±5 minutes of now.
 */
export function verifySigningToken(get: HeaderGet, raw: Buffer, secret: string, nowMs: number): boolean {
  const key = signingKey(secret);
  const id = get('webhook-id');
  const ts = get('webhook-timestamp');
  const sig = get('webhook-signature');
  if (!key || !id || !ts || !sig || id.length > 128 || /[\r\n]/.test(id)) return false;
  if (!/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > HOOK_TIMESTAMP_SKEW_S) return false;
  const want = hmacSha256(key, Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw]));
  let ok = false;
  for (const part of sig.split(' ').slice(0, 8)) {
    const [version, b64] = part.split(',');
    if (version !== 'v1' || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
    // Every candidate is compared, so the time does not say which one matched.
    if (safeEqual(Buffer.from(b64, 'base64'), want)) ok = true;
  }
  return ok;
}
