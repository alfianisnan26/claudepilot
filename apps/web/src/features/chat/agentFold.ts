// Where a sub-agent's lines go in the transcript (chat PRD FR5, the Agents section; ticket T-31). A sub-agent's lines never stand in the main
// flow and never take the main reply's place: they belong to the Task (Agent) call that started it, so they fold into the activity row of
// the turn that made that call, however late they arrive (a background agent still writing after the main turn ended). The row of the
// call shows the agent: its name, its latest line, and it opens the agent's own transcript (AgentDetail). Pure, so it is tested alone.
import type { ChatEvent, ChatTask } from '@portal/contracts';
import { shortTarget, toolLabel, type TranscriptRow } from './ToolRows';
import type { AgentLive } from './motion/deltas';

/** Tools that start a sub-agent. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** What the transcript shows, in order: a row as it is, a turn's work folded into one activity row, or a turn just done. */
export type Item =
  | { kind: 'row'; key: string; row: TranscriptRow; fresh: boolean }
  | {
      kind: 'activity';
      key: string;
      rows: TranscriptRow[];
      result: ChatEvent | null;
      fresh: boolean;
      /** The sub-agents its calls started (their Task call ids), in order. */
      agents: string[];
    }
  | { kind: 'done'; key: string; result: ChatEvent };

export const rowSeq = (r: TranscriptRow): number => (r.type === 'tool' ? r.call.seq : r.type === 'group' ? r.tools[0]!.call.seq : r.event.seq);

const headOf = (r: TranscriptRow): ChatEvent => (r.type === 'tool' ? r.call : r.type === 'group' ? r.tools[0]!.call : r.event);

/** The Task call that started the sub-agent a row came from; null for the main agent's own rows. */
export const rowParent = (r: TranscriptRow): string | null => headOf(r).parentToolUseId ?? null;

/** The sub-agent a row starts: the id of its Task (Agent) call, or null when it is no such call. */
export const agentStarted = (r: TranscriptRow): string | null =>
  r.type === 'tool' && AGENT_TOOLS.has(r.call.toolName ?? '') && r.call.toolUseId ? r.call.toolUseId : null;

export interface ItemsInput {
  rows: TranscriptRow[];
  /** Replies that end their turn: they stay in the open. */
  finals: ReadonlySet<number>;
  /** Rows that stand for a move to another Claude, by seq: they stay in the open. */
  moves: { has(seq: number): boolean };
  /** Rows up to this seq were there when the page opened: they don't rise. */
  base: number;
  details: boolean;
}

export interface Items {
  items: Item[];
  /** Each sub-agent's own rows, by the Task call that started it (a nested agent's go to the agent the main one started). */
  agentRows: ReadonlyMap<string, TranscriptRow[]>;
}

/**
 * The transcript's items. A turn's work (thinking, tool calls, notes between them) folds into activity rows; the reply that ends the turn,
 * what you sent, errors and tool images stay out. A turn's result goes to its activity rows (their usage), and a result that just came in
 * shows the Done pill. A sub-agent's rows whose Task call is in the transcript leave the flow for `agentRows`: they are never a row of
 * their own, wherever they arrive.
 */
