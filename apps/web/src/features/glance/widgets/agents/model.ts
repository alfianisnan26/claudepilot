import type { GlanceAgent } from '@portal/contracts';
import type { GlanceCompact, GlanceLevel } from '../../types';
import { chipCount, listWords, shortSpan } from '../shared/format';
import type { Readings } from '../shared/readings';
import { SESSION_WORD } from '../sessions/model';

// The Agents widget's logic, apart from React so it can be tested (docs/prd/glance-widgets.md §6.3).

/**
 * The chip: how many agents work (workers a session started, and sub-agents running inside sessions; a parent shown for context is not
 * one), amber while any of them waits for an answer.
 */
export function agentsCompact({ data, failed, stale }: Readings): GlanceCompact {
  if (!data) return failed ? { value: '-', level: 'unknown', title: 'Agents: not available', stale: true } : { value: null, level: 'unknown', title: 'Agents: loading', loading: true };
  const a = data.agents;
  if (!a.ok) return { value: '-', level: 'unknown', title: 'Agents: could not be read', stale };
  const level: GlanceLevel = a.waiting > 0 ? 'warn' : a.running > 0 ? 'ok' : 'idle';
  const title = `Agents: ${a.running ? listWords([`${a.running} running`, a.waiting ? `${a.waiting} waiting for you` : null]) : 'none running'}`;
  return { value: chipCount(a.running), level, title, stale };
}

/** A row's dot: going is green, waiting for an answer is amber, anything else is quiet. */
export const agentLevel = (r: GlanceAgent): GlanceLevel => (r.state === 'running' || r.state === 'working' || r.state === 'starting' ? 'ok' : r.state === 'waiting' ? 'warn' : 'idle');

/** A row's second line: what it is and how it stands (a task: its type and how long it has run). */
export function agentSubline(r: GlanceAgent, now: number): string {
  if (r.kind === 'task') return [r.role ?? 'Task', shortSpan(r.since, now)].filter(Boolean).join(' · ');
  const state = r.state === 'running' ? 'Running' : SESSION_WORD[r.state];
  return r.kind === 'worker' ? `Worker · ${state}` : state;
}

/** What Stop does on a row, or null when there is nothing to stop. The same calls the session page makes. */
export type StopCall = { kind: 'task'; sessionId: string; taskId: string } | { kind: 'turn'; sessionId: string };
export function stopCall(r: GlanceAgent): StopCall | null {
  if (!r.stoppable) return null;
  if (r.kind === 'task') return r.taskId ? { kind: 'task', sessionId: r.sessionId, taskId: r.taskId } : null;
  return { kind: 'turn', sessionId: r.sessionId };
}

/** The accessible name of a row's Stop: what stops. */
export const stopLabel = (r: GlanceAgent): string => (r.kind === 'task' ? `Stop ${r.title}` : `Stop the turn of ${r.title}`);

/** How long a stop that the portal accepted keeps its row's button away before offering it again (the Agents panel waits the same). */
export const STOP_GRACE_MS = 15_000;
