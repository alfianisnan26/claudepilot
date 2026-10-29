import { Badge, Button, Dialog, Switch } from '@isnanme/ui';
import type { ScheduleRow, TriggerRun } from '@portal/contracts';
import { Pencil, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { canEdit, canRunNow, canSwitch, detailRows, STATE_LABEL, STATE_TONE, triggerIdOf } from './model';

/**
 * One schedule in a sheet (T-2950, general-manager PRD §9.2): everything the list knows about the row, and for a trigger its last runs and
 * its actions (Run now, the switch, Edit, Delete). The kit's Dialog is a bottom sheet on a phone; its header is not a drag handle
 * (`lib/sheetDrag.ts`, installed once in main.tsx), so a scroll inside never closes it.
 */
export function ScheduleSheet(p: {
  row: ScheduleRow | null;
  acting: boolean;
  onClose: () => void;
  onAct: (r: ScheduleRow, what: 'switch' | 'run') => void;
  onEdit: (r: ScheduleRow) => void;
  onDelete: (r: ScheduleRow) => void;
}) {
  const r = p.row;
  const [runs, setRuns] = useState<{ status: 'loading' } | { status: 'ready'; items: TriggerRun[] } | { status: 'error'; message: string }>({ status: 'loading' });
  const triggerId = r?.kind === 'trigger' ? triggerIdOf(r) : null;
  // The runs follow the row's last run, so Run now shows its new run when the list refreshes.
  const lastRun = r?.last_run ?? null;

  useEffect(() => {
    if (!triggerId) return;
    let live = true;
    setRuns({ status: 'loading' });
    api.triggerRuns(triggerId, 5).then(
      (page) => live && setRuns({ status: 'ready', items: page.items }),
      (e) => live && setRuns({ status: 'error', message: errorText(e, 'No answer from the portal.') }),
    );
    return () => {
      live = false;
    };
  }, [triggerId, lastRun]);

  return (
    <Dialog
      open={!!r}
      onClose={p.onClose}
      size="sm"
      title={<span className="[overflow-wrap:anywhere]">{r?.name ?? ''}</span>}
      description={r ? <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge> : null}
      footer={
        r ? (
          <div className="flex w-full flex-wrap items-center justify-end gap-2" data-schedule-sheet-actions="">
            {canSwitch(r) ? (
              <span className="mr-auto flex min-h-11 items-center gap-2 text-sm">
                <Switch checked={!!r.enabled} label={`${r.name} on`} disabled={p.acting} onChange={() => p.onAct(r, 'switch')} />
                {r.enabled ? 'On' : 'Off'}
              </span>
            ) : null}
            {canEdit(r) ? (
              <Button variant="ghost" size="icon" aria-label={`Delete ${r.name}`} disabled={p.acting} onClick={() => p.onDelete(r)}>
                <Trash2 className="size-[18px]" />
              </Button>
            ) : null}
            {canEdit(r) ? (
              <Button variant="secondary" disabled={p.acting} onClick={() => p.onEdit(r)}>
                <Pencil className="size-4" />
                Edit
              </Button>
            ) : null}
            {canRunNow(r) ? (
              <Button disabled={p.acting} loading={p.acting} onClick={() => p.onAct(r, 'run')}>
                <Play className="size-4" />
                Run now
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {r ? (
        <div data-schedule-sheet={r.id}>
          {r.description ? <p className="mb-3 text-sm text-muted [overflow-wrap:anywhere]">{r.description}</p> : null}
          <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            {detailRows(r, (iso) => timeAgo(iso)).map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted">{d.label}</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]">{d.value}</dd>
              </div>
            ))}
          </dl>
          {triggerId ? (
            <div className="mt-4">
              <h3 className="mb-1 text-[13px] font-semibold text-muted">Runs</h3>
              {runs.status === 'loading' ? <div className="skeleton h-8 rounded-lg" /> : null}
              {runs.status === 'error' ? <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">{runs.message}</p> : null}
              {runs.status === 'ready' && runs.items.length === 0 ? <p className="text-sm text-muted">Not yet.</p> : null}
              {runs.status === 'ready' && runs.items.length > 0 ? (
                <ul className="divide-y divide-line text-sm" data-schedule-runs="">
                  {runs.items.map((run) => (
                    <li key={run.id} className="flex min-h-9 items-center gap-2 py-1">
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{run.state.replace(/_/g, ' ')}</span>
                      <span className="shrink-0 text-muted">{timeAgo(run.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
