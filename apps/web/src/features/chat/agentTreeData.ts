// T-1710: the Agents tree (the owner's reference, docs/design/agent-tree-reference.png): a lead with its workers (`parentId`) and their
// workers, as connected cards with a status, the task, cost and time. This module is the data: which trees there are, what each card
// says, the header's counts, the failed list and the person's Dismiss (kept in this browser). Pure, so the rules are tested
// (agentTreeData.test.ts); AgentTree.tsx draws it.
import { CHAT_ENDED_CREDENTIAL, CHAT_ENDED_INTEGRITY, matchesQuery, sessionCost, type ChatSession } from '@portal/contracts';
import { bySpawn } from './crew';
import { cap, modelShortName } from './modelName';

/**
 * A card's status. `failed`: interrupted, or ended for a safety, integrity or error stop. `done`: ended any other way. `waiting`: a request
 * waits on a person. `running`: a turn or a task of it runs. `asleep`: its process stopped after idling (it wakes on a message). `idle`: alive
 * and quiet (its turn is over; a worker that reported and waits for its lead's next word). Idle is said as it is, never shown as Done.
 */
export type AgentStatus = 'running' | 'waiting' | 'failed' | 'done' | 'asleep' | 'idle';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  failed: 'Failed',
  done: 'Done',
  asleep: 'Asleep',
  idle: 'Idle',
};

/** An ending that reads as an error (not a person closing it). */
const ERROR_ENDING = /\b(error|errored|failed|failure|crash(ed)?)\b/i;

export function agentStatus(s: ChatSession): AgentStatus {
  if (s.state === 'interrupted') return 'failed';
  if (s.state === 'ended') {
    const why = s.endedReason ?? '';
    return why.startsWith(CHAT_ENDED_CREDENTIAL) || why.startsWith(CHAT_ENDED_INTEGRITY) || ERROR_ENDING.test(why) ? 'failed' : 'done';
  }
  if (s.waiting > 0 || s.state === 'waiting') return 'waiting';
  if (s.state === 'working' || s.state === 'starting' || (s.agentsRunning ?? 0) > 0) return 'running';
  if (s.process === 'asleep') return 'asleep';
  return 'idle';
}

/** How a failed agent can be retried from the tree: `recover` (an integrity ending, in place), `resume` (a short message wakes it), or not at all. */
export type RetryKind = 'recover' | 'resume' | null;

export function retryKind(s: ChatSession): RetryKind {
  if (s.state === 'interrupted') return 'resume';
  if (s.state === 'ended' && (s.endedReason ?? '').startsWith(CHAT_ENDED_INTEGRITY)) return 'recover';
  return null; // ended for credentials or an error: the session page says what to do
}

/** The message a Retry sends to an interrupted agent (it resumes the conversation, then reads this). */
export const RESUME_MESSAGE = 'Resume where you left off and finish the task.';

export interface AgentNode {
  session: ChatSession;
  /** Its role (`claude --agent <name>`) when it has one, else its title. */
  name: string;
  /** "Opus 5.5", or null before the first report. */
  model: string | null;
  status: AgentStatus;
  /** What it works on: the title when the name is its role, else null (the name already says it). */
  task: string | null;
  costUsd: number;
  /** From its start to now (still going) or to its last activity. */
  elapsedMs: number;
  children: AgentNode[];
  /** Every agent under it, however deep. */
  descendants: number;
}

export interface AgentTreeData {
  root: AgentNode;
  /** Agents in the tree, the lead included. */
  total: number;
  running: number;
  /** Failed agents the person has not dismissed, in reading order. */
  failed: AgentNode[];
  costUsd: number;
}

/** Still going: the clock runs to now. */
const going = (st: AgentStatus) => st === 'running' || st === 'waiting';

function nodeOf(s: ChatSession, kids: Map<string, ChatSession[]>, now: number, seen: Set<string>): AgentNode {
  seen.add(s.id);
  const children = (kids.get(s.id) ?? []).filter((c) => !seen.has(c.id)).map((c) => nodeOf(c, kids, now, seen));
  const status = agentStatus(s);
  const role = s.agent?.trim();
  const born = Date.parse(s.createdAt);
  const end = going(status) ? now : Date.parse(s.lastActivityAt);
  return {
    session: s,
    name: role ? cap(role) : s.title || 'Untitled',
    model: modelShortName(s.model),
    status,
    task: role ? s.title || null : null,
    costUsd: sessionCost(s).usd,
    elapsedMs: Number.isFinite(born) && Number.isFinite(end) ? Math.max(0, end - born) : 0,
    children,
    descendants: children.reduce((n, c) => n + 1 + c.descendants, 0),
  };
}

