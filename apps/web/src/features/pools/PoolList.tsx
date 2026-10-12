import { Badge, Button, ConfirmDialog, EmptyState, FormDialog, LoadError, Menu, RowsSkeleton, TextField, useToast, type MenuItem } from '@isnanme/ui';
import { POOL_NAME_MAX, type PoolSummary } from '@portal/contracts';
import { Copy, History, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { api, ApiError, errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { AssignWorkspacesDialog } from './AssignWorkspacesDialog';
import { revisionBadges, usedBy } from './labels';
import { PoolEditorDialog } from './PoolEditor';
import { RevisionsDialog } from './RevisionsDialog';
import type { MultiPoolUi } from './types';

/**
 * One multi-assignment pool type's tab (foundation PRD §10 pool pages): a card per pool with its name,
 * description, revision, status, "Used by N workspaces", and the same actions for every type.
 */
export function PoolList<C>({ tabId, label, ui }: { tabId: string; label: string; ui: MultiPoolUi<C> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<{ pool: PoolSummary | null } | null>(null);
  const [duplicating, setDuplicating] = useState<PoolSummary | null>(null);
  const [removing, setRemoving] = useState<PoolSummary | null>(null);
  const [revisions, setRevisions] = useState<PoolSummary | null>(null);
  const [assigning, setAssigning] = useState<PoolSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setPools(await api.pools.list(ui.type));
    } catch {
      setFailed(true);
    }
  }, [ui.type]);
  useEffect(() => void load(), [load]);
  useLive('pools', () => void load());

  const edit = (pool: PoolSummary | null) => {
    if (ui.editor === 'page') navigate(pool ? `/admin/pools/${tabId}/${pool.id}/edit` : `/admin/pools/${tabId}/new`);
    else setEditing({ pool });
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      const unassign = !!ui.deleteUnassigns && removing.workspaces > 0;
      const result = await api.pools.remove(ui.type, removing.id, { unassign });
      toast(`${removing.name} deleted${'warnings' in result && result.warnings.length ? `. ${result.warnings.join(' ')}` : ''}`);
      setRemoving(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not delete it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const newButton = (
    <Button icon={<Plus className="size-4" />} onClick={() => edit(null)}>
      <span className="hidden sm:inline">New {ui.noun.one}</span>
      <span className="sm:hidden">New</span>
    </Button>
  );
  const Icon = ui.icon;

  return (
    <>
      <PageHeader
        title={label}
        description={ui.description}
        action={
          ui.headerAction ? (
            <div className="flex items-center gap-2">
              {ui.headerAction}
              {pools && pools.length > 0 && newButton}
            </div>
          ) : (
            pools && pools.length > 0 && newButton
          )
        }
      />
      {failed && <LoadError onRetry={load} />}
      {!pools && !failed && <RowsSkeleton rows={3} lines={2} trailing icon="rounded-2xl" />}
      {pools &&
        (pools.length === 0 ? (
          <EmptyState icon={<Icon className="size-6" />} title={`No ${ui.noun.other} yet`} action={newButton} />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {pools.map((p) => (
              <PoolCard
                key={p.id}
                pool={p}
                ui={ui}
                onEdit={() => edit(p)}
                onDuplicate={() => setDuplicating(p)}
                onAssign={() => setAssigning(p)}
                onRevisions={() => setRevisions(p)}
                onRemove={() => setRemoving(p)}
              />
            ))}
          </div>
        ))}

      {ui.editor !== 'page' && (
        <PoolEditorDialog
          ui={ui}
          open={!!editing}
          pool={editing?.pool ?? null}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            toast(`${p.name} saved`);
            void load();
          }}
        />
      )}
      <DuplicateDialog
        ui={ui}
        pool={duplicating}
        onClose={() => setDuplicating(null)}
        onDone={(p) => {
          setDuplicating(null);
          toast(`${p.name} created`);
          void load();
        }}
      />
      <RevisionsDialog type={ui.type} pool={revisions} onClose={() => setRevisions(null)} />
      <AssignWorkspacesDialog
        type={ui.type}
        pool={assigning}
        note={assigning && ui.assignNote?.(assigning)}
        onClose={() => setAssigning(null)}
        onDone={(message) => {
          setAssigning(null);
          toast(message);
          void load();
        }}
      />
      <ConfirmDialog
        open={!!removing}
        title={`Delete ${removing?.name ?? ''}?`}
        description={`${ui.deleteUnassigns && removing && removing.workspaces > 0 ? `Takes it out of ${removing.workspaces} workspace${removing.workspaces === 1 ? '' : 's'}, then deletes it and its revisions.` : 'Deletes the pool and its revisions.'}${ui.deleteNote ? ` ${ui.deleteNote}` : ''}`}
        confirmLabel="Delete"
        loading={busy}
        onConfirm={() => void remove()}
        onClose={() => !busy && setRemoving(null)}
      />
    </>
  );
}

