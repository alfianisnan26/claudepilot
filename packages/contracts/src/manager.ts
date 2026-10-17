/**
 * The General Manager's read tools on the Portal MCP (docs/prd/general-manager.md §9.1, T-968 S2a). Read only: nothing here changes,
 * approves or starts anything. Each tool is declared in its own module's `authz.ts` and goes through the seam; what the caller may not
 * see answers exactly like what does not exist (NOT_FOUND, the tool's own text). Text an agent, a workspace or a third party wrote
 * comes back labelled as untrusted; a credential-shaped value never leaves the portal (masked as `[redacted]`, a secret setting as `[set]`).
 *
 * `manager_status` (§9.1's last row) waits for S1: there is no manager session or `cpmt_` token to report on yet.
 */

/** The S2a tools, in the PRD's order. */
export const MANAGER_READ_TOOLS = ['settings_get', 'approvals_list', 'autotransfer_events', 'crew_limits_get', 'deploy_status'] as const;
export type ManagerReadTool = (typeof MANAGER_READ_TOOLS)[number];

/** Text from outside the portal, cleaned, capped and labelled with where it came from (portal-mcp PRD §14.4). */
export interface ManagerUntrusted {
  untrusted_text: string;
  source: string;
}

/** What a string setting that looks like a credential shows instead of its value. */
export const SETTING_SECRET_SET = '[set]';

/** `settings_get`: one setting. */
export interface ManagerSettingRow {
  key: string;
  group: string;
  label: string;
  type: 'boolean' | 'string' | 'number';
  /** The effective value; a credential-shaped string is `[set]`, never the value. */
  value: boolean | string | number;
  default: boolean | string | number;
  /** `default` when nobody changed it, else `changed`. */
  source: 'default' | 'changed';
  /** A security switch: moving it away from its protective value needs a person's confirmation (S5's card for the manager). */
  needs_confirmation: boolean;
  choices?: string[];
  updated_at: string | null;
  updated_by: string | null;
}

/** `approvals_list`: one open request a session waits on, any age (attention_list shows only those over ten minutes). */
export interface ManagerApprovalRow {
  session_id: string;
  session_title: ManagerUntrusted | null;
  request_id: string;
  kind: string;
  tool: string | null;
  /** The controller's own short, redacted summary of what it asks. */
  summary: ManagerUntrusted | null;
  agent: ManagerUntrusted | null;
  since: string;
  age_s: number;
  link: string;
}

/** `autotransfer_events`: one auto move event. */
export interface ManagerAutoEventRow {
  id: number;
  at: string;
  session_id: string;
  kind: string;
  reason: string | null;
  from: string | null;
  to: string | null;
  code: string | null;
  actor: string;
  /** For a `moved` event: whether its Undo is open now; null for every other kind. */
  undoable: boolean | null;
}

/** `autotransfer_events`: one card waiting for an answer. */
export interface ManagerAutoCardRow {
  id: string;
  session_id: string;
  at: string;
  reason: string;
  from: string;
  to: string;
}

/** `crew_limits_get`: one worker of the lead. */
export interface ManagerWorkerRow {
  id: string;
  title: ManagerUntrusted | null;
  state: string;
  agent: string | null;
  created_at: string;
}

/** `crew_limits_get`: the lead's caps (D-43, D-71) and its slots. */
export interface ManagerCrewLimits {
  session_id: string;
  /** The portal-wide settings (Settings › Sessions). */
  global: { max_depth: number; max_children: number; spawns_per_hour: number; messages_per_hour: number } | 'unavailable';
  /** The session's own limit: null follows the global one, 0 starts none. */
  own_max_workers: number | null;
  /** What holds now: the own limit clamped to the global one. Null: no limit. */
  max_workers: number | null;
  subagents: boolean;
  in_use: number;
  free: number | null;
  workers: ManagerWorkerRow[];
  /** The portal keeps no queue of slices: a lead's queue is its status file's NEXT. Never guessed. */
  queue: 'unavailable';
}

/** `deploy_status`: one run that deploys. */
export interface ManagerDeployRow {
  id: string;
  number: number;
  pipeline: string;
  branch: string | null;
  sha: string | null;
  status: string;
  /** The job running or held now, or null when none is. */
  stage: string | null;
  /** The status of the job named `gate`, or `unavailable` when the run has none. */
  gate: string;
  /** Environments whose release waits for a person's approval in the portal. */
  waiting_for_approval: string[];
  created_at: string;
  link: string;
}
