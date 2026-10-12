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

/** The eight 16-bit groups of an IPv6 address (`::` expanded, an embedded dotted quad read), or null when `ip` isn't one. */
function ipv6Groups(ip: string): number[] | null {
  const addr = ip.split('%')[0]!.toLowerCase();
  if (isIP(addr) !== 6) return null;
  const gap = addr.indexOf('::');
  const groups = (text: string) =>
    (text ? text.split(':') : []).flatMap((part) => {
      if (!part.includes('.')) return [parseInt(part, 16)];
      const [a, b, c, d] = part.split('.').map(Number) as [number, number, number, number];
      return [a * 256 + b, c * 256 + d];
    });
  if (gap < 0) {
    const all = groups(addr);
    return all.length === 8 ? all : null;
  }
  const head = groups(addr.slice(0, gap));
  const tail = groups(addr.slice(gap + 2));
  const fill = 8 - head.length - tail.length;
  return fill < 0 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

const dotted = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * The IPv4 address an IPv6 one stands for, when it does: mapped (`::ffff:a.b.c.d`, which `new URL` spells
 * `::ffff:7f00:1`), compatible (`::a.b.c.d`), translated (`::ffff:0:a.b.c.d`), NAT64 (`64:ff9b::/96`) and
 * 6to4 (`2002:aabb:ccdd::/48`). Null for any other address.
 */
export function embeddedIPv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return dotted(g[6]!, g[7]!);
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return dotted(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return dotted(g[6]!, g[7]!);
  if (g[0] === 0x2002) return dotted(g[1]!, g[2]!);
  return null;
}

/**
 * Private, loopback, link-local and other non-public addresses (IPv4 and IPv6). An IPv6 address that
 * carries an IPv4 one is judged by that one, in whatever spelling (`::ffff:127.0.0.1` is `::ffff:7f00:1`
 * once a URL parser has seen it). Anything that is not an IP address is refused.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
      (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // TEST-NET-3
      a >= 224
    );
  }
  const g = ipv6Groups(ip);
  if (!g) return true;
  const inner = embeddedIPv4(ip);
  if (inner) return isPrivateAddress(inner);
  const first = g[0]!;
  return (
    g.every((x) => x === 0) || // ::
    (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) || // ::1
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    (first === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) || // Teredo, documentation
    (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) || // 100::/64 discard-only
    (first === 0x64 && g[1] === 0xff9b && g[2] === 1) // 64:ff9b:1::/48 local-use NAT64
  );
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
