// Passwords (docs/prd/identity-onboarding.md §8, FR16 to FR18, decisions D2 and D3): scrypt from node:crypto with the parameters stored in
// the hash, a constant-time compare, at most two hashes in flight (the memory of one is 128 MiB at the default cost) with a short queue, the
// policy from the contract plus a local block list, and a dummy hash so an unknown name costs the same as a wrong password.
//
// Nothing here logs, stores or returns a password; a hash leaves this file only to be written to `users.password_hash`.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { AppError } from '@isnanme/core';
import { IDENTITY_ERROR_CODES, PASSWORD, PASSWORD_HASH, normalizeUsername, passwordProblems, type PasswordProblem } from '@portal/contracts';
import { COMMON_PASSWORDS } from './common.js';
import './errors.js';

export interface ScryptParams {
  /** log2 of N. */
  logN: number;
  r: number;
  p: number;
}

/** OWASP's minimum (N=2^17, r=8, p=1): about 250 ms and 128 MiB per hash here. */
export const DEFAULT_PARAMS: ScryptParams = { logN: PASSWORD_HASH.logN, r: PASSWORD_HASH.r, p: PASSWORD_HASH.p };
/** `PORTAL_PASSWORD_COST=test`: allowed only with the dev seed or NODE_ENV=test (FR17); milliseconds instead of a quarter second. */
export const TEST_PARAMS: ScryptParams = { logN: 10, r: 8, p: 1 };
/** The default 32 MiB refuses N=2^17; 256 MiB fits two of them with room (FR16). */
const MAX_MEM = 256 * 1024 * 1024;

const HASH_FORMAT = /^scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{32,})$/;

export interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

/** `scrypt$ln=17,r=8,p=1$<salt>$<hash>` (base64url), or null when it is not one of ours. */
export function parseHash(stored: string): ParsedHash | null {
  const m = HASH_FORMAT.exec(stored);
  if (!m) return null;
  return { params: { logN: Number(m[1]), r: Number(m[2]), p: Number(m[3]) }, salt: Buffer.from(m[4]!, 'base64url'), key: Buffer.from(m[5]!, 'base64url') };
}

