// Portal MCP tool policy (v0), generated from the registered tool list (tools.tsv) and checked for full coverage.
import { readFileSync } from 'node:fs';
const rows = readFileSync(new URL('./tools.tsv', import.meta.url), 'utf8').split('\n').map((l) => l.split('\t'));
const R = [];
const rule = (re, access, note = '') => R.push({ re: new RegExp(`^(${re})$`), access, note });
// workspaces
rule('workspace_list', 'list(workspace)', '');
rule('workspace_get', 'workspace view workspace_id', '');
rule('workspace_create', 'create(workspace); target operate', 'owned by the token\'s user; host-level targets need an admin owner');
rule('workspace_start|workspace_stop|workspace_sync', 'workspace operate workspace_id', '');
rule('workspace_delete', 'workspace manage workspace_id +confirm', '');
// accounts
rule('account_pool_list', 'list(account_pool)', '');
rule('account_list', 'list(account)', 'never a key');
rule('account_check', 'account operate account_id', '');
rule('account_pool_assign', 'workspace manage workspace_id; account_pool operate pool_id', 'credential exposure rules');
// pools
rule('pool_types', 'signed-in', '');
rule('pool_list', 'list(pool)', '');
rule('pool_get', 'pool view pool_id', '');
rule('pool_create', 'create(pool)', '');
rule('pool_update|pool_delete', 'pool manage pool_id', 'delete +confirm');
rule('pool_assign|pool_unassign', 'workspace manage workspace_id; pool operate pool_id', '');
// monitor, portal
rule('monitor_overview', 'signed-in; counts only what is visible', '');
rule('usage_report', 'signed-in + memberScope', '');
rule('portal_status', 'signed-in', 'agent-callable: no platform detail');
rule('audit_search', 'own rows; platform(audit,view) for all', '');
rule('mcp_lockdown', 'self (own tokens); platform(emergency,manage) for all users and agents', '');
// sessions (admin tools)
rule('session_list', 'list(session)', '');
rule('session_get', 'session view session_id', '');
rule('session_interrupt|session_end', 'session operate session_id', '');
rule('session_start', 'workspace operate workspace_id; claude operate claude_id', 'the session is owned by the token\'s user; never bypass-capable');
rule('session_send', 'session operate session_id', 'scope admin today: stays');
rule('session_respond', 'session operate session_id', 'allow needs scope admin; never Bypass');
rule('session_configure', 'session operate session_id', 'model, effort, mode; never enters Bypass');
// chat agent tools
rule('session_rename_self|artifact_publish', 'agent: own session only', '');
rule('session_spawn', 'agent: own session; creates a child owned by the root creator', 'caps and policy stay');
rule('session_message|session_family|session_stop_worker', 'agent: own session tree only', '');
// catalog and skills
rule('mcp_catalog_list|mcp_builtin_list', 'list(mcp_entry) / signed-in', '');
rule('mcp_propose_entry|mcp_proposal_withdraw', 'create(mcp_entry draft) owned by the owner; withdraw own', 'never approves');
rule('skill_propose|skill_proposals_list', 'own workspace\'s persona/skills; proposal owned by the owner of the target set', 'never approves');
rule('persona_get_self|persona_propose_update|persona_set_avatar_proposal', 'agent: own workspace\'s persona; proposal for its owner', 'never approves');
// tickets
rule('ticket_list', 'list(ticket); agent: its workspace and the owner\'s shared queue', '');
rule('ticket_get', 'ticket view id', '');
rule('ticket_create', 'create(ticket) owned by the token/agent owner', '');
rule('ticket_update|ticket_comment|ticket_close', 'ticket operate id; agent: assigned to its session', '');
rule('ticket_claim_next', 'list(ticket) operate; agent only', '');
rule('ticket_start_session', 'ticket operate id; workspace operate; claude operate', '');
// repos, ci
rule('repos_list|repos_attention', 'list(repo)', '');
rule('repo_get|repo_events', 'repo view id', '');
rule('worktree_create', 'repo operate id; agent: own workspace', '');
rule('ci_runs_list', 'list(ci_run)', '');
rule('ci_run_get|ci_run_logs', 'ci_run view id', '');
rule('ci_validate', 'signed-in', '');
rule('ci_run_trigger|ci_run_cancel', 'ci_repo operate / ci_run operate; agent: its own branch', '');
// usage
rule('usage_summary|usage_attribution|usage_budgets|usage_spikes', 'signed-in + memberScope / Visibility', 'agent: own tree');
rule('usage_budget_set|usage_budget_delete', 'budget manage / workspace manage / platform(usage,manage)', '+confirm');
rule('claude_usage', 'claude view; agent: its own Claude', '');
rule('claude_usage_summary|claude_usage_report|claude_move_advice', 'signed-in + Claudes the user may use', '');
// knowledge
rule('vault_list', 'list(vault) ∩ token vault allow-list', '');
rule('note_search|note_read|note_backlinks|tag_list|graph_neighbours|graph_query', 'vault view vault', 'agent: also the vault\'s agent policy');
rule('note_write|note_edit|note_append|daily_append', 'vault operate vault', 'agent: also the vault\'s agent policy; agent notes stay out of snapshots until promoted');
const out = []; const un = [];
for (const [file, name, scope, ro, d] of rows) {
  const hit = R.find((r) => r.re.test(name));
  if (!hit) un.push(name); else out.push({ file, name, scope, ro, d, ...hit });
}
console.error(`tools ${rows.length}, covered ${out.length}, unmatched ${un.length}: ${un.join(',')}`);
const unused = R.filter((r) => !rows.some((x) => r.re.test(x[1])));
if (unused.length) console.error('unused rules:', unused.map((r) => r.re.source).join(' '));
console.log('| Tool | Scope | Access | Note |\n| --- | --- | --- | --- |');
for (const o of out) console.log(`| \`${o.name}\` | ${o.scope}${o.ro ? ' R' : ''}${o.d ? ' D' : ''} | ${o.access.replace(/\|/g, '\\|')} | ${o.note.replace(/\|/g, '\\|')} |`);
