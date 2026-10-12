// The GitHub HTTP client of the Codespaces POC (docs/prd/codespaces-poc.md §8, §11). Everything the portal says to GitHub goes through here:
// the OAuth device flow (no client secret: GitHub's device flow needs only the client ID) and the REST API with a person's token.
//
// Rules this file keeps (PRD §11):
// - OUTBOUND ONLY TO GITHUB: a host is github.com / api.github.com or a GHE.com data-residency host (`<sub>.ghe.com`, `api.<sub>.ghe.com`).
//   Any other origin (the stand-in in tests and scratch portals) needs `allowOtherHosts`, which the config grants only outside production
//   with PORTAL_GITHUB_STANDIN=1. A user-chosen GHE.com host passes the SSRF guard (`assertPublicUrl`) once when it is connected.
// - THE TOKEN TRAVELS ONLY IN THE Authorization HEADER: never in a URL, a log line, an error message or an argument list. Errors carry GitHub's
//   status and a fixed message; a response body is never echoed (it can quote what was sent).
// - Rate limits: a 403/429 with `x-ratelimit-remaining: 0` or `retry-after` becomes RATE_LIMITED with the time to wait; nothing retries in a loop.

import { AppError } from '@isnanme/core';

export const GITHUB_API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15_000;
const BODY_LIMIT = 2_000_000;
const USER_AGENT = 'ClaudePilot-portal';

export interface GitHubEndpoints {
  /** `https://github.com`: device flow endpoints. */
  web: string;
  /** `https://api.github.com`: the REST API. */
  api: string;
}

export interface GitHubClientOptions {
  endpoints: GitHubEndpoints;
  /** Tests and scratch portals: allow a non-GitHub origin (the stand-in). */
  allowOtherHosts?: boolean;
  fetch?: typeof fetch;
}

const GHE = /^(?:api\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/;

/** True for the hosts the portal may talk to with a GitHub token. */
export function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'github.com' || h === 'api.github.com' || GHE.test(h);
}

/** The web and API origins for a host as a person names it: `github.com` (default) or a GHE.com subdomain. */
export function endpointsFor(host: string): GitHubEndpoints {
  const h = host.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (h === 'github.com' || h === '') return { web: 'https://github.com', api: 'https://api.github.com' };
  if (GHE.test(h) && !h.startsWith('api.')) return { web: `https://${h}`, api: `https://api.${h}` };
  throw new AppError('VALIDATION_FAILED', 'Use github.com or a <name>.ghe.com host.', { details: { host: 'Use github.com or a <name>.ghe.com host.' } });
}

export interface GitHubResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** A GitHub answer that is not a success, without its body. `status` 0 = no answer (network, timeout). */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAt: string | null = null,
  ) {
    super(message);
  }
}

export class GitHubClient {
  readonly endpoints: GitHubEndpoints;
  readonly #fetch: typeof fetch;

  constructor(opts: GitHubClientOptions) {
    for (const [k, v] of Object.entries(opts.endpoints)) {
      const u = new URL(v);
      if (u.username || u.password || u.search || u.hash) throw new Error(`GitHub ${k} endpoint must be a bare origin`);
      if (!opts.allowOtherHosts && (u.protocol !== 'https:' || !isGitHubHost(u.hostname))) throw new Error(`GitHub ${k} endpoint ${u.origin} is not a GitHub host`);
    }
    this.endpoints = { web: opts.endpoints.web.replace(/\/+$/, ''), api: opts.endpoints.api.replace(/\/+$/, '') };
    this.#fetch = opts.fetch ?? fetch;
  }

  /** A form POST to the web origin, for the device flow (`/login/device/code`, `/login/oauth/access_token`). JSON answers. */
  async devicePost(path: '/login/device/code' | '/login/oauth/access_token', form: Record<string, string>): Promise<GitHubResponse<Record<string, unknown>>> {
    return this.#send(`${this.endpoints.web}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams(form).toString(),
    });
  }

  /** A REST call with a person's token. `path` is built by the provider from validated parts only. */
  async api<T>(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<GitHubResponse<T>> {
    if (!path.startsWith('/') || path.includes('..') || /[\s#]/.test(path)) throw new Error('bad GitHub path');
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': USER_AGENT,
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.#send<T>(`${this.endpoints.api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status >= 400) throw toError(res);
    return res;
  }

  async #send<T>(url: string, init: RequestInit): Promise<GitHubResponse<T>> {
    let res: Response;
    try {
      res = await this.#fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const timeout = (e as Error).name === 'TimeoutError';
      throw new GitHubError(0, timeout ? 'GitHub did not answer in time.' : 'GitHub could not be reached.');
    }
    const text = await res.text();
    if (text.length > BODY_LIMIT) throw new GitHubError(res.status, 'GitHub sent more than expected.');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body: body as T, headers: res.headers };
  }
}

/** The fixed messages per status: GitHub's own message is not shown (it can quote input), only mapped. */
function toError(res: GitHubResponse<unknown>): GitHubError {
  const h = res.headers;
  const retryAfter = Number(h.get('retry-after'));
  const reset = Number(h.get('x-ratelimit-reset'));
  if ((res.status === 403 || res.status === 429) && (h.get('x-ratelimit-remaining') === '0' || retryAfter > 0 || res.status === 429)) {
    const at = retryAfter > 0 ? Date.now() + retryAfter * 1000 : reset > 0 ? reset * 1000 : Date.now() + 60_000;
    return new GitHubError(429, 'GitHub’s rate limit was reached.', new Date(at).toISOString());
  }
  const msg: Record<number, string> = {
    400: 'GitHub refused the request.',
    401: 'GitHub refused the token (revoked, expired or wrong).',
    402: 'GitHub needs a payment method or a higher spending limit for Codespaces.',
    403: 'The token lacks a permission, or an organization policy blocks this.',
    404: 'Not found at GitHub, or the token cannot see it.',
    409: 'GitHub says the codespace is busy with another operation.',
    422: 'GitHub could not process the request.',
    503: 'Codespaces is unavailable at GitHub right now.',
  };
  return new GitHubError(res.status, msg[res.status] ?? `GitHub answered ${res.status}.`);
}

/** A GitHubError as the portal answers it. */
export function appErrorOf(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (!(e instanceof GitHubError)) return new AppError('INTERNAL_ERROR', 'Something went wrong talking to GitHub.');
  if (e.status === 429) return new AppError('RATE_LIMITED', e.message, { details: { retryAt: e.retryAt } });
  if (e.status === 404) return new AppError('NOT_FOUND', e.message);
  if (e.status === 409) return new AppError('CONFLICT', e.message);
  if (e.status === 0 || e.status >= 500) return new AppError('SERVICE_UNAVAILABLE', e.message);
  if (e.status === 401 || e.status === 403 || e.status === 402) return new AppError('FORBIDDEN', e.message, { details: { github: e.status } });
  return new AppError('BAD_REQUEST', e.message, { details: { github: e.status } });
}

/** The kind of token by its prefix (GitHub's documented prefixes). */
export function tokenTypeOf(token: string): 'github_pat' | 'gho' | 'ghu' | 'ghp' | null {
  if (token.startsWith('github_pat_')) return 'github_pat';
  if (token.startsWith('gho_')) return 'gho';
  if (token.startsWith('ghu_')) return 'ghu';
  if (token.startsWith('ghp_')) return 'ghp';
  return null;
}
