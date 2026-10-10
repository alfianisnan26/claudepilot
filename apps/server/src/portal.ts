import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CODE_ALPHABET,
  GENERATED_CODE_LENGTH,
  codeProblem,
  normalizeCode,
  type AdminState,
  type CodeSource,
} from '@portal/contracts';
import { AppError } from '@isnanme/core';

interface Session {
  createdAt: number;
  expiresAt: number;
}

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < GENERATED_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * The portal's state: the server code, whether sign-in is open, and the signed-in sessions.
 * Kept in memory: a restart goes back to the env code (or a fresh one) and signs everyone out.
 */
export class Portal {
  #code: string;
  #source: CodeSource;
  #codeUpdatedAt = Date.now();
  #enabled = true;
  readonly #sessions = new Map<string, Session>();

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
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.#sessions.set(token, { createdAt: now, expiresAt: now + this.ttlMs });
    return token;
  }

  session(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const s = this.#sessions.get(token);
    if (s && s.expiresAt <= Date.now()) {
      this.#sessions.delete(token);
      return undefined;
    }
    return s;
  }

  signOut(token: string) {
    this.#sessions.delete(token);
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
    for (const token of this.#sessions.keys()) if (token !== keep) this.#sessions.delete(token);
  }

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
  }

  #prune() {
    const now = Date.now();
    for (const [token, s] of this.#sessions) if (s.expiresAt <= now) this.#sessions.delete(token);
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
