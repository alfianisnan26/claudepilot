import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CODE_ALPHABET,
  FOUNDING_USER_ID,
  GENERATED_CODE_LENGTH,
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
}

/** What an email account is now, asked on every use so a role change or a disable takes effect at once. Null: gone. */
export type AccountRole = (userId: string) => 'admin' | 'member' | 'disabled' | 'unavailable' | null;

/** Keeps sessions across restarts, keyed by a hash of the token (the portal database). */
export interface SessionStore {
  load(now: number): Map<string, Session>;
  save(hash: string, session: Session): void;
  remove(hash: string): void;
  removeAllExcept(hash: string | null): void;
}

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < GENERATED_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Sessions are looked up by this, so neither memory nor the database holds a usable token. */
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

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
  /** By token hash. */
  readonly #sessions = new Map<string, Session>();
  #store: SessionStore | null = null;
  #storeFailed = false;
  /** T-118 MU2 S1a: the role of an email account's session; until it is set every account session is refused. */
  roleOf: AccountRole = () => null;
  /** Called after sessions end by sign-out or a new code, so what is tied to them (open sockets) can be cut. */
  onRevoked: () => void = () => {};
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

  matches(input: string): boolean {
    return timingSafeEqual(digest(normalizeCode(input)), digest(this.#code));
  }

  /** Signs in with the code; returns the new session token. */
  signIn(input: string): string {
    if (!this.#enabled) throw new AppError('FORBIDDEN', 'Sign-in is turned off on this server.');
    if (!this.matches(input)) throw new AppError('UNAUTHORIZED', 'That code is not right.');
    return this.openSession();
  }

  /** A new session after a check done elsewhere (an email account, T-118). An admin account's is a full session; a member's is not. */
  openSession(userId: string | null = null): string {
    if (!this.#enabled) throw new AppError('FORBIDDEN', 'Sign-in is turned off on this server.');
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const hash = tokenHash(token);
    const session: Session = { createdAt: now, expiresAt: now + this.ttlMs, ...(userId ? { userId } : {}) };
    this.#sessions.set(hash, session);
    this.#persist((st) => st.save(hash, session));
    return token;
  }

  /**
   * A FULL session: the server code's, or an admin account's (MU2 S1a). A member's session is NOT one, so every check that asks this (the
   * HTTP guard, the chat, terminal and browser sockets, re-auth) refuses a member by itself; `anySession` is the member-aware door.
   */
  session(token: string | undefined): Session | undefined {
    const s = this.anySession(token);
    if (!s || !s.userId) return s;
    return this.roleOf(s.userId) === 'admin' ? s : undefined;
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

  signOut(token: string) {
    const hash = tokenHash(token);
    const s = this.#sessions.get(hash);
    this.#sessions.delete(hash);
    this.#persist((st) => st.remove(hash));
    this.onRevoked();
    if (s) this.#signedOut([s.userId ?? FOUNDING_USER_ID]);
  }

  /** Sets a new code (given, or generated) and signs out every session but `keep`. */
  rotate(keep: string, input?: string): void {
    if (input !== undefined) {
      const problem = codeProblem(input);
      if (problem) throw new AppError('VALIDATION_FAILED', problem, { details: { code: problem } });
    }
    this.#code = input === undefined ? generateCode() : normalizeCode(input);
    this.#source = input === undefined ? 'generated' : 'custom';
    this.#codeUpdatedAt = Date.now();
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
