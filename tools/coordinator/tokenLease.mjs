// One short-lived Portal MCP admin token per run of an automation helper (T-258 item 5), shared by tools/coordinator/portal.mjs and
// docs/dev-sessions/supervisor.mjs.
//
// - Minted for 1 hour (`expiresIn: '1h'`), never the old 7 days.
// - Reused while it has more than `renewBeforeMs` left: a helper that makes many calls holds one token, not one per call.
// - Minted with `replace: true`: the portal revokes this label's live tokens first (a crashed run's leftover, or this run's
//   own token when it renews), one audit row each, so a label never piles up and never meets the 409 or the cap.
// - `revoke()` at the end of the run (and on SIGINT/SIGTERM in long-running helpers).
// The secret lives only in this process's memory and is never printed: errors name the code and message, never the token.
//
// `api(method, path, body)` is the helper's signed-in portal call and returns `{ status, data, error }`.

export const LEASE_LIFETIME = '1h';
const HOUR_MS = 60 * 60 * 1000;

export function tokenLease({ api, label, now = () => Date.now(), renewBeforeMs = 5 * 60 * 1000 }) {
  let held = null; // { id, secret, expiresAt }

  async function get() {
    if (held && Date.parse(held.expiresAt) - now() > renewBeforeMs) return held.secret;
    const r = await api('POST', '/api/portal-mcp/tokens', { label, scope: 'admin', expiresIn: LEASE_LIFETIME, replace: true });
    const id = r?.data?.token?.id;
    const secret = r?.data?.secret;
    if (!id || !secret) {
      held = null;
      throw new Error(`no Portal MCP token for "${label}": ${r?.error?.code ?? r?.status ?? 'no answer'} ${r?.error?.message ?? ''}`.trim());
    }
    held = { id, secret, expiresAt: r.data.token.expiresAt ?? new Date(now() + HOUR_MS).toISOString() };
    return secret;
  }

  async function revoke() {
    const id = held?.id;
    held = null;
    if (id) await api('DELETE', `/api/portal-mcp/tokens/${encodeURIComponent(id)}`).catch(() => {});
  }

  return {
    get,
    revoke,
    /** The id of the token held now (for logs: an id is not a secret), or null. */
    get id() {
      return held?.id ?? null;
    },
  };
}
