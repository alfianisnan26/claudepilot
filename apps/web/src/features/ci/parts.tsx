import { cn } from '@isnanme/ui';
import { CI_STATUS_LABEL, shortSha, type CiReason, type CiRunSummary, type CiUnitStatus } from '@portal/contracts';
import { Circle, CircleCheck, CircleMinus, CircleSlash, CircleX, Clock, Hand, LoaderCircle, type LucideIcon } from 'lucide-react';

const LOOK: Record<CiUnitStatus, { Icon: LucideIcon; tone: string }> = {
  queued: { Icon: Clock, tone: 'text-muted' },
  running: { Icon: LoaderCircle, tone: 'text-gold' },
  passed: { Icon: CircleCheck, tone: 'text-accent' },
  failed: { Icon: CircleX, tone: 'text-danger' },
  cancelled: { Icon: CircleSlash, tone: 'text-muted' },
  pending: { Icon: Circle, tone: 'text-muted' },
  skipped: { Icon: CircleMinus, tone: 'text-muted' },
  waiting: { Icon: Hand, tone: 'text-gold' },
};

/** Shape and colour, not colour alone: a clock, a spinner, a tick, a cross, a slash, an empty circle, a dash, a raised hand (waits for a person). */
export function StatusIcon({ status, className }: { status: CiUnitStatus; className?: string }) {
  const { Icon, tone } = LOOK[status];
  return (
    <span title={CI_STATUS_LABEL[status]} className={cn('inline-flex shrink-0 items-center justify-center', tone, className)}>
      <Icon className={cn('size-5', status === 'running' && 'motion-safe:animate-spin')} aria-hidden="true" />
      <span className="sr-only">{CI_STATUS_LABEL[status]}</span>
    </span>
  );
}

const REASON: Partial<Record<CiReason, string>> = {
  timeout: 'Timed out',
  invalid_pipeline: 'Invalid pipeline',
  runner_lost: 'Runner lost',
  no_space: 'No disk space',
  runner_error: 'Runner error',
  superseded: 'Superseded',
  signal: 'Killed',
  needs: 'Needs failed',
  condition: 'Condition',
  fail_fast: 'Matrix stopped',
  rejected: 'Rejected',
};

/** What a run row shows: a running run with a job held for a person's approval shows the hand. */
export const runLook = (r: Pick<CiRunSummary, 'status' | 'jobs'>): CiUnitStatus => (r.status === 'running' && r.jobs.some((j) => j.status === 'waiting') ? 'waiting' : r.status);

/** The reason a unit ended, when it is more than a step that exited non-zero. */
export const reasonLabel = (reason: CiReason | null): string | null => (reason ? (REASON[reason] ?? null) : null);

export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Elapsed time of something still going, from when it started. */
export const elapsed = (startedAt: string | null, now: number): number | null => (startedAt ? Math.max(0, now - Date.parse(startedAt)) : null);

export { shortSha };

/** `refs/heads/x` is shown as `x`; a tag keeps a marker. */
export const refLabel = (branch: string | null, tag: string | null): string => (branch ?? (tag ? `tag ${tag}` : ''));

export const MONO = 'font-mono text-[12.5px]';
