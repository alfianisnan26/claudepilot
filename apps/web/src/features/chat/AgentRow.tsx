import { cn } from '@isnanme/ui';
import type { ChatEvent, ChatTask } from '@portal/contracts';
import { Bot, ChevronRight } from 'lucide-react';
import { createContext, useContext } from 'react';
import { agentLatest, modelShort, rowSeq } from './agentFold';
import type { AgentLive } from './motion/deltas';
import type { TranscriptRow } from './ToolRows';

/** What the transcript knows of its sub-agents: their tasks, what each writes now, their own rows, and how to open one. */
export interface AgentsView {
  /** Tasks by the Task call that started them (`ChatTask.toolUseId`). */
  byCall: ReadonlyMap<string, ChatTask>;
  live: ReadonlyMap<string, AgentLive>;
  rows: ReadonlyMap<string, TranscriptRow[]>;
  /** Opens a sub-agent's detail view. */
  open?: (taskId: string) => void;
}

const NONE: AgentsView = { byCall: new Map(), live: new Map(), rows: new Map() };

/**
 * Given through context, not props: the agents' live text changes many times a second, and only the rows that show an agent should
 * render again for it, not the whole transcript (its rows are memoized).
 */
export const AgentsContext = createContext<AgentsView>(NONE);

/**
 * The line an activity row shows while one of its sub-agents still runs: that agent's name and what it does now (the most recently active
 * one when several run). Null when none of them runs.
 */
export function useAgentLine(ids: readonly string[]): { label: string; line: string } | null {
  const view = useContext(AgentsContext);
  let best: { label: string; line: string; rank: number } | null = null;
  for (const id of ids) {
    const task = view.byCall.get(id);
    if (task?.status !== 'running') continue;
    const live = view.live.get(id);
    const rows = view.rows.get(id);
    // Writing now ranks first; otherwise the agent with the newest stored line.
    const rank = live ? Number.MAX_SAFE_INTEGER : rows?.length ? rowSeq(rows[rows.length - 1]!) : 0;
    if (best && best.rank >= rank) continue;
    best = { label: task.description || task.subagentType || 'Agent', line: agentLatest(rows, live) ?? 'Starting', rank };
  }
  return best && { label: best.label, line: best.line };
}

/**
 * The call that started a sub-agent, as one row: the agent's icon, its name, its model, and its latest line (shimmering while it runs).
 * Its own lines are not listed here: the row opens the agent's detail view, where they are.
 */
export function AgentRow({ call, result }: { call: ChatEvent; result: ChatEvent | null }) {
  const view = useContext(AgentsContext);
  const id = call.toolUseId ?? '';
  const task = view.byCall.get(id) ?? null;
  const running = task ? task.status === 'running' : !result;
  const failed = task ? task.status === 'failed' || task.status === 'killed' : !!result?.isError;
  const name = task?.description || call.text || 'Agent';
  const model = task ? modelShort(task.model) : null;
  const line = agentLatest(view.rows.get(id), view.live.get(id)) ?? (running ? 'Starting' : (task?.summary ?? null));
  const open = task && view.open ? () => view.open!(task.taskId) : undefined;
  const body = (
    <>
      <Bot className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('min-w-0 truncate font-medium', failed ? 'text-danger' : 'text-ink-soft')}>{name}</span>
          {model && <span className="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-muted uppercase">{model}</span>}
        </span>
        {line && <span className={cn('block truncate text-[12.5px]', running ? 'shimmer' : 'text-muted')}>{line}</span>}
      </span>
      <span className="sr-only">{running ? '(running)' : failed ? '(stopped or failed)' : '(done)'}</span>
      {open && <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />}
    </>
  );
  const cls = 'flex w-full max-w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left text-[14px] sm:text-[13px]';
  return open ? (
    <button type="button" onClick={open} aria-label={`Open agent ${name}`} className={cn(cls, 'press hover:bg-surface-2 tap:min-h-11')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
