import type { GlanceSnapshot } from '@portal/contracts';

/** What a widget's compact model is given: the shared snapshot and how far to trust it (see `useGlance`). */
export interface Readings {
  data: GlanceSnapshot | null;
  /** Nothing could be loaded yet. */
  failed: boolean;
  /** What is shown is old. */
  stale: boolean;
}

/** The palette key of a Claude as the usage palette knows it: its id, or its workspace's Default when none was recorded. */
export const claudeKey = (s: { claudeId: string; workspaceId: string }): string => s.claudeId || `default:${s.workspaceId}`;
