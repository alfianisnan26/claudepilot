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

/** Why a session may not start another, or null when it may. `parent` is the session that would start it. */
export function spawnProblem(
  caps: AgentCaps,
  parent: { id: string; depth: number },
  children: { state: string; createdAt: string }[],
  now = Date.now(),
): AppError | null {
  const refuse = (scope: string, message: string, limit: number) => new AppError(SESSION_CAP, message, { status: 409, details: { scope, limit } });
  if (parent.depth + 1 > caps.maxDepth)
    return refuse(
      'depth',
      caps.maxDepth === 0 ? 'Sessions may not start sessions here (Settings › Sessions).' : `Sessions started by sessions may go ${caps.maxDepth} ${caps.maxDepth === 1 ? 'level' : 'levels'} deep, and this session is at that depth (Settings › Sessions).`,
      caps.maxDepth,
    );
  const live = children.filter((c) => c.state !== 'ended').length;
  if (live >= caps.maxChildren) return refuse('children', `This session already has ${live} workers running, which is the limit (Settings › Sessions). Wait for one to finish, or end one.`, caps.maxChildren);
  const recent = children.filter((c) => Date.parse(c.createdAt) > now - HOUR_MS).length;
  if (recent >= caps.spawnsPerHour) return refuse('rate', `This session has started ${recent} workers in the last hour, which is the limit (Settings › Sessions).`, caps.spawnsPerHour);
  return null;
}

/** A sliding hour of message times per sender, for the rate limit on messages between sessions. */
export class MessageRate {
  readonly #sent = new Map<string, number[]>();

  /** Records a message from `from` and returns whether it is within `limit` an hour. */
  allow(from: string, limit: number, now = Date.now()): boolean {
    const recent = (this.#sent.get(from) ?? []).filter((t) => t > now - HOUR_MS);
    if (recent.length >= limit) {
      this.#sent.set(from, recent);
      return false;
    }
    recent.push(now);
    this.#sent.set(from, recent);
    return true;
  }

  forget(from: string): void {
    this.#sent.delete(from);
  }
}

/** Why a worker runs on the Claude it got (T-294): its parent's, the one it was told, one with room, or its parent's for want of one. */
export type SpawnClaudeWhy = 'parent' | 'named' | 'room' | 'no_room' | 'usage_unknown';

/** What a worker may be told to run on: `same` (its parent's Claude, the default), `auto`, or a Claude's name or id. */
export const SPAWN_CLAUDE_HELP = 'same (your Claude, the default), auto (a Claude of this workspace with room by a fresh, measured reading, the least busy first), or a Claude’s name';

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
    const fit = ranking.candidates.filter((c) => {
      const u = usageOf(c.claudeId);
      return c.rank !== null && c.reason === 'room' && c.basis === 'measured' && !c.stale && ids.has(c.claudeId) && u?.runsOn === 'plan' && unknownUsage(u, p.family, p.nowMs) === null;
    });
    if (!fit.length) return { claudeId: p.parentClaudeId, why: 'no_room' };
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
