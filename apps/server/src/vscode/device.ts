// The device flow (RFC 8628) for the VS Code extension (docs/prd/vscode-extension.md §4). The extension has no cookie: it asks for a code,
// the person approves it in the portal while signed in, the extension polls and gets a token once.
//
// Pending codes live in memory only: they last ten minutes, and a restart just means "start again". The device code (the extension's
// polling secret) is kept as its SHA-256; the user code (what the person types) is short, so it is only ever accepted from a signed-in
// person, and at most PENDING_MAX codes exist at once.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  VSCODE_CLIENT_NAME_MAX,
  VSCODE_DEVICE_TTL_S,
  VSCODE_POLL_INTERVAL_S,
  VSCODE_USER_CODE_ALPHABET,
  formatUserCode,
  normalizeUserCode,
  type VscodePending,
} from '@portal/contracts';

/** Codes that may be pending at once: a flood of starts can't grow memory, and a guess at a user code stays hopeless. */
export const PENDING_MAX = 20;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Entry {
  deviceHash: string;
  userCode: string;
  client: string;
  ip: string | null;
  createdMs: number;
  expiresMs: number;
  lastPollMs: number;
  interval: number;
  state: 'pending' | 'approved' | 'denied';
}

/** One line of plain text, at most VSCODE_CLIENT_NAME_MAX characters: it becomes part of a token's label (no quotes or angle brackets). */
export function cleanClientName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"<>]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (s || 'VS Code').slice(0, VSCODE_CLIENT_NAME_MAX).trim();
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; client: string };

export class DeviceFlow {
  readonly #byDevice = new Map<string, Entry>();
  readonly #byUser = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  #sweep(): void {
    const t = this.now();
    for (const e of this.#byDevice.values()) if (e.expiresMs <= t) this.#drop(e);
  }

  #drop(e: Entry): void {
    this.#byDevice.delete(e.deviceHash);
    this.#byUser.delete(e.userCode);
  }

  /** Starts a flow. Null when PENDING_MAX codes are already waiting (the caller answers 429). */
  start(clientName: unknown, ip: string | null): { deviceCode: string; userCode: string; expiresIn: number; interval: number } | null {
    this.#sweep();
    if (this.#byDevice.size >= PENDING_MAX) return null;
    const deviceCode = randomBytes(32).toString('base64url');
    let userCode = '';
    do {
      userCode = Array.from({ length: 8 }, () => VSCODE_USER_CODE_ALPHABET[randomInt(VSCODE_USER_CODE_ALPHABET.length)]).join('');
    } while (this.#byUser.has(userCode));
    const t = this.now();
    const e: Entry = {
      deviceHash: sha(deviceCode),
      userCode,
      client: cleanClientName(clientName),
      ip,
      createdMs: t,
      expiresMs: t + VSCODE_DEVICE_TTL_S * 1000,
      lastPollMs: 0,
      interval: VSCODE_POLL_INTERVAL_S,
      state: 'pending',
    };
    this.#byDevice.set(e.deviceHash, e);
    this.#byUser.set(userCode, e);
    return { deviceCode, userCode: formatUserCode(userCode), expiresIn: VSCODE_DEVICE_TTL_S, interval: VSCODE_POLL_INTERVAL_S };
  }

  /** What a code asks for, for the approval page; null for a code that is unknown, expired or already answered (one answer for all). */
  pending(typed: string): VscodePending | null {
    this.#sweep();
    const code = normalizeUserCode(typed);
    const e = code ? this.#byUser.get(code) : undefined;
    if (!e || e.state !== 'pending') return null;
    return { userCode: formatUserCode(e.userCode), client: e.client, ip: e.ip, createdAt: new Date(e.createdMs).toISOString(), expiresAt: new Date(e.expiresMs).toISOString() };
  }

  /** The person's answer. False when there is no such pending code. */
  decide(typed: string, decision: 'approve' | 'deny'): boolean {
    this.#sweep();
    const code = normalizeUserCode(typed);
    const e = code ? this.#byUser.get(code) : undefined;
    if (!e || e.state !== 'pending') return false;
    e.state = decision === 'approve' ? 'approved' : 'denied';
    return true;
  }

  /**
   * A poll. `approved` is answered once and the code is gone after it (the caller issues the token then). A poll sooner than the interval
   * is `slow_down` and the interval grows by 5 s (RFC 8628 §3.5). An unknown device code is `expired`: nothing tells it apart from one that was.
   */
  poll(deviceCode: unknown): PollResult {
    this.#sweep();
    if (typeof deviceCode !== 'string' || deviceCode.length < 20 || deviceCode.length > 100) return { status: 'expired' };
    const e = this.#byDevice.get(sha(deviceCode));
    if (!e) return { status: 'expired' };
    const t = this.now();
    if (e.state === 'denied') {
      this.#drop(e);
      return { status: 'denied' };
    }
    if (e.state === 'approved') {
      this.#drop(e);
      return { status: 'approved', client: e.client };
    }
    if (e.lastPollMs && t - e.lastPollMs < e.interval * 1000) {
      e.interval += 5;
      e.lastPollMs = t;
      return { status: 'slow_down', interval: e.interval };
    }
    e.lastPollMs = t;
    return { status: 'pending' };
  }

  /** How many codes wait (tests, and a cheap health look). */
  get size(): number {
    this.#sweep();
    return this.#byDevice.size;
  }
}
