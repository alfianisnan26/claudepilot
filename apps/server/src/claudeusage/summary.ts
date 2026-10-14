// Claude usage: the summary strip (docs/prd/claude-usage.md §20.7): spend today, speed, time until the limit, next reset, overall and per Claude.
// It joins what requests spent (spend.ts, from `chat_usage`) with where each plan window is heading (pace.ts, from the percentages Claude Code
// reported): the two are never mixed into one number. Pure over the rows and the snapshot it is given.

import type { ClaudeUsage, UsageSummary, UsageSummaryClaude } from '@portal/contracts';
import { nextResetOf, soonestOutlook, soonestReset } from './pace.js';
import { ClaudeIndex, dayStart, spendSpeed, spendToday, TRAILING_MS, type ClaudeKey, type ClaudeRef, type SpendRow } from './spend.js';

export interface SummaryInput {
  /** The snapshot's Claudes (each with its pace, outlook and slot) at `nowMs`. */
  claudes: ClaudeUsage[];
  /** Requests finished since the day began or in the last 15 minutes, whichever is earlier. */
  rows: SpendRow[];
  refs: ClaudeRef[];
  nowMs: number;
  tzOffsetMin?: number;
  /** Narrows everything to one Claude. */
  claudeId?: string;
  /** Multi-user seam: false leaves a Claude's requests out. Absent: all. */
  allow?: (claude: ClaudeKey) => boolean;
}

/** The earliest finish time `buildSummary` needs rows from. */
export function summaryRowsFrom(nowMs: number, tzOffsetMin?: number): number {
  return Math.min(dayStart(nowMs, tzOffsetMin), nowMs - TRAILING_MS);
}

export function buildSummary(input: SummaryInput): UsageSummary {
  const { nowMs } = input;
  const ds = dayStart(nowMs, input.tzOffsetMin);
  const index = new ClaudeIndex(input.refs);
  const byClaude = new Map<string, SpendRow[]>();
  const visible: SpendRow[] = [];
  for (const r of input.rows) {
    const ref = index.resolve(r);
    if (input.allow && !input.allow(ref)) continue;
    visible.push(r);
    const list = byClaude.get(ref.claudeId);
    if (list) list.push(r);
    else byClaude.set(ref.claudeId, [r]);
  }
  const scoped = input.claudeId ? input.claudes.filter((c) => c.claudeId === input.claudeId) : input.claudes;
  const rowsOf = (id: string) => byClaude.get(id) ?? [];

  const claudes: UsageSummaryClaude[] = scoped
    .map((c) => ({
      claudeId: c.claudeId,
      name: c.claudeName,
      workspaceId: c.workspaceId,
      workspaceName: c.workspaceName,
      slot: c.slot,
      runsOn: c.runsOn,
      state: c.state,
      today: spendToday(rowsOf(c.claudeId), nowMs, ds),
      speed: spendSpeed(rowsOf(c.claudeId), nowMs, ds),
      limit: c.outlook,
      nextReset: nextResetOf({ runsOn: c.runsOn, windows: c.windows, checkedAt: c.checkedAt }, nowMs),
      // T-255: why its plan usage is unknown (the snapshot's own answer), so nothing reads it as 0 % used.
      unavailable: c.unavailable ?? null,
    }))
    .sort((a, b) => (b.today.costUsd.value ?? 0) - (a.today.costUsd.value ?? 0) || a.name.localeCompare(b.name));

  // Overall spend counts every request, even one of a Claude that is gone; with a Claude picked, its requests only.
  const rows = input.claudeId ? rowsOf(input.claudeId) : visible;
  const limit = soonestOutlook(claudes.map((c) => ({ outlook: c.limit, claudeId: c.claudeId, name: c.name })));
  const reset = soonestReset(claudes);
  return {
    now: new Date(nowMs).toISOString(),
    scope: { claudeId: input.claudeId ?? null, claudeName: input.claudeId ? scoped[0]?.claudeName ?? null : null },
    today: spendToday(rows, nowMs, ds),
    speed: spendSpeed(rows, nowMs, ds),
    limit: { ...limit.outlook, claudeId: limit.from?.claudeId ?? null, claudeName: limit.from?.name ?? null },
    nextReset: { ...reset.reset, claudeId: reset.from?.claudeId ?? null, claudeName: reset.from?.name ?? null },
    claudes,
  };
}
