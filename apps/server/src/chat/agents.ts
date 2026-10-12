// Sessions that start and message sessions (chat-sessions PRD, multi-agent; Portal MCP I8): a session's Claude may start workers
// and talk to them, only through the portal. The portal decides who may: a session starts sessions only in its own workspace, only
// as deep as the setting allows, only so many at a time and so often, never in Bypass, and its workers answer to it. Every call is
// labelled with the actor that made it (`session:<id>`), every spawn and message is in both transcripts, and what a session can
// message is its parent and its children, nobody else. These are shared settings, read through `agentCaps`.

import { AppError } from '@isnanme/core';
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
  help: 'How many messages one session may send to its workers or its parent in an hour. Stops two sessions from answering each other forever.',
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
