// Schedules (owner, 2026-10-18: "list of scheduler as well"; T-965): the portal's own background loops beside the cron triggers.

/** One background loop of the portal, with what its runs did. Every value is measured by the loop itself (platform/loops.ts). */
export interface PortalLoop {
  id: string;
  what: string;
  everyMs: number;
  since: string;
  lastRunAt: string | null;
  lastMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
  runs: number;
  failures: number;
}

export const SCHEDULES_API = {
  /** Full session only. GET: `PortalLoop[]`. The cron triggers come from `TRIGGER_API.list`. */
  loops: '/api/admin/loops',
} as const;
