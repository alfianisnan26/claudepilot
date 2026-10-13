import type { Workspace, WorkspaceStatus, WorkspaceUsage } from '@portal/contracts';
import { usageFractions } from '../../../workspaces/usage';
import type { GlanceCompact, GlanceLevel } from '../../types';
import { chipCount, listWords } from '../shared/format';

// The Workspaces widget and its Home card (docs/prd/glance-widgets.md §18): what runs, what is stopped, what is failing, CPU and memory
// where the portal measured them, and the Claude Code version against the image's pin. Pure, so it is tested.

export type WorkspaceBucket = 'failing' | 'busy' | 'running' | 'stopped';

/** `error` and `unreachable` are failing; a workspace on its way up or down is busy. */
export const bucketOf = (s: WorkspaceStatus): WorkspaceBucket =>
  s === 'error' || s === 'unreachable' ? 'failing' : s === 'running' ? 'running' : s === 'stopped' ? 'stopped' : 'busy';

const BUCKET_ORDER: Record<WorkspaceBucket, number> = { failing: 0, busy: 1, running: 2, stopped: 3 };

export interface WorkspaceRow {
  id: string;
  name: string;
  target: string;
  status: WorkspaceStatus;
  bucket: WorkspaceBucket;
  level: GlanceLevel;
  /** 0 to 1 of its limit (or of the host); null where the portal has no measurement (stopped, not pushed yet). */
  cpu: number | null;
  memory: number | null;
  /** What runs inside, what the image pins, and whether they differ (both known). */
  running: string | null;
  pinned: string | null;
  differs: boolean;
  detail: string | null;
}

export interface WorkspacesView {
  total: number;
  running: number;
  stopped: number;
  failing: number;
  busy: number;
  /** Workspaces whose Claude Code differs from the pin. */
  drift: number;
  /** Failing first, then busy, running, stopped; by name within each. */
  rows: WorkspaceRow[];
}

const LEVEL: Record<WorkspaceBucket, GlanceLevel> = { failing: 'critical', busy: 'warn', running: 'ok', stopped: 'idle' };

export function workspacesView(list: readonly Workspace[], usage: readonly WorkspaceUsage[]): WorkspacesView {
  const byId = new Map(usage.map((u) => [u.id, u]));
  const rows = list.map((w): WorkspaceRow => {
    const bucket = bucketOf(w.status);
    const measured = bucket === 'running' ? usageFractions(byId.get(w.id), w.cpus, w.memoryMb) : { cpu: undefined, memory: undefined };
    const running = w.claude?.running ?? null;
    const pinned = w.claude?.pinned ?? null;
    return {
      id: w.id,
      name: w.name,
      target: w.target,
      status: w.status,
      bucket,
      level: LEVEL[bucket],
      cpu: measured.cpu ?? null,
      memory: measured.memory ?? null,
      running,
      pinned,
      differs: !!running && !!pinned && running !== pinned,
      detail: w.detail?.trim() || null,
    };
  });
  rows.sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || a.name.localeCompare(b.name));
  const n = (b: WorkspaceBucket) => rows.filter((r) => r.bucket === b).length;
  return { total: rows.length, running: n('running'), stopped: n('stopped'), failing: n('failing'), busy: n('busy'), drift: rows.filter((r) => r.differs).length, rows };
}

/** A fraction as a whole percent: "37 %"; "-" when not measured. */
export const pctOf = (f: number | null): string => (f === null ? '-' : `${Math.round(f * 100)} %`);

/** The chip: how many run; red when one is failing, amber while one is on its way up or down. */
export function workspacesCompact(v: WorkspacesView | null, failed: boolean): GlanceCompact {
  if (!v) return failed ? { value: '-', level: 'unknown', title: 'Workspaces: not available', stale: true } : { value: null, level: 'unknown', title: 'Workspaces: loading', loading: true };
  const level: GlanceLevel = v.failing ? 'critical' : v.busy ? 'warn' : v.running ? 'ok' : 'idle';
  const parts = listWords([v.running ? `${v.running} running` : null, v.stopped ? `${v.stopped} stopped` : null, v.failing ? `${v.failing} failing` : null, v.busy ? `${v.busy} changing` : null]);
  return { value: chipCount(v.running), level, title: `Workspaces: ${parts || 'none'}` };
}