/** Every node, the lead first, in reading order (depth first, workers in spawn order). */
export function flatten(n: AgentNode): AgentNode[] {
  return [n, ...n.children.flatMap(flatten)];
}

/**
 * The trees in a list of sessions: each lead (a session with no lead in the list) that started at least one worker, with its workers and
 * theirs, in spawn order. Archived sessions are left out. Trees are ordered by their lead's start, newest first, so a tree holds still while
 * its agents work (QA A9). `query` keeps the trees with an agent that matches it. `dismissed` takes a failed agent out of the failed list.
 */
export function buildAgentTrees(
  sessions: readonly ChatSession[],
  opts: { now?: number; query?: string; dismissed?: (s: ChatSession) => boolean } = {},
): AgentTreeData[] {
  const now = opts.now ?? Date.now();
  const open = sessions.filter((s) => !s.archivedAt);
  const byId = new Map(open.map((s) => [s.id, s]));
  const kids = new Map<string, ChatSession[]>();
  for (const s of open) {
    if (s.parentId && s.parentId !== s.id && byId.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  }
  for (const list of kids.values()) list.sort(bySpawn);
  const roots = open.filter((s) => !(s.parentId && s.parentId !== s.id && byId.has(s.parentId)) && kids.has(s.id));
  roots.sort((a, b) => bySpawn(b, a));
  const seen = new Set<string>();
  const query = opts.query?.trim() ?? '';
  return roots
    .map((r) => nodeOf(r, kids, now, seen))
    .filter((root) => !query || flatten(root).some((n) => matchesQuery(n.session, query)))
    .map((root) => {
      const all = flatten(root);
      return {
        root,
        total: all.length,
        running: all.filter((n) => n.status === 'running').length,
        failed: all.filter((n) => n.status === 'failed' && !opts.dismissed?.(n.session)),
        costUsd: all.reduce((sum, n) => sum + n.costUsd, 0),
      };
    });
}

/** "42s", "1m 06s", "2h 05m". */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}

/** "$1.52", "$0.04", "$0.003". */
export const costLabel = (usd: number): string => `$${usd.toFixed(usd > 0 && usd < 0.01 ? 3 : 2)}`;

/** T-1825: a cost in two parts, so the cents read quieter than the dollars: "$1.52" → "$1" and ".52". */
export function costParts(usd: number): { whole: string; fraction: string } {
  const label = costLabel(usd);
  const dot = label.indexOf('.');
  return dot < 0 ? { whole: label, fraction: '' } : { whole: label.slice(0, dot), fraction: label.slice(dot) };
}

/** T-1825: who makes a card's model, for its glyph. */
export type ModelMaker = 'claude' | 'openai' | 'gemini' | 'ollama' | 'other';

/**
 * Read from the model id Claude Code reported (a gateway can route Claude Code to other models): a Claude family or id, an OpenAI one
 * (`gpt-…`, `o3`, `o4-mini`), a Gemini one, a model served by Ollama (`ollama/…`), `other` for an id it cannot place, null before
 * the first report. Never a guess beyond the id.
 */
export function modelMaker(model: string | null | undefined): ModelMaker | null {
  const v = model?.trim().toLowerCase();
  if (!v) return null;
  if (/\b(claude|fable|opus|sonnet|haiku)\b/.test(v) || v.includes('claude-')) return 'claude';
  if (/(^|[/.:])(gpt-|chatgpt|o[1-9](-|$)|openai)/.test(v)) return 'openai';
  if (/gemini/.test(v)) return 'gemini';
  if (v.includes('ollama')) return 'ollama';
  return 'other';
}

/**
 * T-1825: the icons on a card, each a fact of the session (never a guess): `branch` (it works in its own worktree), `bypass` (Bypass is on).
 * The session carries no list of its tools or MCP servers, so none is drawn.
 */
export type AgentFacet = 'branch' | 'bypass';

export function agentFacets(s: Pick<ChatSession, 'worktree' | 'mode'>): AgentFacet[] {
  const out: AgentFacet[] = [];
  if (s.worktree) out.push('branch');
  if (s.mode === 'bypassPermissions') out.push('bypass');
  return out;
}

/** T-1825: which edges of a sideways scroller have more to see (the edge fade), with a pixel of slack for sub-pixel scroll positions. */
export function edgeFade(scrollLeft: number, scrollWidth: number, clientWidth: number): { left: boolean; right: boolean } {
  if (scrollWidth - clientWidth <= 1) return { left: false, right: false };
  return { left: scrollLeft > 1, right: scrollLeft + clientWidth < scrollWidth - 1 };
}

