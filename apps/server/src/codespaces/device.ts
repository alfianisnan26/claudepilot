// GitHub's OAuth device flow, run by the portal with ONLY A CLIENT ID (docs/prd/codespaces-poc.md §8.2). GitHub documents that the device
// flow needs no client secret ("The client_secret is not needed for the device flow", docs.github.com, authorizing-oauth-apps, read
// 2026-10-12); the portal never holds one.
//
// One flow: ask GitHub for a device code and a user code, show the user code and the link, poll GitHub's token endpoint at the interval it
// gave (5 s more on each `slow_down`), and stop on success, `access_denied`, expiry (`expired_token`, or our own clock), cancel, or a hard
// error. Polling runs HERE, server-side, so the person may close the dialog. The device code stays in this closure: it is never sent to the
// browser, logged or stored. The access token goes straight to `onToken` (which seals it in the Secrets store) and is dropped.
//
// Limits: one pending flow per person (a second start returns the pending one), at most MAX_STARTS starts per person per hour (GitHub
// itself allows 50 code submissions per hour per app), finished flows are forgotten after KEEP_MS.

import { AppError, newId } from '@isnanme/core';
import type { DeviceFlowState, DeviceFlowView } from '@portal/contracts';
import { GitHubError, type GitHubClient } from './github.js';

const MAX_STARTS = 10;
const START_WINDOW_MS = 60 * 60_000;
const KEEP_MS = 10 * 60_000;
const MAX_INTERVAL_S = 60;
const NETWORK_RETRY_S = 10;
const USER_CODE = /^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?$/;

export interface DeviceFlowOptions {
  gh: GitHubClient;
  clientId: string | null;
  scopes: string[];
  /** Seals the token and makes the connection; returns its id. Throws to fail the flow (the token is then dropped). */
  onToken: (ownerId: string, token: string, grantedScopes: string[] | null) => Promise<string>;
  /** Audit hook: kind and fixed details only. */
  audit?: (kind: string, ownerId: string, detail: Record<string, unknown>) => void;
  now?: () => number;
  /** Tests: 0.001 turns GitHub's 5 s interval into 5 ms. */
  timeScale?: number;
}

interface Flow {
  view: DeviceFlowView;
  ownerId: string;
  deviceCode: string;
  timer: NodeJS.Timeout | null;
  finishedAt: number | null;
}

export class DeviceFlows {
  readonly #flows = new Map<string, Flow>();
  readonly #starts = new Map<string, number[]>();
  readonly #now: () => number;
  readonly #scale: number;

  constructor(private readonly opts: DeviceFlowOptions) {
    this.#now = opts.now ?? Date.now;
    this.#scale = opts.timeScale ?? 1;
  }

  get available(): boolean {
    return !!this.opts.clientId;
  }

