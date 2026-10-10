import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '@isnanme/core';
import type { CheckResult } from '@portal/contracts';

const TIMEOUT_MS = 10_000;
const DETAIL_MAX = 300;

/**
 * Stores a base URL the way Claude Code wants it: no trailing `/`, `/v1` or `/v1/messages`
 * (Claude Code appends `/v1/messages` itself). Only http(s), no credentials, query or fragment.
 */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Enter a full URL, like https://gateway.example.com.', {
      details: { baseUrl: 'Enter a full URL, like https://gateway.example.com.' },
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new AppError('VALIDATION_FAILED', 'Use an http or https URL.', { details: { baseUrl: 'Use an http or https URL.' } });
  if (url.username || url.password)
    throw new AppError('VALIDATION_FAILED', "Don't put credentials in the URL.", { details: { baseUrl: "Don't put credentials in the URL." } });
  if (url.search || url.hash)
    throw new AppError('VALIDATION_FAILED', 'Leave out the query and fragment.', { details: { baseUrl: 'Leave out the query and fragment.' } });
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1(\/messages)?$/, '').replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Private, loopback, link-local and other non-public addresses (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

/**
 * Guards checks against custom hosts (SSRF): the portal only calls public addresses unless the
 * endpoint allows private networks. The name is resolved here and again by fetch, so a host that
 * changes its DNS answer in between could slip through; acceptable for an admin-only portal.
 */
export async function assertReachableHost(baseUrl: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) return; // unresolvable: the check reports it as unreachable
  if (addresses.some(isPrivateAddress))
    throw new AppError('VALIDATION_FAILED', `${host} is a private address. Turn on "Allow private network" for this host to use it.`);
}

export interface CheckOutcome {
  result: CheckResult;
  status: number | null;
  detail: string | null;
  organizationId: string | null;
  anthropicWorkspaceId: string | null;
}

/** Takes the key (and anything ending in its last 12 characters) out of provider text. */
export function redact(text: string, key: string): string {
  let out = text.split(key).join('[redacted]');
  if (key.length > 16) out = out.split(key.slice(-12)).join('[redacted]');
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX - 1)}…` : out;
}

/** Sends the key the way Claude Code's apiKeyHelper does: both headers, same value. */
export function authHeaders(key: string): Record<string, string> {
  return { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' };
}

/** One result per response (Account Pool PRD §11.2): structured fields first, message text last. */
export function classify(status: number, body: unknown, headers: Headers): CheckResult {
  const error = (body as { error?: { type?: string; message?: string; details?: { error_code?: string } } } | null)?.error;
  const message = error?.message ?? '';
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) return 'invalid';
  if (status === 402) return 'billing';
  if (status === 403) return 'no_permission';
  if (status === 404) return 'wrong_path';
  if (status === 429)
    return error?.details?.error_code === 'enforced_spend_limit_reached' || (!headers.get('retry-after') && /spend/i.test(message))
      ? 'spend_limit'
      : 'rate_limited';
  if (status === 400 && /^You have reached your specified/i.test(message)) return 'spend_limit';
  if (status === 400 && /credit balance/i.test(message)) return 'billing';
  return 'error';
}

/** Validates a key against its endpoint with `GET /v1/models` (no inference, not billed). */
export async function checkKey(endpoint: { baseUrl: string; allowPrivateNetwork: boolean }, key: string): Promise<CheckOutcome> {
  const none = { organizationId: null, anthropicWorkspaceId: null };
  try {
    await assertReachableHost(endpoint.baseUrl, endpoint.allowPrivateNetwork);
  } catch (e) {
    return { result: 'unreachable', status: null, detail: (e as Error).message, ...none };
  }
  let res: Response;
  try {
    res = await fetch(`${endpoint.baseUrl}/v1/models?limit=1`, {
      headers: authHeaders(key),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const why = (e as Error).name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} s.` : (cause?.code ?? cause?.message ?? (e as Error).message);
    return { result: 'unreachable', status: null, detail: redact(String(why), key), ...none };
  }
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: classify by status
  }
  const result = classify(res.status, body, res.headers);
  const message = (body as { error?: { message?: string } } | null)?.error?.message;
  return {
    result,
    status: res.status,
    detail: result === 'ok' ? null : redact(message ?? (text.slice(0, DETAIL_MAX) || res.statusText), key),
    organizationId: res.headers.get('anthropic-organization-id'),
    anthropicWorkspaceId: res.headers.get('anthropic-workspace-id'),
  };
}

/** Model IDs a host serves (`GET /v1/models`), for picking custom model names. */
export async function listModels(endpoint: { baseUrl: string; allowPrivateNetwork: boolean }, key: string): Promise<string[]> {
  await assertReachableHost(endpoint.baseUrl, endpoint.allowPrivateNetwork);
  const res = await fetch(`${endpoint.baseUrl}/v1/models?limit=1000`, {
    headers: authHeaders(key),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e: unknown) => {
    throw new AppError('SERVICE_UNAVAILABLE', `The host didn't answer: ${redact((e as Error).message, key)}`);
  });
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  if (!res.ok) throw new AppError('SERVICE_UNAVAILABLE', `The host answered ${res.status} to /v1/models.`);
  return (body?.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}
