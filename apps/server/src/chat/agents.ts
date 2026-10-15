// Sessions that start and message sessions (chat-sessions PRD, multi-agent; Portal MCP I8): a session's Claude may start workers
// and talk to them, only through the portal. The portal decides who may: a session starts sessions only in its own workspace, only
// as deep as the setting allows, only so many at a time and so often, never in Bypass, and its workers answer to it. Every call is
// labelled with the actor that made it (`session:<id>`), every spawn and message is in both transcripts, and what a session can
// message is its parent, its children and its crew (the other workers of its parent, T-294), nobody else. These are shared settings,
// read through `agentCaps`.

import { AppError } from '@isnanme/core';
import type { ClaudeUsage, WorkspaceClaude } from '@portal/contracts';
import { unknownUsage } from '../autotransfer/decide.js';
import { recommendMove } from '../claudeusage/recommend.js';
import { defineSetting } from '../settings/registry.js';
import { SESSION_CAP } from './caps.js';

export const AGENT_DEPTH_SETTING = 'sessions.maxDepth';
export const AGENT_CHILDREN_SETTING = 'sessions.maxChildren';
export const AGENT_SPAWNS_SETTING = 'sessions.spawnsPerHour';
export const AGENT_MESSAGES_SETTING = 'sessions.messagesPerHour';

defineSetting({
  key: AGENT_DEPTH_SETTING,
  type: 'number',
  default: 1,
  min: 0,
  max: 4,
  scope: 'global',
  group: 'sessions',
  order: 40,
  label: 'Nesting depth',
  help: 'How many levels of sessions may start sessions. 1: a session a person started may start workers, and the workers may not. 0: sessions may not start sessions at all.',
});
defineSetting({
  key: AGENT_CHILDREN_SETTING,
  type: 'number',
  default: 5,
  min: 1,
  max: 20,
  scope: 'global',
  group: 'sessions',
  order: 50,
  label: 'Workers per session',
  help: 'How many sessions started by one session may be running at once. They also count against the running-session caps.',
});
defineSetting({
  key: AGENT_SPAWNS_SETTING,
  type: 'number',
  default: 20,
  min: 1,
  max: 200,
  scope: 'global',
  group: 'sessions',
  order: 60,
  label: 'Workers an hour',
  help: 'How many workers one session may start in an hour. Stops a looping or confused session from filling the portal with workers.',
});
defineSetting({
  key: AGENT_MESSAGES_SETTING,
  type: 'number',
  default: 60,
  min: 1,
  max: 600,
  scope: 'global',
  group: 'sessions',
  order: 70,
  label: 'Messages an hour',
  help: 'How many messages one session may send to its parent, its workers or its crew in an hour. Stops two sessions from answering each other forever.',
});

/** The limits on sessions starting and messaging sessions, read each time. */
export interface AgentCaps {
  maxDepth: number;
  maxChildren: number;
  spawnsPerHour: number;
  messagesPerHour: number;
}

const HOUR_MS = 3_600_000;

/**
 * T-294: how many workers a session may run at once: its own limit (`ChatSession.maxWorkers`) clamped to the global `sessions.maxChildren`,
 * or the global cap when it has none. The global settings stay the ceiling. Null only with no caps installed and no own limit: no limit.
 */
export function effectiveMaxWorkers(caps: Pick<AgentCaps, 'maxChildren'> | null | undefined, own: number | null | undefined): number | null {
  const mine = typeof own === 'number' && Number.isInteger(own) && own >= 0 ? own : null;
  if (!caps) return mine;
  return mine === null ? caps.maxChildren : Math.min(mine, caps.maxChildren);
}

/**
 * T-294: the Claude Code tools a session with sub-agents off is launched without (`--disallowedTools`): the sub-agent tool under both its
 * names, `Workflow` (a script that orchestrates sub-agents) and `RemoteTrigger` (starts remote agents). Verified with Claude Code 2.1.296
 * (docs/prd/evidence/t294-subagents-flag.md): none of the four is in `system/init`'s tools then. Known gap: `Skill` stays (skills are how
 * a session works), and a skill that runs in a forked context runs in a sub-agent.
 */
export const SUBAGENT_TOOLS = ['Agent', 'Task', 'Workflow', 'RemoteTrigger'] as const;

/**
 * Why a session may not start another, or null when it may. `parent` is the session that would start it, with its own limit on workers
 * (T-294: null for the global one, 0 for none). `caps` null: no global limits installed (tests); the session's own limit still holds.
 */
