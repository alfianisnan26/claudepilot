import { AppError } from '@isnanme/core';
import {
  isProtectedPool,
  PROTECTED_POOL_REASON,
  SECRET_LIMITS,
  secretExposeDefault,
  unexposedEnvSecrets,
  type PoolDetail,
  type PoolSummary,
  type SecretEntryInput,
  type SecretEntryView,
} from '@portal/contracts';
import { z } from 'zod';
import { actorOfPrincipal } from '../../authz/seam.js';
import { declarePoolToolPolicies, secretWriteAccess } from '../../pools/authz.js';
import { paginate, pageInput } from '../paging.js';
import { PortalToolError, registerPortalTool, uiOnly, type PortalToolContext } from '../registry.js';
import { assertCanChange, labelProse, resolveWorkspace, uiLink } from './common.js';
import type { PortalToolDeps } from './deps.js';

/**
 * Whether pools of a type may be written over MCP: `true` (create, update, delete), `false` (never), or `'write-only'` (T-2866, secrets):
 * created with names only by `pool_create`, a value set by `pool_secret_set`, and no value ever read back.
 */
type McpWrites = boolean | 'write-only';

/** What each pool type is for. A type this table doesn't know still lists, with a generic line. */
const TYPE_INFO: Record<string, { description: string; holds_secrets: boolean; mcp_writes: McpWrites }> = {
  secrets: {
    description:
      'Environment variables and secret files delivered into workspaces. Write-only over MCP: pool_create takes names only, pool_secret_set sets one value, and no value is ever returned.',
    holds_secrets: true,
    mcp_writes: 'write-only',
  },
  skillset: { description: 'Reviewed Claude Code skills, delivered as a plugin. A set may use approved skill versions only.', holds_secrets: false, mcp_writes: true },
  mcpset: { description: 'Sets of reviewed MCP servers from the catalog, delivered as a plugin. A set may use approved catalog versions only; secrets are referenced by name.', holds_secrets: false, mcp_writes: true },
};

const info = (type: string): { description: string; holds_secrets: boolean; mcp_writes: McpWrites } =>
  TYPE_INFO[type] ?? { description: 'A pool type of this portal.', holds_secrets: false, mcp_writes: false };

/** T-2823: the warning for secrets with an environment-style name that are delivered as files only. */
const exposeWarnings = (type: string, content: unknown): string[] => {
  if (type !== 'secrets') return [];
  const names = unexposedEnvSecrets(content);
  return names.length ? [`Not exposed as variables, so commands can’t read them from the environment: ${names.join(', ')}. Set expose with pool_secret_set or in the portal.`] : [];
};

