import { createHash, randomBytes } from 'node:crypto';
import type { Actor } from '@portal/contracts';

/**
 * App ports (docs/prd/app-ports.md §4): the one-time codes the portal mints for an open, and the cookies an app host swaps them for. Both live
 * in memory only (a portal restart signs every app host out; the owner opens it again). Keys are SHA-256 of the value, so a heap dump of this
 * map holds no usable code or cookie. Neither value is ever logged.
 */

/** What an open is bound to: who, which workspace and port, which app host, and the portal page that asked (for frame-ancestors). */
export interface AppGrant {
  workspaceId: string;
  port: number;
  /** The app host exactly as the browser sends it in `Host` (lowercase, with the portal's port when it has one). */
  host: string;
  /** The portal session that opened it: the app host's cookie dies with it (sign-out, a new server code, expiry). */
  sessionToken: string;
  actor: Actor;
  /** `https://pilot.example` — the only page that may frame the app host. */
  portalOrigin: string;
  /** The scheme the app host is reached with (the portal page's): the cookie is Secure on https. */
  scheme: 'http' | 'https';
}

/** The cookie on an app host. Never forwarded to the app. */
export const APP_COOKIE = '__pilot_app';

const CODE_TTL_MS = 30_000;
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CODES = 1000;
const MAX_COOKIES = 5000;

const hash = (v: string) => createHash('sha256').update(v).digest('base64url');
/** 32 random bytes, base64url: what a code and a cookie are. */
const fresh = () => randomBytes(32).toString('base64url');

export class AppPortGrants {
  readonly #codes = new Map<string, AppGrant & { expiresAt: number }>();
  readonly #cookies = new Map<string, AppGrant & { expiresAt: number; createdAt?: number; lastUsedAt?: number }>();
  readonly #now: () => number;
  readonly codeTtlMs: number;
  readonly cookieTtlMs: number;

  constructor(opts: { now?: () => number; codeTtlMs?: number; cookieTtlMs?: number } = {}) {
    this.#now = opts.now ?? Date.now;
    this.codeTtlMs = opts.codeTtlMs ?? CODE_TTL_MS;
    this.cookieTtlMs = opts.cookieTtlMs ?? COOKIE_TTL_MS;
  }

  /** A one-time code for this grant: valid `codeTtlMs`, once. */
  mint(grant: AppGrant): { code: string; expiresAt: number } {
    this.#sweep();
    if (this.#codes.size >= MAX_CODES) this.#codes.delete(this.#codes.keys().next().value!);
    const code = fresh();
    const expiresAt = this.#now() + this.codeTtlMs;
    this.#codes.set(hash(code), { ...grant, expiresAt });
    return { code, expiresAt };
  }

  /**
   * Swaps a code for a cookie value, on the host it was minted for. The code is gone after the first try, whatever the answer (a wrong host
   * burns it too). Null: unknown, used, expired or another host.
   */
  redeem(code: string, host: string): { cookie: string; grant: AppGrant; maxAgeS: number } | null {
    if (!code) return null;
    const key = hash(code);
    const g = this.#codes.get(key);
    this.#codes.delete(key);
    if (!g || g.expiresAt <= this.#now() || g.host !== host.toLowerCase()) return null;
    this.#sweep();
    if (this.#cookies.size >= MAX_COOKIES) this.#cookies.delete(this.#cookies.keys().next().value!);
    const cookie = fresh();
    const grant: AppGrant = {
      workspaceId: g.workspaceId,
      port: g.port,
      host: g.host,
      sessionToken: g.sessionToken,
      actor: g.actor,
      portalOrigin: g.portalOrigin,
      scheme: g.scheme,
    };
    this.#cookies.set(hash(cookie), { ...grant, expiresAt: this.#now() + this.cookieTtlMs, createdAt: this.#now(), lastUsedAt: this.#now() });
    return { cookie, grant, maxAgeS: Math.floor(this.cookieTtlMs / 1000) };
  }

  /** Called after forgetWorkspace (the proxy cuts that workspace's live connections). */
  onForget: ((workspaceId: string) => void) | undefined;

  /**
   * The grant a cookie value holds on this host, with when the cookie ends (the longest a socket opened with it may live); null when unknown,
   * expired or minted for another host. The same object for the same cookie while it lives (the proxy counts bridges per grant by it).
   */
  lookup(cookie: string | undefined, host: string): Readonly<AppGrant & { expiresAt: number }> | null {
    if (!cookie) return null;
    const g = this.#cookies.get(hash(cookie));
    if (!g) return null;
    if (g.expiresAt <= this.#now()) {
      this.#cookies.delete(hash(cookie));
      return null;
    }
    if (g.host !== host.toLowerCase()) return null;
    g.lastUsedAt = this.#now();
    return g;
  }

  /**
   * The open app sessions (owner, 2026-10-18: "list of running browser proxy session"): one per app host cookie that still lives. `id` is the
   * first 16 characters of the cookie's hash: enough to revoke it, nothing to sign in with.
   */
  list(): { id: string; workspaceId: string; port: number; host: string; actor: Actor; createdAt: number | null; lastUsedAt: number | null; expiresAt: number }[] {
    this.#sweep();
    return [...this.#cookies].map(([k, g]) => ({
      id: k.slice(0, 16),
      workspaceId: g.workspaceId,
      port: g.port,
      host: g.host,
      actor: g.actor,
      createdAt: g.createdAt ?? null,
      lastUsedAt: g.lastUsedAt ?? null,
      expiresAt: g.expiresAt,
    }));
  }

  /** Ends one app session by its `list` id: the next request with that cookie is refused. Returns whether one was found. */
  revoke(id: string): boolean {
    if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return false;
    for (const k of this.#cookies.keys())
      if (k.startsWith(id)) {
        this.#cookies.delete(k);
        this.onRevoke?.(k);
        return true;
      }
    return false;
  }

  /** Called after a revoke with the grant's key (the proxy may cut that grant's open sockets). */
  onRevoke: ((key: string) => void) | undefined;

  /** Drops every cookie of a workspace (it was removed or renamed). */
  forgetWorkspace(workspaceId: string): void {
    for (const [k, g] of this.#cookies) if (g.workspaceId === workspaceId) this.#cookies.delete(k);
    this.onForget?.(workspaceId);
  }

  get size(): { codes: number; cookies: number } {
    return { codes: this.#codes.size, cookies: this.#cookies.size };
  }

  #sweep() {
    const now = this.#now();
    for (const [k, g] of this.#codes) if (g.expiresAt <= now) this.#codes.delete(k);
    for (const [k, g] of this.#cookies) if (g.expiresAt <= now) this.#cookies.delete(k);
  }
}
