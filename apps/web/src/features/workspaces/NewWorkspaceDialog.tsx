import { cn, FormDialog, Select, TextField } from '@isnanme/ui';
import {
  WORKSPACE_NAME_MAX,
  workspaceNameProblem,
  type AccountPool,
  type CreateWorkspaceRequest,
  type MultiPoolType,
  type PoolSummary,
  type WorkspaceTarget,
} from '@portal/contracts';
import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PoolChoice } from '@/features/pools/PoolPicker';
import { multiPoolTabs } from '@/features/pools/registry';
import { api, ApiError } from '@/lib/api';

type AddOns = Partial<Record<MultiPoolType, string[]>>;

const CPU_OPTIONS = [
  { value: '', label: 'No limit' },
  { value: '0.5', label: '½ CPU' },
  { value: '1', label: '1 CPU' },
  { value: '2', label: '2 CPUs' },
  { value: '4', label: '4 CPUs' },
];
const MEMORY_OPTIONS = [
  { value: '', label: 'No limit' },
  { value: '1024', label: '1 GB' },
  { value: '2048', label: '2 GB' },
  { value: '4096', label: '4 GB' },
  { value: '8192', label: '8 GB' },
];

export function NewWorkspaceDialog({
  open,
  targets,
  pools,
  onClose,
  onCreate,
}: {
  open: boolean;
  targets: WorkspaceTarget[];
  pools: AccountPool[];
  onClose: () => void;
  onCreate: (body: CreateWorkspaceRequest) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [cpus, setCpus] = useState('2');
  const [memory, setMemory] = useState('4096');
  const [poolId, setPoolId] = useState('');
  const [addOns, setAddOns] = useState<AddOns>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setTarget(targets.find((t) => t.available)?.id ?? '');
    setCpus('2');
    setMemory('4096');
    setPoolId('');
    setAddOns({});
    setErrors({});
    setFormError(null);
  }, [open, targets]);

  const submit = async () => {
    const problem = workspaceNameProblem(name);
    const next: Record<string, string> = {};
    if (problem) next.name = problem;
    if (!target) next.target = 'Pick where it runs.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    setFormError(null);
    try {
      await onCreate({
        name,
        target,
        cpus: cpus ? Number(cpus) : undefined,
        memoryMb: memory ? Number(memory) : undefined,
        accountPoolId: poolId || null,
        // Assigned right after the create, the way the account pool is.
        pools: Object.fromEntries(Object.entries(addOns).filter(([, ids]) => ids.length > 0)),
      });
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object')
        setErrors(e.details as Record<string, string>);
      setFormError(e instanceof Error ? e.message : 'Could not create it.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="New workspace"
      description="A container with Claude Code, git and gh. Its home folder survives restarts."
      onSubmit={submit}
      submitLabel="Create"
      saving={saving}
      error={formError}
      dirty={!!name}
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
          hint="Lowercase letters, digits and dashes."
          placeholder="my-project"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={WORKSPACE_NAME_MAX}
          className="[&_input]:font-mono"
          value={name}
          onChange={(e) => {
            setName(e.target.value.toLowerCase().replace(/[\s_]+/g, '-'));
            setErrors(({ name: _, ...rest }) => rest);
          }}
          error={errors.name}
          data-autofocus
        />
        <Select
          label="Runs on"
          value={target}
          onChange={(v) => (setTarget(v), setErrors(({ target: _, ...rest }) => rest))}
          options={targets.map((t) => ({
            value: t.id,
            label: t.available ? `${t.label} · ${t.where}` : `${t.label} (unreachable)`,
            disabled: !t.available,
          }))}
          placeholder="Pick a target"
          error={errors.target}
        />
        <Select
          label="Account pool"
          value={poolId}
          onChange={setPoolId}
          options={[{ value: '', label: 'None (sign in inside the workspace)' }, ...pools.map((p) => ({ value: p.id, label: p.name }))]}
          hint={poolId ? 'Claude Code starts signed in with the pool’s keys.' : undefined}
          error={errors.accountPoolId}
        />
        <div className="grid grid-cols-2 gap-3">
          <Select label="CPU" value={cpus} onChange={setCpus} options={CPU_OPTIONS} error={errors.cpus} />
          <Select label="Memory" value={memory} onChange={setMemory} options={MEMORY_OPTIONS} error={errors.memoryMb} />
        </div>
        <AddOnsSection open={open} value={addOns} onChange={setAddOns} error={errors.pools} />
      </div>
    </FormDialog>
  );
}

/**
 * Add-ons (foundation PRD §10): pools of each registered multi-assignment type, collapsed by default.
 * Hidden while no such type is registered.
 */
function AddOnsSection({ open, value, onChange, error }: { open: boolean; value: AddOns; onChange: (next: AddOns) => void; error?: string }) {
  const tabs = multiPoolTabs();
  const [expanded, setExpanded] = useState(false);
  const [pools, setPools] = useState<Partial<Record<MultiPoolType, PoolSummary[]>>>({});

  useEffect(() => {
    if (!open) return;
    setExpanded(false);
    setPools({});
    let current = true;
    for (const t of multiPoolTabs())
      api.pools.list(t.pool.type).then(
        (list) => current && setPools((p) => ({ ...p, [t.pool.type]: list })),
        () => current && setPools((p) => ({ ...p, [t.pool.type]: [] })),
      );
    return () => void (current = false);
  }, [open]);

  if (tabs.length === 0) return null;
  const count = Object.values(value).reduce((n, ids) => n + (ids?.length ?? 0), 0);
  return (
    <div className="rounded-2xl border border-line">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((x) => !x)}
        className="press flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <span className="flex-1 text-sm font-semibold text-ink-soft">Add-ons</span>
        <span className="text-[13px] text-muted">{count ? `${count} selected` : 'Optional'}</span>
        <ChevronDown className={cn('size-4 text-muted transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="flex flex-col gap-4 border-t border-line px-4 py-3">
          {tabs.map((t) => {
            const list = pools[t.pool.type];
            return list ? (
              <PoolChoice
                key={t.id}
                ui={t.pool}
                label={t.label}
                pools={list}
                value={value[t.pool.type] ?? []}
                onChange={(ids) => onChange({ ...value, [t.pool.type]: ids })}
              />
            ) : (
              <p key={t.id} className="text-[13px] text-muted">
                Loading {t.label.toLowerCase()}…
              </p>
            );
          })}
          {error && <p className="text-[13px] font-medium text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
