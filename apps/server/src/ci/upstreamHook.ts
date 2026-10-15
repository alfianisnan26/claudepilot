// The upstream webhook `POST /hooks/ci/<remote id>` (local-git-ci PRD FR8a, T-486 S2): a Git host announces a push, and the remote's next
// upstream sync becomes due now. Mounted outside /api, the session guard and the Origin check: its door is the host's signature over the raw
// body, keyed with the remote's hook secret (a Secrets & env NAME, its value read in memory from the remote's workspace; never a literal).
//
// Order: the source address's refusal bucket (30 refused requests a minute: junk spends only its own address's bucket, never a hook's) and a
// (remote, address) pair that failed 5 times in 10 minutes (429); the body, at most 1 MiB within 10 s
// (413, 408); then the remote, its hook key, the signature (GitHub `X-Hub-Signature-256: sha256=<hex>`, or Gitea `X-Gitea-Signature: <hex>`)
// and the seam acting as the remote's owner (can operate the ci_repo). ANY of those refused answers the same 404 as a remote that does not
// exist, and counts against the pair. Accepted: 202 `{"ok":true}`. It never fetches here: `kickUpstream` makes the detached, one-at-a-time
// sync due, and coalesces kicks (one more after a sync that is running, at most one sync per remote every UPSTREAM_HOOK_GAP_MS).
// Logs carry nothing of the body, the signature or the key.

import { HOOK_MAX_BYTES, HOOK_READ_TIMEOUT_S, objectRef } from '@portal/contracts';
import { createHmac, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { asUser, can, ownersOf } from '../authz/seam.js';
import { config } from '../config.js';
import { verifyBareHmac, verifyPrefixedHmac } from '../triggers/providers/signature.js';
import { readBody } from '../triggers/receiver.js';
import type { CiService } from './service.js';

export const CI_HOOK_LIMITS = { hookMinute: 120, addressMinute: 30, failures: 5, failureWindowMs: 10 * 60_000, blockMs: 10 * 60_000 };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAP_MAX = 10_000;

export interface CiHookDeps {
  /** The client's address (default: as the triggers' receiver reads it, the proxy's forwarded one when `trustProxy`). */
  clientAddress?(c: Context): string;
  now?: () => number;
  /** Called with the body when there is no hook key (default: an HMAC over it with a per-process random key). A test spies on it. */
  dummyCheck?(raw: Buffer): void;
}

const DUMMY_KEY = randomBytes(32);
/** An HMAC-SHA256 over the body with a key made at start, thrown away: timing cover for a refusal that has no real key. */
export function burnHmac(raw: Buffer): void {
  createHmac('sha256', DUMMY_KEY).update(raw).digest();
}

const portalAddress = (c: Context): string => {
  const forwarded = config.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded || ((c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'unknown');
};

const json = (c: Context, status: number, body: object, headers: Record<string, string> = {}) =>
  c.body(JSON.stringify(body), status as never, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
const notFound = (c: Context) => json(c, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
const tooMany = (c: Context, retryS: number) =>
  json(c, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, { 'Retry-After': String(Math.max(1, Math.ceil(retryS))) });

/** Did the host sign `raw` with `key`? GitHub's prefixed header first, then Gitea's bare one; a missing or malformed header is a no. */
export function signedBy(get: (name: string) => string | null, raw: Buffer, key: string): boolean {
  const github = verifyPrefixedHmac(get('x-hub-signature-256'), raw, key);
  const gitea = verifyBareHmac(get('x-gitea-signature'), raw, key);
  return github || gitea;
}

export function createCiHookRoutes(ci: Pick<CiService, 'upstreamHookKey' | 'kickUpstream'>, d: CiHookDeps = {}): Hono {
  const hooks = new Hono();
  const now = d.now ?? Date.now;
  const address = d.clientAddress ?? portalAddress;
  const dummyCheck = d.dummyCheck ?? burnHmac;
  // Unverified traffic is charged to its source address (refusals only); verified traffic to its hook. They never share a bucket.
  const addressBuckets = new Map<string, { at: number; n: number }>();
  const hookBuckets = new Map<string, { at: number; n: number }>();
  const failures = new Map<string, { at: number; n: number }>();
  const blocked = new Map<string, number>();

  hooks.post('/:id', async (c) => {
    const id = c.req.param('id') ?? '';
    const at = now();
    const addr = address(c).slice(0, 64);
    const ab = addressBuckets.get(addr);
    if (ab && at - ab.at < 60_000 && ab.n >= CI_HOOK_LIMITS.addressMinute) return tooMany(c, (ab.at + 60_000 - at) / 1000);
    const pair = `${id.slice(0, 64)}|${addr}`;
    const until = blocked.get(pair);
    if (until && until > at) return tooMany(c, (until - at) / 1000);

    const raw = await readBody(c.req.raw, HOOK_MAX_BYTES, HOOK_READ_TIMEOUT_S * 1000);
    if (raw === 'too_large') return json(c, 413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'That request is too large.' } }, { Connection: 'close' });
    if (raw === 'timeout') return json(c, 408, { ok: false, error: { code: 'TIMEOUT', message: 'The body took too long.' } }, { Connection: 'close' });

    const refuse = () => {
      const cur = addressBuckets.get(addr);
      const b = cur && at - cur.at < 60_000 ? cur : { at, n: 0 };
      b.n++;
      if (addressBuckets.size > MAP_MAX) addressBuckets.clear();
      addressBuckets.set(addr, b);
      const f = failures.get(pair);
      const w = f && at - f.at < CI_HOOK_LIMITS.failureWindowMs ? f : { at, n: 0 };
      w.n++;
      if (failures.size > MAP_MAX) failures.clear();
      failures.set(pair, w);
      if (w.n >= CI_HOOK_LIMITS.failures) {
        if (blocked.size > MAP_MAX) blocked.clear();
        blocked.set(pair, at + CI_HOOK_LIMITS.blockMs);
      }
      return notFound(c);
    };

    const hook = ID.test(id) ? ci.upstreamHookKey(id) : null;
    // No key to check against: do the same HMAC work with a throwaway key, so an unknown id or a remote with no secret takes about as long.
    if (!hook) {
      dummyCheck(raw);
      return refuse();
    }
    if (!signedBy((name) => c.req.header(name) ?? null, raw, hook.key)) return refuse();
    // Signed: the seam decides as the remote's owner (a job acting for them), like a trigger acting for its owner.
    const ref = objectRef('ci_repo', id);
    const owner = ownersOf(ref)[0];
    if (!owner || !can(asUser(owner, 'ci-upstream-hook'), 'operate', ref).allow) return refuse();
    // Verified: counted against this hook only.
    const hb = hookBuckets.get(id);
    const hw = hb && at - hb.at < 60_000 ? hb : { at, n: 0 };
    if (++hw.n > CI_HOOK_LIMITS.hookMinute) return tooMany(c, (hw.at + 60_000 - at) / 1000);
    if (hookBuckets.size > MAP_MAX) hookBuckets.clear();
    hookBuckets.set(id, hw);
    ci.kickUpstream(id);
    return json(c, 202, { ok: true });
  });

  // Every other method is no route (the table above is all CI_HOOK_POLICIES declares): the same 404 body.
  hooks.notFound((c) => notFound(c));
  return hooks;
}
