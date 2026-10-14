import { Badge, Button, Spinner, type BadgeTone } from '@isnanme/ui';
import type { ChatEvent, ChatTask } from '@portal/contracts';
import { ArrowLeft, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { latestLine, modelShort } from './agentFold';
import { ticketOf } from './agentList';
import { chatApi } from './api';
import { Markdown } from './Markdown';
import type { AgentLive } from './motion/deltas';
import { AgentTag, formatDuration, formatTokens, useNow } from './shared';
import { buildRows, ThinkingRow, ToolCall, type TranscriptRow } from './ToolRows';

export const TASK_STATUS: Record<ChatTask['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'Running', tone: 'success' },
  completed: { label: 'Done', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  killed: { label: 'Stopped', tone: 'danger' },
};

/** While the agent runs, how often its new lines are fetched. */
const POLL_MS = 2_000;

/** A task's time: live from its start while it runs; finished, what it reported, else start to end. */
export function taskMs(t: ChatTask, now: number): number {
  const started = Date.parse(t.startedAt);
  return t.status === 'running' ? now - started : (t.durationMs ?? (t.endedAt ? Date.parse(t.endedAt) - started : Number.NaN));
}

/**
 * One sub-agent's own transcript (`CHAT_API.taskEvents`): fetched when the view opens, then its new lines every two seconds while it runs,
 * and once more when it ends. Oldest first; bounded by the server.
 */
function useTaskTranscript(sessionId: string, taskId: string, running: boolean) {
  const [state, setState] = useState<{ events: ChatEvent[]; truncated: boolean; error: string | null; loaded: boolean }>({ events: [], truncated: false, error: null, loaded: false });
  const last = useRef(0);
  useEffect(() => {
    let gone = false;
    last.current = 0;
    setState({ events: [], truncated: false, error: null, loaded: false });
    const load = () =>
      chatApi.taskEvents(sessionId, taskId, last.current).then(
        (t) => {
          if (gone) return;
          const fresh = t.events.filter((e) => e.seq > last.current);
          if (fresh.length) last.current = fresh[fresh.length - 1]!.seq;
          setState((s) => ({ events: fresh.length ? [...s.events, ...fresh] : s.events, truncated: s.truncated || t.truncated, error: null, loaded: true }));
        },
        (e: unknown) => !gone && setState((s) => ({ ...s, error: errorText(e, 'Couldn’t load its lines.'), loaded: true })),
      );
    void load();
    const timer = running ? window.setInterval(() => void load(), POLL_MS) : 0;
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
    // `running` turning false loads once more (the last lines), then stops.
  }, [sessionId, taskId, running]);
  return state;
}

/**
 * A sub-agent in full (chat PRD, the Agents panel): what it was asked to do, its type, model, status, tokens, tool uses and time, its
 * result, and its own transcript (tool calls, results, text; newest at the bottom, live while it runs), with Stop. It replaces the list in
 * the Agents panel or sheet; back returns to the list.
 */
export function AgentDetail({
  sessionId,
  task: t,
  live,
  onBack,
  onClose,
  closeLabel,
  titleId,
  onStop,
  stopping,
  stopDisabled,
  failure,
}: {
  sessionId: string;
  task: ChatTask;
  live?: AgentLive;
  onBack: () => void;
  onClose: () => void;
  closeLabel: string;
  titleId?: string;
  onStop?: () => void;
  stopping: boolean;
  stopDisabled: boolean;
  failure?: string;
}) {
  const running = t.status === 'running';
  const status = TASK_STATUS[t.status] ?? TASK_STATUS.running;
  const now = useNow(running);
  const ms = taskMs(t, now);
  const model = modelShort(t.model);
  const name = t.description || 'Task';
  const { events, truncated, error, loaded } = useTaskTranscript(sessionId, t.taskId, running);
  const rows = useMemo(() => buildRows(events, false), [events]);
  // Claude Code reports an agent's tool uses when it ends; while it runs, the count is its own transcript's (the newest 200 lines at most).
  const toolsSoFar = useMemo(() => rows.reduce((n, r) => n + (r.type === 'tool' ? 1 : r.type === 'group' ? r.tools.length : 0), 0), [rows]);
  const ticket = ticketOf(t.description);
  const liveLine = running && live ? (live.thinking ? 'Thinking' : latestLine(live.text)) : '';

  // Newest at the bottom, followed while the reader is there.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows, liveLine]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const facts: [string, ReactNode][] = [
    ['Type', t.subagentType ? <AgentTag label={t.subagentType} /> : <span className="text-muted">Command</span>],
    [
      'Model',
      model ? (
        <span title={t.model ?? undefined} className="font-medium break-all">
          {model}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-muted">
          Unavailable
          <InfoTip label="About the model">Claude Code hasn’t reported which model it runs on (a background command has none).</InfoTip>
        </span>
      ),
    ],
    ['Tokens', t.tokens != null ? <span className="tabular-nums">{formatTokens(t.tokens)}</span> : <span className="text-muted">–</span>],
    [
      'Tool uses',
      t.toolUses != null ? (
        <span className="tabular-nums">{t.toolUses}</span>
      ) : running && loaded ? (
        <span className="tabular-nums">
          {truncated ? 'over ' : ''}
          {toolsSoFar} so far
        </span>
      ) : (
        <span className="text-muted">–</span>
      ),
    ],
    ['Time', Number.isFinite(ms) ? <span className="tabular-nums">{formatDuration(ms)}</span> : <span className="text-muted">–</span>],
  ];
  // The ticket its description names (`T-149 slice 1: …`), a way to the ticket.
  if (ticket)
    facts.unshift([
      'Ticket',
      <Link to={`/admin/tickets/${ticket}`} className="inline-flex items-center font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink tap:min-h-11">
        {ticket}
      </Link>,
    ]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2 pl-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to agents"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink tap:size-11"
        >
          <ArrowLeft className="size-[18px]" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">
            Agent
          </h2>
          <p className="truncate text-[11px] text-muted">{model ? `${status.label} · ${model}` : status.label}</p>
        </div>
        {onStop && running && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Square className="size-3.5" />}
            loading={stopping}
            disabled={stopDisabled}
            onClick={onStop}
            aria-label={stopping ? `Stopping ${name}` : `Stop ${name}`}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink tap:size-11"
        >
          <X className="size-[18px]" />
        </button>
      </div>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <div className="border-b border-line px-4 py-3">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[14px] leading-snug font-semibold break-words">{name}</p>
            <Badge tone={status.tone} className="shrink-0">
              {running && <Spinner className="size-3" />}
              {status.label}
            </Badge>
          </div>
          <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 break-words text-ink-soft">{v}</dd>
              </div>
            ))}
          </dl>
          {failure && !stopping && (
            <p role="alert" className="mt-2 text-[12.5px] font-medium break-words text-danger">
              {failure}
            </p>
          )}
          {t.summary && (
            <div className="mt-3">
              <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Result</h3>
              <p className="mt-1 text-[13px] break-words whitespace-pre-wrap text-ink-soft">{t.summary}</p>
            </div>
          )}
        </div>
        <section aria-label="Its transcript" className="px-4 py-3">
          <div className="flex items-center gap-1">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Transcript</h3>
            <InfoTip label="About this transcript">Its own lines only: the tools it used, what they returned, and what it wrote. Newest at the bottom; live while it runs.</InfoTip>
          </div>
          {truncated && <p className="mt-2 text-[12px] text-muted">Older lines are not shown.</p>}
          {error && (
            <p role="alert" className="mt-2 text-[12.5px] break-words text-danger">
              {error}
            </p>
          )}
          {!loaded ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-4" />
            </div>
          ) : rows.length === 0 && !liveLine ? (
            <p className="mt-2 text-[13px] text-muted">{running ? 'Nothing yet.' : 'Nothing recorded.'}</p>
          ) : (
            // Its tool rows stand alone here (not inside an activity line): 44 px to tap on a touch screen.
            <div className="mt-2 flex min-w-0 flex-col gap-2 tap:[&_button[aria-expanded]]:min-h-11" role="log" aria-live="polite">
              {rows.map((r) => (
                <DetailRow key={rowKey(r)} row={r} running={running} />
              ))}
              {liveLine && <p className="shimmer truncate text-[13px]">{liveLine}</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const rowKey = (r: TranscriptRow) => (r.type === 'tool' ? `t${r.call.seq}` : r.type === 'group' ? `g${r.tools[0]!.call.seq}` : `e${r.event.seq}`);

/** One of the agent's lines: a tool call with its result, a thinking block, what it wrote, or a note. */
function DetailRow({ row: r, running }: { row: TranscriptRow; running: boolean }) {
  if (r.type === 'tool') return <ToolCall call={r.call} result={r.result} agent={null} running={running} details={false} images={[]} />;
  if (r.type === 'thinking') return <ThinkingRow event={r.event} agent={null} details={false} />;
  if (r.type === 'group') return null; // not grouped here
  const e = r.event;
  if (e.kind === 'assistant' && e.text) return <Markdown text={e.text} className="w-full min-w-0 text-[14px] leading-[1.55] break-words text-ink" />;
  if (!e.text) return null;
  return <p className={e.kind === 'error' ? 'text-[12.5px] break-words text-danger' : 'text-[12.5px] break-words text-muted'}>{e.text}</p>;
}
