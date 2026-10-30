// The portal's VS Code API, as one small client. Pure: no `vscode` import and no Node-only API (it runs in the desktop and the web
// extension host alike), and the fetch is injected so the tests run it against a fake portal.

import {
  VSCODE_API,
  VSCODE_API_HEADER,
  VSCODE_API_VERSION,
  type VscodeAgent,
  type VscodeApproval,
  type VscodeDeviceStart,
  type VscodeEvents,
  type VscodeMe,
  type VscodeRespondRequest,
  type VscodeStatus,
  type VscodeTicket,
  type VscodeTokenPoll,
  type VscodeVersion,
  type VscodeWorkspace,
} from '../../../packages/contracts/src/vscode.js';
import { redact } from './redact.js';

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; credentials?: 'omit'; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** A refusal or a failure, with the portal's code; the message never holds a secret. */
export class PortalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(redact(message));
  }
  get signedOut(): boolean {
    return this.status === 401;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The portal address a person may set: https anywhere, plain http only on this machine (a `kubectl port-forward`): a token sent over
 * plain http to another host could be read on the way. No user name or password in it, nothing after the host but `/`.
 */
export function checkPortalUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'That is not an address. Use https://your-portal or http://127.0.0.1:<port>.' };
  }
  if (u.username || u.password) return { ok: false, reason: 'Leave the user name and password out of the address.' };
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname) && !/^127\.\d+\.\d+\.\d+$/.test(u.hostname))
    return { ok: false, reason: 'Plain http is only for this machine (localhost). Use https for a portal elsewhere.' };
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Use an https:// address.' };
  if (u.pathname !== '/' && u.pathname !== '') return { ok: false, reason: 'Use the portal’s address only, without a path.' };
  return { ok: true, url: u.origin };
}

/** Whether this extension and the portal can talk: the portal names the API it speaks and the oldest it still serves. */
export function compat(v: Pick<VscodeVersion, 'api' | 'minApi'>): { ok: true } | { ok: false; reason: string } {
  if (VSCODE_API_VERSION < v.minApi) return { ok: false, reason: `This extension is too old for the portal (API ${VSCODE_API_VERSION}, the portal needs ${v.minApi} or newer). Update the extension.` };
  if (v.api < VSCODE_API_VERSION) return { ok: false, reason: `The portal is older than this extension (API ${v.api}, the extension needs ${VSCODE_API_VERSION}). Update the portal or use an older extension.` };
  return { ok: true };
}

export interface ClientOptions {
  baseUrl: string;
  /** The token, read from SecretStorage when a call is made (never kept here). */
  token?: () => Promise<string | undefined>;
  fetch?: FetchLike;
  /** Told the portal's API version from any answer's header, so a mismatch is noticed on every call, not only at sign-in. */
  onApiVersion?: (api: number) => void;
  timeoutMs?: number;
}

export class PortalClient {
  readonly baseUrl: string;
  readonly #o: ClientOptions;

  constructor(o: ClientOptions) {
    const checked = checkPortalUrl(o.baseUrl);
    if (!checked.ok) throw new PortalError('BAD_URL', checked.reason, 0);
    this.baseUrl = checked.url;
    this.#o = o;
  }

