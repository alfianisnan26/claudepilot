// The public receiver `POST /hooks/<token>` (docs/prd/triggers.md FR3 to FR9, §12, R1 to R8, R11, R14, R15, R18, R22). Mounted on
// `platform.hooks`: outside `/api`, the session guard and the Origin check; its door is the provider's signature over the raw bytes.
//
// Order: the token's shape and its lookup by SHA-256 (an unknown, malformed, deleted or disabled token, and any other method or path,
// answer the SAME 404 body); Locked or Frozen: 503; `Content-Encoding` other than identity and a content type other than JSON: 415; the
// global rate (300 a minute) and a (token, address) pair that failed 5 times in 10 minutes: 429; the body, at most 1 MiB (413 before the
// rest is read, the connection closed) within 10 seconds (408); the signature (401, a fixed body, counted for that pair only so a stranger
// cannot lock the real sender out); the per-token rates (60 a minute, 600 an hour: 429 with Retry-After); JSON (400). Everything after that
// answers 200 `{"ok":true}`, whether it started a run, was filtered, a duplicate or refused by a limit: the answer never says which (FR6).
// Logs carry a trigger id, a provider and a result code; never the token, the secret or the payload.

import { HOOK_MAX_BYTES, HOOK_READ_TIMEOUT_S, HOOK_TOKEN_PREFIX } from '@portal/contracts';
import type { Context, Hono } from 'hono';
import { normalizeDelivery, verifyDelivery, deliveryIdOf } from './providers/index.js';
import type { TriggerRunner } from './runner.js';
import { recordOf, tokenHash, type TriggerStore } from './store.js';

export const RECEIVER_LIMITS = { perTokenMinute: 60, perTokenHour: 600, globalMinute: 300, failures: 5, failureWindowMs: 10 * 60_000, blockMs: 10 * 60_000 };
const TOKEN = /^cpwh_[A-Za-z0-9_-]{32}$/;
const MAP_MAX = 10_000;

export interface ReceiverDeps {
  store: TriggerStore;
  runner: TriggerRunner;
  /** The client's address as the rest of the portal reads it (the proxy's forwarded address when `trustProxy`). */
  clientAddress(c: Context): string;
  now?: () => Date;
}

const json = (c: Context, status: number, body: object, headers: Record<string, string> = {}) => c.body(JSON.stringify(body), status as never, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
const notFound = (c: Context) => json(c, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
const unauthorized = (c: Context) => json(c, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'The signature did not verify.' } });
const tooMany = (c: Context, retryS: number) => json(c, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, { 'Retry-After': String(Math.max(1, Math.ceil(retryS))) });

