import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CODE_ALPHABET,
  FOUNDING_USER_ID,
  GENERATED_CODE_LENGTH,
  MIN_CODE_BITS,
  codeBits,
  codeProblem,
  normalizeCode,
  type AdminState,
  type CodeSource,
} from '@portal/contracts';
import { AppError } from '@isnanme/core';

export interface Session {
  createdAt: number;
  expiresAt: number;
  /** The email account that signed in (T-118); absent for the server code. Its role decides what the session is (MU2 S1a). */
  userId?: string | null;
  /** Migration 407: the browser it came from ("Safari on iPhone", identity/device.ts), for the person's Profile. */
  device?: string | null;
  /** Migration 407: how it signed in: `password`, `code` or `sso:<providerId>`. */
  method?: string | null;
}

/** What a sign-in records besides the account (migration 407). */
export interface SessionMeta {
  device?: string | null;
  method?: string | null;
}

/** One live session of an account, as its Profile lists it: a short handle (the first 16 hex of the token's hash), never the token. */
export interface AccountSession extends Session {
  id: string;
  current: boolean;
}

/** The handle of a session in lists: enough to name it, too short to look it up by anything but this account's own list. */
const handleOf = (hash: string) => hash.slice(0, 16);

/** What an email account is now, asked on every use so a role change or a disable takes effect at once. Null: gone. */
export type AccountRole = (userId: string) => 'admin' | 'member' | 'disabled' | 'unavailable' | null;

/** Keeps sessions across restarts, keyed by a hash of the token (the portal database). */
export interface SessionStore {
  load(now: number): Map<string, Session>;
  save(hash: string, session: Session): void;
  remove(hash: string): void;
  removeAllExcept(hash: string | null): void;
  /** Owner request 2026-11-01: whether sign-in with the server code is on, kept across restarts; null: never set (on). */
  codeSignIn?(): boolean | null;
  setCodeSignIn?(on: boolean): void;
}