export const formatHash = (params: ScryptParams, salt: Buffer, key: Buffer): string =>
  `scrypt$ln=${params.logN},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;

/** A value no password can match: what a reset (FR23) and the seed's accounts store. Parses, so a verify against it costs a full hash. */
export const UNMATCHABLE_HASH = `scrypt$ln=${DEFAULT_PARAMS.logN},r=${DEFAULT_PARAMS.r},p=${DEFAULT_PARAMS.p}$${'A'.repeat(22)}$${'A'.repeat(43)}`;

/**
 * NFKC, no NUL, at most 128 characters: checked BEFORE any hashing (FR16), so a megabyte of password costs nothing. Null means "not a
 * password at all" (the caller answers the uniform failure or a validation error, never a hint about the stored one).
 */
export function normalizePassword(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PASSWORD.max * 4) return null;
  const pw = raw.normalize('NFKC');
  if (pw.includes('\u0000')) return null;
  if ([...pw].length > PASSWORD.max) return null;
  return pw;
}

const scrypt = (password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, PASSWORD_HASH.keyBytes, { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });

/** At most `maxConcurrent` hashes run at once; `maxQueue` more wait; the rest are refused at once with a 503 (FR17, I17). */
export class PasswordHasher {
  #inFlight = 0;
  readonly #queue: (() => void)[] = [];
  #dummy: Promise<string> | null = null;

  constructor(
    readonly params: ScryptParams = DEFAULT_PARAMS,
    private readonly limits: { maxConcurrent: number; maxQueue: number } = { maxConcurrent: PASSWORD_HASH.maxConcurrent, maxQueue: 20 },
  ) {}

  get inFlight() {
    return this.#inFlight;
  }
  get queued() {
    return this.#queue.length;
  }

  async #run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.limits.maxConcurrent) {
      if (this.#queue.length >= this.limits.maxQueue) throw new AppError('SERVICE_UNAVAILABLE', 'The server is busy. Try again in a moment.');
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#inFlight++;
    try {
      return await fn();
    } finally {
      this.#inFlight--;
      this.#queue.shift()?.();
    }
  }

  /** The stored form of a (normalised) password. */
  hash(password: string): Promise<string> {
    const salt = randomBytes(PASSWORD_HASH.saltBytes);
    return this.#run(async () => formatHash(this.params, salt, await scrypt(password, salt, this.params)));
  }

  /**
   * Whether `password` matches `stored`. A hash that is not ours (or the unmatchable one) still costs one full hash of this profile, so every
   * sign-in path takes the same time (FR19, FR27). `rehash`: the stored parameters are weaker than the current ones (FR16).
   */
  async verify(password: string, stored: string): Promise<{ ok: boolean; rehash: boolean }> {
    const parsed = parseHash(stored);
    if (!parsed || parsed.key.length !== PASSWORD_HASH.keyBytes) {
      await this.verify(password, await this.dummy());
      return { ok: false, rehash: false };
    }
    const key = await this.#run(() => scrypt(password, parsed.salt, parsed.params));
    const ok = key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
    return { ok, rehash: ok && this.needsRehash(parsed.params) };
  }

  needsRehash(params: ScryptParams): boolean {
    return params.logN < this.params.logN || params.r < this.params.r || params.p < this.params.p;
  }

  /** A hash of a random password nobody knows, made once, for the paths where no account exists (FR19). */
  dummy(): Promise<string> {
    this.#dummy ??= this.hash(randomBytes(24).toString('base64url'));
    return this.#dummy;
  }
}

/* ---------- The policy ---------- */

const COMMON = new Set(COMMON_PASSWORDS);
const PADDING = /^[\d!@#$%^&*._\-+=?, ]+|[\d!@#$%^&*._\-+=?, ]+$/g;

/** A listed entry, a listed entry padded with digits or punctuation, or a listed entry repeated (FR18's `common`). */
export function isCommonPassword(password: string): boolean {
  const lower = password.normalize('NFKC').toLowerCase();
  for (const candidate of new Set([lower, lower.replace(PADDING, ''), lower.replace(/\s+/g, '')])) {
    if (candidate.length === 0) continue;
    if (COMMON.has(candidate)) return true;
    for (let n = 2; n * 3 <= candidate.length; n++) {
      if (candidate.length % n !== 0) continue;
      const unit = candidate.slice(0, candidate.length / n);
      if (COMMON.has(unit) && unit.repeat(n) === candidate) return true;
    }
  }
  return false;
}

/** The contract's checks plus the block list: what the server refuses and what the forms show. */
export function passwordPolicy(password: string, who: { username?: string; displayName?: string } = {}): PasswordProblem[] {
  const problems = passwordProblems(password, { username: who.username ? normalizeUsername(who.username) : undefined, displayName: who.displayName });
  if (isCommonPassword(password)) problems.push('common');
  return problems;
}

/** Normalises and checks a new password; throws `PASSWORD_REJECTED` (422, `details.problems`) or returns the password to hash. */
export function acceptNewPassword(raw: unknown, who: { username?: string; displayName?: string } = {}): string {
  const password = typeof raw === 'string' ? raw.normalize('NFKC') : '';
  if (password.includes('\u0000')) throw new AppError('VALIDATION_FAILED', 'A password can’t contain a NUL character.', { details: { password: 'Not allowed.' } });
  const problems = passwordPolicy(password, who);
  if (!password || problems.length) {
    throw new AppError(IDENTITY_ERROR_CODES.PASSWORD_REJECTED, 'Choose another password.', { details: { problems: problems.length ? problems : ['too_short'] } });
  }
  return password;
}