/** Reads at most `max` bytes within `ms`; 'too_large' or 'timeout' otherwise (and stops reading). */
export async function readBody(req: Request, max: number, ms: number): Promise<Buffer | 'too_large' | 'timeout'> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return 'too_large';
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), timeout]);
      if (r === 'timeout') {
        void reader.cancel().catch(() => undefined);
        return 'timeout';
      }
      if (r.done) break;
      total += r.value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(r.value);
    }
  } catch {
    // A body limit upstream ends the stream with an error past its cap.
    return 'too_large';
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/** Fixed-window counters, bounded in memory. */
class Windows {
  readonly #m = new Map<string, { at: number; n: number }>();
  hit(key: string, windowMs: number, now: number): number {
    const w = this.#m.get(key);
    if (!w || now - w.at >= windowMs) {
      if (this.#m.size > MAP_MAX) this.#m.clear();
      this.#m.set(key, { at: now, n: 1 });
      return 1;
    }
    w.n++;
    return w.n;
  }
  peek(key: string, windowMs: number, now: number): number {
    const w = this.#m.get(key);
    return !w || now - w.at >= windowMs ? 0 : w.n;
  }
  resetIn(key: string, windowMs: number, now: number): number {
    const w = this.#m.get(key);
    return w ? (w.at + windowMs - now) / 1000 : windowMs / 1000;
  }
}

export function mountReceiver(hooks: Hono, d: ReceiverDeps): void {
  const now = () => (d.now ?? (() => new Date()))().getTime();
  const windows = new Windows();
  const blocked = new Map<string, number>();

  hooks.post('/:token', async (c) => {
    const token = c.req.param('token') ?? '';
    // The hash is computed for every path, so the time to a 404 does not depend on the shape of the token (R1).
    const hash = tokenHash(token);
    const row = TOKEN.test(token) ? d.store.byTokenHash(hash) : null;
    if (!row || row.enabled !== 1 || !row.source || row.source !== 'webhook') return notFound(c);
    const t = recordOf(row);
    if (!t.webhook) return notFound(c);
    if (d.runner.locked() || !d.store.store.secrets) return json(c, 503, { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Not accepting deliveries now.' } });

    const enc = (c.req.header('content-encoding') ?? 'identity').trim().toLowerCase();
    if (enc !== 'identity' && enc !== '') return json(c, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send JSON without compression.' } });
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return json(c, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send JSON (application/json).' } });

    const at = now();
    if (windows.hit('global', 60_000, at) > RECEIVER_LIMITS.globalMinute) return tooMany(c, windows.resetIn('global', 60_000, at));
    const pair = `${hash.slice(0, 32)}|${d.clientAddress(c).slice(0, 64)}`;
    const until = blocked.get(pair);
    if (until && until > at) return tooMany(c, (until - at) / 1000);

    const raw = await readBody(c.req.raw, HOOK_MAX_BYTES, HOOK_READ_TIMEOUT_S * 1000);
    if (raw === 'too_large') return json(c, 413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'That request is too large.' } }, { Connection: 'close' });
    if (raw === 'timeout') return json(c, 408, { ok: false, error: { code: 'TIMEOUT', message: 'The body took too long.' } }, { Connection: 'close' });

    const secret = d.store.secret(row);
    const get = (name: string) => c.req.header(name) ?? null;
    if (!secret || !verifyDelivery(t.webhook.provider, get, raw, secret, t.webhook.gitlabAuth, at)) {
      if (windows.hit(`fail|${pair}`, RECEIVER_LIMITS.failureWindowMs, at) >= RECEIVER_LIMITS.failures) {
        if (blocked.size > MAP_MAX) blocked.clear();
        blocked.set(pair, at + RECEIVER_LIMITS.blockMs);
      }
      return unauthorized(c);
    }

    // Authenticated: the per-token rates (a stranger who learned the URL cannot use them up: they count only signed deliveries).
    const perMinute = windows.hit(`m|${t.id}`, 60_000, at);
    const perHour = windows.hit(`h|${t.id}`, 3_600_000, at);
    if (perMinute > RECEIVER_LIMITS.perTokenMinute) return tooMany(c, windows.resetIn(`m|${t.id}`, 60_000, at));
    if (perHour > RECEIVER_LIMITS.perTokenHour) return tooMany(c, windows.resetIn(`h|${t.id}`, 3_600_000, at));

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(c, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Malformed JSON.' } });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(c, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Expected a JSON object.' } });

    const atIso = new Date(at).toISOString();
    const n = normalizeDelivery(t.webhook.provider, get, body as Record<string, unknown>, t.webhook.host, atIso);
    if (n.kind === 'ignore') {
      d.store.count(t.id, 'ignored');
      return json(c, 200, { ok: true });
    }
    // Not awaited: the host gets its answer now; dedupe and the filters run before the first await inside `fire`.
    void d.runner
      .fire(t, { facts: n.facts, labels: n.labels, deliveryId: deliveryIdOf(t.webhook.provider, get, raw), actor: `webhook:${t.webhook.provider}` })
      .catch((e: Error) => console.error(`[triggers] ${t.id}: a delivery failed (${e.message.slice(0, 80)})`));
    return json(c, 200, { ok: true });
  });

  // Every other method and path under /hooks: the same 404 as an unknown token (R1, R7).
  hooks.all('*', (c) => notFound(c));
}