  pendingFor(ownerId: string): DeviceFlowView | null {
    this.#sweep();
    for (const f of this.#flows.values()) if (f.ownerId === ownerId && f.view.state === 'pending') return { ...f.view };
    return null;
  }

  async start(ownerId: string): Promise<DeviceFlowView> {
    const clientId = this.opts.clientId;
    if (!clientId) throw new AppError('CONFLICT', 'Sign-in with GitHub is off: PORTAL_GITHUB_CLIENT_ID is not set. Use a token.');
    const pending = this.pendingFor(ownerId);
    if (pending) return pending;
    const now = this.#now();
    const recent = (this.#starts.get(ownerId) ?? []).filter((t) => now - t < START_WINDOW_MS);
    if (recent.length >= MAX_STARTS) throw new AppError('RATE_LIMITED', 'Too many sign-ins started. Try again in an hour.');
    this.#starts.set(ownerId, [...recent, now]);

    let res;
    try {
      res = await this.opts.gh.devicePost('/login/device/code', { client_id: clientId, scope: this.opts.scopes.join(' ') });
    } catch (e) {
      throw new AppError('SERVICE_UNAVAILABLE', e instanceof GitHubError ? e.message : 'GitHub could not be reached.');
    }
    const b = res.body ?? {};
    if (typeof b.error === 'string') {
      const why =
        b.error === 'device_flow_disabled'
          ? 'Device flow is off in the GitHub app’s settings.'
          : b.error === 'incorrect_client_credentials'
            ? 'GitHub does not know PORTAL_GITHUB_CLIENT_ID.'
            : 'GitHub refused to start a sign-in.';
      this.opts.audit?.('codespaces.device_refused', ownerId, { error: String(b.error).slice(0, 40) });
      throw new AppError('CONFLICT', why);
    }
    const deviceCode = typeof b.device_code === 'string' ? b.device_code : '';
    const userCode = typeof b.user_code === 'string' ? b.user_code : '';
    const verification = typeof b.verification_uri === 'string' ? b.verification_uri : '';
    const expiresIn = Number(b.expires_in);
    const interval = Number(b.interval);
    if (!deviceCode || deviceCode.length > 200 || !USER_CODE.test(userCode) || !this.#sameOrigin(verification) || !(expiresIn > 0))
      throw new AppError('SERVICE_UNAVAILABLE', 'GitHub sent an answer the portal does not understand.');

    const view: DeviceFlowView = {
      id: newId(),
      state: 'pending',
      userCode,
      verificationUri: verification,
      expiresAt: new Date(now + Math.min(expiresIn, 3600) * 1000).toISOString(),
      interval: Math.min(Math.max(Number.isFinite(interval) && interval > 0 ? interval : 5, 1), MAX_INTERVAL_S),
      requestedScopes: [...this.opts.scopes],
      connectionId: null,
      detail: null,
    };
    const flow: Flow = { view, ownerId, deviceCode, timer: null, finishedAt: null };
    this.#flows.set(view.id, flow);
    this.opts.audit?.('codespaces.device_started', ownerId, { flow: view.id, scopes: view.requestedScopes });
    this.#schedule(flow, view.interval);
    return { ...view };
  }

  get(id: string, ownerId: string): DeviceFlowView {
    this.#sweep();
    const f = this.#flows.get(id);
    if (!f || f.ownerId !== ownerId) throw new AppError('NOT_FOUND', 'Not found.');
    return { ...f.view };
  }

  cancel(id: string, ownerId: string): DeviceFlowView {
    const f = this.#flows.get(id);
    if (!f || f.ownerId !== ownerId) throw new AppError('NOT_FOUND', 'Not found.');
    if (f.view.state === 'pending') this.#finish(f, 'cancelled', null);
    return { ...f.view };
  }

  stop(): void {
    for (const f of this.#flows.values()) if (f.timer) clearTimeout(f.timer);
    this.#flows.clear();
  }

  #sameOrigin(uri: string): boolean {
    try {
      const u = new URL(uri);
      return u.origin === new URL(this.opts.gh.endpoints.web).origin && !u.username && !u.password;
    } catch {
      return false;
    }
  }

  #schedule(f: Flow, seconds: number) {
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => void this.#poll(f), Math.max(1, seconds * 1000 * this.#scale));
    f.timer.unref?.();
  }

  async #poll(f: Flow): Promise<void> {
    f.timer = null;
    if (f.view.state !== 'pending') return;
    if (this.#now() >= Date.parse(f.view.expiresAt)) return this.#finish(f, 'expired', 'The code expired. Start again.');
    let b: Record<string, unknown>;
    try {
      b = (await this.opts.gh.devicePost('/login/oauth/access_token', { client_id: this.opts.clientId!, device_code: f.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })).body ?? {};
    } catch {
      // No answer: try again later, never faster than GitHub's interval.
      return this.#schedule(f, Math.max(f.view.interval, NETWORK_RETRY_S));
    }
    if (f.view.state !== 'pending') return; // cancelled while the request was out: the token, if any, is dropped
    const token = typeof b.access_token === 'string' ? b.access_token : null;
    if (token) {
      const granted = typeof b.scope === 'string' ? b.scope.split(/[ ,]+/).filter(Boolean) : null;
      try {
        f.view.connectionId = await this.opts.onToken(f.ownerId, token, granted);
        this.#finish(f, 'connected', null);
      } catch (e) {
        this.#finish(f, 'failed', e instanceof AppError ? e.message : 'The token could not be stored.');
      }
      return;
    }
    switch (b.error) {
      case 'authorization_pending':
        return this.#schedule(f, f.view.interval);
      case 'slow_down': {
        const next = Number(b.interval);
        f.view.interval = Math.min(Number.isFinite(next) && next > f.view.interval ? next : f.view.interval + 5, MAX_INTERVAL_S);
        return this.#schedule(f, f.view.interval);
      }
      case 'access_denied':
        return this.#finish(f, 'denied', 'Sign-in was cancelled at GitHub.');
      case 'expired_token':
      case 'token_expired':
        return this.#finish(f, 'expired', 'The code expired. Start again.');
      default:
        return this.#finish(f, 'failed', 'GitHub refused the sign-in.');
    }
  }

  #finish(f: Flow, state: DeviceFlowState, detail: string | null) {
    if (f.timer) clearTimeout(f.timer);
    f.timer = null;
    f.deviceCode = '';
    f.view.state = state;
    f.view.detail = detail;
    f.view.userCode = null;
    f.finishedAt = this.#now();
    this.opts.audit?.(`codespaces.device_${state}`, f.ownerId, { flow: f.view.id, ...(f.view.connectionId ? { connection: f.view.connectionId } : {}) });
  }

  #sweep() {
    const now = this.#now();
    for (const [id, f] of this.#flows) {
      if (f.view.state === 'pending' && now >= Date.parse(f.view.expiresAt)) this.#finish(f, 'expired', 'The code expired. Start again.');
      if (f.finishedAt !== null && now - f.finishedAt > KEEP_MS) this.#flows.delete(id);
    }
  }
}
