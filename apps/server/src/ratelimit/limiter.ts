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

/** Fixed windows in memory, bounded: past `maxKeys`, ended windows go first, then the oldest. A restart forgets every count. */
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
    for (const k of this.#hits.keys()) {
      if (this.#hits.size < this.maxKeys) break;
      this.#hits.delete(k);
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
