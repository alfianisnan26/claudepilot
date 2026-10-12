import type { ChatSessionState, GlanceSession } from '@portal/contracts';
import { workspaceLabel } from '@portal/contracts';
import type { GlanceCompact, GlanceLevel } from '../../types';
import { chipCount, listWords, plural } from '../shared/format';
import type { Readings } from '../shared/readings';

// The Sessions widget's logic, apart from React so it can be tested (docs/prd/glance-widgets.md §6.2).

/** The chip: how many sessions are running, a dot that says whether any waits for you, and the state in words. */
export function sessionsCompact({ data, failed, stale }: Readings): GlanceCompact {
  if (!data) return failed ? { value: '-', level: 'unknown', title: 'Sessions: not available', stale: true } : { value: null, level: 'unknown', title: 'Sessions: loading', loading: true };
  const s = data.sessions;
  if (!s.ok) return { value: '-', level: 'unknown', title: 'Sessions: could not be read', stale };
  const level: GlanceLevel = s.waiting > 0 ? 'warn' : s.running > 0 ? 'ok' : 'idle';
  const parts = [s.running ? `${s.running} running` : null, s.waiting ? `${s.waiting} waiting for you` : null];
  const title = `Sessions: ${listWords(parts) || 'none running'}, ${s.open} open`;
  return { value: chipCount(s.running), level, title, stale };
}

/** The state a row's dot shows: waiting and interrupted ask for you, working and starting are going, the rest is quiet. */
export const sessionLevel = (state: ChatSessionState): GlanceLevel =>
  state === 'waiting' || state === 'interrupted' ? 'warn' : state === 'working' || state === 'starting' ? 'ok' : 'idle';

/** What the state is called in a row. */
export const SESSION_WORD: Record<ChatSessionState, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs you',
  interrupted: 'Interrupted',
  ended: 'Ended',
};

/**
 * A row's second line: what a waiting session asks, else the state, the Claude and the workspace. The workspace says where it runs,
 * so it is the one thing a short title cannot.
 */
export function sessionSubline(s: GlanceSession): { state: string; rest: string } {
  const state = SESSION_WORD[s.state];
  if (s.state === 'waiting' && s.waitingFor) return { state, rest: s.waitingFor };
  return { state, rest: [s.claudeName, workspaceLabel(s.workspaceId)].filter(Boolean).join(' · ') };
}

/** The row's tooltip and accessible detail: the plain sentence. */
export function sessionTitle(s: GlanceSession): string {
  const base = `${s.title}: ${SESSION_WORD[s.state].toLowerCase()}`;
  return s.waiting > 0 ? `${base}, ${plural(s.waiting, 'request')} waiting` : base;
}
