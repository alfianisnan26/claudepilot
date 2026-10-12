import { AppError } from '@isnanme/core';
import type { Account } from '@portal/contracts';
import { z } from 'zod';
import { paginate, pageInput } from '../paging.js';
import { registerPortalTool, type PortalToolContext } from '../registry.js';
import { assertCanChange, assertUnlocked, resolveWorkspace, uiLink } from './common.js';
import type { PortalToolDeps } from './deps.js';

/** Account pools and accounts over MCP (portal-mcp PRD §13.2). Keys are never read or written here: masked values and fingerprints only. */
export function registerAccountTools(deps: PortalToolDeps): void {
  const { store, accounts, accountPools, workspaces, chat } = deps;

  const accountBrief = (a: Account, ctx: PortalToolContext) => ({
    id: a.id,
    name: a.name,
    endpoint_id: a.endpointId,
    key: a.hasSecret ? a.masked : 'missing',
    fingerprint: a.fingerprint,
    enabled: a.enabled,
    state: a.health.state,
    cooling_until: a.health.until,
    detail: ctx.untrusted(a.health.detail, 'client'),
    last_check: { result: a.check.result, at: a.check.at, detail: ctx.untrusted(a.check.detail, 'client') },
  });

  registerPortalTool({
    name: 'account_pool_list',
    title: 'List account pools',
    description: 'Account pools: their endpoint, strategy, members in priority order with each account’s state, and how many workspaces use them.',
    scope: 'read',
    input: z.object({ query: z.string().max(80).optional(), ...pageInput }),
    handler(ctx, args) {
      const byId = new Map(accounts.overview().accounts.map((a) => [a.id, a]));
      const all = accountPools.list().filter((p) => !args.query || p.name.toLowerCase().includes(args.query.toLowerCase()));
      const page = paginate(all, args, { q: args.query });
      return {
        summary: `${page.total} account pools.`,
        account_pools: page.items.map((p) => ({
          id: p.id,
          name: p.name,
          endpoint_id: p.endpointId,
          strategy: p.strategy,
          revision: p.revision,
          workspaces: p.workspaces,
          members: p.members.map((m) => {
            const a = byId.get(m.accountId);
            return { account_id: m.accountId, name: a?.name ?? null, enabled: m.enabled, state: a?.health.state ?? 'unknown' };
          }),
        })),
        total: page.total,
        next_cursor: page.next_cursor,
        ui: uiLink('/admin/pools?tab=accounts'),
      };
    },
  });

  registerPortalTool({
    name: 'account_list',
    title: 'List accounts',
    description: 'API-key accounts: masked key, endpoint, state and last check. Keys themselves are never shown. Error text from a provider is labelled untrusted.',
    scope: 'read',
    input: z.object({ state: z.enum(['ok', 'cooling', 'exhausted', 'billing', 'invalid', 'attention']).optional(), endpoint_id: z.string().max(80).optional(), ...pageInput }),
    handler(ctx, args) {
      const overview = accounts.overview();
      const all = overview.accounts.filter((a) => (!args.state || a.health.state === args.state) && (!args.endpoint_id || a.endpointId === args.endpoint_id));
      const page = paginate(all, args, { s: args.state, e: args.endpoint_id });
      return {
        summary: `${page.total} accounts.${overview.locked ? ' The portal is locked: keys cannot be used.' : ''}`,
        accounts: page.items.map((a) => accountBrief(a, ctx)),
        endpoints: overview.endpoints.map((e) => ({ id: e.id, name: e.name, kind: e.kind, accounts: e.accounts })),
        total: page.total,
        next_cursor: page.next_cursor,
      };
    },
  });

  registerPortalTool({
    name: 'account_check',
    title: 'Check an account’s key',
    description: 'Asks the provider whether an account’s key works, and records the result. The key is used by the portal and never shown.',
    scope: 'operate',
    hints: { idempotent: true, openWorld: true },
    input: z.object({ id: z.string().max(80).describe('The account id (see account_list).') }),
    async handler(ctx, args) {
      assertUnlocked(store);
      const before = accounts.overview().accounts.find((a) => a.id === args.id);
      if (!before) throw new AppError('NOT_FOUND', 'No such account. List them with account_list.');
      const a = await accounts.check(args.id);
      ctx.affected(`account:${a.id}`);
      return { summary: `${a.name}: ${a.check.result}.`, account: accountBrief(a, ctx) };
    },
  });

  registerPortalTool({
    name: 'account_pool_assign',
    title: 'Give a workspace an account pool',
    description:
      'Assigns an account pool to a workspace, or removes it (pool_id null: back to the workspace’s own sign-in). The pool’s key then outranks any sign-in there, billing moves to the pool and the workspace’s chat sessions end. Asks for confirmation first.',
    scope: 'admin',
    hints: { destructive: true, idempotent: true },
    input: z.object({
      workspace_id: z.string().max(100),
      pool_id: z.string().max(100).nullable().describe('An account pool id or exact name; null removes the pool.'),
      confirm_token: z.string().optional(),
    }),
    async handler(ctx, args) {
      assertCanChange(store, 'pool');
      const w = resolveWorkspace(await workspaces.list(), args.workspace_id);
      let poolId: string | null = null;
      if (args.pool_id !== null) {
        const found = accountPools.list().filter((p) => p.id === args.pool_id || p.name === args.pool_id);
        if (found.length !== 1) throw new AppError('NOT_FOUND', `No single account pool “${args.pool_id}”. List them with account_pool_list.`);
        poolId = found[0]!.id;
      }
      const current = accountPools.stateFor(w.id);
      const sessions = chat.list({ workspaceId: w.id }).filter((s) => s.state !== 'ended' && !s.archivedAt);
      const gate = ctx.confirm(
        args,
        {
          workspace: w.id,
          from: current ? `account pool ${current.poolName}` : 'its own Claude sign-in',
          to: poolId ? `account pool ${accountPools.list().find((p) => p.id === poolId)?.name}` : 'its own Claude sign-in',
          consequences: poolId
            ? ['the pool’s key outranks any Claude sign-in in this workspace', 'billing moves to the pool’s accounts', 'some Claude Code features that need a subscription sign-in stop working']
            : ['the workspace goes back to the Claude sign-in of each Claude in it; any that is not signed in must sign in again'],
          chat_sessions_that_end: sessions.length,
        },
        `${w.id}@${w.createdAt}:${poolId ?? 'none'}`,
      );
      if (gate) return gate;
      const state = accountPools.assign(w.id, { poolId, confirmOverride: true }, { existing: true });
      ctx.affected(`workspace:${w.id}`);
      return { summary: poolId ? `${w.id} now uses account pool ${state?.poolName}.` : `${w.id} is back on its own sign-in.`, account: state ? { pool: state.poolName, state: state.state, account: state.accountName } : null };
    },
  });
}

