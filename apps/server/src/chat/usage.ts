// Chat usage over time (Usage charts): the turns stored as metrics (`chat_usage`, one row per model
// per turn, sub-agents included) added up into buckets across a window, and per Claude and per model.

import { AppError } from '@isnanme/core';
import { CHAT_USAGE_RANGES, type ChatUsageRange, type ChatUsageReport, type ChatUsageTotals } from '@portal/contracts';
import type { ChatStore, UsageRecord } from './store.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Each window and its bucket: about 24 to 30 columns whatever the range. */
const WINDOWS: Record<ChatUsageRange, { span: number; bucket: number }> = {
  '30m': { span: 30 * MIN, bucket: MIN },
  '1h': { span: HOUR, bucket: 2 * MIN },
  '12h': { span: 12 * HOUR, bucket: 30 * MIN },
  '1d': { span: DAY, bucket: HOUR },
  '7d': { span: 7 * DAY, bucket: 6 * HOUR },
  '30d': { span: 30 * DAY, bucket: DAY },
};

export const isUsageRange = (v: unknown): v is ChatUsageRange => (CHAT_USAGE_RANGES as readonly unknown[]).includes(v);

/**
 * The buckets a range covers, ending with the one that holds `now`: whole buckets back from its end, lined up with the viewer's clock
 * (`tzOffsetMin` is `Date.getTimezoneOffset()`). One rule for this report and the extended one (claudeusage/requests.ts, docs §20.8).
 */
export function usageWindow(range: ChatUsageRange, now: number, tzOffsetMin?: number): { span: number; bucket: number; count: number; start: number; end: number } {
  const { span, bucket } = WINDOWS[range];
  const shift = -(Number.isFinite(tzOffsetMin) ? (tzOffsetMin as number) : 0) * MIN; // local = UTC + shift
  const end = Math.floor((now + shift) / bucket) * bucket + bucket - shift;
  const count = Math.round(span / bucket);
  return { span, bucket, count, start: end - count * bucket, end };
}

const zero = (): ChatUsageTotals => ({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, agents: 0 });

function add(into: ChatUsageTotals, r: UsageRecord): void {
  into.costUsd += r.costUsd;
  into.input += r.input;
  into.output += r.output;
  into.cacheRead += r.cacheRead;
  into.cacheWrite += r.cacheWrite;
  into.requests += r.requests;
  into.agents += r.agents;
}

/** Most cost first, then most requests. */
const byCost = (a: ChatUsageTotals, b: ChatUsageTotals) => b.costUsd - a.costUsd || b.requests - a.requests;

/**
 * Usage over `range`, ending now. Buckets line up with the viewer's clock: `tzOffsetMin` is
 * `Date.getTimezoneOffset()` (minutes behind UTC), so a 30-day chart's days start at their midnight.
 * `claudeId` narrows everything to one Claude.
 */
export function usageReport(
  chat: Pick<ChatStore, 'usageSince' | 'claudeName'>,
  range: unknown,
  opts: { claudeId?: string; tzOffsetMin?: number; now?: number } = {},
): ChatUsageReport {
  if (!isUsageRange(range)) throw new AppError('VALIDATION_FAILED', `Pick a range: ${CHAT_USAGE_RANGES.join(', ')}.`);
  // The newest bucket holds now; the window is whole buckets back from its end.
  const { bucket, count, start, end } = usageWindow(range, opts.now ?? Date.now(), opts.tzOffsetMin);

  const buckets = Array.from({ length: count }, (_, i) => ({ at: new Date(start + i * bucket).toISOString(), ...zero() }));
  const totals = zero();
  const claudes = new Map<string, ChatUsageTotals & { claudeId: string; name: string; workspaceId: string }>();
  const models = new Map<string, ChatUsageTotals & { model: string }>();

  for (const r of chat.usageSince(start, opts.claudeId || undefined)) {
    const i = Math.floor((r.atMs - start) / bucket);
    if (i < 0 || i >= count) continue;
    add(buckets[i]!, r);
    add(totals, r);
    const claudeKey = `${r.workspaceId}\u0000${r.claudeId ?? ''}`;
    let c = claudes.get(claudeKey);
    if (!c) {
      c = { claudeId: r.claudeId ?? '', name: chat.claudeName(r.workspaceId, r.claudeId ?? '') ?? 'Default', workspaceId: r.workspaceId, ...zero() };
      claudes.set(claudeKey, c);
    }
    add(c, r);
    let m = models.get(r.model);
    if (!m) {
      m = { model: r.model, ...zero() };
      models.set(r.model, m);
    }
    add(m, r);
  }

  return {
    range,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    bucketMs: bucket,
    totals,
    buckets,
    byClaude: [...claudes.values()].sort(byCost),
    byModel: [...models.values()].sort(byCost),
  };
}
