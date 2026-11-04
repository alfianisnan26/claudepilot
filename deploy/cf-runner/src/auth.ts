// Request signing between scripts/job-run.sh (scripts/job-run-cf-client.mjs) and the dispatcher (T-3542, CFR-2, decision D5: one HMAC key
// per workspace). The key is never sent: each request carries the workspace id, a unix time and
//   sig = hex(HMAC-SHA256(key, METHOD "\n" PATH?QUERY "\n" TS "\n" hex(SHA-256(body))))
// The Worker holds the keys as one secret, JOBRUN_KEYS = {"<workspace>": "<64 hex>"}. A request older or newer than SKEW_S is refused, so a
// captured request replays only within that window (TLS keeps it from being captured in the first place).

export const SKEW_S = 300;
const enc = new TextEncoder();

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(body: ArrayBuffer | Uint8Array | string): Promise<string> {
  const data = typeof body === 'string' ? enc.encode(body) : body;
  return hex(await crypto.subtle.digest('SHA-256', data));
}

export async function sign(key: string, method: string, pathQuery: string, ts: string, bodyHash: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(`${method.toUpperCase()}\n${pathQuery}\n${ts}\n${bodyHash}`)));
}

/** Constant-time compare of two hex strings of the same length. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function parseKeys(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [ws, k] of Object.entries(o)) {
      if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(ws) && typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)) out[ws] = k;
    }
    return out;
  } catch {
    return {};
  }
}

export type AuthResult = { ok: true; workspace: string } | { ok: false; why: string };

/** Checks a request's signature. `body` is the raw body bytes (empty for GET/DELETE). `now` in unix seconds (tests pass a fixed one). */
export async function verify(req: Request, body: ArrayBuffer, keys: Record<string, string>, now: number): Promise<AuthResult> {
  const ws = req.headers.get('x-jobrun-key') ?? '';
  const ts = req.headers.get('x-jobrun-ts') ?? '';
  const sig = (req.headers.get('x-jobrun-sig') ?? '').toLowerCase();
  const key = keys[ws];
  if (!key) return { ok: false, why: 'unknown workspace' };
  if (!/^[0-9]{9,11}$/.test(ts) || Math.abs(now - Number(ts)) > SKEW_S) return { ok: false, why: 'stale or bad timestamp' };
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, why: 'bad signature' };
  const u = new URL(req.url);
  const want = await sign(key, req.method, u.pathname + u.search, ts, await sha256Hex(body));
  return same(want, sig) ? { ok: true, workspace: ws } : { ok: false, why: 'bad signature' };
}
