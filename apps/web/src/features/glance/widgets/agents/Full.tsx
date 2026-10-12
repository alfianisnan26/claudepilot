import { Button, useToast } from '@isnanme/ui';
import type { GlanceAgent } from '@portal/contracts';
import { Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { GlanceList, GlanceRow, LevelDot } from '../../ui';
import type { GlanceFullProps } from '../../types';
import { stopSession, stopTask } from '../shared/chatCall';
import { compactCount } from '../shared/format';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useEngaged, useSettling, useSteadyRows } from '../shared/steady';
import { useGlance } from '../shared/store';
import { useNow } from '../shared/useNow';
import { agentLevel, agentSubline, STOP_GRACE_MS, stopCall, stopLabel } from './model';

const NONE: GlanceAgent[] = [];
const keyOf = (r: GlanceAgent) => r.key;

/** One step of nesting each, written out so the stylesheet sees every class. */
const INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12', 'pl-16'] as const;

/** Agents: the workers sessions started and the sub-agents running inside them, under the session they belong to; Stop on each that runs. */
export function AgentsFull({ close }: GlanceFullProps) {
  const { data, failed, denied, stale, reload } = useGlance();
  const now = useNow();
  const toast = useToast();
  // Stops the portal accepted: the row's Stop stays away until the row changes, or a while passes (as the Agents panel does).
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);
  // The tree stays as it is while the pointer is over it or focus is in it: rows that finish stay in place, dimmed, and new ones wait.
  const { engaged, bind } = useEngaged();
  const steadyRows = useSteadyRows(data?.agents.rows ?? NONE, keyOf, engaged, true);
  // Stop is off for a moment after the list changes, so a press aimed at a row that has just moved cannot land on another.
  const settling = useSettling(steadyRows.map((r) => r.row.key));
  const rows = data?.agents.rows;
  useEffect(() => {
    // A row that is gone, or no longer stoppable, has answered: forget it, so a later run of the same row can be stopped.
    if (!rows) return;
    setStopped((cur) => {
      const live = new Set(rows.filter((r) => r.stoppable).map((r) => r.key));
      const next = new Set([...cur].filter((k) => live.has(k)));
      return next.size === cur.size ? cur : next;
    });
  }, [rows]);

  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  if (!data.agents.ok) return <GlanceFailed reload={reload} message="Could not read agents." />;

  const stop = async (r: GlanceAgent) => {
    const call = stopCall(r);
    if (!call) return;
    try {
      await (call.kind === 'task' ? stopTask(call.sessionId, call.taskId) : stopSession(call.sessionId));
      setStopped((cur) => new Set(cur).add(r.key));
      const t = window.setTimeout(() => {
        timers.current.delete(t);
        setStopped((cur) => {
          if (!cur.has(r.key)) return cur;
          const next = new Set(cur);
          next.delete(r.key);
          return next;
        });
      }, STOP_GRACE_MS);
      timers.current.add(t);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not stop it.', 'error');
    }
  };

  return (
    <>
      {stale && <StaleNote reload={reload} />}
      {steadyRows.length === 0 ? (
        <GlanceLine>No agents running.</GlanceLine>
      ) : (
        <div {...bind}>
          <GlanceList label="Agents">
            {steadyRows.map(({ row: r, gone }) => {
              const call = gone ? null : stopCall(r);
              const stopping = stopped.has(r.key);
              return (
                <GlanceRow key={r.key} className={`p-0 ${gone ? 'opacity-60' : ''}`}>
                  <Link
                    to={`/admin/sessions/${encodeURIComponent(r.sessionId)}`}
                    onClick={close}
                    className={`press flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl py-2 hover:bg-surface-2 ${INDENT[Math.min(r.depth, INDENT.length - 1)]}`}
                  >
                    <LevelDot level={agentLevel(r)} />
                    <span className="min-w-0 flex-1">
                      <span dir="auto" title={r.title} className={`block truncate text-sm ${r.kind === 'session' ? 'font-semibold' : 'font-medium'}`}>
                        {r.title}
                      </span>
                      <span className="block truncate text-xs text-muted">{gone ? 'Finished' : agentSubline(r, now)}</span>
                    </span>
                  </Link>
                  {call && !stopping && (
                    <Button variant="ghost" size="icon" disabled={settling} aria-label={stopLabel(r)} title={stopLabel(r)} onClick={() => stop(r)}>
                      <Square className="size-3.5 fill-current" />
                    </Button>
                  )}
                </GlanceRow>
              );
            })}
          </GlanceList>
        </div>
      )}
      {data.agents.more > 0 && (
        <Link to="/admin/sessions" onClick={close} className="press mt-1 flex min-h-11 items-center justify-center rounded-xl text-xs text-muted hover:bg-surface-2 hover:text-ink">
          +{compactCount(data.agents.more)} more
        </Link>
      )}
    </>
  );
}
