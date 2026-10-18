import { AppError } from '@isnanme/core';
import type { MultiPoolType, Verb, Workspace } from '@portal/contracts';
import { z } from 'zod';
import { paginate, pageInput } from '../paging.js';
import { registerPortalTool, PortalToolError, type PortalToolContext } from '../registry.js';
import { actorOfPrincipal, visible } from '../../authz/seam.js';
import { assertCanChange, labelProse, resolveWorkspaceFor, uiLink, workspaceBrief } from './common.js';
import type { PortalToolDeps } from './deps.js';

const WORKSPACE_STATUSES = ['creating', 'starting', 'running', 'stopping', 'stopped', 'error'] as const;

/** Workspaces over MCP (portal-mcp PRD §13.1): reads, start/stop/sync, create, and delete behind a confirmation. */
export function registerWorkspaceTools(deps: PortalToolDeps): void {
  const { store, workspaces, chat, accountPools, poolService, reconciler } = deps;

  /** The view the UI shows: with its account pool and delivery status. */
  const decorate = (w: Workspace): Workspace => {
    const row = reconciler.row(w.id);
    return { ...w, account: accountPools.stateFor(w.id), delivery: row ? { status: row.status, reason: row.reason, appliedAt: row.applied_at, claudeVersion: row.claude_version } : null };
  };
  // Any form of the id, through the manager's one resolver (T-42): it also knows the labels a workspace had before a rename. T-1043 S0c: out
  // of the workspaces the caller may view, and `verb` asked of the seam on the one found (the dispatch asked about the form given).
  const find = async (idOrName: string, verb: Verb, ctx: PortalToolContext) =>
    decorate(resolveWorkspaceFor(actorOfPrincipal(ctx.principal), verb, await workspaces.list(), idOrName, (ref) => workspaces.resolve?.(ref) ?? null));
  const liveSessions = (id: string) => chat.list().filter((s) => s.workspaceId === id && s.state !== 'ended' && !s.archivedAt);

  registerPortalTool({
    name: 'workspace_list',
    title: 'List workspaces',
    description: 'Workspaces across every target, newest first: status, limits, the account pool and delivery state. Page with cursor and limit.',
    scope: 'read',
    input: z.object({
      target: z.string().max(40).optional().describe('Only this target, e.g. docker.'),
      status: z.enum(WORKSPACE_STATUSES).optional(),
      query: z.string().max(80).optional().describe('Part of a workspace name.'),
      ...pageInput,
    }),
    async handler(ctx, args) {
      const all = visible(actorOfPrincipal(ctx.principal), 'workspace', await workspaces.list(), (w) => w.id).map(decorate).filter((w) => (!args.target || w.target === args.target) && (!args.status || w.status === args.status) && (!args.query || w.name.includes(args.query.toLowerCase())));
      const page = paginate(all, args, { t: args.target, s: args.status, q: args.query });
      return { summary: `${page.total} workspaces.`, workspaces: page.items.map((w) => workspaceBrief(w, ctx)), total: page.total, next_cursor: page.next_cursor };
    },
  });

  registerPortalTool({
    name: 'workspace_get',
    title: 'Get a workspace',
    description: 'One workspace in full: status, limits, pools by type, delivery state, its Claudes, its chat sessions and what it is using now. Accepts the stable id (ws_…), the id (target/name) or the exact name.',
    scope: 'read',
    input: z.object({
      id: z.string().max(100).describe('The stable id (`ws_` and 12 hex), `<target>/<name>`, or just the name when it is unique.'),
      include: z.array(z.enum(['usage', 'sessions', 'claudes', 'pools'])).max(4).optional().describe('Extras to include (default: pools, sessions and claudes).'),
    }),
    async handler(ctx, args) {
      const w = await find(args.id, 'view', ctx);
      const include = new Set(args.include ?? ['pools', 'sessions', 'claudes']);
      const out: Record<string, unknown> = { summary: `${w.id} is ${w.status}.`, workspace: workspaceBrief(w, ctx), ui: uiLink(`/admin/workspaces`) };
      if (include.has('pools'))
        out.pools = poolService.assignmentsFor(w.id).map((a) => ({ type: a.type, pool_id: a.poolId, name: a.poolName, revision: a.revision, pinned_revision: a.pinnedRevision, state: a.state }));
      if (include.has('sessions'))
        out.sessions = visible(
          actorOfPrincipal(ctx.principal),
          'session',
          chat.list().filter((s) => s.workspaceId === w.id && !s.archivedAt),
          (s) => s.id,
        )
          .slice(0, 20)
          .map((s) => ({ id: s.id, title: ctx.untrusted(s.title, 'agent'), state: s.state, last_activity_at: s.lastActivityAt }));
      if (include.has('claudes')) out.claudes = chat.listClaudes(w.id).filter((c) => !c.removedAt).map((c) => ({ id: c.id, name: c.name }));
      if (include.has('usage')) {
        const u = (await workspaces.usage()).find((x) => x.id === w.id);
        out.usage = u ? { cpu_percent: u.cpuPercent, memory_bytes: u.memoryBytes } : null;
      }
      return out;
    },
  });

  registerPortalTool({
    name: 'workspace_create',
    title: 'Create a workspace',
    description:
      'Creates a workspace and returns at once with status creating; poll workspace_get until it runs. Optionally assigns an account pool and pools (by id or exact name) from the start.',
    scope: 'admin',
    input: z.object({
      name: z.string().min(1).max(40).describe('Lowercase letters, digits and dashes; starts with a letter.'),
      target: z.string().max(40).describe('Where it runs, e.g. docker (see portal_status).'),
      cpus: z.number().positive().max(64).optional(),
      memory_mb: z.number().int().min(256).optional(),
      account_pool: z.string().max(100).optional().describe('An account pool id or exact name.'),
      pools: z
        .object({ secrets: z.array(z.string()).max(20).optional(), skillset: z.array(z.string()).max(20).optional(), mcpset: z.array(z.string()).max(20).optional() })
        .optional()
        .describe('Pools of each multi-assignment type, by id or exact name.'),
    }),
    async handler(ctx, args) {
      assertCanChange(store, 'workspace');
      // Names resolve to ids first, so a typo is refused before anything is created.
      let poolId: string | null = null;
      if (args.account_pool) {
        const found = accountPools.list().filter((p) => p.id === args.account_pool || p.name === args.account_pool);
        if (found.length !== 1) throw new AppError('VALIDATION_FAILED', `No single account pool “${args.account_pool}”.`, { details: { account_pool: 'Use an id or an exact name.' } });
        poolId = found[0]!.id;
      }
      const wanted: Partial<Record<MultiPoolType, string[]>> = {};
      for (const [type, items] of Object.entries(args.pools ?? {}) as [MultiPoolType, string[] | undefined][]) {
        if (!items?.length) continue;
        wanted[type] = items.map((x) => {
          const found = poolService.list(type).filter((p) => p.id === x || p.name === x);
          if (found.length !== 1) throw new AppError('VALIDATION_FAILED', `No single ${type} pool “${x}”.`, { details: { pools: `Unknown ${type} pool.` } });
          return found[0]!.id;
        });
      }
      const addOns = poolService.checkAddOns(wanted);
      const created = await workspaces.create({ name: args.name, target: args.target, cpus: args.cpus, memoryMb: args.memory_mb });
      // A new workspace has no sign-in of its own yet, so no override confirmation is needed (as in the UI).
      if (poolId) accountPools.assign(created.id, { poolId }, { existing: false });
      for (const [type, ids] of Object.entries(addOns)) poolService.setAssignments(created.id, type, ids.map((id) => ({ poolId: id })));
      ctx.affected(`workspace:${created.id}`);
      console.log(`[portal-mcp] ${ctx.actor} creating workspace ${created.id}`);
      return { summary: `Creating ${created.id}.`, id: created.id, status: created.status, ui: uiLink('/admin/workspaces') };
    },
  });

  registerPortalTool({
    name: 'workspace_rename',
    title: 'Rename a workspace',
    description:
      'Changes the name a workspace is shown by (its label: 1 to 40 characters, one line, unique on its target). Nothing running is touched: its id, its runtime name, its volume and every reference stay, and every name it had keeps resolving. Asks for confirmation first, showing the change.',
    scope: 'admin',
    hints: { idempotent: true },
    input: z.object({
      id: z.string().max(100).describe('The stable id (`ws_` and 12 hex), `<target>/<name>`, or the name when it is unique.'),
      label: z.string().max(200).describe('The new name: plain text, one line, at most 40 characters, no slash.'),
      confirm_token: z.string().optional().describe('From the confirmation_required answer.'),
    }),
    async handler(ctx, args) {
      const w = await find(args.id, 'operate', ctx);
      assertCanChange(store, 'workspace');
      const actor = actorOfPrincipal(ctx.principal);
      // Checked before the confirmation: a label that is not allowed, or taken on the target, is refused at once.
      const plan = await workspaces.planRename(w.id, args.label, actor);
      const ids = { id: w.id, stable_id: w.stableId ?? plan.known.id, name: w.name };
      if (plan.unchanged) return { summary: `${w.id} is already called that.`, ...ids, label: labelProse(plan.to, 'workspace_label') };
      const gate = ctx.confirm(
        args,
        {
          rename: w.id,
          stable_id: ids.stable_id,
          from: labelProse(plan.from, 'workspace_label'),
          to: labelProse(plan.to, 'workspace_label'),
          changes: 'the name it is shown by, only',
          keeps: ['its id and every reference to it', 'its runtime name, container or pod, and its home volume', 'every name it had, which keeps resolving'],
        },
        `${ids.stable_id}@${plan.from}`,
      );
      if (gate) return gate;
      const done = await workspaces.rename(w.id, args.label, actor, { actor: ctx.actor, actorLabel: ctx.actorLabel });
      ctx.affected(`workspace:${w.id}`);
      return { summary: `Renamed ${w.id}.`, ...ids, label: labelProse(done.label, 'workspace_label'), previous: labelProse(done.previous, 'workspace_label') };
    },
  });

  registerPortalTool({
    name: 'workspace_resources',
    title: 'Change a workspace’s CPU and memory',
    description:
      'Sets the CPU and memory of a Kubernetes workspace: limits (cpus in cores, memory_mb in MiB) and what its pod reserves (cpu_request, memory_request_mb; never above the limits). Values left out keep what it has. apply "now" patches its Deployment and the pod restarts: EVERY session in that workspace ends; it is refused while a CI run is running there, and when the pod would not fit its node (the numbers are in the refusal). apply "next_restart" keeps them for its next start. Asks for confirmation first, showing the change and the fit check.',
    scope: 'admin',
    hints: { destructive: true, idempotent: true },
    input: z.object({
      id: z.string().max(100).describe('The stable id (`ws_` and 12 hex), `<target>/<name>`, or the name when it is unique.'),
      apply: z.enum(['now', 'next_restart']).describe('now: patch and restart the pod (every session in it ends); next_restart: at its next start.'),
      cpus: z.number().positive().max(64).optional().describe('CPU limit in cores, e.g. 4 or 0.5.'),
      memory_mb: z.number().int().positive().optional().describe('Memory limit in MiB, e.g. 8192.'),
      cpu_request: z.number().positive().max(64).optional().describe('CPU the pod reserves, in cores (at most cpus).'),
      memory_request_mb: z.number().int().positive().optional().describe('Memory the pod reserves, in MiB (at most memory_mb).'),
      confirm_token: z.string().optional().describe('From the confirmation_required answer.'),
    }),
    async handler(ctx, args) {
      const w = await find(args.id, 'operate', ctx);
      assertCanChange(store, 'workspace');
      const actor = actorOfPrincipal(ctx.principal);
      const req ={ apply: args.apply, cpus: args.cpus, memoryMb: args.memory_mb, cpuRequest: args.cpu_request, memoryRequestMb: args.memory_request_mb };
      // Checked before the confirmation: values out of bounds, a request above its limit, or a target without resources are refused at once.
      const plan = await workspaces.planResources(w.id, req, actor);
      const show = (v: Partial<{ cpus: number; memoryMb: number; cpuRequest: number; memoryRequestMb: number }>) => ({ cpus: v.cpus ?? null, memory_mb: v.memoryMb ?? null, cpu_request: v.cpuRequest ?? null, memory_request_mb: v.memoryRequestMb ?? null });
      const ids = { id: w.id, stable_id: w.stableId ?? plan.known.id };
      if (plan.unchanged) return { summary: `${w.id} already has these values.`, ...ids, values: show(plan.values) };
      const restarts = plan.apply === 'now' && plan.replicas > 0;
      const gate = ctx.confirm(
        args,
        {
          resources: w.id,
          stable_id: ids.stable_id,
          from: show(plan.live),
          to: show(plan.values),
          apply: plan.apply,
          warning: restarts ? `The pod restarts now: every session in this workspace ends (${liveSessions(w.id).length} live).` : plan.apply === 'now' ? 'It is stopped: it starts with these values.' : 'Nothing restarts now: they apply at its next start.',
          fit: { state: plan.fit.state, message: plan.fit.message },
        },
        `${ids.stable_id}@${plan.apply}:${JSON.stringify(plan.values)}`,
      );
      if (gate) return gate;
      const done = await workspaces.setResources(w.id, req, actor, { actor: ctx.actor, actorLabel: ctx.actorLabel });
      ctx.affected(`workspace:${w.id}`);
      return {
        summary: done.outcome === 'applied' ? (restarts ? `Applied to ${w.id}: its pod restarts.` : `Applied to ${w.id}.`) : done.outcome === 'pending' ? `Kept for the next start of ${w.id}.` : `${w.id} already has these values.`,
        ...ids,
        outcome: done.outcome,
        wanted: done.wanted ? show(done.wanted) : null,
        live: show(done.live),
        pending: done.pending,
        fit: done.fit ? { state: done.fit.state, message: done.fit.message } : null,
      };
    },
  });

  registerPortalTool({
    name: 'workspace_start',
    title: 'Start a workspace',
    description: 'Starts a stopped workspace. Returns at once; its status moves to starting, then running.',
    scope: 'operate',
    hints: { idempotent: true },
    input: z.object({ id: z.string().max(100) }),
    async handler(ctx, args) {
      const w = await find(args.id, 'operate', ctx);
      assertCanChange(store, 'workspace');
      if (w.status === 'running') return { summary: `${w.id} is already running.`, id: w.id, status: w.status };
      await workspaces.start(w.target, w.name);
      ctx.affected(`workspace:${w.id}`);
      return { summary: `Starting ${w.id}.`, id: w.id, status: 'starting' };
    },
  });

  registerPortalTool({
    name: 'workspace_stop',
    title: 'Stop a workspace',
    description: 'Stops a running workspace. Its chat sessions stop with it; they can be resumed after it starts again.',
    scope: 'operate',
    hints: { destructive: true, idempotent: true },
    input: z.object({ id: z.string().max(100) }),
    async handler(ctx, args) {
      const w = await find(args.id, 'operate', ctx);
      assertCanChange(store, 'workspace');
      const sessions = liveSessions(w.id);
      if (w.status === 'stopped') return { summary: `${w.id} is already stopped.`, id: w.id, status: w.status, sessions_stopped: 0 };
      await workspaces.stop(w.target, w.name);
      ctx.affected(`workspace:${w.id}`);
      return { summary: `Stopping ${w.id}.`, id: w.id, status: 'stopping', sessions_stopped: sessions.length };
    },
  });

  registerPortalTool({
    name: 'workspace_sync',
    title: 'Re-deliver configuration to a workspace',
    description: 'Asks the delivery engine to compare a workspace with what its pools say it should have, and fix it. Returns the delivery state after the attempt was requested.',
    scope: 'operate',
    hints: { idempotent: true },
    input: z.object({ id: z.string().max(100) }),
    async handler(ctx, args) {
      const w = await find(args.id, 'operate', ctx);
      assertCanChange(store, 'pool');
      await reconciler.request(w.id, `portal mcp sync (${ctx.actor})`);
      const row = reconciler.row(w.id);
      ctx.affected(`workspace:${w.id}`);
      return {
        summary: `${w.id} delivery is ${row?.status ?? 'none'}.`,
        id: w.id,
        delivery: row ? { status: row.status, reason: ctx.untrusted(row.reason, 'delivery'), applied_at: row.applied_at } : null,
      };
    },
  });

  registerPortalTool({
    name: 'workspace_delete',
    title: 'Delete a workspace',
    description:
      'Deletes a workspace, its home volume (repositories, sign-ins, session files) and its pool assignments. Cannot be undone. Asks for confirmation first, showing what will be lost.',
    scope: 'admin',
    hints: { destructive: true, idempotent: true },
    input: z.object({ id: z.string().max(100), confirm_token: z.string().optional().describe('From the confirmation_required answer.') }),
    async handler(ctx, args) {
      const w = await find(args.id, 'manage', ctx);
      assertCanChange(store, 'workspace');
      const sessions = liveSessions(w.id);
      const assignments = poolService.assignmentsFor(w.id);
      const gate = ctx.confirm(
        args,
        {
          delete: w.id,
          status: w.status,
          loses: ['the workspace container', 'its home volume: repositories, Claude sign-ins, files and session data'],
          running_sessions: sessions.length,
          pool_assignments: assignments.map((a) => `${a.type}: ${a.poolName}`).concat(w.account ? [`account pool: ${w.account.poolName}`] : []),
        },
        `${w.id}@${w.createdAt}`,
      );
      if (gate) return gate;
      if (w.status === 'creating') throw new PortalToolError('CONFLICT', 'It is still being created. Wait for it to finish, then delete it.');
      await workspaces.remove(w.target, w.name);
      accountPools.forgetWorkspace(w.id);
      poolService.forgetWorkspace(w.id);
      ctx.affected(`workspace:${w.id}`);
      console.log(`[portal-mcp] ${ctx.actor} deleted workspace ${w.id}`);
      return { summary: `Deleted ${w.id}.`, id: w.id, deleted: true };
    },
  });
}
