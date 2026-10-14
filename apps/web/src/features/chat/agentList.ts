// The Agents panel's list as data (ticket T-149): each task's short label and its one line, the groups (running agents, running commands,
// failed, done), the counts the filter chips show, and what a filter and a search keep. Pure, so it is tested alone; AgentsPanel draws it.
import type { ChatEvent, ChatTask } from '@portal/contracts';
import { isAgentTask } from './agentFold';
import { commandLabel, looksLikeCommand } from './commandLabel';
import { visibly } from './shellTokens';

export type StatusFilter = 'running' | 'failed' | 'done';
export type KindFilter = 'agents' | 'commands';
export interface ListFilter {
  status: StatusFilter | null;
  kind: KindFilter | null;
  /** What the search field holds (matched without regard to case). */
  query: string;
}
export const NO_FILTER: ListFilter = { status: null, kind: null, query: '' };

/** How many done rows show at first, and how many more each "Show more" adds. */
export const DONE_PAGE = 10;

/** The command a background command's call runs, as the portal kept it (redacted, disguising characters escaped), or null. */
export function callCommand(call: ChatEvent | undefined): { text: string; cut: boolean } | null {
  if (!call || call.kind !== 'tool_use') return null;
  const command = call.toolInput?.command;
  if (typeof command === 'string' && command.trim()) return { text: command, cut: !!call.toolInputCut };
  return call.toolName === 'Bash' && call.text?.trim() ? { text: call.text, cut: false } : null;
}

/**
 * Whether a command task's description is the command line itself. Claude Code names a background command's task by the call's own
 * `description` when Claude gave one, else by its whole command line (observed with 2.1.296); the portal keeps 200 characters of it.
 */
export function namedByCommand(description: string, command: string | null): boolean {
  const d = description.trim();
  if (!d) return true;
  if (command === null) return looksLikeCommand(d);
  const c = command.trim();
  if (d === c || visibly(d) === c) return true;
  return d.endsWith('…') && c.startsWith(visibly(d.slice(0, -1)));
}

/**
 * A task's label, one short line: a sub-agent's description; a command's own description when Claude gave one, else a label made from
 * its command (`node test: imageBuild.test.ts`), never the whole command line. Disguising characters shown (`⟦U+202E⟧`).
 */
export function taskLabel(t: ChatTask, command: string | null): string {
  if (isAgentTask(t)) return visibly(t.description || t.subagentType || 'Agent');
  if (!namedByCommand(t.description, command)) return visibly(t.description.trim());
  const source = command ?? t.description;
  return commandLabel(source) || visibly(t.description.trim()) || 'Command';
}

/** The exit code a finished background command reported ("… failed with exit code 3"), or null. */
export function exitCode(summary: string | null | undefined): number | null {
  const m = /\bexit code (-?\d+)\b/i.exec(summary ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * What Claude Code says about an exit code it does not count as a failure: `completed (exit code 1: No matches found)` (grep finding
 * nothing). Null when it says nothing.
 */
export function exitNote(summary: string | null | undefined): string | null {
  return /\bexit code -?\d+: ([^)\n]{1,80})\)/i.exec(summary ?? '')?.[1]?.trim() || null;
}

