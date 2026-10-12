// The spend adapter: `UsageSpend.onAlert` (U1b, claude-usage PRD §21-26). A spike (a heads-up, a heuristic) and a budget at its critical
// or exceeded level notify as `cost_spike`, which breaks through quiet hours by default. Every figure is an estimate. The alert names its
// owner: that is the audience. Its `summary` line is not used (names and numbers are taken field by field).

import type { SpendAlert } from '@portal/contracts';
import type { NotifyBus } from '../bus.js';

const USER = /^u_[a-z0-9]{1,40}$/;

export function adaptSpend(spend: { onAlert(fn: (a: SpendAlert) => void): () => void }, bus: NotifyBus): () => void {
  return spend.onAlert((a) => {
    const audience = USER.test(a.owner) ? [a.owner] : undefined;
    if (a.kind === 'budget') {
      if (a.level === 'near') return;
      bus.emit({
        kind: 'cost_spike',
        subject: { type: 'budget', id: a.budgetId, workspaceId: a.workspaceId },
        facts: { what: 'budget', name: a.budgetName, usedPct: a.usedPct, level: a.level, paused: a.paused },
        estimates: ['usedPct'],
        ...(audience ? { audience } : {}),
      });
      return;
    }
    bus.emit({
      kind: 'cost_spike',
      subject: a.sessionId ? { type: 'session', id: a.sessionId, workspaceId: a.workspaceId } : { type: 'claude', id: a.claudeId, workspaceId: a.workspaceId },
      facts: { what: 'spike', spikeKind: a.spikeKind, workspace: a.workspaceId },
      ...(audience ? { audience } : {}),
    });
  });
}