/** A secrets set's content as MCP shows it: names, options and fingerprints only (no hint: it holds the value's last characters). */
const secretsContentShown = (content: unknown): unknown => {
  const entries = (content as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return content;
  return {
    ...(content as object),
    entries: (entries as SecretEntryView[]).map((e) => {
      if (e.kind !== 'secret' || !e.secret) return e;
      const { hint: _hint, ...rest } = e.secret;
      return { ...e, secret: rest };
    }),
  };
};

/** The portal service for pools, a tool author's view: one set of tools for every multi-assignment type (PRD §13.2). */
export function registerPoolTools(deps: PortalToolDeps): void {
  const { store, workspaces, poolService } = deps;
  declarePoolToolPolicies();

  const brief = (p: PoolSummary) => {
    const warnings = exposeWarnings(p.type, p.content);
    return {
      id: p.id,
      type: p.type,
      name: p.name,
      description: labelProse(p.description, 'imported'),
      revision: p.revision,
      latest_revision: p.latestRevision,
      status: p.status,
      rollout_paused: p.rolloutPaused ? { at: p.rolloutPaused.at, reason: labelProse(p.rolloutPaused.reason, 'agent') } : null,
      used_by_workspaces: p.workspaces,
      updated_at: p.updatedAt,
      ...(warnings.length ? { warnings } : {}),
    };
  };

  const needPool = (id: string): { id: string; type: string; summary: PoolDetail } => {
    const byId = poolService.typeOf(id);
    if (byId) return { id, type: byId, summary: poolService.get(id) };
    // By exact name within a type; an ambiguous name returns the matches.
    const matches = poolService.types().flatMap((t) => poolService.list(t).filter((p) => p.name === id));
    if (matches.length === 1) return { id: matches[0]!.id, type: matches[0]!.type, summary: poolService.get(matches[0]!.id) };
    if (matches.length > 1) throw new PortalToolError('AMBIGUOUS', `${matches.length} pools are named “${id}”. Use the id.`, { matches: matches.map((m) => ({ id: m.id, type: m.type })) });
    throw new AppError('NOT_FOUND', `No pool “${id}”. List them with pool_list.`);
  };

  registerPortalTool({
    name: 'pool_types',
    title: 'List pool types',
    description: 'The pool types this portal has, what each is for, and whether pools of that type can be created or changed over MCP.',
    scope: 'read',
    input: z.object({}),
    handler() {
      const types = poolService.types().map((t) => ({ type: t, ...info(t), pools: poolService.list(t).length }));
      return { summary: `${types.length} pool types.`, types };
    },
  });

  registerPortalTool({
    name: 'pool_list',
    title: 'List pools',
    description: 'Pools of every type (or one), with their revision, review status and how many workspaces use them. Account pools have their own tools.',
    scope: 'read',
    input: z.object({ type: z.string().max(20).optional(), query: z.string().max(80).optional().describe('Part of a pool name.'), ...pageInput }),
    handler(_ctx, args) {
      const types = poolService.types();
      if (args.type && !types.includes(args.type as (typeof types)[number])) throw new AppError('NOT_FOUND', `No pool type “${args.type}”. Known: ${types.join(', ')}.`);
      const all = types
        .filter((t) => !args.type || t === args.type)
        .flatMap((t) => poolService.list(t))
        .filter((p) => !args.query || p.name.toLowerCase().includes(args.query.toLowerCase()));
      const page = paginate(all, args, { t: args.type, q: args.query });
      return { summary: `${page.total} pools.`, pools: page.items.map(brief), total: page.total, next_cursor: page.next_cursor };
    },
  });

  registerPortalTool({
    name: 'pool_get',
    title: 'Get a pool',
    description:
      'One pool: its current content (for secrets: names, options and fingerprints only, never a value), the last revisions, and the workspaces that use it. Imported text in the content (descriptions, tool lists) is labelled untrusted.',
    scope: 'read',
    input: z.object({ id: z.string().max(100).describe('The pool id, or its exact name.') }),
    handler(_ctx, args) {
      const { summary: p } = needPool(args.id);
      return {
        summary: `${p.name} (${p.type}) is at revision ${p.revision}, used by ${p.workspaces} workspaces.`,
        pool: brief(p),
        content: labelProse(p.type === 'secrets' ? secretsContentShown(p.content) : p.content, 'imported'),
        revisions: p.revisions.slice(0, 10).map((r) => ({ revision: r.revision, status: r.status, note: labelProse(r.note, 'agent'), created_at: r.createdAt, current: r.current })),
        assigned_to: p.assignedTo.map((a) => ({ workspace_id: a.workspaceId, pinned_revision: a.pinnedRevision, revision: a.revision, delivered_revision: a.deliveredRevision })),
        ui: uiLink(`/admin/pools?tab=${p.type}`),
      };
    },
  });

  /** Pools of this type may be created, changed and deleted over MCP with any content; secrets pools never (values must not be read back). */
  const writable = (type: string) => {
    if (info(type).mcp_writes !== true)
      throw uiOnly(
        type === 'secrets'
          ? 'secrets pools are write-only over MCP: create one with names only (pool_create), set a value with pool_secret_set; change or delete it in the portal.'
          : `${type} pools can’t be created or changed over MCP: their values would pass through this conversation.`,
        `Pools → ${type}`,
      );
  };

  /**
   * pool_create for secrets (T-2866): names only, as `{ names: [...] }` or `{ entries: [{ name, kind: 'secret', options? }] }`. A value,
   * a variable, or anything else is refused: a value goes in with pool_secret_set alone.
   */
  const namesOnlySecrets = (content: Record<string, unknown>): { entries: SecretEntryInput[] } => {
    const bad = () =>
      new AppError('VALIDATION_FAILED', 'A secrets pool is created with names only: { "names": ["API_KEY"] } or { "entries": [{ "kind": "secret", "name": "API_KEY" }] }. Set each value with pool_secret_set.');
    const keys = Object.keys(content);
    if (keys.length !== 1 || (keys[0] !== 'names' && keys[0] !== 'entries')) throw bad();
    const raw = content[keys[0]];
    if (!Array.isArray(raw) || raw.length > SECRET_LIMITS.entries) throw bad();
    return {
      entries: raw.map((r) => {
        if (typeof r === 'string') return { kind: 'secret', name: r, options: { expose: secretExposeDefault(r) } };
        if (!r || typeof r !== 'object') throw bad();
        const { kind, name, options, ...rest } = r as { kind?: unknown; name?: unknown; options?: unknown };
        if (kind !== 'secret' || typeof name !== 'string' || Object.keys(rest).length > 0) throw bad();
        if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw bad();
        const o = (options ?? {}) as Record<string, unknown>;
        return { kind: 'secret', name, options: { ...o, expose: typeof o.expose === 'boolean' ? o.expose : secretExposeDefault(name) } };
      }),
    };
  };

  registerPortalTool({
    name: 'pool_create',
    title: 'Create a pool',
    description:
      'Creates a skillset or MCP set from content that references approved versions only. A set that needs review is saved as waiting_review and is not delivered until a person approves it in the portal. A secrets pool is created with names only ({ "names": [...] }); set each value with pool_secret_set.',
    scope: 'admin',
    input: z.object({
      type: z.string().max(20),
      name: z.string().min(1).max(60),
      description: z.string().max(500).optional(),
      content: z.record(z.string(), z.unknown()).describe('The type’s content, as pool_get shows it. No secret values.'),
      note: z.string().max(300).optional(),
    }),
    handler(ctx, args) {
      assertCanChange(store, 'pool');
      if (!poolService.types().includes(args.type as never)) throw new AppError('NOT_FOUND', `No pool type “${args.type}”.`);
      const secrets = args.type === 'secrets';
      if (secrets) {
        if (isProtectedPool({ name: args.name, description: args.description })) throw new PortalToolError('PROTECTED', PROTECTED_POOL_REASON);
      } else writable(args.type);
      const content = secrets ? namesOnlySecrets(args.content) : args.content;
      const p = poolService.create(args.type, { name: args.name, description: args.description, content, note: args.note ?? `via MCP (${ctx.actor})` });
      ctx.affected(`pool:${p.id}`);
      const missing = secrets ? (content as { entries: SecretEntryInput[] }).entries.map((e) => e.name) : [];
      return { summary: `Created ${p.name}: revision ${p.latestRevision} is ${p.status}.`, pool: brief(p), secrets_missing: missing };
    },
  });

  /**
   * The secrets pool `pool_secret_set` writes to, or the one not-found answer (T-2866). By id or exact name among secrets pools only; for
   * an agent only among the pools its own workspace gets, BEFORE an ambiguous name is reported, so a call never learns of a pool elsewhere.
   */
  const secretsPoolFor = (ctx: PortalToolContext, ref: string): PoolDetail => {
    const notFound = () => new AppError('NOT_FOUND', `No pool “${ref}”. List them with pool_list.`);
    if (!poolService.types().includes('secrets')) throw notFound();
    const actor = actorOfPrincipal(ctx.principal);
    const reachable = poolService
      .list('secrets')
      .filter((p) => p.id === ref || p.name === ref)
      .map((p) => poolService.get(p.id))
      .filter((p) => secretWriteAccess(actor, { id: p.id, workspaces: p.assignedTo.map((a) => a.workspaceId) }) !== 'not_found');
    const byId = reachable.filter((p) => p.id === ref);
    const found = byId.length ? byId : reachable;
    if (found.length === 0) throw notFound();
    if (found.length > 1) throw new PortalToolError('AMBIGUOUS', `${found.length} secrets pools are named “${ref}”. Use the id.`, { matches: found.map((m) => ({ id: m.id, type: m.type })) });
    const p = found[0]!;
    if (secretWriteAccess(actor, { id: p.id, workspaces: p.assignedTo.map((a) => a.workspaceId) }) === 'shared')
      throw new PortalToolError('SHARED_POOL', `${p.name} is used by other workspaces too: a value set here would change theirs. Change it in the portal.`);
    return p;
  };

  registerPortalTool({
    name: 'pool_secret_set',
    title: 'Set a secret',
    description:
      'Sets one secret’s value in a secrets pool, as a new revision. Write-only: the value is never returned, logged or shown (pool_get gives the name and a fingerprint). expose (make it an environment variable too) defaults to true for names like API_KEY. An agent may set secrets only in a pool its own workspace alone uses; a protected pool (prd, or marked [protected]) is refused.',
    scope: 'agent',
    rate: { perMinute: 10, perHour: 60 },
    maxArgsBytes: SECRET_LIMITS.secretBytes + 16 * 1024,
    input: z.object({
      pool: z.string().min(1).max(100).describe('The secrets pool id, or its exact name.'),
      name: z.string().min(1).max(64).describe('The secret’s name, e.g. API_KEY. A new name adds an entry.'),
      value: z.string().min(1).max(SECRET_LIMITS.secretBytes).describe('The value. Write-only: never returned or shown.'),
      expose: z.boolean().optional().describe('Also an environment variable. Default: true for an environment-style name (API_KEY).'),
      note: z.string().max(300).optional().describe('Why, for the revision history.'),
    }),
    handler(ctx, args) {
      const p = secretsPoolFor(ctx, args.pool);
      if (isProtectedPool(p)) throw new PortalToolError('PROTECTED', PROTECTED_POOL_REASON);
      assertCanChange(store, 'pool');
      const entries = ((p.content as { entries?: SecretEntryView[] } | null)?.entries ?? []).map((e): SecretEntryInput =>
        e.kind === 'variable' ? { id: e.id, kind: 'variable', name: e.name, value: e.value, confirmed: e.confirmed } : { id: e.id, kind: 'secret', name: e.name, options: e.options ?? {} },
      );
      const at = entries.findIndex((e) => e.name === args.name);
      if (at >= 0 && entries[at]!.kind !== 'secret') throw new PortalToolError('CONFLICT', `${args.name} is a plain variable in ${p.name}, not a secret. Change it in the portal.`);
      // An existing secret keeps its expose unless the call names one; the name's default is for a new entry only (T-2866 review).
      const found = at >= 0 ? entries[at]! : undefined;
      const existing = found?.kind === 'secret' ? found.options : undefined;
      // A stored secret's options omit a false expose, so an existing secret is exposed exactly when expose is true (as this tool reports it).
      const expose = args.expose ?? (found ? existing?.expose === true : secretExposeDefault(args.name));
      const target: SecretEntryInput = at >= 0 ? { ...entries[at]!, options: { ...entries[at]!.options, expose }, newValue: args.value } : { kind: 'secret', name: args.name, options: { expose }, newValue: args.value };
      if (at >= 0) entries[at] = target;
      else entries.push(target);
      const updated = poolService.update(p.id, { content: { entries }, note: args.note ?? `${args.name} set via MCP (${ctx.actor})`, baseRevision: p.latestRevision });
      ctx.affected(`pool:${p.id}`);
      const entry = ((updated.content as { entries?: SecretEntryView[] } | null)?.entries ?? []).find((e) => e.name === args.name);
      const warnings = exposeWarnings('secrets', updated.content);
      return {
        summary: `${args.name} set in ${updated.name}: revision ${updated.latestRevision} is ${updated.status}.`,
        pool: { id: updated.id, name: updated.name },
        name: args.name,
        revision: updated.latestRevision,
        status: updated.status,
        expose: entry?.options?.expose === true,
        fingerprint: entry?.secret?.fingerprint ?? null,
        version: entry?.secret?.version ?? null,
        ...(warnings.length ? { warnings } : {}),
      };
    },
  });

  registerPortalTool({
    name: 'pool_update',
    title: 'Change a pool',
    description:
      'Saves new content as a revision (skillset and MCP set pools). Pass base_revision (from pool_get) so a stale edit is refused. A revision that needs review is saved as waiting_review and is not delivered until a person approves it. restore_revision makes an older revision current again.',
    scope: 'admin',
    hints: { destructive: true },
    input: z.object({
      id: z.string().max(100),
      base_revision: z.number().int().min(0).describe('The latest_revision you read.'),
      content: z.record(z.string(), z.unknown()).optional(),
      restore_revision: z.number().int().min(1).optional(),
      note: z.string().max(300).optional(),
      confirm_token: z.string().optional(),
    }),
    handler(ctx, args) {
      assertCanChange(store, 'pool');
      const { id, type, summary: cur } = needPool(args.id);
      writable(type);
      if (cur.latestRevision !== args.base_revision) throw new PortalToolError('CONFLICT', `The pool is at revision ${cur.latestRevision}, not ${args.base_revision}. Read it again with pool_get.`, { latest_revision: cur.latestRevision });
      if ((args.content === undefined) === (args.restore_revision === undefined)) throw new AppError('VALIDATION_FAILED', 'Give content, or restore_revision, not both and not neither.');
      if (cur.workspaces > ctx.settings.confirmAbove) {
        const gate = ctx.confirm(
          args,
          { change: `${cur.name} (${type})`, workspaces_affected: cur.workspaces, how: args.restore_revision ? `make revision ${args.restore_revision} current` : 'save the content as a new revision' },
          `${id}@${cur.latestRevision}`,
        );
        if (gate) return gate;
      }
      const p = args.restore_revision
        ? poolService.makeCurrent(id, args.restore_revision)
        : poolService.update(id, { content: args.content, note: args.note ?? `via MCP (${ctx.actor})` });
      ctx.affected(`pool:${id}`);
      return { summary: `${p.name}: latest revision ${p.latestRevision} is ${p.status}.`, pool: brief(p) };
    },
  });

  registerPortalTool({
    name: 'pool_delete',
    title: 'Delete a pool',
    description: 'Deletes a pool (skillset or MCP set). Refused while workspaces use it unless unassign is true, which removes it from them first. Asks for confirmation, showing the workspaces.',
    scope: 'admin',
    hints: { destructive: true, idempotent: true },
    input: z.object({ id: z.string().max(100), unassign: z.boolean().optional(), confirm_token: z.string().optional() }),
    handler(ctx, args) {
      assertCanChange(store, 'pool');
      const { id, type, summary: p } = needPool(args.id);
      writable(type);
      const gate = ctx.confirm(args, { delete: `${p.name} (${type})`, revisions: p.revisions.length, workspaces_using_it: p.assignedTo.map((a) => a.workspaceId), will_unassign: !!args.unassign }, `${id}@${p.latestRevision}`);
      if (gate) return gate;
      if (p.assignedTo.length && !args.unassign) throw new PortalToolError('CONFLICT', `${p.assignedTo.length} workspaces use it. Pass unassign: true to remove it from them first.`, { workspaces: p.assignedTo.map((a) => a.workspaceId) });
      for (const a of p.assignedTo) removeFrom(a.workspaceId, id, type);
      poolService.delete(id);
      ctx.affected(`pool:${id}`);
      return { summary: `Deleted ${p.name}.`, deleted: true };
    },
  });

  /** Removes one pool from one workspace, keeping that workspace's other pools of the type exactly as they are. */
  function removeFrom(workspaceId: string, poolId: string, type: string) {
    const rest = poolService.assignmentsFor(workspaceId).filter((a) => a.type === type && a.poolId !== poolId && a.state === 'assigned');
    poolService.setAssignments(workspaceId, type, rest.map((a) => ({ poolId: a.poolId })));
  }

  const workspaceIds = async (ids: string[]) => {
    const all = await workspaces.list();
    return ids.map((x) => resolveWorkspace(all, x).id);
  };

  const needsConfirm = (ctx: PortalToolContext, n: number) => n > ctx.settings.confirmAbove;

  registerPortalTool({
    name: 'pool_assign',
    title: 'Assign a pool to workspaces',
    description:
      'Adds a pool to up to 50 workspaces (their other pools stay). Reaching more than 5 workspaces asks for confirmation first. Delivery follows on its own; check workspace_get for the delivery state.',
    scope: 'admin',
    hints: { destructive: true, idempotent: true },
    input: z.object({ pool_id: z.string().max(100), workspace_ids: z.array(z.string().max(100)).min(1).max(50), confirm_token: z.string().optional() }),
    async handler(ctx, args) {
      assertCanChange(store, 'pool');
      const { id, summary: p } = needPool(args.pool_id);
      const ids = await workspaceIds(args.workspace_ids);
      if (needsConfirm(ctx, ids.length)) {
        const gate = ctx.confirm(args, { assign: `${p.name} (${p.type})`, to_workspaces: ids, replaces: 'nothing: pools of this type already on a workspace stay' }, `${id}@${p.latestRevision}:${ids.join(',')}`);
        if (gate) return gate;
      }
      const result = poolService.assignToMany(id, ids);
      ctx.affected(`pool:${id}`, ...result.assigned.map((w) => `workspace:${w}`));
      return { summary: `Assigned ${p.name} to ${result.assigned.length} workspaces (${result.already.length} already had it).`, assigned: result.assigned, already_assigned: result.already };
    },
  });

  registerPortalTool({
    name: 'pool_unassign',
    title: 'Remove a pool from workspaces',
    description: 'Removes a pool from up to 50 workspaces. What it delivered is taken away by the delivery engine. Reaching more than 5 workspaces asks for confirmation first.',
    scope: 'admin',
    hints: { destructive: true, idempotent: true },
    input: z.object({ pool_id: z.string().max(100), workspace_ids: z.array(z.string().max(100)).min(1).max(50), confirm_token: z.string().optional() }),
    async handler(ctx, args) {
      assertCanChange(store, 'pool');
      const { id, type, summary: p } = needPool(args.pool_id);
      const ids = await workspaceIds(args.workspace_ids);
      const had = ids.filter((w) => p.assignedTo.some((a) => a.workspaceId === w));
      if (needsConfirm(ctx, ids.length)) {
        const gate = ctx.confirm(args, { remove: `${p.name} (${type})`, from_workspaces: had }, `${id}@${p.latestRevision}:${had.join(',')}`);
        if (gate) return gate;
      }
      for (const w of had) removeFrom(w, id, type);
      ctx.affected(`pool:${id}`, ...had.map((w) => `workspace:${w}`));
      return { summary: `Removed ${p.name} from ${had.length} workspaces.`, removed_from: had, did_not_have_it: ids.filter((w) => !had.includes(w)) };
    },
  });
}
