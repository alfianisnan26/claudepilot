import { useMemo } from 'react';
import { useClaudeUsage, useNow } from '@/features/usage/claude/useClaudeUsage';
import { useGlanceSettings } from '../../settings';
import type { GlanceCompact, GlanceContext } from '../../types';
import { quotaCompact } from './quota';
import { useRecentClaudeId } from './recent';

/**
 * The Quota chip. It reads the shared snapshot of the Usage page (`useClaudeUsage`: one request however many chips are on screen,
 * kept fresh by the live topic `claudeusage`), so it asks the portal for nothing of its own. The composer's chip always follows
 * the open session's Claude, whatever the all-Claudes setting says.
 */
export function useQuotaCompact(ctx: GlanceContext): GlanceCompact {
  const { report, failed } = useClaudeUsage();
  const settings = useGlanceSettings();
  const nowMs = useNow(60_000);
  const recentClaudeId = useRecentClaudeId(!ctx.focus.claudeId);
  const claudes = report?.claudes ?? null;
  const mode = ctx.placement === 'composer' ? 'active' : settings.quotaMode;
  return useMemo(
    () => quotaCompact({ claudes, failed, focusClaudeId: ctx.focus.claudeId, recentClaudeId, mode, nowMs, thresholds: settings.thresholds }),
    [claudes, failed, ctx.focus.claudeId, recentClaudeId, mode, nowMs, settings.thresholds],
  );
}
