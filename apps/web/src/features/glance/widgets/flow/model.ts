import type { FlowAction, FlowSnapshot } from '@portal/contracts';
import type { GlanceCompact, GlanceLevel } from '../../types';

// The Flow card's figures (T-1966), pure: the five counts summed over the programs that ran, and the newest actions.

export interface FlowView {
  enabled: boolean;
  /** Null: no program could be read in the last round (shown as "-", never a guessed zero). */
  merge: number | null;
  qa: number | null;
  idle: number | null;
  bypass: number | null;
  stalled: number | null;
  inReview: number | null;
  lastRunAt: string | null;
  actions: FlowAction[];
}

export function flowView(s: FlowSnapshot): FlowView {
  const ran = s.programs.filter((p) => p.enabled && p.ok);
  const sum = (f: (p: (typeof ran)[number]) => number) => (ran.length ? ran.reduce((a, p) => a + f(p), 0) : null);
  return {
    enabled: s.enabled,
    merge: sum((p) => p.counts.merge),
    qa: sum((p) => p.counts.qa),
    idle: sum((p) => p.counts.idle),
    bypass: sum((p) => p.counts.bypass),
    stalled: sum((p) => p.counts.stall),
    inReview: sum((p) => p.inReview),
    lastRunAt: s.lastRunAt,
    actions: s.actions,
  };
}

export function flowCompact(v: FlowView | null, failed: boolean): GlanceCompact {
  if (!v) return { value: failed ? '-' : null, level: 'unknown', title: failed ? 'Flow: not available' : 'Flow: loading', loading: !failed };
  if (!v.enabled) return { value: null, level: 'idle', title: 'Flow: the watchdog is off' };
  if (v.merge === null) return { value: '-', level: 'unknown', title: 'Flow: no program was read' };
  const stuck = (v.merge ?? 0) + (v.qa ?? 0) + (v.idle ?? 0);
  const level: GlanceLevel = (v.stalled ?? 0) > 0 ? 'critical' : stuck > 0 || (v.bypass ?? 0) > 0 ? 'warn' : 'ok';
  return {
    value: String(stuck),
    level,
    title: `Flow: ${v.merge} to merge, ${v.qa} without QA, ${v.idle} idle leads${(v.stalled ?? 0) > 0 ? ', stalled' : ''}`,
  };
}

const KIND: Record<FlowAction['kind'], string> = { told: 'Told', reported: 'Reported', notified: 'Notified you', skipped: 'Skipped', failed: 'Failed' };
const COND: Record<FlowAction['condition'], string> = { merge: 'merge', qa: 'QA', idle: 'idle lead', bypass: 'Bypass', stall: 'stall' };

/** One action in a few words: "Told · merge · T-12, T-13". */
export function actionLine(a: FlowAction): string {
  const t = a.tickets.length ? ` · ${a.tickets.slice(0, 3).join(', ')}${a.tickets.length > 3 ? ` +${a.tickets.length - 3}` : ''}` : '';
  return `${KIND[a.kind]} · ${COND[a.condition]}${t}`;
}

export const actionLevel = (a: FlowAction): GlanceLevel => (a.kind === 'failed' || a.kind === 'notified' ? 'critical' : a.kind === 'told' ? 'ok' : 'warn');
