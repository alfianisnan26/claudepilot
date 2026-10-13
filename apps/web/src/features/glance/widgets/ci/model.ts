import type { CiRunList, CiRunSummary, GlanceSnapshot } from '@portal/contracts';
import type { GlanceCompact, GlanceLevel } from '../../types';
import { chipCount, listWords, plural } from '../shared/format';

// The CI widget and its Home card (docs/prd/glance-widgets.md §18): the last runs, the failures that still stand and the deploys held for
// a person's approval. The runs come from the CI list; the failures and the deploys from the glance snapshot (the same rule as Needs you).

/** A run holds a job for a person's approval (local-git-ci FR41). */
export const holdsDeploy = (r: Pick<CiRunSummary, 'status' | 'jobs'>): boolean => r.status === 'running' && r.jobs.some((j) => j.status === 'waiting');

export interface CiView {
  /** The newest runs, as the list gives them. */
  runs: CiRunSummary[];
  /** Runs not finished, over every run. */
  active: number;
  /** Failed runs that still stand, and deploys held for approval: null when the snapshot could not read them. */
  failing: number | null;
  deploys: number | null;
}

export function ciView(list: Pick<CiRunList, 'items' | 'active'> | null, glance: GlanceSnapshot | null, max = 5): CiView {
  const a = glance?.attention;
  return {
    runs: (list?.items ?? []).slice(0, max),
    active: list?.active ?? 0,
    failing: a && a.ci.ok ? a.ci.count : null,
    deploys: a && a.deploys.ok ? a.deploys.count : null,
  };
}

/** The chip: failures that stand; red while a deploy waits for you, amber for a failure, green while runs go, grey otherwise. */
export function ciCompact(v: CiView | null, failed: boolean): GlanceCompact {
  if (!v) return failed ? { value: '-', level: 'unknown', title: 'CI: not available', stale: true } : { value: null, level: 'unknown', title: 'CI: loading', loading: true };
  const level: GlanceLevel = v.deploys ? 'critical' : v.failing ? 'warn' : v.active ? 'ok' : v.failing === null ? 'unknown' : 'idle';
  const parts = listWords([
    v.deploys ? `${plural(v.deploys, 'deploy')} to approve` : null,
    v.failing ? `${v.failing} failing` : null,
    v.active ? `${v.active} running` : null,
  ]);
  return { value: v.failing === null ? '-' : chipCount(v.failing), level, title: `CI: ${parts || (v.failing === null ? 'failures could not be read' : 'nothing failing')}` };
}
