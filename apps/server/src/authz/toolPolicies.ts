// Portal MCP tools that had no declaration (organizations slice 1, P4). With this table every tool of the portal declares its access, and the
// dispatch refuses a tool that does not (`requireToolPolicy`, seam.ts). What each kind means at dispatch (T-348):
//   - `objects`: every named id through the one can() before the handler (a refusal reads like a missing object);
//   - `platform`: the area at the verb (an agent never reaches one);
//   - `agent` (reach from the token) and `signed-in`: the handler's own rules, which stay as they were. They are used where an argument is
//     not an id the seam can resolve (a set or an account pool named by its exact name, a vault by its binding, a ticket under the FR9a
//     rules of the tickets service) or where the tool acts on the caller's own session tree.
// The token's scope still caps the user's level (read = view, operate = operate, admin = manage).

import type { ToolObjectCheck, ToolPolicies, ToolPolicy, Verb } from '@portal/contracts';
import { NO_SESSION } from '../chat/authz.js';
import { declareToolPolicies } from './seam.js';

const objects = (...checks: ToolObjectCheck[]): ToolPolicy => ({ kind: 'objects', checks });
const workspace = (verb: Verb, arg = 'id', optional = false): ToolObjectCheck => ({ type: 'workspace', verb, arg, ...(optional ? { optional } : {}) });
const session = (verb: Verb, arg = 'id'): ToolObjectCheck => ({ type: 'session', verb, arg, notFound: NO_SESSION });
const SELF_SESSION: ToolPolicy = { kind: 'agent', reach: 'session' };
const TREE: ToolPolicy = { kind: 'agent', reach: 'tree' };
const WORKSPACE_REACH: ToolPolicy = { kind: 'agent', reach: 'workspace' };
const HANDLER: ToolPolicy = { kind: 'signed-in' };

export const TOOL_TABLE_POLICIES: ToolPolicies = {
  // The caller's own session and its crew (an agent's token: its session tree).
  artifact_publish: SELF_SESSION,
  session_rename_self: SELF_SESSION,
  persona_get_self: SELF_SESSION,
  persona_propose_update: SELF_SESSION,
  persona_set_avatar_proposal: SELF_SESSION,
  skill_propose: SELF_SESSION,
  skill_proposals_list: SELF_SESSION,
  mcp_propose_entry: SELF_SESSION,
  mcp_proposal_withdraw: SELF_SESSION,
  session_spawn: TREE,
  session_message: TREE,
  session_family: TREE,
  session_stop_worker: TREE,
  crew_post: TREE,
  crew_read: TREE,
  // The agent's own workspace (repositories, worktrees, its vaults' notes through their bindings), or what an admin's token may see.
  repos_list: WORKSPACE_REACH,
  repo_get: WORKSPACE_REACH,
  repo_events: WORKSPACE_REACH,
  repos_attention: WORKSPACE_REACH,
  worktree_create: WORKSPACE_REACH,
  vault_list: WORKSPACE_REACH,
  note_search: WORKSPACE_REACH,
  note_read: WORKSPACE_REACH,
  note_backlinks: WORKSPACE_REACH,
  tag_list: WORKSPACE_REACH,
  graph_neighbours: WORKSPACE_REACH,
  graph_query: WORKSPACE_REACH,
  note_write: WORKSPACE_REACH,
  note_edit: WORKSPACE_REACH,
  note_append: WORKSPACE_REACH,
  daily_append: WORKSPACE_REACH,
  // Tickets: the tickets service's rules (bucket owner, the holder, acting for an ended session: FR9a, T-270).
  ticket_get: WORKSPACE_REACH,
  ticket_comment: WORKSPACE_REACH,
  ticket_attach: WORKSPACE_REACH,
  ticket_attachment_get: WORKSPACE_REACH,
  ticket_attachment_remove: WORKSPACE_REACH,
  ticket_claim_next: WORKSPACE_REACH,
  ticket_close: WORKSPACE_REACH,
  ticket_start_session: objects({ type: 'ticket', verb: 'operate', arg: 'id' }, workspace('operate', 'workspace_id')),
  // Read-only views an agent may ask about itself (its Claude, its usage, the portal's state); the service scopes them to the caller.
  claude_usage: HANDLER,
  usage_summary: HANDLER,
  usage_attribution: HANDLER,
  usage_budgets: HANDLER,
  usage_spikes: HANDLER,
  portal_status: HANDLER,
  mcp_catalog_list: HANDLER,
  mcp_builtin_list: HANDLER,
  // The platform's usage, monitoring and audit (an admin's token).
  claude_usage_summary: { kind: 'platform', area: 'usage', verb: 'view' },
  claude_usage_report: { kind: 'platform', area: 'usage', verb: 'view' },
  claude_move_advice: { kind: 'platform', area: 'usage', verb: 'view' },
  usage_report: { kind: 'platform', area: 'usage', verb: 'view' },
  monitor_overview: { kind: 'platform', area: 'usage', verb: 'view' },
  audit_search: { kind: 'platform', area: 'audit', verb: 'view' },
  mcp_lockdown: { kind: 'platform', area: 'emergency', verb: 'operate' },
  usage_budget_set: { kind: 'signed-in', creates: 'budget' },
  usage_budget_delete: objects({ type: 'budget', verb: 'manage', arg: 'id' }),
  // Workspaces and sessions, by id (any form of a workspace id; a session's alias is followed by its resolver).
  workspace_list: { kind: 'signed-in', filter: 'workspace' },
  workspace_create: { kind: 'signed-in', creates: 'workspace' },
  workspace_get: objects(workspace('view')),
  workspace_start: objects(workspace('operate')),
  workspace_stop: objects(workspace('operate')),
  workspace_sync: objects(workspace('operate')),
  workspace_delete: objects(workspace('manage')),
  session_list: { kind: 'objects', checks: [workspace('view', 'workspace_id', true)], filter: 'session' },
  session_get: objects(session('view')),
  session_interrupt: objects(session('operate')),
  session_end: objects(session('operate')),
  session_send: objects(session('operate')),
  session_respond: objects(session('operate')),
  session_configure: objects(session('manage')),
  // Sets and account pools may be named by their exact name: the handler resolves the name, then checks (no id for the dispatch).
  pool_types: HANDLER,
  pool_list: { kind: 'signed-in', filter: 'pool' },
  pool_get: HANDLER,
  pool_create: { kind: 'signed-in', creates: 'pool' },
  pool_update: HANDLER,
  pool_delete: HANDLER,
  pool_assign: { kind: 'objects', checks: [{ type: 'workspace', verb: 'manage', arg: 'workspace_ids', many: true }] },
  pool_unassign: { kind: 'objects', checks: [{ type: 'workspace', verb: 'manage', arg: 'workspace_ids', many: true }] },
  account_pool_list: { kind: 'signed-in', filter: 'account_pool' },
  account_list: { kind: 'signed-in', filter: 'account' },
  account_check: objects({ type: 'account', verb: 'operate', arg: 'id' }),
  account_pool_assign: objects(workspace('manage', 'workspace_id')),
};

export function declareToolTablePolicies(): void {
  declareToolPolicies('tools', TOOL_TABLE_POLICIES);
}
