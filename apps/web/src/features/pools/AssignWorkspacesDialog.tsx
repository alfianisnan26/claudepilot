import { Button, ChipGroup, Dialog, RowsSkeleton } from '@isnanme/ui';
import { workspaceDisplayName, type MultiPoolType, type PoolSummary, type Workspace } from '@portal/contracts';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, errorText } from '@/lib/api';

/** Bulk assignment from a pool's card: pick the workspaces that should get it (foundation PRD §10). */
export function AssignWorkspacesDialog({
  type,
  pool,
  note,
  onClose,
  onDone,
}: {
  type: MultiPoolType;
  pool: PoolSummary | null;
  /** What assigning this pool means (`MultiPoolUi.assignNote`), shown above the choice. */
  note?: ReactNode;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [has, setHas] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!pool) return;
    setWorkspaces(null);
    setPicked([]);
    setError(null);
    let current = true;
    Promise.all([api.workspaces.list(), api.pools.get(type, pool.id)]).then(
      ([list, detail]) => {
        if (!current) return;
        setWorkspaces(list.filter((w) => w.status !== 'error'));
        setHas(new Set(detail.assignedTo.map((a) => a.workspaceId)));
      },
      (e: unknown) => current && setError(errorText(e, 'Could not load the workspaces.')),
    );
    return () => void (current = false);
  }, [type, pool]);

  const save = async () => {
    if (!pool) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.pools.assign(type, pool.id, picked);
      onDone(`${pool.name} assigned to ${r.assigned.length} workspace${r.assigned.length === 1 ? '' : 's'}`);
    } catch (e) {
      setError(errorText(e, 'Could not assign it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!pool}
      onClose={() => !saving && onClose()}
      title={pool ? `Assign ${pool.name}` : 'Assign'}
      description="Each workspace you pick gets this pool, following its current revision."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button loading={saving} disabled={picked.length === 0} onClick={() => void save()}>
            {picked.length > 1 ? `Assign to ${picked.length} workspaces` : 'Assign'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {note && (
          <div className="flex items-start gap-2 rounded-xl bg-flame-soft px-3 py-2 text-[13px] text-ink-soft">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-1">{note}</div>
          </div>
        )}
        {!workspaces && !error && <RowsSkeleton rows={2} lines={0} trailing={false} />}
        {workspaces &&
          (workspaces.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No workspaces yet.</p>
          ) : (
            <ChipGroup
              multiple
              label="Workspaces"
              value={picked}
              onChange={setPicked}
              options={workspaces.map((w) => ({ value: w.id, label: workspaceDisplayName(w), detail: has.has(w.id) ? 'has it' : undefined, disabled: has.has(w.id) }))}
            />
          ))}
        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
