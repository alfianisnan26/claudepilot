// Exec ids the proxy has seen created (docs/prd/targets-connect.md §11.4, appendix A): `start`, `resize` and `inspect` are allowed only
// for an exec that was made through this agent, for a managed container, within the last 24 hours. An id the agent never saw (made by
// something else on the host, or before the agent restarted) is `unmanaged`: it could belong to any container.
export const EXEC_TTL_MS = 24 * 60 * 60 * 1000;

export class ExecIds {
  readonly #ids = new Map<string, { container: string; at: number }>();

  constructor(
    private readonly opts: { ttlMs?: number; max?: number; now?: () => number } = {},
  ) {}

  #now = () => (this.opts.now ?? Date.now)();

  add(execId: string, containerId: string): void {
    const now = this.#now();
    this.#ids.delete(execId);
    this.#ids.set(execId, { container: containerId, at: now });
    this.#prune(now);
  }

  /** The container the exec was made for, or null when it is unknown or older than the lifetime. */
  get(execId: string): string | null {
    const found = this.#ids.get(execId);
    if (!found) return null;
    if (this.#now() - found.at > (this.opts.ttlMs ?? EXEC_TTL_MS)) {
      this.#ids.delete(execId);
      return null;
    }
    return found.container;
  }

  get size(): number {
    return this.#ids.size;
  }

  #prune(now: number): void {
    const ttl = this.opts.ttlMs ?? EXEC_TTL_MS;
    const max = this.opts.max ?? 10_000;
    for (const [id, v] of this.#ids) {
      if (now - v.at <= ttl && this.#ids.size <= max) break; // insertion order is age order
      this.#ids.delete(id);
    }
  }
}
