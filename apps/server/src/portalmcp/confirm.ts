import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Server confirmation for destructive tools (portal-mcp PRD §14.1, layer 3). The first call returns what
// will be lost and a `confirm_token`; the second repeats the arguments with the token. A token is single use,
// valid for 5 minutes, and bound to the caller, the tool, the arguments (without the token itself), the
// resolved target and a hash of the preview: if anything differs at confirm time, a new confirmation is asked.
//
// The model can complete this step alone. It stops accidental one-shot calls and shows the blast radius; real
// protection comes from scopes, the annotations clients prompt on, and the guards (§14.1).

const TTL_MS = 5 * 60_000;
const MAX_PENDING = 500;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Stable JSON: object keys sorted, so equal arguments hash equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const hashArgs = (args: Record<string, unknown>): string => {
  const { confirm_token: _token, ...rest } = args;
  return sha(canonical(rest));
};

interface Pending {
  principalId: string;
  tool: string;
  argsHash: string;
  target: string;
  previewHash: string;
  expiresAt: number;
}

export type ConfirmOutcome =
  /** A valid token for exactly this call: go ahead (it is used up). */
  | { status: 'confirmed' }
  /** No token, or one that no longer fits: show this and ask again. */
  | { status: 'required'; confirmToken: string; changed: boolean; expiresInSeconds: number };

export class Confirmations {
  readonly #pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Checks `token` against this call, or issues a new one. `changed` is set when a token was presented
   * but the preview or the target is no longer what it was bound to (the blast radius moved).
   */
  check(call: { principalId: string; tool: string; args: Record<string, unknown>; preview: unknown; target?: string }, token: string | undefined): ConfirmOutcome {
    const now = this.now();
    this.#sweep(now);
    const argsHash = hashArgs(call.args);
    const previewHash = sha(canonical(call.preview));
    const target = call.target ?? '';
    let changed = false;
    if (token) {
      // Looked up by digest, so how long a lookup takes says nothing about the token.
      const key = sha(token);
      const p = this.#pending.get(key);
      if (p && p.expiresAt > now && p.principalId === call.principalId && p.tool === call.tool && same(p.argsHash, argsHash)) {
        if (p.target === target && same(p.previewHash, previewHash)) {
          this.#pending.delete(key); // single use
          return { status: 'confirmed' };
        }
        this.#pending.delete(key);
        changed = true;
      }
    }
    if (this.#pending.size >= MAX_PENDING) this.#evictOldest();
    const confirmToken = `cfm_${randomBytes(24).toString('base64url')}`;
    this.#pending.set(sha(confirmToken), { principalId: call.principalId, tool: call.tool, argsHash, target, previewHash, expiresAt: now + TTL_MS });
    return { status: 'required', confirmToken, changed, expiresInSeconds: TTL_MS / 1000 };
  }

  /** Drops what a revoked token had pending. */
  forget(principalId: string) {
    for (const [k, v] of this.#pending) if (v.principalId === principalId) this.#pending.delete(k);
  }

  get size() {
    return this.#pending.size;
  }

  #sweep(now: number) {
    for (const [k, v] of this.#pending) if (v.expiresAt <= now) this.#pending.delete(k);
  }

  #evictOldest() {
    const first = this.#pending.keys().next();
    if (!first.done) this.#pending.delete(first.value);
  }
}

/** Constant-time equality for two hex digests. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
