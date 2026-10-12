import { LoadError } from '@isnanme/ui';
import type { ClaudeUsage, ClaudeUsageState } from '@portal/contracts';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { usageApi } from '@/lib/usage';
import { ExportMenu } from '../ExportMenu';
import { ClaudeRow } from './ClaudeRow';
import { needsPaceLook } from './pace';
import { useClaudeUsage, useNow } from './useClaudeUsage';

/** Who needs a look first: out of usage, near it, within limits, then the ones with nothing to run out of. */
const RANK: Record<ClaudeUsageState, number> = { exhausted: 0, near: 1, ok: 2, unknown: 3, signed_out: 4, no_limits: 5 };

/**
 * Claudes that need a look: near their limit, out, or estimated to run out before they reset (a confident estimate only), not counting the
 * ones whose alerts are snoozed: the tab's badge.
 */
export function attentionCount(claudes: ClaudeUsage[]): number {
  return claudes.filter((c) => ((c.state === 'near' || c.state === 'exhausted') && !c.snoozedUntil) || needsPaceLook(c)).length;
}

const hashId = () => {
  try {
    return decodeURIComponent(window.location.hash.slice(1)) || null;
  } catch {
    return null;
  }
};

/**
 * Usage → Claudes: each Claude's plan windows as Claude Code reports them (PRD claude-usage §13). One row each, the neediest
 * first; the history sits behind a row's chevron. Opens on the Claude a link names (`#<id>`).
 */
export function ClaudesTab() {
  const { report, failed, reload } = useClaudeUsage({ watch: true });
  const now = useNow(30_000);
  const [open, setOpen] = useState<string | null>(hashId);
  const claudes = useMemo(() => [...(report?.claudes ?? [])].sort((a, b) => RANK[a.state] - RANK[b.state]), [report]);

  // A link to one Claude scrolls to it once the rows are there.
  useEffect(() => {
    if (open && report) document.getElementById(open)?.scrollIntoView({ block: 'nearest' });
    // Only when the report first arrives: later changes must not move the page under a finger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!report]);

  return (
    <>
      <PageHeader
        title="Claudes"
        description="The plan limits Claude Code reports for each Claude: the 5-hour session, the week and the weeks of single models, and when each resets. Read while the workspace runs, every few minutes (more often with this tab open), and from live chats. A dash means not read yet, not zero. A pool or an API key has no plan limits. The pale stretch after a bar is where the window is estimated to stand at its reset, from how fast it filled; the thin tick is where an even spend would be."
        action={
          <ExportMenu
            items={[
              { label: 'Readings · CSV', url: usageApi.exportUrl({ what: 'quota', format: 'csv', range: '7d' }) },
              { label: 'Readings · JSON', url: usageApi.exportUrl({ what: 'quota', format: 'json', range: '7d' }) },
            ]}
          />
        }
      />
      {failed ? (
        <LoadError onRetry={reload} />
      ) : !report ? (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-28 rounded-[24px]" />
          ))}
        </div>
      ) : claudes.length === 0 ? (
        <p className="py-3 text-[13px] text-muted">No Claudes yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {claudes.map((c) => (
            <ClaudeRow key={c.claudeId} c={c} peers={claudes} nowMs={now} open={open === c.claudeId} onToggle={() => setOpen(open === c.claudeId ? null : c.claudeId)} />
          ))}
        </ul>
      )}
    </>
  );
}
