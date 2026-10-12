// Portal MCP tool policy v0: the FALLBACK declaration of every registered tool no module declares itself (docs/prd/authorization.md Appendix B,
// from the registered tool list of 2026-10-12, reviewed row by row against each tool's arguments). Consulted only for a tool with no
// `declareToolPolicies` row of its own (tools.ts `effectiveToolPolicyFor`); a module that declares its tools wins. The tool's own `scope` stays
// as a CAP (read = view, operate = operate, admin = manage; `agent` = operate inside its own session tree and workspace: evaluate.ts), this says
// which objects a call names. What a row cannot say is the handler's and noted: a conditional object (a budget's scope), a list the handler
// filters with `visible`, an agent's extra limits (its own branch, its own Claude, the vault's agent policy).

import type { ObjectType, ToolObjectCheck, ToolPolicies, ToolPolicy, Verb } from '@portal/contracts';
import { declareFallbackToolPolicies } from './tools.js';

const signedIn = (o: { filter?: ObjectType; creates?: ObjectType } = {}): ToolPolicy => ({ kind: 'signed-in', ...o });
const self: ToolPolicy = { kind: 'self' };
const agent = (reach: 'session' | 'tree' | 'workspace'): ToolPolicy => ({ kind: 'agent', reach });
const check = (type: ObjectType, verb: Verb, arg: string, o: Pick<ToolObjectCheck, 'optional' | 'many' | 'poolTypeArg'> = {}): ToolObjectCheck => ({ type, verb, arg, ...o });
const obj = (checks: ToolObjectCheck[], o: { filter?: ObjectType; creates?: ObjectType; confirm?: boolean } = {}): ToolPolicy => ({ kind: 'objects', checks, ...o });