/* ---------- T-1853: the filter: by default the agents at work and the leads above them; the rest folds behind a count ---------- */

/** `active`: running or waiting on a person. `waiting`: only those waiting. `all`: every agent. */
export type TreeFilter = 'active' | 'waiting' | 'all';
export const TREE_FILTERS: readonly TreeFilter[] = ['active', 'waiting', 'all'];
export const FILTER_KEY = 'claudepilot.agent-tree.filter';

const shows = (f: TreeFilter, st: AgentStatus) => f === 'all' || st === 'waiting' || (f === 'active' && st === 'running');

/** What a filter folds away, by kind: `idle` (idle or asleep), `ended` (done or failed), `running` (hidden by Waiting). */
export interface Folded {
  idle: number;
  ended: number;
  running: number;
}

/**
 * The tree as the filter shows it: an agent stays when it matches or has an agent under it that does (its leads stay, so a worker is never
 * shown without the line to its lead); the tree's lead always stays. `descendants` counts what is shown. `folded` counts the rest.
 */
export function filterTree(root: AgentNode, filter: TreeFilter): { root: AgentNode; folded: Folded } {
  const prune = (n: AgentNode, top: boolean): AgentNode | null => {
    const children = n.children.map((c) => prune(c, false)).filter((c): c is AgentNode => c !== null);
    if (!top && !shows(filter, n.status) && children.length === 0) return null;
    const same = children.length === n.children.length && children.every((c, i) => c === n.children[i]);
    return same ? n : { ...n, children, descendants: children.reduce((k, c) => k + 1 + c.descendants, 0) };
  };
  const shown = prune(root, true)!;
  const kept = new Set(flatten(shown).map((n) => n.session.id));
  const folded: Folded = { idle: 0, ended: 0, running: 0 };
  for (const n of flatten(root)) {
    if (kept.has(n.session.id)) continue;
    if (n.status === 'done' || n.status === 'failed') folded.ended++;
    else if (n.status === 'running' || n.status === 'waiting') folded.running++;
    else folded.idle++;
  }
  return { root: shown, folded };
}

/** "+5 idle · 3 ended", or null when nothing is folded. */
export function foldedLabel(f: Folded): string | null {
  const parts = [f.running && `${f.running} running`, f.idle && `${f.idle} idle`, f.ended && `${f.ended} ended`].filter(Boolean);
  return parts.length ? `+${parts.join(' · ')}` : null;
}

/** The viewer's filter (this browser), `active` when none is kept or storage cannot be read. */
export function readFilter(store: Store | null = defaultStore()): TreeFilter {
  try {
    const v = store?.getItem(FILTER_KEY);
    return TREE_FILTERS.includes(v as TreeFilter) ? (v as TreeFilter) : 'active';
  } catch {
    return 'active';
  }
}

export function writeFilter(f: TreeFilter, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(FILTER_KEY, f);
  } catch {
    // private window or blocked storage: this visit only
  }
}

/* ---------- Dismiss: hide a failed agent from the failed count, for this viewer (this browser) ---------- */

export const DISMISS_KEY = 'claudepilot.agent-tree.dismissed';
/** At most this many dismissals are kept (the oldest go first). */
export const DISMISS_MAX = 200;

/** What a dismissal holds to: the failure as it was. A new failure of the same agent (after a Retry) counts again. */
export const failureMark = (s: Pick<ChatSession, 'state' | 'endedReason'>): string => `${s.state}:${s.endedReason ?? ''}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStore = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The dismissals (agent id → its failure mark); empty when storage cannot be read (a private window, blocked site data). */
export function readDismissed(store: Store | null = defaultStore()): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(store?.getItem(DISMISS_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

/** Dismisses one failed agent; returns the dismissals now in effect (kept in memory when storage cannot be written). */
export function dismissFailed(
  s: Pick<ChatSession, 'id' | 'state' | 'endedReason'>,
  current: Record<string, string>,
  store: Store | null = defaultStore(),
): Record<string, string> {
  const rest = Object.entries(current).filter(([id]) => id !== s.id);
  const next = Object.fromEntries([...rest.slice(Math.max(0, rest.length - DISMISS_MAX + 1)), [s.id, failureMark(s)]]);
  try {
    store?.setItem(DISMISS_KEY, JSON.stringify(next));
  } catch {
    // private window or full storage: dismissed for this visit only
  }
  return next;
}

/** Whether a dismissal still holds for the agent: it is the same failure that was dismissed. */
export const isDismissed = (dismissed: Record<string, string>, s: Pick<ChatSession, 'id' | 'state' | 'endedReason'>): boolean =>
  dismissed[s.id] === failureMark(s);