export function buildItems({ rows, finals, moves, base, details }: ItemsInput): Items {
  const isActivity = (r: TranscriptRow): boolean => {
    if (r.type === 'thinking' || r.type === 'group') return true;
    if (r.type === 'tool') return !r.result?.images?.length;
    const e = r.event;
    if (e.kind === 'assistant') return !!e.agentLabel || !finals.has(e.seq);
    // What stands for a move stays where it is, in the open.
    if (e.kind === 'system' && (e.transfer || e.btw || e.restart || moves.has(e.seq))) return false;
    return e.kind === 'system' || e.kind === 'retry' || e.kind === 'resolved';
  };
  // "Ready" (the process started) says nothing a reader needs, except in Show all details.
  const quiet = (r: TranscriptRow) => !details && r.type === 'event' && r.event.kind === 'system' && r.event.text === 'Ready';
  const substantive = (r: TranscriptRow) => r.type !== 'event' || r.event.kind === 'assistant';

  const items: Item[] = [];
  const agentRows = new Map<string, TranscriptRow[]>();
  /** A Task call seen in the flow (or inside an agent) → the agent of the main flow it belongs to. */
  const rootOf = new Map<string, string>();
  let run: TranscriptRow[] = [];
  let turn: Extract<Item, { kind: 'activity' }>[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.some(substantive)) {
      const first = rowSeq(run[0]!);
      const block: Extract<Item, { kind: 'activity' }> = {
        kind: 'activity',
        key: `a${first}`,
        rows: run,
        result: null,
        fresh: first > base,
        agents: run.flatMap((r) => agentStarted(r) ?? []),
      };
      items.push(block);
      turn.push(block);
    } else for (const r of run) items.push({ kind: 'row', key: `r${rowSeq(r)}`, row: r, fresh: rowSeq(r) > base });
    run = [];
  };
  for (const r of rows) {
    if (quiet(r)) continue;
    const parent = rowParent(r);
    const root = parent === null ? undefined : rootOf.get(parent);
    if (root !== undefined) {
      // A sub-agent's line: its agent's, never the flow's (and an agent it starts in turn is the same agent's).
      const own = agentRows.get(root);
      if (own) own.push(r);
      else agentRows.set(root, [r]);
      const nested = agentStarted(r);
      if (nested) rootOf.set(nested, root);
      continue;
    }
    const started = parent === null ? agentStarted(r) : null;
    if (started) rootOf.set(started, started);
    if (isActivity(r)) {
      run.push(r);
      continue;
    }
    flush();
    if (r.type === 'event' && r.event.kind === 'result') {
      for (const b of turn) b.result = r.event;
      if (r.event.seq > base) items.push({ kind: 'done', key: `d${r.event.seq}`, result: r.event });
      turn = [];
      continue;
    }
    if (r.type === 'event' && r.event.kind === 'user') turn = [];
    items.push({ kind: 'row', key: `r${rowSeq(r)}`, row: r, fresh: rowSeq(r) > base });
  }
  flush();
  return { items, agentRows };
}

/** The last line of text that says something, cut for one row. */
export function latestLine(text: string, max = 120): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.length > max ? `…${last.slice(-(max - 1))}` : last;
}

/** What a sub-agent is doing, in a few words: what it is writing now, else its latest stored line ("Read hostname", its last words). */
export function agentLatest(rows: readonly TranscriptRow[] | undefined, live: AgentLive | undefined): string | null {
  if (live?.thinking) return 'Thinking';
  if (live?.text.trim()) return latestLine(live.text);
  for (let i = (rows?.length ?? 0) - 1; i >= 0; i--) {
    const r = rows![i]!;
    if (r.type === 'tool' || r.type === 'group') {
      const call = r.type === 'tool' ? r.call : r.tools[r.tools.length - 1]!.call;
      const name = call.toolName ? toolLabel(call.toolName) : 'Tool';
      const target = shortTarget(call.text);
      return target ? `${name} ${target}` : name;
    }
    if (r.type === 'thinking') return 'Thought';
    if (r.event.kind === 'assistant' && r.event.text?.trim()) return latestLine(r.event.text);
  }
  return null;
}

const FAMILY = /(?:^|[^a-z])(fable|opus|sonnet|haiku)(?:[^a-z]|$)/i;

/**
 * A model id as a short label: its family ("sonnet", "opus", "fable", "haiku"), else the id itself (what Claude Code reported, never a
 * guess). Null when no model was reported: the caller says "unavailable".
 */
export function modelShort(model: string | null | undefined): string | null {
  if (!model) return null;
  return FAMILY.exec(model)?.[1]?.toLowerCase() ?? model;
}

/** Whether a task is a sub-agent (which runs on a model), not a background command. */
export const isAgentTask = (t: Pick<ChatTask, 'subagentType' | 'model'>): boolean => !!t.subagentType || !!t.model;
