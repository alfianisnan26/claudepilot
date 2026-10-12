import { cn, Dialog, StatGrid, StatTile } from '@isnanme/ui';
import type { ChatEvent, ChatSegment, ChatSession } from '@portal/contracts';
import { CircleCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { chatApi } from './api';
import { formatTokens, formatUsd } from './shared';
import { formatSeconds } from './ToolRows';

/** One finished turn's numbers, from its `result` event. */
export interface TurnUsage {
  seq: number;
  at: string;
  /** What the turn alone cost; null when Claude Code reported no cost. */
  costUsd: number | null;
  durationMs: number | null;
  /** Input tokens, cached or not, and output tokens; null on turns stored before tokens were kept. */
  input: number | null;
  cached: number | null;
  output: number | null;
}

/**
 * Each finished turn's usage, oldest first. Results carry the turn's own cost; older ones only the
 * process's running total, so theirs is the change from the previous result (a lower total means a
 * new process, which counts from zero).
 */
export function turnUsage(events: ChatEvent[]): TurnUsage[] {
  const out: TurnUsage[] = [];
  let lastTotal = 0;
  for (const e of events) {
    if (e.kind !== 'result') continue;
    const total = e.costUsd ?? null;
    const cost = e.turnCostUsd ?? (total === null ? null : total >= lastTotal ? total - lastTotal : total);
    if (total !== null) lastTotal = total;
    const t = e.tokens;
    out.push({
      seq: e.seq,
      at: e.at,
      costUsd: cost,
      durationMs: e.durationMs ?? null,
      input: t ? t.input + t.cacheRead + t.cacheWrite : null,
      cached: t ? t.cacheRead : null,
      output: t ? t.output : null,
    });
  }
  return out;
}

/** "5.2 s · 101k in · 480 out · $0.090": what's known of a turn, in one line. */
export function usageLine(u: TurnUsage): string {
  const parts: string[] = [];
  if (u.durationMs !== null) parts.push(u.durationMs < 10_000 ? `${(u.durationMs / 1000).toFixed(1)} s` : formatSeconds(u.durationMs));
  if (u.input !== null && u.output !== null) parts.push(`${formatTokens(u.input)} in · ${formatTokens(u.output)} out`);
  if (u.costUsd !== null) parts.push(formatUsd(u.costUsd));
  return parts.join(' · ');
}

/**
 * A turn just finished: a small "Done" pill with its numbers rises in, stays a few seconds, then folds
 * away. The numbers stay in the turn's activity details and in Usage (tap the pill).
 */
export function TurnDone({ usage, onOpen }: { usage: TurnUsage; onOpen?: () => void }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShown(false), 6000);
    return () => clearTimeout(t);
  }, []);
  const line = usageLine(usage);
  return (
    <AnimatePresence initial>
      {shown && (
        <motion.div
          key="done"
          initial={{ opacity: 0, y: 8, scale: 0.96, height: 0 }}
          animate={{ opacity: 1, y: 0, scale: 1, height: 'auto' }}
          exit={{ opacity: 0, y: -4, scale: 0.98, height: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          className="flex justify-center overflow-hidden"
        >
          <button
            type="button"
            onClick={onOpen}
            className="glass-field press my-1 inline-flex items-center gap-1.5 rounded-full border border-line/60 px-3 py-1 text-[11.5px] font-medium text-ink-soft tabular-nums"
          >
            <CircleCheck className="size-3.5 text-accent" aria-hidden="true" />
            <span>Done</span>
            {line && <span className="text-muted">· {line}</span>}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Usage (⋯ → Usage): the session's totals, then each turn's time, tokens and cost. */
export function UsageDialog({ open, onClose, events, session }: { open: boolean; onClose: () => void; events: ChatEvent[]; session: ChatSession | null }) {
  const turns = useMemo(() => turnUsage(events), [events]);
  const known = (pick: (u: TurnUsage) => number | null) => turns.reduce((n, u) => n + (pick(u) ?? 0), 0);
  const cost = known((u) => u.costUsd);
  const input = known((u) => u.input);
  const cached = known((u) => u.cached);
  const output = known((u) => u.output);
  const context = session?.context;
  // Turns stored before tokens were kept have none: say so rather than 0.
  const counted = turns.some((u) => u.input !== null);
  // A chat that moved between Claudes: what each run cost.
  const [segments, setSegments] = useState<ChatSegment[]>([]);
  const id = session?.id;
  const moved = (session?.previousClaudes.length ?? 0) > 0;
  useEffect(() => {
    if (!open || !id || !moved) return setSegments([]);
    let current = true;
    chatApi.segments(id).then(
      (list) => current && setSegments(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open, id, moved, session?.claudeSessionId]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-1.5">
          Usage <InfoTip label="About usage">Estimated at list prices from this session’s stored turns.</InfoTip>
        </span>
      }
      size="sm"
    >
      <StatGrid cols={2}>
        <StatTile label="Cost" value={formatUsd(cost)} size="sm" />
        <StatTile label="Turns" value={String(turns.length)} size="sm" />
        <StatTile label="Tokens in" value={counted ? formatTokens(input) : '—'} hint={input ? `${Math.round((cached / input) * 100)}% from cache` : undefined} size="sm" />
        <StatTile label="Tokens out" value={counted ? formatTokens(output) : '—'} size="sm" />
      </StatGrid>
      {context && (
        <p className="mt-3 text-[12.5px] text-muted">
          Context: {formatTokens(context.usedTokens)}
          {context.windowTokens ? ` of ${formatTokens(context.windowTokens)} (${Math.round((context.usedTokens / context.windowTokens) * 100)}%)` : ''} after the last turn.
        </p>
      )}
      {segments.length > 1 && (
        <ul aria-label="By Claude" className="mt-4 flex flex-col divide-y divide-line rounded-2xl border border-line">
          {segments.map((g) => (
            <li key={g.n} className="flex items-baseline gap-3 px-3.5 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate font-semibold">{g.claudeName}</span>
              <span className="shrink-0 text-muted tabular-nums">{g.turns} {g.turns === 1 ? 'turn' : 'turns'}</span>
              <span className="w-16 shrink-0 text-right font-semibold tabular-nums">{formatUsd(g.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
      <Link to="/admin/usage" onClick={onClose} className="mt-3 inline-block text-[13px] font-semibold text-ink underline underline-offset-2">
        Usage over time
      </Link>
      {turns.length > 0 && (
        <ol className="mt-4 flex flex-col divide-y divide-line rounded-2xl border border-line">
          {[...turns].reverse().map((u, i) => (
            <li key={u.seq} className="flex items-baseline gap-3 px-3.5 py-2.5 text-[13px]">
              <span className="w-7 shrink-0 font-semibold text-muted tabular-nums">#{turns.length - i}</span>
              <span className={cn('min-w-0 flex-1 truncate tabular-nums text-ink-soft')}>{usageLine({ ...u, costUsd: null }) || '—'}</span>
              <span className="shrink-0 font-semibold tabular-nums">{u.costUsd !== null ? formatUsd(u.costUsd) : '—'}</span>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