export const TOOL_POLICIES_V0: ToolPolicies = {
  // workspaces (portalmcp/tools/workspaces.ts)
  workspace_list: signedIn({ filter: 'workspace' }),
  workspace_get: obj([check('workspace', 'view', 'id')]),
  workspace_create: obj([check('target', 'operate', 'target')], { creates: 'workspace' }), // owned by the token's user; a host-level target needs an admin (the resolver)
  workspace_start: obj([check('workspace', 'operate', 'id')]),
  workspace_stop: obj([check('workspace', 'operate', 'id')]),
  workspace_sync: obj([check('workspace', 'operate', 'id')]),
  workspace_delete: obj([check('workspace', 'manage', 'id')], { confirm: true }),
  // accounts (portalmcp/tools/accounts.ts): never a key
  account_pool_list: signedIn({ filter: 'account_pool' }),
  account_list: signedIn({ filter: 'account' }),
  account_check: obj([check('account', 'operate', 'id')]),
  account_pool_assign: obj([check('workspace', 'manage', 'workspace_id'), check('account_pool', 'operate', 'pool_id', { optional: true })]), // null removes the pool; credential exposure rules
  // sets (portalmcp/tools/pools.ts)
  pool_types: signedIn(),
  pool_list: signedIn({ filter: 'pool' }),
  pool_get: obj([check('pool', 'view', 'id')]),
  pool_create: signedIn({ creates: 'pool' }),
  pool_update: obj([check('pool', 'manage', 'id')]),
  pool_delete: obj([check('pool', 'manage', 'id')], { confirm: true }),
  pool_assign: obj([check('workspace', 'manage', 'workspace_id', { optional: true }), check('pool', 'operate', 'pool_id')]),
  pool_unassign: obj([check('workspace', 'manage', 'workspace_id', { optional: true }), check('pool', 'operate', 'pool_id')]),
  // monitor and portal (portalmcp/tools/{monitor,portal}.ts)
  monitor_overview: signedIn(), // counts only what is visible (the handler)
  usage_report: signedIn(), // memberScope (the handler)
  portal_status: signedIn(), // agent-callable: no platform detail
  audit_search: self, // own rows; platform(audit, view) for everyone's (the handler)
  mcp_lockdown: self, // own tokens; everyone's needs platform(emergency, manage) (the handler)
  // sessions (portalmcp/tools/sessions.ts)
  session_list: signedIn({ filter: 'session' }),
  session_get: obj([check('session', 'view', 'id')]),
  session_interrupt: obj([check('session', 'operate', 'id')]),
  session_end: obj([check('session', 'operate', 'id')]),
  session_start: obj([check('workspace', 'operate', 'workspace_id'), check('claude', 'operate', 'claude_id', { optional: true }), check('ticket', 'operate', 'ticket_id', { optional: true })], { creates: 'session' }), // owned by the token's user; never bypass-capable
  session_send: obj([check('session', 'operate', 'id')]),
  session_respond: obj([check('session', 'operate', 'id')]), // allow needs scope admin; never Bypass
  session_configure: obj([check('session', 'operate', 'id')]), // model, effort, mode; never enters Bypass
  // the chat's own tools for its Claude (chat/portalTools.ts, chat/artifacts/portalTools.ts)
  session_rename_self: agent('session'),
  artifact_publish: agent('session'),
  session_spawn: agent('session'), // creates a child owned by the root's creator; caps and policy stay
  session_message: agent('tree'),
  session_family: agent('tree'),
  session_stop_worker: agent('tree'),
  // catalog (portalmcp/tools/catalog.ts)
  mcp_catalog_list: signedIn({ filter: 'mcp_entry' }),
  mcp_builtin_list: signedIn({ filter: 'mcp_entry' }),
  mcp_propose_entry: signedIn({ creates: 'mcp_entry' }), // a draft owned by the proposer; never approves
  mcp_proposal_withdraw: self, // own proposals (the handler matches the proposer)
  // skills and personas (skills/portalTools.ts, personas/portalTools.ts): an agent about its own workspace; proposals go to the owner
  skill_propose: agent('workspace'),
  skill_proposals_list: agent('workspace'),
  persona_get_self: agent('workspace'),
  persona_propose_update: agent('workspace'),
  persona_set_avatar_proposal: agent('workspace'),
  // tickets (tickets/portalTools.ts)
  ticket_list: signedIn({ filter: 'ticket' }), // an agent: its workspace and the owner's shared queue (the handler)
  ticket_get: obj([check('ticket', 'view', 'id')]),
  ticket_create: obj([check('workspace', 'view', 'workspace_id', { optional: true })], { creates: 'ticket' }), // owned by the token's or agent's owner
  ticket_update: obj([check('ticket', 'operate', 'id')]), // an agent: assigned to its session (the handler)
  ticket_comment: obj([check('ticket', 'operate', 'id')]),
  ticket_claim_next: obj([check('ticket', 'operate', 'id', { optional: true })], { filter: 'ticket' }), // agent only
  ticket_close: obj([check('ticket', 'operate', 'id')]),
  ticket_start_session: obj([check('ticket', 'operate', 'id'), check('workspace', 'operate', 'workspace_id'), check('claude', 'operate', 'claude_id', { optional: true })]),
  // repositories (repos/portalTools.ts)
  repos_list: signedIn({ filter: 'repo' }),
  repo_get: obj([check('repo', 'view', 'id')]),
  repo_events: obj([check('repo', 'view', 'repo_id', { optional: true }), check('workspace', 'view', 'workspace_id', { optional: true })], { filter: 'repo' }),
  repos_attention: obj([check('workspace', 'view', 'workspace_id', { optional: true })], { filter: 'repo' }),
  worktree_create: obj([check('repo', 'operate', 'repo_id')]), // an agent: its own workspace (the cap)
  // CI (ci/portalTools.ts)
  ci_runs_list: obj([check('workspace', 'view', 'workspace_id', { optional: true })], { filter: 'ci_run' }),
  ci_run_get: obj([check('ci_run', 'view', 'id')]),
  ci_run_logs: obj([check('ci_run', 'view', 'id')]),
  ci_validate: signedIn(),
  ci_run_trigger: obj([check('workspace', 'operate', 'workspace_id', { optional: true })]), // `repo` is a name inside the workspace: the handler resolves it to the ci_repo and checks operate; an agent: its own branch
  ci_run_cancel: obj([check('ci_run', 'operate', 'id')]),
  // usage spend (usagespend/portalTools.ts): memberScope and Visibility in the handler; an agent: its own tree
  usage_summary: signedIn(),
  usage_attribution: obj([check('session', 'view', 'session_id', { optional: true }), check('claude', 'view', 'claude_id', { optional: true }), check('workspace', 'view', 'workspace_id', { optional: true })]),
  usage_budgets: signedIn(),
  usage_spikes: signedIn(),
  usage_budget_set: obj([check('budget', 'manage', 'id', { optional: true })], { creates: 'budget', confirm: true }), // a new budget: scope=workspace needs manage on scope_id, else platform(usage, manage) (the handler, MU6c)
  usage_budget_delete: obj([check('budget', 'manage', 'id')], { confirm: true }),
  // Claude usage (claudeusage/portalTools.ts)
  claude_usage: obj([check('claude', 'view', 'claude_id', { optional: true })], { filter: 'claude' }), // an agent: its own Claude
  claude_usage_summary: obj([check('claude', 'view', 'claude_id', { optional: true })], { filter: 'claude' }),
  claude_usage_report: obj([check('claude', 'view', 'claude_id', { optional: true })], { filter: 'claude' }),
  claude_move_advice: obj([check('workspace', 'view', 'workspace_id', { optional: true }), check('claude', 'view', 'from_claude_id', { optional: true })], { filter: 'claude' }),
  // knowledge (knowledge/portalTools.ts): an agent also passes the vault's own agent policy (the handler)
  vault_list: signedIn({ filter: 'vault' }), // ∩ the token's vault allow-list
  note_search: obj([check('vault', 'view', 'vault')]),
  note_read: obj([check('vault', 'view', 'vault')]),
  note_backlinks: obj([check('vault', 'view', 'vault')]),
  tag_list: obj([check('vault', 'view', 'vault')]),
  graph_neighbours: obj([check('vault', 'view', 'vault')]),
  graph_query: obj([check('vault', 'view', 'vault', { optional: true })], { filter: 'vault' }),
  note_write: obj([check('vault', 'operate', 'vault')]),
  note_edit: obj([check('vault', 'operate', 'vault')]),
  note_append: obj([check('vault', 'operate', 'vault')]),
  daily_append: obj([check('vault', 'operate', 'vault')]),
};

let declared = false;
/** Declares the fallback rows once (idempotent). */
export function declareToolPoliciesV0(): void {
  if (declared) return;
  declared = true;
  declareFallbackToolPolicies('authz.v0', TOOL_POLICIES_V0);
}
