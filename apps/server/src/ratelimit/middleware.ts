// The Hono front door for request limits (PILOT-1138). Portable like limiter.ts: Hono runs on Node and on Workers, nothing here is `node:`.
//
// A refused request gets 429 with `Retry-After`, before any route reads its body or its token. The first refusal of a window calls
// `onLimited` once, with the rule's name, the method and the key (a client address) only: never the path, the query or a header, so a
// token in any of them cannot reach an audit row or a log through here.
import type { Context, MiddlewareHandler } from 'hono';
import { take, type RateLimitStore, type RateRule, type RateVerdict } from './limiter.js';

export interface LimitedEvent {
  rule: string;
  method: string;
  key: string;
  retryAfterS: number;
}

export interface RateLimitOptions {
  store: RateLimitStore;
  rule: RateRule;
  /** What is counted (a client address). null lets the request through uncounted. */
  key: (c: Context) => string | null;
  /** Once per key and window, at its first refusal. Must not throw; if it does, the refusal still goes out. */
  onLimited?: (e: LimitedEvent) => void;
  /** The 429 body; `Retry-After` is set by the middleware whatever this returns. */
  refuse?: (c: Context, v: RateVerdict) => Response;
  now?: () => number;
}

const defaultRefuse = (c: Context) => c.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment.' } }, 429);

export function rateLimit(o: RateLimitOptions): MiddlewareHandler {
  const now = o.now ?? Date.now;
  return async (c, next) => {
    const key = o.key(c);
    if (key === null) return next();
    const v = await take(o.store, o.rule, key, now());
    if (v.ok) return next();
    if (v.first) {
      try {
        o.onLimited?.({ rule: o.rule.name, method: c.req.method, key, retryAfterS: v.retryAfterS });
      } catch {
        // an audit failure never turns a refusal into a pass
      }
    }
    const res = (o.refuse ?? defaultRefuse)(c, v);
    res.headers.set('Retry-After', String(v.retryAfterS));
    return res;
  };
}
