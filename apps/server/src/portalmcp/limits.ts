// Portal MCP rate limits (portal-mcp PRD §14.5). Fixed windows, in memory: a restart gives everyone a
// fresh allowance, which is fine for a limit whose job is to stop floods and runaway loops.

export interface LimitResult {
  ok: boolean;
  /** Seconds until the window resets (always set when `ok` is false). */
  retryAfterSeconds: number;
}

export class WindowLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one hit against `limit` per `windowMs` for `key`. */
  hit(key: string, limit: number, windowMs: number): LimitResult {
    const now = this.now();
    if (this.#hits.size > 5_000) this.#sweep(now);
    let entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.#hits.set(key, entry);
    }
    entry.count++;
    return { ok: entry.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  #sweep(now: number) {
    for (const [k, v] of this.#hits) if (v.resetAt <= now) this.#hits.delete(k);
  }
}

export interface Limits {
  /** Requests without a valid token, per client address, per minute. */
  unauthenticatedPerMinute: number;
  /** Tool calls per admin token. */
  readPerMinute: number;
  writePerMinute: number;
  destructivePer10Minutes: number;
  /** Tool calls per agent token (one per chat session): a looping or injected agent is stopped sooner. */
  agentReadPerMinute: number;
  agentWritePerMinute: number;
}

export const DEFAULT_LIMITS: Limits = {
  unauthenticatedPerMinute: 120,
  readPerMinute: 120,
  writePerMinute: 30,
  destructivePer10Minutes: 10,
  agentReadPerMinute: 60,
  agentWritePerMinute: 20,
};

export type CallClass = 'read' | 'write' | 'destructive';

/** The limits the endpoint applies: per client address before a token is known, per token (and per tool) after. */
export class PortalLimits {
  readonly #limiter: WindowLimiter;

  constructor(
    readonly limits: Limits = DEFAULT_LIMITS,
    now: () => number = Date.now,
  ) {
    this.#limiter = new WindowLimiter(now);
  }

  /** One request from `ip` that has no valid token. */
  unauthenticated(ip: string): LimitResult {
    return this.#limiter.hit(`ip:${ip}`, this.limits.unauthenticatedPerMinute, 60_000);
  }

  /** One tool call by a token. An agent's token has its own, lower allowance and no destructive class. */
  call(tokenId: string, kind: CallClass, agent = false): LimitResult {
    if (agent) {
      return kind === 'read'
        ? this.#limiter.hit(`tok:${tokenId}:read`, this.limits.agentReadPerMinute, 60_000)
        : this.#limiter.hit(`tok:${tokenId}:write`, this.limits.agentWritePerMinute, 60_000);
    }
    switch (kind) {
      case 'read':
        return this.#limiter.hit(`tok:${tokenId}:read`, this.limits.readPerMinute, 60_000);
      case 'write':
        return this.#limiter.hit(`tok:${tokenId}:write`, this.limits.writePerMinute, 60_000);
      case 'destructive':
        return this.#limiter.hit(`tok:${tokenId}:destructive`, this.limits.destructivePer10Minutes, 600_000);
    }
  }

  /** One call of one tool that declared its own rate (a proposal, anything that fills a queue). */
  tool(tokenId: string, tool: string, rate: { perMinute?: number; perHour?: number }): LimitResult {
    const minute = rate.perMinute ? this.#limiter.hit(`tool:${tokenId}:${tool}:m`, rate.perMinute, 60_000) : null;
    const hour = rate.perHour ? this.#limiter.hit(`tool:${tokenId}:${tool}:h`, rate.perHour, 3_600_000) : null;
    if (minute && !minute.ok) return minute;
    if (hour && !hour.ok) return hour;
    return { ok: true, retryAfterSeconds: 0 };
  }
}
