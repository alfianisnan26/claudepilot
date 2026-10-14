import { KEEPGOING_CAUSE_TEXT, workspaceLabel, type KeepGoingChat, type KeepGoingList } from '@portal/contracts';
import type { GlanceCompact, GlanceLevel } from '../../types';
import { chipCount, listWords, plural } from '../shared/format';

// The Autonomy widget and its Home card (T-259 slice 2, docs/prd/chat-sessions.md §23): the chats the portal keeps going, how each stands
// and what Keep going did last. Every figure comes from `GET /api/keepgoing` (the sweep's own trail and reports); nothing is guessed.

export const STATE_WORD: Record<KeepGoingChat['state'], string> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle',
  asleep: 'Asleep',
  waiting: 'Waiting',
  interrupted: 'Interrupted',
  ended: 'Ended',
};

export interface AutonomyRow {
  id: string;
  title: string;
  workspace: string;
  state: string;
  level: GlanceLevel;
  /** What stands (the causes reported), or else the last action's sentence; null when nothing happened yet. */
  what: string | null;
  at: string | null;
}

export interface AutonomyView {
  paused: boolean;
  watched: number;
  /** Chats left down (reported `down`). */
  down: number;
  /** Chats with another cause reported and standing (an approval waits, Bypass off, a cap, a wake that failed). */
  reported: number;
  /** Nudges and wakes in the last 24 hours, over every watched chat. */
  actions: number;
  rows: AutonomyRow[];
}

/** A chat's level: left down is critical, another cause standing or an ended chat a warning, a working one ok, else idle. */
export function rowLevel(c: KeepGoingChat): GlanceLevel {
  const standing = c.keepGoing.standing ?? [];
  if (standing.includes('down')) return 'critical';
  if (standing.length || c.state === 'ended' || c.state === 'interrupted') return 'warn';
  return c.state === 'working' || c.state === 'starting' ? 'ok' : 'idle';
}

export function autonomyView(list: KeepGoingList): AutonomyView {
  const rows = list.chats.map((c): AutonomyRow => {
    const standing = c.keepGoing.standing ?? [];
    const last = c.keepGoing.last;
    return {
      id: c.sessionId,
      title: c.title,
      workspace: workspaceLabel(c.workspaceId),
      state: STATE_WORD[c.state] ?? c.state,
      level: rowLevel(c),
      what: standing.length ? standing.map((s) => KEEPGOING_CAUSE_TEXT[s] ?? s).join(', ') : (last?.reason ?? null),
      at: last?.at ?? null,
    };
  });
  return {
    paused: list.paused,
    watched: list.chats.length,
    down: list.chats.filter((c) => c.keepGoing.standing?.includes('down')).length,
    reported: list.chats.filter((c) => (c.keepGoing.standing ?? []).some((s) => s !== 'down')).length,
    actions: list.chats.reduce((n, c) => n + c.keepGoing.nudgesToday + c.keepGoing.wakesToday, 0),
    rows,
  };
}

/** The chip: how many chats are kept going; red while one is left down, amber for another report or the pause, green while one is watched. */
export function autonomyCompact(v: AutonomyView | null, failed: boolean): GlanceCompact {
  if (!v) return failed ? { value: '-', level: 'unknown', title: 'Autonomy: not available', stale: true } : { value: null, level: 'unknown', title: 'Autonomy: loading', loading: true };
  const level: GlanceLevel = v.down ? 'critical' : v.reported || v.paused ? 'warn' : v.watched ? 'ok' : 'idle';
  const parts = listWords([v.paused ? 'paused' : null, v.down ? `${v.down} left down` : null, v.reported ? `${v.reported} reported` : null]);
  return { value: chipCount(v.watched), level, title: `Autonomy: ${v.watched ? plural(v.watched, 'chat') : 'no chats'} kept going${parts ? `, ${parts}` : ''}` };
}
