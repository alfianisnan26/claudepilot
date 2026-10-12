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
} as const;

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
} as const;
