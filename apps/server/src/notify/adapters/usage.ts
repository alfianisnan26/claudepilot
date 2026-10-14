// The plan-usage adapter: `ClaudeUsageMonitor.onAlert` (claude-usage PRD). `high` (95 %), `exhausted` and a `projection` (an estimate)
// notify as `quota_low`; `near` (80 %) goes to the history only (`level: 'near'`). New fields of the alert are tolerated.
// T-126 item 1: the alert says how many chats run on the Claude (`chats`, a number: a chat's title is agent-writable text and stays out of
// `facts`); the pipeline drops one for a Claude no chat runs on unless the person watches it. Without `chatsOn` (not known) `chats` is
// absent and the alert goes as before.

import type { ClaudeUsageAlert } from '@portal/contracts';
import type { NotifyBus } from '../bus.js';

/** How many chats run on a Claude now (not ended). */
export type ChatsOn = (claudeId: string) => number;

export function adaptUsage(usage: { onAlert(fn: (a: ClaudeUsageAlert) => void): () => void }, bus: NotifyBus, chatsOn?: ChatsOn): () => void {
  return usage.onAlert((a) => {
    const projection = a.kind === 'projection';
    const used = typeof a.usedPct === 'number' ? a.usedPct : null;
    let on: number | null = null;
    try {
      on = chatsOn ? chatsOn(a.claudeId) : null;
    } catch {
      on = null; // not known: the alert goes as before
    }
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
        ...(on !== null ? { chats: on } : {}),
      },
      ...(projection ? { estimates: ['etaAt', 'projectedPct'] } : {}),
    });
  });
}
