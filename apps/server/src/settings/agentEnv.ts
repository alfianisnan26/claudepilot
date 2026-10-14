import { SETTING_KEYS, type AgentEnvStatus } from '@portal/contracts';
import type { Fragment } from '../delivery/types.js';
import type { FragmentProvider } from '../delivery/reconciler.js';
import { dropInPath } from '../delivery/ownership.js';
import type { Store } from '../store/store.js';
import { defineSetting } from './registry.js';
import type { Settings } from './store.js';

const RESTART = 'A running Claude reads it at its next start.';

/**
 * The agent policy (T-285, settings-policies PRD §10.1): portal settings that reach every Claude process in
 * every workspace as `env` in the policy owner's drop-in (`10-claudepilot-policy.json`). Claude Code applies a
 * managed `env` to itself and to its sub-agents at start. Each value is always written, a default included:
 * a value is overwritten, never removed (the PRD row), and no pool can set these names (`ownership.ts`).
 * Every default has a source, named in its help.
 */
export const AGENT_ENV = [
  {
    def: defineSetting({
      key: SETTING_KEYS.agentsSubagentCacheTtl,
      type: 'string',
      default: '1h',
      choices: ['5m', '1h'],
      scope: 'global',
      group: 'agents',
      order: 20,
      label: 'Sub-agent cache',
      help: `How long the prompt cache of sub-agents’ requests lives (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL). 1h keeps it warm across waits; 5m is Claude Code’s own default and re-writes the context after a longer wait. Source: T-285, sub-agents re-wrote 47 M tokens of context after waits on the 5 minute cache. Claude Code ignores 1h while a subscription is in overage. ${RESTART}`,
    }),
    env: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
  },
  {
    def: defineSetting({
      key: SETTING_KEYS.agentsMaxSubagents,
      type: 'number',
      default: 5,
      min: 1,
      max: 50,
      integer: true,
      scope: 'global',
      group: 'agents',
      order: 30,
      label: 'Sub-agents',
      help: `How many sub-agents one Claude runs at once (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). Source: the owner’s decision D-43, five. ${RESTART}`,
    }),
    env: 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  },
  {
    def: defineSetting({
      key: SETTING_KEYS.agentsSpawnDepth,
      type: 'number',
      default: 3,
      min: 1,
      max: 10,
      integer: true,
      scope: 'global',
      group: 'agents',
      order: 40,
      label: 'Spawn depth',
      help: `How deep sub-agents may start sub-agents of their own (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH). Source: the Standard preset of the settings PRD, 3. ${RESTART}`,
    }),
    env: 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
  },
  {
    def: defineSetting({
      key: SETTING_KEYS.agentsBashOutputMax,
      type: 'number',
      default: 8000,
      min: 1000,
      max: 200000,
      integer: true,
      scope: 'global',
      group: 'agents',
      order: 50,
      label: 'Bash output',
      help: `Characters of a command’s output Claude keeps; the middle of a longer one is cut (BASH_MAX_OUTPUT_LENGTH). Source: the token-economy design, lever 4, 8000. ${RESTART}`,
    }),
    env: 'BASH_MAX_OUTPUT_LENGTH',
  },
  {
    def: defineSetting({
      key: SETTING_KEYS.agentsMcpOutputMax,
      type: 'number',
      default: 25000,
      min: 1000,
      max: 200000,
      integer: true,
      scope: 'global',
      group: 'agents',
      order: 60,
      label: 'MCP output',
      help: `Tokens of a tool result from an MCP server Claude keeps (MAX_MCP_OUTPUT_TOKENS). Source: Claude Code’s own default, 25000. ${RESTART}`,
    }),
    env: 'MAX_MCP_OUTPUT_TOKENS',
  },
] as const;

/** The setting keys of the agent policy: a change to one delivers to every workspace again. */
export const AGENT_ENV_KEYS: ReadonlySet<string> = new Set(AGENT_ENV.map((a) => a.def.key));

/** The policy owner's fragment provider for the agent policy, plus what landed in each workspace. */
export class AgentEnvPolicy implements FragmentProvider {
  readonly type = 'policy' as const;

  constructor(
    private readonly store: Store,
    private readonly settings: Settings,
  ) {}

  /** Every variable with its value, in a stable order. */
  desired(): Record<string, string> {
    return Object.fromEntries(AGENT_ENV.map((a) => [a.env, String(this.settings.get(a.def.key))]));
  }

  knownPools(): string[] {
    return [];
  }

  fragments(): Fragment[] {
    return [{ owner: 'policy', settings: { env: this.desired() } }];
  }

  /** After a delivery that wrote the policy drop-in: remember what landed (names and values, none of them secret). */
  delivered(workspaceId: string, ctx: { now: Date; delivered: Set<string>; landedAt?: number }): void {
    const db = this.store.db;
    const file = dropInPath('policy');
    if (!db || !this.store.writable || !file || !ctx.delivered.has(file)) return;
    try {
      const env = JSON.stringify(this.desired());
      const row = db.prepare('SELECT env, changed_at FROM policy_env_state WHERE workspace_id = ?').get(workspaceId) as { env: string; changed_at: string } | undefined;
      const changedAt = row && row.env === env ? row.changed_at : new Date(ctx.landedAt ?? ctx.now.getTime()).toISOString();
      db.prepare(
        `INSERT INTO policy_env_state (workspace_id, env, changed_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET env = excluded.env, changed_at = excluded.changed_at, updated_at = excluded.updated_at`,
      ).run(workspaceId, env, changedAt, ctx.now.toISOString());
    } catch (e) {
      console.error(`[settings] recording the agent policy of ${workspaceId} failed: ${(e as Error).message}`);
    }
  }

  /** The agent policy in one workspace: each value asked for and the one that landed (null: unavailable, never a guess). */
  status(workspaceId: string): AgentEnvStatus {
    let applied: Record<string, string> | null = null;
    let appliedAt: string | null = null;
    try {
      const row = this.store.db?.prepare('SELECT env, changed_at FROM policy_env_state WHERE workspace_id = ?').get(workspaceId) as { env: string; changed_at: string } | undefined;
      if (row) {
        applied = JSON.parse(row.env) as Record<string, string>;
        appliedAt = row.changed_at;
      }
    } catch {
      applied = null;
    }
    const desired = this.desired();
    const values = AGENT_ENV.map((a) => ({ key: a.def.key, env: a.env, desired: desired[a.env]!, applied: applied?.[a.env] ?? null }));
    const state = !applied ? 'unavailable' : values.every((v) => v.applied === v.desired) ? 'applied' : 'pending';
    return { workspaceId, state, values, appliedAt };
  }

  /** A workspace was removed: nothing to remember about it. */
  forgetWorkspace(workspaceId: string): void {
    if (!this.store.writable) return;
    try {
      this.store.db!.prepare('DELETE FROM policy_env_state WHERE workspace_id = ?').run(workspaceId);
    } catch {
      // The table may not exist on an older schema.
    }
  }
}