/** The first line of a result that says something, without Markdown's heading, list and emphasis marks. */
export function firstLine(text: string | null | undefined): string | null {
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, '').replace(/\*\*|__|`/g, '').trim();
    if (line) return line;
  }
  return null;
}

export type LineTone = 'live' | 'muted' | 'danger' | 'warn';
/** A row's second line: a lead (what it is doing, or how it ended) and, for a command, its command line in the code font. */
export interface TaskLine {
  lead: string | null;
  tone: LineTone;
  /** A command's command line on one line, when it says more than the label. */
  code: string | null;
}

const oneLine = (s: string) => visibly(s.replace(/\s+/g, ' ').trim());

/**
 * A row's second line. A running agent: what it does now (`latest`), else "Starting". A finished one: its result's first line; failed,
 * its error; stopped, "Stopped". A command: running, its command line; finished, its exit code then its command line. Nothing the label
 * already says is printed again.
 */
export function taskLine(t: ChatTask, label: string, command: string | null, latest: string | null): TaskLine {
  const same = (s: string | null) => (s !== null && s.trim() === label.trim() ? null : s);
  if (isAgentTask(t)) {
    if (t.status === 'running') return { lead: same(latest ? visibly(latest) : null) ?? 'Starting', tone: 'live', code: null };
    if (t.status === 'killed') return { lead: 'Stopped', tone: 'warn', code: null };
    const first = firstLine(t.summary);
    const result = same(first === null ? null : visibly(first));
    if (t.status === 'failed') return { lead: result ?? 'Failed', tone: 'danger', code: null };
    return { lead: result ?? 'Done', tone: 'muted', code: null };
  }
  const code = command ?? (looksLikeCommand(t.description) ? t.description : null);
  const shown = code !== null ? same(oneLine(code)) : null;
  const exit = exitCode(t.summary);
  if (t.status === 'running') return { lead: shown ? null : 'Running', tone: 'live', code: shown };
  if (t.status === 'killed') return { lead: 'Stopped', tone: 'warn', code: shown };
  // `exit 3` that ended with exit code 3 says Failed, not its label again.
  if (t.status === 'failed') return { lead: (exit !== null && same(`exit ${exit}`)) || 'Failed', tone: 'danger', code: shown };
  // Done is Claude Code's call: an exit code it does not count as a failure (grep that found nothing) reads with its reason, not in red.
  const note = exitNote(t.summary);
  return { lead: (exit !== null && same(`exit ${exit}${note ? `: ${note}` : ''}`)) || 'Done', tone: 'muted', code: shown };
}

export interface Counts {
  running: number;
  /** Failed or stopped: work that did not finish. */
  failed: number;
  done: number;
  agents: number;
  commands: number;
}

/** One task per id (the last one seen wins), in the order given. */
export function uniqueTasks(tasks: readonly ChatTask[]): ChatTask[] {
  const byId = new Map<string, ChatTask>();
  for (const t of tasks) byId.set(t.taskId, t);
  return [...byId.values()];
}

/** The counts the chips show: by status (running, failed or stopped, done) and by kind (sub-agents, commands); each adds up to all. */
export function countTasks(tasks: readonly ChatTask[]): Counts {
  const c: Counts = { running: 0, failed: 0, done: 0, agents: 0, commands: 0 };
  for (const t of uniqueTasks(tasks)) {
    if (t.status === 'running') c.running++;
    else if (t.status === 'completed') c.done++;
    else c.failed++;
    if (isAgentTask(t)) c.agents++;
    else c.commands++;
  }
  return c;
}

export interface Groups {
  /** Sub-agents that run, oldest first (a new one joins at the end: the rows above hold still). */
  agents: ChatTask[];
  /** Background commands that run, oldest first. */
  commands: ChatTask[];
  /** Failed or stopped, newest first: never folded away. */
  failed: ChatTask[];
  /** Done, newest first (the panel folds this group). */
  done: ChatTask[];
}

const started = (t: ChatTask) => Date.parse(t.startedAt) || 0;
const ended = (t: ChatTask) => (t.endedAt ? Date.parse(t.endedAt) : Number.NaN) || started(t);
const oldestFirst = (a: ChatTask, b: ChatTask) => started(a) - started(b) || a.taskId.localeCompare(b.taskId);
const newestFirst = (a: ChatTask, b: ChatTask) => ended(b) - ended(a) || b.taskId.localeCompare(a.taskId);

/**
 * The groups after a filter: a status chip keeps its group(s) only, a kind chip its kind in every group, and a search the tasks whose
 * text (`haystack`: label, description, type, model, command, result) holds it. A failed or stopped task is only ever in `failed`.
 */
export function groupTasks(tasks: readonly ChatTask[], filter: ListFilter, haystack: (t: ChatTask) => string): Groups {
  const q = filter.query.trim().toLowerCase();
  const g: Groups = { agents: [], commands: [], failed: [], done: [] };
  for (const t of uniqueTasks(tasks)) {
    const agent = isAgentTask(t);
    if (filter.kind === 'agents' && !agent) continue;
    if (filter.kind === 'commands' && agent) continue;
    const status: StatusFilter = t.status === 'running' ? 'running' : t.status === 'completed' ? 'done' : 'failed';
    if (filter.status && filter.status !== status) continue;
    if (q && !haystack(t).toLowerCase().includes(q)) continue;
    if (status === 'running') (agent ? g.agents : g.commands).push(t);
    else if (status === 'failed') g.failed.push(t);
    else g.done.push(t);
  }
  g.agents.sort(oldestFirst);
  g.commands.sort(oldestFirst);
  g.failed.sort(newestFirst);
  g.done.sort(newestFirst);
  return g;
}

/** A sub-agent's ticket when its description names one (`T-149 slice 1: …`): the first `T-<n>`. */
export function ticketOf(text: string | null | undefined): string | null {
  return /(?<![A-Za-z0-9-])T-(\d{1,6})(?![0-9])/.exec(text ?? '')?.[0] ?? null;
}
