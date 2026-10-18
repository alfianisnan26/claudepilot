// The job-run Mac door (T-1083 S1b, D-84): who may call it.
//
// The door (`/jobrun/mac/*`, outside /api, like /mcp and /hooks/ci) takes ONE key: the calling session's own agent token (`PILOT_MCP_TOKEN`,
// `cpst_`), checked by `AgentAccess.verify` on every call (exists, not revoked or expired, agent access on for its workspace, the session alive).
// No token of its own and no table (coordinator, T-1083 #11498). A Portal MCP token (`cpat_`, even an admin's), a manager token (`cpmt_`) and
// the session cookie are never read as a key: verify refuses any other prefix, and the door reads only `Authorization: Bearer`.
//
// The verified principal maps to a `JobRunCaller` here and nowhere else: `{kind:'jobrun', session, workspaceId}`. It is not a seam Actor and
// reaches no other route: the door grants no pmcp scope and `/mcp` is unchanged. A caller's workspace must be on the admin's list
// (`jobrun.macClients`, empty = none). A run is seen and stopped only by the session that started it. Every refusal is the same 404 as a route
// that does not exist.

import type { RoutePolicies } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';
import type { AgentVerify } from '../portalmcp/agents.js';

/** Who called the door: one live session of one workspace on the list. */
export interface JobRunCaller {
  kind: 'jobrun';
  session: string;
  workspaceId: string;
}

/**
 * The door's whole bearer check after verify: an ok agent principal with a session and a workspace, and that workspace on the list. Anything
 * else (a refusal, a user or manager principal, a workspace off the list) is null: the door answers 404.
 */
export function jobRunCallerOf(v: AgentVerify, clients: readonly string[]): JobRunCaller | null {
  if (!v.ok) return null;
  const p = v.principal;
  if (p.kind !== 'agent' || p.scope !== 'agent' || !p.sessionId || !p.workspaceId) return null;
  if (!clients.includes(p.workspaceId)) return null;
  return { kind: 'jobrun', session: p.sessionId, workspaceId: p.workspaceId };
}

/** The settings value as a list: workspace ids split on commas or white space; anything that is not `<target>/<name>` is dropped. */
export function clientList(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return v.split(/[\s,]+/).filter((s) => /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}$/.test(s));
}

const DOOR_CHECKS = [
  'the bearer is the calling session’s agent token: AgentAccess.verify (cpst_ only, live, not revoked or expired, agent access on)',
  'the token’s workspace is on jobrun.macClients (empty: none)',
];

export const JOBRUN_DOOR_POLICIES = {
  'GET /jobrun/mac/slot': { kind: 'handler', checks: DOOR_CHECKS },
  'GET /jobrun/mac/runs': { kind: 'handler', checks: [...DOOR_CHECKS, 'only the runs this session started'] },
  'POST /jobrun/mac/runs': { kind: 'handler', checks: [...DOOR_CHECKS, 'a body of at most 64 KiB'] },
  'GET /jobrun/mac/runs/:id/log': { kind: 'handler', checks: [...DOOR_CHECKS, 'a run this session started'] },
  'DELETE /jobrun/mac/runs/:id': { kind: 'handler', checks: [...DOOR_CHECKS, 'a run this session started'] },
} satisfies RoutePolicies;

let declared = false;
/** Declares the routes once (idempotent: modules load more than once in tests). */
export function declareJobRunPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('jobrun', JOBRUN_DOOR_POLICIES);
}
