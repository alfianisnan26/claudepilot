/**
 * The shared settings store and the MCP lockdown (settings-policies PRD, the owner's "pool MCP only"
 * item): a small typed registry of portal-wide switches, each with a default, backed by the database,
 * every change audited. Other areas define their own settings (`defineSetting` on the server) and the
 * Settings page lists them all. The server is the authority; the page only renders what it returns.
 */

export type SettingType = 'boolean' | 'string' | 'number';
export type SettingValue = boolean | string | number;

/** One setting as the page shows it. */
export interface SettingView {
  /** Dotted, lowercase: `mcp.poolOnly`. */
  key: string;
  /** The page's section: `mcp`, `agents`, `sessions`, … */
  group: string;
  /** One or two words. */
  label: string;
  /** What it does, for the ⓘ next to the label: never a paragraph on the page itself. */
  help: string | null;
  /** The one terse line the confirmation dialog shows when a change removes a protection (see `protective`). */
  confirmText: string | null;
  type: SettingType;
  value: SettingValue;
  default: SettingValue;
  /**
   * Set for security switches: the value that protects. Changing a setting away from it asks for a
   * confirmation, and the server refuses the change without one (`confirm: true`).
   */
  protective?: SettingValue;
  /** A string setting that takes one of these values only: the page shows a choice. */
  choices?: string[];
  /** Sort order within the group. */
  order: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SettingGroup {
  id: string;
  label: string;
}

/** `GET /api/settings`. */
export interface SettingsView {
  groups: SettingGroup[];
  settings: SettingView[];
}

/** `PUT /api/settings/:key`. */
export interface SettingUpdate {
  value: SettingValue;
  /** Required to change a security switch away from its protective value. */
  confirm?: boolean;
}

/** One audited change (`GET /api/settings/audit`). */
export interface SettingChange {
  id: number;
  at: string;
  key: string;
  oldValue: SettingValue | null;
  newValue: SettingValue;
  actor: string;
}

/** Keys other areas read: `settings.get(SETTING_KEYS.x)` on the server. */
export const SETTING_KEYS = {
  /** MCP: claude.ai (SSO) connectors never load in a workspace. */
  mcpAccountOff: 'mcp.accountOff',
  /** MCP: only servers delivered through the pools may load; Claude adds none itself. */
  mcpPoolOnly: 'mcp.poolOnly',
  /** Agents (I11): a session's Claude may propose changes to its own persona and skills. Always reviewed by a person. */
  agentsSelfEdit: 'agents.selfEdit',
  /** Agents (T-285): the prompt cache of sub-agents' requests, `5m` or `1h` (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL). */
  agentsSubagentCacheTtl: 'agents.subagentCacheTtl',
  /** Agents (T-285): sub-agents one Claude runs at once (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). */
  agentsMaxSubagents: 'agents.maxSubagents',
  /** Agents (T-285): how deep sub-agents may spawn sub-agents (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH). */
  agentsSpawnDepth: 'agents.spawnDepth',
  /** Agents (T-285): characters of a Bash result Claude keeps (BASH_MAX_OUTPUT_LENGTH). */
  agentsBashOutputMax: 'agents.bashOutputMax',
  /** Agents (T-285): tokens of an MCP result Claude keeps (MAX_MCP_OUTPUT_TOKENS). */
  agentsMcpOutputMax: 'agents.mcpOutputMax',
} as const;

/**
 * One variable of the agent policy (T-285) in one workspace: what the portal asks for and what last landed in
 * the workspace's policy drop-in. `applied` is null while nothing has landed: the page says "unavailable", never a guess.
 */
export interface AgentEnvValue {
  /** The setting it comes from (`agents.maxSubagents`). */
  key: string;
  /** The variable Claude Code reads. */
  env: string;
  desired: string;
  applied: string | null;
  /** A Secrets & env set assigned here that also sets this name: its entry is skipped, the policy wins (T-285). */
  overriddenPool: string | null;
}

/** `GET /api/settings/agent-env/:target/:name`: the agent policy as it stands in one workspace. */
export interface AgentEnvStatus {
  workspaceId: string;
  /** `applied` when every value landed, `pending` while a change is on its way, `unavailable` when nothing landed yet. */
  state: 'applied' | 'pending' | 'unavailable';
  values: AgentEnvValue[];
  /** When the drop-in last changed here. A running Claude reads it at its next start. */
  appliedAt: string | null;
}

/** Where one workspace stands with the MCP lockdown (portal-mcp.md §10.1's statuses). */
export type LockdownState = 'off' | 'locked' | 'pending' | 'not_protected';

/** `GET /api/settings/lockdown/:target/:name`: one terse line in the Configuration sheet. */
export interface LockdownStatus {
  workspaceId: string;
  accountOff: boolean;
  poolOnly: boolean;
  /** `off` while neither switch is on. `pending` while the change hasn't landed or sessions that started before it still run. */
  state: LockdownState;
  /** Why it isn't `locked`, in a sentence. */
  reason: string | null;
  /** Running sessions that started before the last change: restart them (Claude Code never applies it to them). */
  restart: number;
}

export const SETTINGS_API = {
  list: '/api/settings',
  one: (key: string) => `/api/settings/${key}`,
  audit: '/api/settings/audit',
  /** `/api/settings/lockdown/<target>/<name>` */
  lockdown: (workspaceId: string) => `/api/settings/lockdown/${workspaceId}`,
  /** `/api/settings/agent-env/<target>/<name>` */
  agentEnv: (workspaceId: string) => `/api/settings/agent-env/${workspaceId}`,
} as const;
