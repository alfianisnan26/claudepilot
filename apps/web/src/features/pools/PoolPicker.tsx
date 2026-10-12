import { Button, ChipGroup, Dialog, RowsSkeleton } from '@isnanme/ui';
import type { PoolSummary, Workspace, WorkspacePoolAssignment } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useEscapeFirst } from '@/lib/escape';
import type { MultiPoolTab } from './registry';
import type { MultiPoolUi } from './types';

/** Picks pools of one type: the type's own picker when it has one, otherwise chips. */
export function PoolChoice({
  ui,
  label,
  pools,
  value,
  onChange,
  hideLabel,
}: {
  // Each type has its own content shape; only the pools' names and IDs matter here.
  ui: MultiPoolUi<unknown>;
  label: string;
  pools: PoolSummary[];
  value: string[];
  onChange: (poolIds: string[]) => void;
  /** Where a title already names the type. */
  hideLabel?: boolean;
}) {
  if (ui.AddOn) return <ui.AddOn pools={pools} value={value} onChange={onChange} />;
  if (pools.length === 0) return <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No {ui.noun.other} yet.</p>;
  return (
    <ChipGroup
      multiple
      label={label}
      hideLabel={hideLabel}
      value={value}
      onChange={onChange}
      options={pools.map((p) => ({ value: p.id, label: p.name, detail: p.revision ? `r${p.revision}` : undefined }))}
    />
  );
}

/**
 * The Configuration row's change control (foundation PRD §10): which pools of one type a workspace
 * has. Pools it keeps keep their pin and per-workspace options. Opens over the Configuration sheet,
 * so Escape closes only this.
 */
export function PoolPickerDialog({
  workspace,
  tab,
  assignments,
  onClose,
  onDone,
}: {
  workspace: Workspace | null;
  tab: MultiPoolTab | null;
  assignments: WorkspacePoolAssignment[];
  onClose: () => void;
  /** The pool types' warnings about the change come along (it went ahead). */
  onDone: (message: string, warnings: string[]) => void;
}) {
  const open = !!workspace && !!tab;
  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEscapeFirst(open, () => !saving && onClose());
  const assigned = assignments.filter((a) => a.state === 'assigned').map((a) => a.poolId);

  useEffect(() => {
    if (!tab || !workspace) return;
    setPools(null);
    setError(null);
    setPicked(assigned);
    let current = true;
    api.pools.list(tab.pool.type).then(
      (list) => current && setPools(list),
      (e: unknown) => current && setError(errorText(e, 'Could not load them.')),
    );
    return () => void (current = false);
    // `assigned` is read when the picker opens, not on every live update while it's open.
  }, [tab, workspace?.id]);

  const unchanged = picked.length === assigned.length && picked.every((id) => assigned.includes(id));
  const save = async () => {
    if (!tab || !workspace) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.pools.setWorkspace(workspace.id, tab.pool.type, { items: picked.map((poolId) => ({ poolId })) });
      onDone(`${workspace.name}: ${tab.label} saved`, r.warnings);
    } catch (e) {
      setError(errorText(e, 'Could not change them.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !saving && onClose()}
      size="sm"
      title={tab?.label ?? ''}
      description={tab && workspace ? `Which ${tab.pool.noun.other} ${workspace.name} gets. Changes reach it within seconds.` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button loading={saving} disabled={unchanged || !pools} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!pools && !error && <RowsSkeleton rows={2} lines={0} trailing={false} />}
        {pools && tab && <PoolChoice ui={tab.pool} label={tab.label} hideLabel pools={pools} value={picked} onChange={setPicked} />}
        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
