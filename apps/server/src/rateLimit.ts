/** Most addresses remembered at once; past it, expired ones go first, then the oldest. */
const MAX_KEYS = 10_000;

/** Fixed-window counter per key (client address): enough to stop guessing the code. */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  blocked(key: string): boolean {
    const hit = this.#hits.get(key);
    if (!hit) return false;
    if (hit.resetAt <= Date.now()) {
      this.#hits.delete(key);
      return false;
    }
    return hit.count >= this.limit;
  }

  fail(key: string) {
    const now = Date.now();
    const hit = this.#hits.get(key);
    if (!hit || hit.resetAt <= now) {
      if (!hit && this.#hits.size >= MAX_KEYS) this.#sweep(now);
      this.#hits.set(key, { count: 1, resetAt: now + this.windowMs });
    } else hit.count++;
  }

  reset(key: string) {
    this.#hits.delete(key);
  }

  /** Addresses tried from all over would otherwise stay in memory for as long as the portal runs. */
  #sweep(now: number) {
    for (const [key, hit] of this.#hits) if (hit.resetAt <= now) this.#hits.delete(key);
    for (const key of this.#hits.keys()) {
      if (this.#hits.size < MAX_KEYS) break;
      this.#hits.delete(key);
    }
  }

  /** How many addresses are remembered (for tests). */
  get size() {
    return this.#hits.size;
  }
}
