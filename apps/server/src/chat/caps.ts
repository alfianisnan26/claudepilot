// Concurrency caps for chat sessions (chat-sessions PRD FR39, Settings & policies FR13): how many Claude Code processes may be
// awake in one workspace and in the whole portal. A new session over a cap makes room by putting the longest-idle session to
// sleep (it wakes on its next message) and is refused, naming the cap and where it comes from, when nothing can sleep. Lowering a
// cap never stops a running session. An Ultracode session counts as two. These are shared settings, so the Settings page lists
// them; the controller reads them through `liveCaps`.

import { AppError, defineErrorCodes } from '@isnanme/core';
import { defineSetting } from '../settings/registry.js';

export const CAP_WORKSPACE_SETTING = 'sessions.maxLivePerWorkspace';
export const CAP_TOTAL_SETTING = 'sessions.maxLiveTotal';
export const SESSION_CAP = 'SESSION_CAP';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    SESSION_CAP: true;
  }
}
defineErrorCodes({ [SESSION_CAP]: { status: 409, message: 'Too many sessions are running.' } });

defineSetting({
  key: CAP_WORKSPACE_SETTING,
  type: 'number',
  default: 4,
  min: 1,
  max: 50,
  scope: 'global',
  group: 'sessions',
  order: 20,
  label: 'Sessions per workspace',
  help: 'How many chat sessions may have Claude Code running in one workspace. A new session over the cap puts the longest-idle one to sleep (it wakes on its next message); if none can sleep, it is refused. Ultracode counts as two. Lowering it never stops a running session.',
});

defineSetting({
  key: CAP_TOTAL_SETTING,
  type: 'number',
  default: 10,
  min: 1,
  max: 200,
  scope: 'global',
  group: 'sessions',
  order: 30,
  label: 'Sessions in total',
  help: 'How many chat sessions may have Claude Code running across all workspaces, so one busy workspace cannot starve the others or drain an account’s rate limit.',
});

/** The caps in force, read each time a session starts or wakes. */
export interface LiveCaps {
  perWorkspace: number;
  total: number;
}

/** What one session counts for: an Ultracode session runs many agents, so it counts as two. */
export const weightOf = (row: { ultracode: number }): number => (row.ultracode === 1 ? 2 : 1);

/**
 * Which sessions to put to sleep, longest-idle first, for a new one of `weight` to fit; null when even sleeping everything that
 * may sleep would not make room (the caller refuses). `live` is every awake session, `sleepable` the ones that may be put to sleep.
 */
export function makeRoom(
  live: { id: string; workspaceId: string; weight: number }[],
  sleepable: { id: string; since: number }[],
  workspaceId: string,
  weight: number,
  caps: LiveCaps,
): { sleep: string[] } | { refuse: { scope: 'workspace' | 'total'; limit: number; running: number } } {
  const asleep = new Set<string>();
  const counts = () => {
    let ws = 0;
    let all = 0;
    for (const s of live) {
      if (asleep.has(s.id)) continue;
      all += s.weight;
      if (s.workspaceId === workspaceId) ws += s.weight;
    }
    return { ws, all };
  };
  const byAge = [...sleepable].sort((a, b) => a.since - b.since);
  const where = new Map(live.map((s) => [s.id, s.workspaceId]));
  for (;;) {
    const { ws, all } = counts();
    const over: 'workspace' | 'total' | null = ws + weight > caps.perWorkspace ? 'workspace' : all + weight > caps.total ? 'total' : null;
    if (!over) return { sleep: [...asleep] };
    // The workspace's own cap is eased by one of that workspace's sessions; the total by the longest-idle anywhere.
    const victim = byAge.find((v) => !asleep.has(v.id) && (over === 'total' || where.get(v.id) === workspaceId));
    if (!victim) return { refuse: { scope: over, limit: over === 'workspace' ? caps.perWorkspace : caps.total, running: over === 'workspace' ? ws : all } };
    asleep.add(victim.id);
  }
}

/** The refusal: which cap, how many are running, and where the number comes from. */
export function capError(scope: 'workspace' | 'total', limit: number, running: number, workspaceId: string): AppError {
  const where = scope === 'workspace' ? `in ${workspaceId}` : 'in total';
  return new AppError(SESSION_CAP, `${running} ${running === 1 ? 'session is' : 'sessions are'} already running ${where}, which is the limit (Settings › Sessions). Wait for one to finish, or end one.`, {
    status: 409,
    details: { scope, limit, running, setting: scope === 'workspace' ? CAP_WORKSPACE_SETTING : CAP_TOTAL_SETTING },
  });
}

export const BUDGET_SETTING = 'sessions.budgetUsd';

defineSetting({
  key: BUDGET_SETTING,
  type: 'number',
  default: 10,
  min: 1,
  max: 1000,
  scope: 'global',
  group: 'sessions',
  order: 25,
  label: 'Spend limit per session',
  help: 'In US dollars: what one chat session on an account pool’s keys may spend before Claude Code stops it (an estimate from the keys’ prices). It applies to sessions that start or wake after the change; a session on a Claude’s own sign-in has its plan’s limits instead.',
});