export function generateCode(): string {
  let code = '';
  // PILOT-1185: a draw that measures below the bar (codeBits) is drawn again. PILOT-1189 (review 60152): that is about 1 draw in 4,300, almost
  // all of them a draw with no digit, (23/31)^28 ≈ 2.3e-4, which is measured against the 23 letters (126.7 bits); a draw with a run or a
  // repeat is far rarer. Redrawing those takes under a thousandth of a bit from the code's strength.
  while (codeBits(code) < MIN_CODE_BITS) {
    code = '';
    for (let i = 0; i < GENERATED_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Sessions are looked up by this, so neither memory nor the database holds a usable token. */
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** The hash a web session is kept under (organizations slice 10 marks a session by it: an actor's `loginSessionId` is `ws:<hash>`). */
export const sessionTokenHash = tokenHash;

/**
 * The portal's state: the server code, whether sign-in is open, and the signed-in sessions. The code
 * and the on/off switch live in memory (a restart goes back to the env code, or a fresh one); sessions
 * also go to the session store when there is one, so a restart doesn't sign anyone out.
 */
export class Portal {
  #code: string;
  #source: CodeSource;
  #codeUpdatedAt = Date.now();
  #enabled = true;
  /** Owner request 2026-11-01: sign-in with the server code alone (accounts keep signing in); kept in the store when there is one. */
  #codeSignIn = true;
  /** By token hash. */
  readonly #sessions = new Map<string, Session>();
  #store: SessionStore | null = null;
  #storeFailed = false;
  /** T-118 MU2 S1a: the role of an email account's session; until it is set every account session is refused. */
  roleOf: AccountRole = () => null;
  /** Called after sessions end by sign-out or a new code, so what is tied to them (open sockets) can be cut. */
  onRevoked: () => void = () => {};
  /** PILOT-1189: called after the code changes (a rotation, a custom code), so the boot's code file never holds an old code. */
  onCodeChanged: () => void = () => {};
  /**
   * T-968 S1 (general-manager PRD Q3, lead decision #11136): called with each person whose session a sign-out, a revoke or a new code just
   * ended, on ANY device, even when another device stays signed in (the server code's session is the founding user's). index.ts revokes
   * their manager's token here; the manager gets a new one at the next sign-in.
   */
  onSignedOut: (userId: string) => void = () => {};

  /** Calls `onSignedOut` once for each of `people`. */
  #signedOut(people: Iterable<string>) {
    for (const person of new Set(people)) {
      try {
        this.onSignedOut(person);
      } catch (e) {
        console.error(`[portal] after the last sign-out: ${(e as Error).message}`);
      }
    }
  }

  constructor(
    envCode: string | undefined,
    private readonly ttlMs: number,
  ) {
    if (envCode !== undefined) {
      const problem = codeProblem(envCode);
      if (problem) throw new Error(`PORTAL_SERVER_CODE is not usable: ${problem}`);
      this.#code = normalizeCode(envCode);
      this.#source = 'env';
    } else {
      this.#code = generateCode();
      this.#source = 'generated';
    }
  }

  /** Restores the sessions saved before a restart, and saves sign-ins and sign-outs from now on. */
  useStore(store: SessionStore) {
    this.#store = store;
    this.#persist((st) => {
      for (const [hash, s] of st.load(Date.now())) this.#sessions.set(hash, s);
      const on = st.codeSignIn?.();
      if (on === false) this.#codeSignIn = false;
    });
  }

  /** Best effort: a database that can't be written keeps sessions in memory until the next restart. */
  #persist(fn: (store: SessionStore) => void) {
    if (!this.#store) return;
    try {
      fn(this.#store);
    } catch (e) {
      if (!this.#storeFailed) console.error(`[portal] sessions not saved: ${(e as Error).message}`);
      this.#storeFailed = true;
    }
  }

  get code() {
    return this.#code;
  }
  get source() {
    return this.#source;
  }
  get enabled() {
    return this.#enabled;
  }
  /** Whether sign-in with the server code is on (an account's sign-in is not affected). */
  get codeSignIn() {
    return this.#codeSignIn;
  }

  matches(input: string): boolean {
    return timingSafeEqual(digest(normalizeCode(input)), digest(this.#code));
  }

  /** Signs in with the code; returns the new session token. */
  signIn(input: string, meta: SessionMeta = {}): string {
    if (!this.#enabled) throw new AppError('FORBIDDEN', 'Sign-in is turned off on this server.');
    if (!this.#codeSignIn) throw new AppError('FORBIDDEN', 'Sign-in with the server code is turned off. Sign in with your account.');
    if (!this.matches(input)) throw new AppError('UNAUTHORIZED', 'That code is not right.');
    return this.openSession(null, meta);
  }

  /** A new session after a check done elsewhere (an email account, T-118). An admin account's is a full session; a member's is not. */
  openSession(userId: string | null = null, meta: SessionMeta = {}): string {
    if (!this.#enabled) throw new AppError('FORBIDDEN', 'Sign-in is turned off on this server.');
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const hash = tokenHash(token);
    const session: Session = {
      createdAt: now,
      expiresAt: now + this.ttlMs,
      ...(userId ? { userId } : {}),
      ...(meta.device ? { device: meta.device.slice(0, 60) } : {}),
      ...(meta.method ? { method: meta.method.slice(0, 80) } : {}),
    };
    this.#sessions.set(hash, session);
    this.#persist((st) => st.save(hash, session));
    return token;
  }

  /**
   * A FULL session: the server code's, or an admin account's (MU2 S1a). A member's session is NOT one. Since D-82 S1a (member access) only
   * what is the platform admin's asks this: the server code's state (`adminState`), a new code, re-auth for Bypass. Everything a member may
   * also reach (the HTTP guard, the sockets) asks `personSession` and lets the seam decide.
   */
  session(token: string | undefined): Session | undefined {
    const s = this.anySession(token);
    if (!s || !s.userId) return s;
    return this.roleOf(s.userId) === 'admin' ? s : undefined;
  }

  /**
   * D-82 S1a (member access, owner 2026-11-01): a session that acts as a PERSON: the server code's, an active admin's or an active member's.
   * Not one whose account cannot be read right now ('unavailable': fail closed), is disabled or gone. What such a person may do is the seam's
   * (`can()`, the route guard's declared policy and its member doors), never this.
   */
  personSession(token: string | undefined): Session | undefined {
    const s = this.anySession(token);
    if (!s || !s.userId) return s;
    const role = this.roleOf(s.userId);
    return role === 'admin' || role === 'member' ? s : undefined;
  }

  /** Any live session, a member's included; an account that is gone or disabled ends its sessions here. */
  anySession(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const hash = tokenHash(token);
    const s = this.#sessions.get(hash);
    if (s && s.expiresAt <= Date.now()) {
      this.#sessions.delete(hash);
      this.#persist((st) => st.remove(hash));
      this.#expired([s.userId ?? FOUNDING_USER_ID]);
      return undefined;
    }
    // The server code's sign-in turned off: its sessions are over (one restored from the store after a restart included).
    if (s && !s.userId && !this.#codeSignIn) {
      this.#sessions.delete(hash);
      this.#persist((st) => st.remove(hash));
      this.#signedOut([FOUNDING_USER_ID]);
      return undefined;
    }
    if (s?.userId) {
      const role = this.roleOf(s.userId);
      // 'unavailable' (the database could not be read, review #10): kept, but not a full session until it can be read again.
      if (role !== 'admin' && role !== 'member' && role !== 'unavailable') {
        this.#sessions.delete(hash);
        this.#persist((st) => st.remove(hash));
        return undefined;
      }
    }
    return s;
  }

  /**
   * T-968 (review 2026-10-18): whether the person is signed in anywhere now, so their General Manager is minted a token only while they
   * are. A server-code session (no account) is the founding user's, as `signOut` counts it.
   */
  signedIn(userId: string): boolean {
    const now = Date.now();
    for (const s of this.#sessions.values()) if (s.expiresAt > now && (s.userId ?? FOUNDING_USER_ID) === userId) return true;
    return false;
  }

  /** Ends every session of one email account (a password change, a disable, a removal, a demotion), except `keepToken`'s; cuts its sockets. */
  revokeUser(userId: string, keepToken?: string) {
    const keep = keepToken ? tokenHash(keepToken) : null;
    let any = false;
    for (const [hash, s] of this.#sessions) {
      if (s.userId !== userId || hash === keep) continue;
      this.#sessions.delete(hash);
      this.#persist((st) => st.remove(hash));
      any = true;
    }
    if (any) this.onRevoked();
    this.#signedOut([userId]);
  }

  /** The live sessions of one account, newest first; `currentToken`'s is marked (the Profile's device list). */
  sessionsOf(userId: string, currentToken?: string): AccountSession[] {
    this.#prune();
    const current = currentToken ? tokenHash(currentToken) : null;
    const out: AccountSession[] = [];
    for (const [hash, s] of this.#sessions) if (s.userId === userId) out.push({ ...s, id: handleOf(hash), current: hash === current });
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Ends ONE session of an account by its handle (the Profile's "Sign out" on a device). Only that account's own sessions are looked at, so
   * a handle of someone else's is the same `false` as one that does not exist. The current session is not ended here (sign out does that).
   */
  revokeSessionOf(userId: string, id: string, currentToken?: string): boolean {
    const current = currentToken ? tokenHash(currentToken) : null;
    for (const [hash, s] of this.#sessions) {
      if (s.userId !== userId || handleOf(hash) !== id || hash === current) continue;
      this.#sessions.delete(hash);
      this.#persist((st) => st.remove(hash));
      this.onRevoked();
      this.#expired([userId]);
      return true;
    }
    return false;
  }

  /** How the session of `token` signed in (`password`, `code`, `sso:<id>`), or null when it was not recorded. */
  methodOf(token: string | undefined): string | null {
    if (!token) return null;
    return this.#sessions.get(tokenHash(token))?.method ?? null;
  }

  signOut(token: string) {
    const hash = tokenHash(token);
    const s = this.#sessions.get(hash);
    this.#sessions.delete(hash);
    this.#persist((st) => st.remove(hash));
    this.onRevoked();
    if (s) this.#signedOut([s.userId ?? FOUNDING_USER_ID]);
  }

  /**
   * PILOT-1185 (PORTAL_SIGNIN_CODE_STRICT): with code sign-in on, a code below MIN_CODE_BITS is refused as a new code, and code sign-in is
   * not turned back on with one. Set by index.ts before the first request; off (today's behaviour) by default.
   */
  requireStrongCode = false;

  #assertStrong(code: string) {
    if (this.requireStrongCode && codeBits(code) < MIN_CODE_BITS) {
      // PILOT-1189 (review 60152): say why. A well-formed code (26 letters, say) is refused only for its strength.
      const problem = `This code is too weak: about ${Math.floor(codeBits(code))} bits, and this server needs at least ${MIN_CODE_BITS} bits while code sign-in is on. Mix letters and digits, with no runs or repeats (Rotate makes one).`;
      throw new AppError('VALIDATION_FAILED', problem, { details: { code: problem } });
    }
  }

  /** Sets a new code (given, or generated) and signs out every session but `keep`. */
  rotate(keep: string, input?: string): void {
    if (input !== undefined) {
      const problem = codeProblem(input);
      if (problem) throw new AppError('VALIDATION_FAILED', problem, { details: { code: problem } });
    }
    const next = input === undefined ? generateCode() : normalizeCode(input);
    if (this.#codeSignIn) this.#assertStrong(next);
    this.#code = next;
    this.#source = input === undefined ? 'generated' : 'custom';
    this.#codeUpdatedAt = Date.now();
    this.onCodeChanged();
    const keepHash = tokenHash(keep);
    const ended: string[] = [];
    for (const [hash, s] of this.#sessions)
      if (hash !== keepHash) {
        ended.push(s.userId ?? FOUNDING_USER_ID);
        this.#sessions.delete(hash);
      }
    this.#persist((st) => st.removeAllExcept(keepHash));
    this.onRevoked();
    this.#signedOut(ended);
  }

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
  }

  /**
   * Owner request 2026-11-01 ("shut down server code access"): sign-in with the server code on or off, kept across restarts. Off ends every
   * server-code session now; accounts (password, SSO) keep signing in. The code still confirms a sensitive action (chat/reauth.ts) for a
   * signed-in admin. Who may turn it off, and the check that an admin can still sign in, are the caller's (admin/routes.ts).
   */
  setCodeSignIn(on: boolean): void {
    if (on && !this.#codeSignIn) this.#assertStrong(this.#code);
    this.#codeSignIn = on;
    this.#persist((st) => st.setCodeSignIn?.(on));
    if (on) return;
    let ended = false;
    for (const [hash, s] of this.#sessions)
      if (!s.userId) {
        this.#sessions.delete(hash);
        this.#persist((st) => st.remove(hash));
        ended = true;
      }
    if (ended) {
      this.onRevoked();
      this.#signedOut([FOUNDING_USER_ID]);
    }
  }

  #prune() {
    const now = Date.now();
    const ended: string[] = [];
    for (const [hash, s] of this.#sessions) {
      if (s.expiresAt > now) continue;
      this.#sessions.delete(hash);
      this.#persist((st) => st.remove(hash));
      ended.push(s.userId ?? FOUNDING_USER_ID);
    }
    this.#expired(ended);
  }

  /**
   * T-968 review M4 and N1: an expired login stops the person's manager only when it was their LAST live one (a sign-out stops it on any
   * device, Q3; an expiry on the laptop while the phone is signed in does not).
   */
  #expired(people: string[]) {
    this.#signedOut(people.filter((u) => !this.signedIn(u)));
  }

  /** The Admin console's view of sign-in with the server code (owner, 2026-11-01): the switch and its age, never the code itself. */
  summary(): { enabled: boolean; source: CodeSource; codeUpdatedAt: string; sessions: number } {
    this.#prune();
    return { enabled: this.#codeSignIn, source: this.#source, codeUpdatedAt: new Date(this.#codeUpdatedAt).toISOString(), sessions: this.#sessions.size };
  }

  adminState(token: string): AdminState {
    this.#prune();
    const s = this.session(token);
    if (!s) throw new AppError('UNAUTHORIZED');
    return {
      code: this.#code,
      source: this.#source,
      enabled: this.#enabled,
      codeUpdatedAt: new Date(this.#codeUpdatedAt).toISOString(),
      sessions: this.#sessions.size,
      signedInAt: new Date(s.createdAt).toISOString(),
    };
  }
}