function PoolCard<C>({
  pool: p,
  ui,
  onEdit,
  onDuplicate,
  onAssign,
  onRevisions,
  onRemove,
}: {
  pool: PoolSummary;
  ui: MultiPoolUi<C>;
  onEdit: () => void;
  onDuplicate: () => void;
  onAssign: () => void;
  onRevisions: () => void;
  onRemove: () => void;
}) {
  const Icon = ui.icon;
  const items: MenuItem[] = [
    { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: onEdit },
    { label: 'Duplicate', icon: <Copy className="size-4" />, onSelect: onDuplicate },
    { label: 'Assign…', icon: <Users className="size-4" />, onSelect: onAssign },
    { label: 'Revisions…', icon: <History className="size-4" />, onSelect: onRevisions },
    // In use: unassign it first (the portal refuses too), unless the type takes it out of its workspaces itself.
    { label: 'Delete', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true, disabled: p.workspaces > 0 && !ui.deleteUnassigns },
  ];
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3">
      {ui.Leading ? (
        <ui.Leading pool={p} />
      ) : (
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate text-sm font-semibold">{p.name}</p>
          {p.revision > 0 && <span className="font-mono text-[11.5px] text-muted">r{p.revision}</span>}
          {revisionBadges(p).map((b) => (
            <Badge key={b.label} tone={b.tone}>
              {b.label}
            </Badge>
          ))}
        </div>
        {p.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-soft">{p.description}</p>}
        {ui.summary && <div className="mt-0.5 truncate text-[12px] text-muted">{ui.summary(p)}</div>}
        {p.rolloutPaused && <p className="mt-1 text-[12px] text-ink-soft">{p.rolloutPaused.reason}</p>}
        <p className="mt-0.5 text-[12px] text-muted">{usedBy(p.workspaces)}</p>
      </div>
      <Menu label={`Actions for ${p.name}`} items={items} />
    </div>
  );
}

/** Duplicate: the newest revision as a new pool's first, under a new name. */
function DuplicateDialog<C>({ ui, pool, onClose, onDone }: { ui: MultiPoolUi<C>; pool: PoolSummary | null; onClose: () => void; onDone: (pool: PoolSummary) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!pool) return;
    setName(`${pool.name} copy`.slice(0, POOL_NAME_MAX));
    setError(null);
    setFieldError(undefined);
  }, [pool]);

  const submit = async () => {
    if (!pool) return;
    setSaving(true);
    setError(null);
    try {
      onDone(await api.pools.duplicate(ui.type, pool.id, name));
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object') setFieldError((e.details as { name?: string }).name);
      setError(errorText(e, 'Could not duplicate it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={!!pool}
      onClose={onClose}
      size="sm"
      title={`Duplicate ${pool?.name ?? ''}`}
      description="Same content, assigned to no workspace."
      onSubmit={submit}
      submitLabel="Duplicate"
      saving={saving}
      error={error}
    >
      <TextField label="Name" autoComplete="off" maxLength={POOL_NAME_MAX} value={name} onChange={(e) => (setName(e.target.value), setFieldError(undefined))} error={fieldError} data-autofocus />
    </FormDialog>
  );
}
