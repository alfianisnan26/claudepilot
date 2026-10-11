import { FormDialog, Select, TextField } from '@isnanme/ui';
import { WORKSPACE_NAME_MAX, workspaceNameProblem, type AccountPool, type CreateWorkspaceRequest, type WorkspaceTarget } from '@portal/contracts';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';

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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // This machine is one workspace you start and stop; there is nothing to create on it.
  const creatable = useMemo(() => targets.filter((t) => t.kind !== 'local'), [targets]);

  useEffect(() => {
    if (!open) return;
    setName('');
    setTarget(creatable.find((t) => t.available)?.id ?? '');
    setCpus('2');
    setMemory('4096');
    setPoolId('');
    setErrors({});
    setFormError(null);
  }, [open, creatable]);

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
          options={creatable.map((t) => ({
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
      </div>
    </FormDialog>
  );
}
