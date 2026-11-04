// Request rate limits that move to the Cloudflare Worker as they are (PILOT-1138, epic PILOT-1131): no `node:` import here or in
// middleware.ts. Counting lives behind `RateLimitStore`, so the portal on Node counts in memory and the Worker can count in a Durable
// Object or the rate-limiting binding without a change to the rules or the middleware.

/** One key's fixed window: hits so far and when the window ends (ms since the epoch). */
export interface WindowCount {
  count: number;
  resetAt: number;
}

/** Where hits are counted. `hit` counts one and answers the window it fell in; it may be async (a Durable Object, a KV). */
export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): WindowCount | Promise<WindowCount>;
}

/**
 * Fixed windows in memory, bounded: at `maxKeys` a sweep drops the ended windows and, if that frees less than a tenth, the oldest tenth
 * too, so a flood of new keys pays one O(n) sweep per `maxKeys / 10` keys, not one per request. A restart forgets every count.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #hits = new Map<string, WindowCount>();

  constructor(private readonly maxKeys = 10_000) {}

  hit(key: string, windowMs: number, now: number): WindowCount {
    let w = this.#hits.get(key);
    if (!w || w.resetAt <= now) {
      if (!w && this.#hits.size >= this.maxKeys) this.#sweep(now);
      w = { count: 0, resetAt: now + windowMs };
      this.#hits.set(key, w);
    }
    w.count++;
    return { count: w.count, resetAt: w.resetAt };
  }

  #sweep(now: number) {
    for (const [k, w] of this.#hits) if (w.resetAt <= now) this.#hits.delete(k);
    const target = this.maxKeys - Math.max(1, Math.ceil(this.maxKeys / 10));
    for (const k of this.#hits.keys()) {
      if (this.#hits.size <= target) break;
      this.#hits.delete(k); // a Map keeps insertion order: the oldest windows go first
    }
  }

  /** How many keys are remembered (for tests). */
  get size() {
    return this.#hits.size;
  }
}

/** At most `limit` requests per `windowMs` for one key. `name` keeps rules apart in a shared store and names the rule in the audit. */
export interface RateRule {
  name: string;
  limit: number;
  windowMs: number;
}

export interface RateVerdict {
  ok: boolean;
  /** Whole seconds until the window ends, at least 1: the `Retry-After` a refusal carries. */
  retryAfterS: number;
  /** This is the first refusal of the window: the one worth an audit row (a flood writes one row, not one per request). */
  first: boolean;
}

/** Counts one request for `key` under `rule`. */
export async function take(store: RateLimitStore, rule: RateRule, key: string, now: number): Promise<RateVerdict> {
  const w = await store.hit(`${rule.name}:${key}`, rule.windowMs, now);
  return { ok: w.count <= rule.limit, retryAfterS: Math.max(1, Math.ceil((w.resetAt - now) / 1000)), first: w.count === rule.limit + 1 };
}

/**
 * The key an address is counted under: an IPv4 address as it is, an IPv6 address by its /64 (one subscriber's whole prefix, which a client
 * can walk through at will), anything else (`unknown`) as it is.
 */
export function addressKey(ip: string): string {
  const v4 = /^(?:::ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(':')) return ip;
  const [head = '', tail] = ip.toLowerCase().split('::', 2) as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8) return ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The seconds a 429 asks the client to wait, from the refusal's details: `retryAfterS` (the code limiter) or `retryAfter` (the identity
 * lockout, identity/throttle.ts), when a positive number, rounded up; else 60.
 */
export function retryAfterOf(details: unknown): number {
  const d = details as { retryAfterS?: unknown; retryAfter?: unknown } | null | undefined;
  for (const s of [d?.retryAfterS, d?.retryAfter]) if (typeof s === 'number' && Number.isFinite(s) && s >= 1) return Math.ceil(s);
  return 60;
}