export function spawnProblem(
  caps: AgentCaps | null,
  parent: { id: string; depth: number; maxWorkers?: number | null },
  children: { state: string; createdAt: string }[],
  now = Date.now(),
): AppError | null {
  const refuse = (scope: string, message: string, limit: number) => new AppError(SESSION_CAP, message, { status: 409, details: { scope, limit } });
  if (caps && parent.depth + 1 > caps.maxDepth)
    return refuse(
      'depth',
      caps.maxDepth === 0 ? 'Sessions may not start sessions here (Settings › Sessions).' : `Sessions started by sessions may go ${caps.maxDepth} ${caps.maxDepth === 1 ? 'level' : 'levels'} deep, and this session is at that depth (Settings › Sessions).`,
      caps.maxDepth,
    );
  const own = effectiveMaxWorkers(null, parent.maxWorkers);
  if (own === 0) return refuse('session_workers', 'This session may not start workers: its own limit is 0 (a person or an admin sets it).', 0);
  const live = children.filter((c) => c.state !== 'ended').length;
  // Its own limit when that is the tighter one, named as its own; else the global one.
  if (own !== null && (!caps || own < caps.maxChildren) && live >= own)
    return refuse('session_workers', `This session already has ${live} workers running, which is its own limit. Wait for one to finish, or end one.`, own);
  if (caps && live >= caps.maxChildren) return refuse('children', `This session already has ${live} workers running, which is the limit (Settings › Sessions). Wait for one to finish, or end one.`, caps.maxChildren);
  const recent = children.filter((c) => Date.parse(c.createdAt) > now - HOUR_MS).length;
  if (caps && recent >= caps.spawnsPerHour) return refuse('rate', `This session has started ${recent} workers in the last hour, which is the limit (Settings › Sessions).`, caps.spawnsPerHour);
  return null;
}

/** T-294: the limits a worker asks for (`session_spawn`); absent fields take its parent's. */
export interface WorkerLimitsAsk {
  maxWorkers?: number;
  subagents?: boolean;
}

/**
 * T-294: a worker's limits, never wider than its parent's: `maxWorkers` at most the parent's effective value (its own clamped to the global
 * cap), and sub-agents on only when the parent has them. What is not asked is the parent's own (a null `maxWorkers` stays the global
 * setting). A wider ask is refused, naming the field, before anything is made.
 */
export function workerLimits(
  caps: Pick<AgentCaps, 'maxChildren'> | null | undefined,
  parent: { maxWorkers?: number | null; subagents?: boolean },
  ask: WorkerLimitsAsk = {},
): { maxWorkers: number | null; subagents: boolean } {
  const parentOn = parent.subagents !== false;
  const ceiling = effectiveMaxWorkers(caps, parent.maxWorkers);
  let maxWorkers = parent.maxWorkers ?? null;
  if (ask.maxWorkers !== undefined) {
    if (!Number.isInteger(ask.maxWorkers) || ask.maxWorkers < 0) throw new AppError('VALIDATION_FAILED', 'max_workers is a whole number, 0 or more.', { details: { max_workers: 'A whole number, 0 or more.' } });
    if (ceiling !== null && ask.maxWorkers > ceiling)
      throw new AppError('VALIDATION_FAILED', `A worker can run at most ${ceiling} workers of its own: your own limit.`, { details: { max_workers: `At most ${ceiling}.` } });
    maxWorkers = ask.maxWorkers;
  }
  if (ask.subagents === true && !parentOn) throw new AppError('VALIDATION_FAILED', 'You may not start sub-agents, so a worker of yours may not either.', { details: { subagents: 'Off, as yours.' } });
  return { maxWorkers, subagents: ask.subagents ?? parentOn };
}

/** A sliding hour of message times per sender, for the rate limit on messages between sessions. */
export class MessageRate {
  readonly #sent = new Map<string, number[]>();

