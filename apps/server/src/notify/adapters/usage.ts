// The plan-usage adapter: `ClaudeUsageMonitor.onAlert` (claude-usage PRD). `high` (95 %), `exhausted` and a `projection` (an estimate)
// notify as `quota_low`; `near` (80 %) goes to the history only (`level: 'near'`). New fields of the alert are tolerated.

import type { ClaudeUsageAlert } from '@portal/contracts';
import type { NotifyBus } from '../bus.js';

export function adaptUsage(usage: { onAlert(fn: (a: ClaudeUsageAlert) => void): () => void }, bus: NotifyBus): () => void {
  return usage.onAlert((a) => {
    const projection = a.kind === 'projection';
    const used = typeof a.usedPct === 'number' ? a.usedPct : null;
    bus.emit({
      kind: 'quota_low',
      subject: { type: 'claude', id: a.claudeId },
      facts: {
        claude: a.claudeName,
        window: a.label,
        level: projection ? 'projection' : a.level,
        projection,
        leftPct: used === null ? null : Math.max(0, 100 - used),
        resetsAt: a.resetsAt,
        ...(projection ? { etaAt: a.etaAt ?? null, projectedPct: a.projectedPct ?? null } : {}),
      },
      ...(projection ? { estimates: ['etaAt', 'projectedPct'] } : {}),
    });
  });
}
