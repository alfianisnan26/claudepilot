import { cn } from '@isnanme/ui';
import type { RepoWorkspaceSummary } from '@portal/contracts';
import { GitBranch } from 'lucide-react';
import { timeAgo } from '@/lib/format';
import { attentionWord, summaryParts, summaryTone } from './labels';
import { TONE_CLASS } from './tone';

/** The attribute that marks the chip, for a row that opens the Repos tab when the chip is what was tapped. */
export const REPOS_CHIP_ATTR = 'data-repos-chip';

/** The sentence for a screen reader (the row's own label): how many repositories need a look; null when none. */
export function reposLabel(summary: RepoWorkspaceSummary | undefined): string | null {
  const n = summary?.summary.attention ?? 0;
  return n > 0 ? attentionWord(n) : null;
}

/**
 * The chip on a workspace's row: how many of its repositories need a look (workspace-git PRD FR23), in the colour of the worst
 * of them. Nothing when none does, or when the workspace was never scanned. It sits inside the row's own button, so it is not
 * a button: the row opens the Repos tab when this is what was tapped. What the count is made of is its tooltip; a stopped
 * workspace's is as of its last scan.
 */
export function ReposChip({ summary }: { summary: RepoWorkspaceSummary | undefined }) {
  const n = summary?.summary.attention ?? 0;
  if (!summary || n === 0) return null;
  const parts = summaryParts(summary.summary).join(' · ');
  const stale = !summary.running && summary.scannedAt ? ` (as of ${timeAgo(summary.scannedAt)})` : '';
  return (
    <span
      {...{ [REPOS_CHIP_ATTR]: '' }}
      title={`${parts || attentionWord(n)}${stale}`}
      className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[12.5px] font-semibold tabular-nums', TONE_CLASS[summaryTone(summary.summary)])}
    >
      <GitBranch className="size-3" aria-hidden="true" />
      {n}
    </span>
  );
}