  async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const token = await this.#o.token?.();
      if (!token) throw new PortalError('UNAUTHORIZED', 'Sign in to the portal first.', 401);
      headers.authorization = `Bearer ${token}`;
    }
    const f = this.#o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.#o.timeoutMs ?? 20_000) : null;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      // No cookie ever (`credentials: 'omit'`): the portal refuses a bearer request that carries one.
      res = await f(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', ...(ctl ? { signal: ctl.signal } : {}) });
    } catch {
      throw new PortalError('NETWORK_ERROR', `Could not reach the portal at ${this.baseUrl}.`, 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const api = Number(res.headers.get(VSCODE_API_HEADER));
    if (Number.isFinite(api) && api > 0) this.#o.onApiVersion?.(api);
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: { code?: string; message?: string } } | null;
    if (res.ok && json && 'data' in json) return json.data as T;
    if (json?.error) throw new PortalError(String(json.error.code ?? 'ERROR'), String(json.error.message ?? `The portal answered ${res.status}.`), res.status);
    if (res.status === 404) throw new PortalError('NOT_FOUND', 'The portal has no VS Code API here. Is the address right, and is the portal up to date?', 404);
    throw new PortalError('BAD_RESPONSE', `The portal answered ${res.status}.`, res.status);
  }

  version = () => this.#call<VscodeVersion>('GET', VSCODE_API.version, undefined, false);
  /** `instance`: this installation's own id, so a new sign-in replaces only its own earlier token. */
  startDevice = (client: string, instance?: string) => this.#call<VscodeDeviceStart>('POST', VSCODE_API.device, { client, ...(instance ? { instance } : {}) }, false);
  poll = (deviceCode: string) => this.#call<VscodeTokenPoll>('POST', VSCODE_API.token, { deviceCode }, false);
  me = () => this.#call<VscodeMe>('GET', VSCODE_API.me);
  logout = () => this.#call<{ revoked: boolean }>('POST', VSCODE_API.logout, {});
  agents = () => this.#call<VscodeAgent[]>('GET', VSCODE_API.agents);
  tickets = () => this.#call<VscodeTicket[]>('GET', VSCODE_API.tickets);
  workspaces = () => this.#call<VscodeWorkspace[]>('GET', VSCODE_API.workspaces);
  status = () => this.#call<VscodeStatus>('GET', VSCODE_API.status);
  approvals = () => this.#call<VscodeApproval[]>('GET', VSCODE_API.approvals);
  events = (sessionId: string, after?: number) => this.#call<VscodeEvents>('GET', `${VSCODE_API.events(sessionId)}${after !== undefined ? `?after=${after}` : ''}`);
  send = (sessionId: string, text: string, uuid: string) => this.#call<{ ok: true; uuid: string }>('POST', VSCODE_API.send(sessionId), { text, uuid });
  /** Deny only: Allow is given in the portal. */
  deny = (sessionId: string, req: Omit<VscodeRespondRequest, 'decision'>) => this.#call<{ ok: true }>('POST', VSCODE_API.respond(sessionId), { ...req, decision: 'deny' });

  /** A page of the portal, for "Open in Portal". Only a path of the portal's own: never another origin. */
  pageUrl(path: string): string {
    const p = path.startsWith('/') && !path.startsWith('//') ? path : '/';
    return `${this.baseUrl}${p}`;
  }
}

export type SignInOutcome = { ok: true; token: string; tokenId: string; label: string; expiresAt: string } | { ok: false; reason: 'denied' | 'expired' | 'cancelled' };

/**
 * Polls until the person answered, the code expired or the caller cancelled (RFC 8628 §3.4/3.5): waits `interval` seconds between polls
 * and grows the wait on `slow_down`. A network error is retried at the next poll; any other error ends it.
 */
export async function pollForToken(
  client: Pick<PortalClient, 'poll'>,
  start: Pick<VscodeDeviceStart, 'deviceCode' | 'interval' | 'expiresIn'>,
  o: { sleep: (ms: number) => Promise<void>; cancelled: () => boolean; now?: () => number },
): Promise<SignInOutcome> {
  const now = o.now ?? (() => Date.now());
  const until = now() + start.expiresIn * 1000;
  let interval = Math.max(1, start.interval);
  while (now() < until) {
    await o.sleep(interval * 1000);
    if (o.cancelled()) return { ok: false, reason: 'cancelled' };
    let r: VscodeTokenPoll;
    try {
      r = await client.poll(start.deviceCode);
    } catch (e) {
      if (e instanceof PortalError && e.code === 'NETWORK_ERROR') continue;
      throw e;
    }
    switch (r.status) {
      case 'ok':
        return { ok: true, token: r.token, tokenId: r.tokenId, label: r.label, expiresAt: r.expiresAt };
      case 'slow_down':
        interval = Math.max(interval + 5, r.interval);
        break;
      case 'denied':
        return { ok: false, reason: 'denied' };
      case 'expired':
        return { ok: false, reason: 'expired' };
      default:
        break;
    }
  }
  return { ok: false, reason: 'expired' };
}