  /**
   * Records `count` messages from `from` (a broadcast is one per recipient, T-294) and returns whether they all fit within `limit` an
   * hour. All or nothing: when they do not all fit, none is recorded.
   */
  allow(from: string, limit: number, now = Date.now(), count = 1): boolean {
    const recent = (this.#sent.get(from) ?? []).filter((t) => t > now - HOUR_MS);
    if (recent.length + count > limit) {
      this.#sent.set(from, recent);
      return false;
    }
    for (let i = 0; i < count; i++) recent.push(now);
    this.#sent.set(from, recent);
    return true;
  }

  forget(from: string): void {
    this.#sent.delete(from);
  }
}

/**
 * T-294: what a worker tells its lead without being asked (`session_spawn` `report`, migration 775): `idle` (the default) when its turn
 * ends, when it waits on a person and when it ends; `end` only when it ends; `none` nothing.
 */
export const WORKER_REPORTS = ['idle', 'end', 'none'] as const;
export type WorkerReport = (typeof WORKER_REPORTS)[number];

/**
 * Why a worker runs on the Claude it got (T-294): its parent's, the one it was told, one with room, its parent's for want of one, or (T-427)
 * with none that has room the least used now.
 */
export type SpawnClaudeWhy = 'parent' | 'named' | 'room' | 'no_room' | 'no_room_lowest' | 'usage_unknown';

/** What a worker may be told to run on: `same` (its parent's Claude, the default), `auto`, or a Claude's name or id. */
export const SPAWN_CLAUDE_HELP = 'same (your Claude, the default), auto (a Claude of this workspace with room by a fresh, measured reading, the least busy first; with none, the least used now), or a Claude’s name';

/** What the worker's Claude is chosen from (T-294). */
export interface SpawnPick {
  want: string | undefined;
  workspaceId: string;
  parentClaudeId: string;
  claudes: readonly Pick<WorkspaceClaude, 'id' | 'name' | 'removedAt'>[];
  /** The Claude usage report's rows, or null when it could not be read. */
  usage: readonly ClaudeUsage[] | null;
  /** The model family the worker will run (its asked model, else its parent's): a model window of that family counts. */
  family: string | null;
  /** The sessions on a Claude now that have not ended: a burst spreads over the Claudes with room. */
  load: (claudeId: string) => number;
  nowMs: number;
}

/**
 * T-294: the Claude a worker starts on. `same` (or nothing) is the parent's. `auto` takes the Claudes the Move ranking classes `room`
 * (every Claude of the workspace, the parent's included) whose reading is measured AND fresh by the auto-transfer's own test
 * (`unknownUsage`: a reading Claude Code could not give, no reset time, older than 15 minutes, or no window: unknown), that run on a
 * plan (never an API key or a pool, billed per use), and of those the one with the fewest live sessions, the ranking's order between
 * equals. With none, or with no usage report, the parent's, and why. A name (any case) or an id must be a Claude of the workspace on a
 * plan: one billed per use, or one whose plan can't be read now, is refused. The refusals never list the Claudes.
 */
export function pickSpawnClaude(p: SpawnPick): { claudeId: string; why: SpawnClaudeWhy } {
  const w = (p.want ?? '').trim();
  if (!w || w.toLowerCase() === 'same') return { claudeId: p.parentClaudeId, why: 'parent' };
  const live = p.claudes.filter((c) => !c.removedAt);
  const usageOf = (id: string) => p.usage?.find((u) => u.claudeId === id);
  if (w.toLowerCase() === 'auto') {
    if (!p.usage) return { claudeId: p.parentClaudeId, why: 'usage_unknown' };
    const ids = new Set(live.map((c) => c.id));
    const ranking = recommendMove([...p.usage], { workspaceId: p.workspaceId, from: null, nowMs: p.nowMs });
    const usable = (c: (typeof ranking.candidates)[number]) => {
      const u = usageOf(c.claudeId);
      return c.rank !== null && !c.stale && ids.has(c.claudeId) && u?.runsOn === 'plan' && unknownUsage(u, p.family, p.nowMs) === null;
    };
    const fit = ranking.candidates.filter((c) => usable(c) && c.reason === 'room' && c.basis === 'measured');
    if (!fit.length) {
      // T-427: none with room (most projected past 100 %): the least used NOW of those not at their limit, spread so that no Claude takes
      // more than its share of live sessions (ceil(live / Claudes) + 1); its parent's only when it is that one or there is none.
      const near = ranking.candidates.filter((c) => usable(c) && (c.reason === 'over_pace' || c.reason === 'tight') && c.leftPct.value !== null);
      if (!near.length) return { claudeId: p.parentClaudeId, why: 'no_room' };
      const share = Math.ceil((near.reduce((n, c) => n + p.load(c.claudeId), 0) + 1) / near.length) + 1;
      const under = near.filter((c) => p.load(c.claudeId) < share);
      const pool = under.length ? under : near;
      const best = [...pool].sort(
        (a, b) =>
          (b.leftPct.value ?? 0) - (a.leftPct.value ?? 0) ||
          p.load(a.claudeId) - p.load(b.claudeId) ||
          Number(b.claudeId === p.parentClaudeId) - Number(a.claudeId === p.parentClaudeId),
      )[0]!;
      return { claudeId: best.claudeId, why: best.claudeId === p.parentClaudeId ? 'no_room' : 'no_room_lowest' };
    }
    const best = fit.reduce((a, b) => (p.load(b.claudeId) < p.load(a.claudeId) ? b : a));
    return { claudeId: best.claudeId, why: best.claudeId === p.parentClaudeId ? 'parent' : 'room' };
  }
  const hit = live.find((c) => c.id === w || c.name.toLowerCase() === w.toLowerCase());
  if (!hit) throw new AppError('VALIDATION_FAILED', 'No such Claude on this workspace. Use same, auto or the name of one of its Claudes.', { details: { claude: 'Unknown Claude.' } });
  if (hit.id === p.parentClaudeId) return { claudeId: hit.id, why: 'parent' };
  const runsOn = usageOf(hit.id)?.runsOn;
  if (runsOn !== 'plan') {
    throw new AppError(
      'FORBIDDEN',
      runsOn === 'key' || runsOn === 'pool' ? 'A worker never runs on a Claude billed per use (an API key or a pool). Use same or auto.' : 'That Claude’s plan can’t be read now. Use same or auto, or name it again later.',
    );
  }
  return { claudeId: hit.id, why: 'named' };
}
