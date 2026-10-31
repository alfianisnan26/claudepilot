/*
 * What a tool call does, by its name: one kind per tool, shared by the portal's transcript (ToolRows picks its icon by kind) and the
 * reporter panel's chat (PILOT-1111: the same kinds, verbs and labels, with the panel's own inlined icons). No React, no icons: the embed
 * bundle imports this without pulling the app's icon chunk. The transcript's row model (calls joined to results, runs of read-only calls
 * folded) lives here too, for the same reason; ToolRows.tsx re-exports it.
 */

import type { ChatEvent } from '@portal/contracts';

export type ToolKind = 'read' | 'write' | 'run' | 'search' | 'list' | 'web' | 'agent' | 'todo' | 'mcp' | 'other';

export function toolKind(name: string | null | undefined): ToolKind {
  const tool = name ?? '';
  if (tool.startsWith('mcp__')) return 'mcp';
  switch (tool) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'run';
    case 'Read':
    case 'NotebookRead':
      return 'read';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'write';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'LS':
      return 'list';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Task':
    case 'Agent':
      return 'agent';
    case 'TodoWrite':
    case 'TodoRead':
      return 'todo';
    default:
      return 'other';
  }
}

/** "mcp__playwright__browser_take_screenshot" reads "playwright · browser_take_screenshot". */
export const toolLabel = (name: string) => (name.startsWith('mcp__') ? name.slice(5).split('__').filter(Boolean).join(' · ') : name);

/** A tool call and its result (null while it runs, or when the result never came). */
export interface ToolPair {
  call: ChatEvent;
  result: ChatEvent | null;
}

/** One line of the transcript: a stored event, a tool call with its result, a run of read-only calls, or thinking. */
export type TranscriptRow =
  | { type: 'event'; event: ChatEvent }
  | ({ type: 'tool' } & ToolPair)
  | { type: 'group'; tools: ToolPair[] }
  | { type: 'thinking'; event: ChatEvent };

/** Tools that only look: a run of two or more of them reads as one row (chat PRD FR5). */
const READ_ONLY = new Set(['Read', 'NotebookRead', 'Glob', 'LS', 'Grep', 'WebFetch', 'WebSearch', 'TodoRead']);
/**
 * Bash commands that plainly only look (Claude Code finds and searches files with Bash): a known
 * reading command with no redirect or chaining. Display only: a wrong guess just folds a row.
 */
const LOOK_COMMAND = /^(ls|cat|head|tail|grep|rg|find|wc|pwd|tree|stat|file|du|which|git (status|log|diff|show|branch))(\s|$)/;
const isReadOnly = (call: ChatEvent) =>
  READ_ONLY.has(call.toolName ?? '') || (call.toolName === 'Bash' && !!call.text && LOOK_COMMAND.test(call.text) && !/[;&>`]|\$\(/.test(call.text));

/** A path's last part ("MEMORY.md"), or a short head of anything else: what a one-line row shows. */
export function shortTarget(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  if (/^[~/]/.test(t) && !/\s/.test(t)) return t.split('/').filter(Boolean).pop() ?? t;
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

/**
 * The transcript's rows from its events. Each result joins its call (by the call's id; a result stored
 * without one joins the oldest open call from the same agent). A result with no call to join shows on
 * its own only when it returned images. With `group`, runs of two or more read-only calls from one agent
 * fold into one row; a call that failed or returned images stays out, because it shows open.
 */
export function buildRows(events: ChatEvent[], group: boolean): TranscriptRow[] {
  const callsById = new Map<string, ChatEvent>();
  const resultOf = new Map<number, ChatEvent>(); // call seq → its result
  const joined = new Set<number>(); // result seqs shown with their call
  const open = new Map<string, ChatEvent[]>(); // agent → its calls, in order
  for (const e of events) {
    const agent = e.agentLabel ?? '';
    if (e.kind === 'tool_use') {
      if (e.toolUseId) callsById.set(e.toolUseId, e);
      const calls = open.get(agent);
      if (calls) calls.push(e);
      else open.set(agent, [e]);
    } else if (e.kind === 'tool_result') {
      // Results stored before calls' ids were kept on them have none: they take the oldest open call.
      const call = e.toolUseId ? callsById.get(e.toolUseId) : open.get(agent)?.find((c) => !resultOf.has(c.seq));
      if (call && !resultOf.has(call.seq)) {
        resultOf.set(call.seq, e);
        joined.add(e.seq);
      }
    }
  }
  // Only results without an id scan an agent's calls, and only rows stored before ids were kept lack one.

  const rows: TranscriptRow[] = [];
  for (const e of events) {
    if (e.kind === 'tool_use') rows.push({ type: 'tool', call: e, result: resultOf.get(e.seq) ?? null });
    else if (e.kind === 'tool_result') {
      if (!joined.has(e.seq) && e.images?.length) rows.push({ type: 'event', event: e });
    } else if (e.kind === 'thinking') rows.push({ type: 'thinking', event: e });
    else if (e.kind !== 'request') rows.push({ type: 'event', event: e }); // requests drive the approvals dock
  }
  if (!group) return rows;

  const out: TranscriptRow[] = [];
  let run: ToolPair[] = [];
  let runAgent: string | null = null;
  const flush = () => {
    if (run.length >= 2) out.push({ type: 'group', tools: run });
    else for (const t of run) out.push({ type: 'tool', ...t });
    run = [];
  };
  for (const r of rows) {
    const groupable = r.type === 'tool' && isReadOnly(r.call) && !r.result?.isError && !r.result?.images?.length;
    if (!groupable) {
      flush();
      out.push(r);
      continue;
    }
    const agent = r.call.agentLabel ?? null;
    if (run.length && agent !== runAgent) flush();
    if (!run.length) runAgent = agent;
    run.push({ call: r.call, result: r.result });
  }
  flush();
  return out;
}

/** "3 files read · 2 searches": what a run of read-only calls did. */
const NOUNS: Record<string, [string, string]> = {
  Read: ['file read', 'files read'],
  NotebookRead: ['notebook read', 'notebooks read'],
  Glob: ['listing', 'listings'],
  LS: ['listing', 'listings'],
  Grep: ['search', 'searches'],
  WebFetch: ['page fetched', 'pages fetched'],
  WebSearch: ['web search', 'web searches'],
  TodoRead: ['to-do check', 'to-do checks'],
  Bash: ['command', 'commands'],
};
export function groupLabel(tools: ToolPair[]): string {
  const counts = new Map<string, number>();
  for (const { call } of tools) {
    const noun = NOUNS[call.toolName ?? '']?.join('|') ?? 'step|steps';
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  return [...counts].map(([noun, n]) => `${n} ${noun.split('|')[n === 1 ? 0 : 1]}`).join(' · ');
}

/** "12 s", "2 min 5 s". */
export function formatSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}
