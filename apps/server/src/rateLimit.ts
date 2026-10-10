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
    if (!hit || hit.resetAt <= now) this.#hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else hit.count++;
  }

  reset(key: string) {
    this.#hits.delete(key);
  }
}
