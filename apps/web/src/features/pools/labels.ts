import type { BadgeTone } from '@isnanme/ui';
import type { PoolSummary } from '@portal/contracts';

/** "Used by 3 workspaces", the line every pool card shows (foundation PRD §10). */
export const usedBy = (n: number) => (n === 0 ? 'Not used yet' : `Used by ${n} workspace${n === 1 ? '' : 's'}`);

/**
 * What a card says about revisions besides the current one: a newer revision waiting for review, a
 * draft, or one held back, and a paused rollout (Skillset PRD §18 A3, FR23).
 */
export function revisionBadges(p: PoolSummary): { label: string; tone: BadgeTone }[] {
  const out: { label: string; tone: BadgeTone }[] = [];
  if (p.latestRevision > p.revision) {
    if (p.status === 'waiting_review') out.push({ label: `r${p.latestRevision} waiting for review`, tone: 'warning' });
    else if (p.status === 'draft') out.push({ label: `r${p.latestRevision} draft`, tone: 'neutral' });
    else out.push({ label: `r${p.latestRevision} not current`, tone: 'neutral' });
  }
  if (p.rolloutPaused) out.push({ label: `r${p.revision} paused`, tone: 'danger' });
  return out;
}

export const STATUS_LABEL: Record<PoolSummary['status'], string> = {
  deliverable: 'Deliverable',
  waiting_review: 'Waiting for review',
  draft: 'Draft',
};

/** Delivery states as the Configuration panel names them (foundation PRD §10). Keyed by string: the engine may add states. */
export const DELIVERY_LABEL: Record<string, { label: string; tone: BadgeTone; busy?: boolean }> = {
  synced: { label: 'Synced', tone: 'success' },
  pending: { label: 'Pending', tone: 'neutral', busy: true },
  drifted: { label: 'Drifted', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  locked: { label: 'Locked', tone: 'warning' },
  frozen: { label: 'Frozen', tone: 'danger' },
  unsupported: { label: 'Unsupported', tone: 'neutral' },
  needs_restart: { label: 'Needs restart', tone: 'warning' },
  none: { label: 'Nothing delivered', tone: 'neutral' },
};

/** `0o644` → "0644". */
export const formatMode = (mode: number) => `0${mode.toString(8).padStart(3, '0')}`;

/** uid or gid as the workspace image names it. */
export const formatOwner = (id: number) => (id === 0 ? 'root' : id === 1000 ? 'node' : String(id));
