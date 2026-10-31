import { cn, Dialog, FormDialog, Segmented, Select, Switch, TextArea, TextField } from '@isnanme/ui';
import { type CiAutoApproveMode, type CiBranch, type CiEnvironment, type CiInput, type CiPipelineInfo, type CiRepo, type CiRun, type Workspace } from '@portal/contracts';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';
import { ciApi } from './api';
import { remoteWorkspaces } from './remoteWorkspaces';
import { Diagnostics } from './RunPage';

/** Field errors the server names (`details: { name: '…' }`) and what is left over for the form. */
function fieldErrors<K extends string>(e: unknown, keys: readonly K[]): { fields: Partial<Record<K, string>>; message: string | null } {
  const details = (e as { details?: Record<string, unknown> }).details;
  const fields: Partial<Record<K, string>> = {};
  let found = false;
  for (const k of keys) {
    const v = details?.[k];
    if (typeof v === 'string') (fields[k] = v), (found = true);
  }
  return { fields, message: found ? null : errorText(e, 'That did not work.') };
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A remote on a workspace: a bare repository its repositories push to, optionally cloned from one that is already there. */
export function NewRemoteDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: CiRepo) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [connect, setConnect] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<'name' | 'source' | 'workspaceId', string>>>({});

  useEffect(() => {
    if (!open) return;
    setName('');
    setSource('');
    setConnect(true);
    setError(null);
    setErrors({});
    let current = true;
    Promise.all([api.workspaces.list(), api.workspaces.targets()]).then(
      ([all, targets]) => {
        if (!current) return;
        const usable = remoteWorkspaces(all, targets);
        setWorkspaces(usable);
        setWorkspaceId((id) => (usable.some((w) => w.id === id) ? id : (usable[0]?.id ?? '')));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    setErrors({});
    try {
      onCreated(await ciApi.createRepo({ workspaceId, name: name.trim(), source: source.trim() || undefined, connect: source.trim() ? connect : undefined }));
    } catch (e) {
      const { fields, message } = fieldErrors(e, ['name', 'source', 'workspaceId'] as const);
      setErrors(fields);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={open} onClose={onClose} title="New remote" onSubmit={submit} submitLabel="Create" saving={saving} error={error} submitDisabled={!workspaceId || !NAME.test(name.trim())} dirty={!!name.trim() || !!source.trim()}>
      <div className="flex flex-col gap-4">
        <Select
          label="Workspace"
          value={workspaceId}
          onChange={setWorkspaceId}
          options={workspaces.map((w) => ({ value: w.id, label: w.id }))}
          placeholder={workspaces.length ? undefined : 'No running workspace'}
          error={errors.workspaceId}
        />
        <TextField label="Name" placeholder="app" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={name} onChange={(e) => (setName(e.target.value), setErrors((x) => ({ ...x, name: undefined })))} error={errors.name} />
        <TextField
          label="From folder"
          optional
          placeholder="/home/node/work/app"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={source}
          onChange={(e) => (setSource(e.target.value), setErrors((x) => ({ ...x, source: undefined })))}
          error={errors.source}
          hint={<InfoTip label="About the folder">A repository in the workspace to copy into the remote. Empty makes an empty remote.</InfoTip>}
        />
        {source.trim() && (
          <div className="flex items-center justify-between gap-3">
            <span id="connect-label" className="text-[14px] font-medium">
              Connect as <span className="font-mono text-[13px]">pilot</span>
            </span>
            <Switch labelledBy="connect-label" checked={connect} onChange={setConnect} />
          </div>
        )}
      </div>
    </FormDialog>
  );
}

/** Branches a push to is a merge: names or patterns, one per line or separated by commas. */
export function ProtectedDialog({ repo, onClose, onSaved }: { repo: CiRepo | null; onClose: () => void; onSaved: (r: CiRepo) => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (repo) (setText(repo.protected.join(', ')), setError(null));
  }, [repo]);
  const submit = async () => {
    if (!repo) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await ciApi.updateRepo(repo.id, { protected: text.split(/[,\s]+/).filter(Boolean) }));
    } catch (e) {
      setError(errorText(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog open={!!repo} onClose={onClose} title="Protected branches" onSubmit={submit} submitLabel="Save" saving={saving} error={error}>
      <TextField
        label="Branches"
        placeholder="main, release/*"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        hint={<InfoTip label="About protected branches">A push or merge into one of these starts the pipelines that run on merge. * stays within one folder, ** goes through folders.</InfoTip>}
      />
    </FormDialog>
  );
}

const RULE_MODES: { value: CiAutoApproveMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'dry', label: 'Dry' },
  { value: 'on', label: 'Auto' },
];
const HOURS = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** The rule's three modes as a radio group with 44 px choices (the shared Segmented is 40 px tall); arrow keys move the choice. */
function ModePicker({ value, onChange }: { value: CiAutoApproveMode; onChange: (m: CiAutoApproveMode) => void }) {
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = RULE_MODES[(i + step + RULE_MODES.length) % RULE_MODES.length]!;
    onChange(next.value);
    (e.currentTarget.parentElement?.children[RULE_MODES.indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby="rule-mode" className="flex gap-1 rounded-full bg-surface-2 p-1">
      {RULE_MODES.map((m, i) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={value === m.value}
          tabIndex={value === m.value ? 0 : -1}
          onClick={() => onChange(m.value)}
          onKeyDown={(e) => move(e, i)}
          className={cn(
            'press h-11 flex-1 rounded-full text-[14px] font-semibold focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden',
            value === m.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * An environment's auto-approve rule (T-110, local-git-ci PRD FR41a): the mode, the hours (UTC) and the paths that need a person. Only a
 * person reaches it (the route refuses tokens and agents). `Auto` lets the portal approve a waiting deploy whose every condition holds.
 */
export function AutoApproveDialog({ repoId, env, onClose, onSaved }: { repoId: string; env: CiEnvironment | null; onClose: () => void; onSaved: (e: CiEnvironment) => void }) {
  const [mode, setMode] = useState<CiAutoApproveMode>('off');
  const [hours, setHours] = useState('');
  const [paths, setPaths] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ fields: Partial<Record<'mode' | 'window' | 'needsPerson', string>>; message: string | null }>({ fields: {}, message: null });
  useEffect(() => {
    if (!env) return;
    setMode(env.autoApprove);
    setHours(env.autoApproveWindow ?? '');
    setPaths(env.needsPerson.join('\n'));
    setErrors({ fields: {}, message: null });
  }, [env]);
  const list = paths.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
  const pathsChanged = !!env && list.join('\n') !== env.needsPerson.join('\n');
  const dirty = !!env && (mode !== env.autoApprove || hours.trim() !== (env.autoApproveWindow ?? '') || pathsChanged);
  const hoursBad = !!hours.trim() && !HOURS.test(hours.trim());
  const submit = async () => {
    if (!env) return;
    setSaving(true);
    setErrors({ fields: {}, message: null });
    try {
      onSaved(await ciApi.setAutoApprove(repoId, env.name, { mode, window: hours.trim() || null, ...(pathsChanged ? { needsPerson: list.length ? list : null } : {}) }));
    } catch (e) {
      setErrors(fieldErrors(e, ['mode', 'window', 'needsPerson'] as const));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog
      open={!!env}
      onClose={onClose}
      title="Auto-approve"
      onSubmit={submit}
      submitLabel={mode === 'on' && env?.autoApprove !== 'on' ? 'Turn on' : 'Save'}
      saving={saving}
      error={errors.message ?? errors.fields.mode ?? null}
      dirty={dirty}
      submitDisabled={!dirty || hoursBad}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-[13px] font-semibold text-ink-soft" id="rule-mode">
            {env?.name}
            <InfoTip label="About auto-approve">
              Off: a person approves each deploy. Dry: the portal writes on the run whether it WOULD approve, and approves nothing. Auto: the
              portal approves a waiting deploy itself, as rule:{env?.name ?? 'environment'}, when every condition holds: the gate green on the
              commit, the build ok, verify and rollback in the pipeline, the same branch as the last release, nothing below in the diff, at most
              6 a day and one at a time, inside the hours, the last deploy it approved not failed or rolled back. Otherwise a person decides, as now.
              Agents can never approve.
            </InfoTip>
          </span>
          <ModePicker value={mode} onChange={setMode} />
        </div>
        <TextField
          label="Hours (UTC)"
          placeholder="always"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          error={hoursBad ? 'HH:MM-HH:MM' : errors.fields.window}
          hint={<InfoTip label="About the hours">When the rule may approve, HH:MM-HH:MM in UTC (it may cross midnight). Empty: always.</InfoTip>}
        />
        <TextArea
          label="Needs a person"
          rows={5}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono text-[12.5px]"
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
          error={errors.fields.needsPerson}
          hint={<InfoTip label="About the paths">A deploy whose diff since the last release touches one of these waits for a person. One per line; ** goes through folders. Empty: the defaults.</InfoTip>}
        />
      </div>
    </FormDialog>
  );
}

export function ConnectDialog({ repo, onClose, onSaved }: { repo: CiRepo | null; onClose: () => void; onSaved: (r: CiRepo) => void }) {
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (repo) (setPath(''), setError(null));
  }, [repo]);
  const submit = async () => {
    if (!repo) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await ciApi.connect(repo.id, { path: path.trim() }));
    } catch (e) {
      setError(errorText(e, 'Could not connect.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog open={!!repo} onClose={onClose} title="Connect folder" onSubmit={submit} submitLabel="Connect" saving={saving} error={error} submitDisabled={!path.trim().startsWith('/')}>
      <TextField
        label="Folder"
        placeholder="/home/node/work/app"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={path}
        onChange={(e) => setPath(e.target.value)}
        hint={<InfoTip label="About connecting">Adds a remote named pilot to that repository. Its other remotes stay as they are.</InfoTip>}
      />
    </FormDialog>
  );
}

/** Starts a pipeline by hand on a branch, with the inputs the pipeline asks for. */
export function RunDialog({ repo, branch, onClose, onStarted }: { repo: CiRepo | null; branch: string; onClose: () => void; onStarted: (r: CiRun) => void }) {
  const [pipelines, setPipelines] = useState<CiPipelineInfo[] | null>(null);
  const [pipeline, setPipeline] = useState('');
  const [ref, setRef] = useState('');
  const [inputs, setInputs] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!repo) return;
    setRef(branch);
    setInputs({});
    setError(null);
    setErrors({});
    setPipelines(null);
    let current = true;
    ciApi.pipelines(repo.id, branch || undefined).then(
      (list) => {
        if (!current) return;
        const manual = list.filter((p) => p.valid && p.triggers.includes('manual'));
        setPipelines(manual);
        setPipeline(manual[0]?.file.replace(/^\.pilot\//, '').replace(/\.ya?ml$/, '') ?? '');
      },
      (e) => current && (setPipelines([]), setError(errorText(e, 'Could not read the pipelines.'))),
    );
    return () => {
      current = false;
    };
  }, [repo, branch]);

  const chosen = pipelines?.find((p) => p.file.replace(/^\.pilot\//, '').replace(/\.ya?ml$/, '') === pipeline);
  const fields: CiInput[] = chosen?.inputs ?? [];
  const value = (i: CiInput) => inputs[i.name] ?? i.default ?? (i.type === 'boolean' ? false : '');

  const submit = async () => {
    if (!repo) return;
    setSaving(true);
    setError(null);
    setErrors({});
    try {
      const given: Record<string, string | boolean> = {};
      for (const i of fields) given[i.name] = value(i);
      onStarted(await ciApi.start({ repoId: repo.id, pipeline, ref: ref.trim(), inputs: given }));
    } catch (e) {
      const details = (e as { details?: Record<string, unknown> }).details;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(details ?? {})) if (typeof v === 'string') next[k] = v;
      setErrors(next);
      setError(Object.keys(next).length ? null : errorText(e, 'Could not start it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={!!repo} onClose={onClose} title="Run" onSubmit={submit} submitLabel="Run" saving={saving} error={error} submitDisabled={!pipeline || !ref.trim()}>
      <div className="flex flex-col gap-4">
        {pipelines && pipelines.length === 0 ? (
          <p className="text-[14px] text-muted">No pipeline here runs by hand.</p>
        ) : (
          <>
            <Select
              label="Pipeline"
              value={pipeline}
              onChange={setPipeline}
              options={(pipelines ?? []).map((p) => {
                const id = p.file.replace(/^\.pilot\//, '').replace(/\.ya?ml$/, '');
                return { value: id, label: id };
              })}
            />
            <TextField label="Branch or tag" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={ref} onChange={(e) => setRef(e.target.value)} error={errors.ref} />
            {fields.map((i) =>
              i.type === 'boolean' ? (
                <div key={i.name} className="flex items-center justify-between gap-3">
                  <span id={`in-${i.name}`} className="text-[14px] font-medium">
                    {i.name}
                  </span>
                  <Switch labelledBy={`in-${i.name}`} checked={value(i) === true} onChange={(v) => setInputs((x) => ({ ...x, [i.name]: v }))} />
                </div>
              ) : i.type === 'choice' ? (
                <Select key={i.name} label={i.name} value={String(value(i))} onChange={(v) => setInputs((x) => ({ ...x, [i.name]: v }))} options={i.options.map((o) => ({ value: o, label: o }))} error={errors[i.name]} />
              ) : (
                <TextField key={i.name} label={i.name} optional={!i.required} value={String(value(i))} onChange={(e) => setInputs((x) => ({ ...x, [i.name]: e.target.value }))} error={errors[i.name]} autoComplete="off" />
              ),
            )}
          </>
        )}
      </div>
    </FormDialog>
  );
}

/** Merges a branch into another on the remote, by the portal (fast-forward when it can, a merge commit otherwise). */
export function MergeDialog({ repo, source, branches, onClose, onMerged }: { repo: CiRepo | null; source: string; branches: CiBranch[]; onClose: () => void; onMerged: () => void }) {
  const targets = useMemo(() => branches.filter((b) => b.name !== source), [branches, source]);
  const [target, setTarget] = useState('');
  const [strategy, setStrategy] = useState<'merge' | 'ff'>('merge');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!repo) return;
    setError(null);
    setStrategy('merge');
    setTarget((t) => (targets.some((b) => b.name === t) ? t : (targets.find((b) => b.name === repo.defaultBranch) ?? targets[0])?.name ?? ''));
  }, [repo, targets]);
  const submit = async () => {
    if (!repo) return;
    setSaving(true);
    setError(null);
    try {
      await ciApi.merge(repo.id, { source, target, strategy });
      onMerged();
    } catch (e) {
      const files = ((e as { details?: { files?: unknown } }).details?.files as string[] | undefined) ?? [];
      setError(files.length ? `${errorText(e, 'Conflict.')} ${files.slice(0, 5).join(', ')}` : errorText(e, 'Could not merge.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog
      open={!!repo}
      onClose={onClose}
      title={
        <>
          Merge <span className="font-mono text-[0.9em]">{source}</span>
        </>
      }
      onSubmit={submit}
      submitLabel="Merge"
      saving={saving}
      error={error}
      submitDisabled={!target}
    >
      <div className="flex flex-col gap-4">
        <Select label="Into" value={target} onChange={setTarget} options={targets.map((b) => ({ value: b.name, label: b.protected ? `${b.name} (protected)` : b.name }))} />
        <Segmented<'merge' | 'ff'>
          label="How"
          value={strategy}
          onChange={setStrategy}
          options={[
            { value: 'merge', label: 'Merge' },
            { value: 'ff', label: 'Fast-forward' },
          ]}
        />
      </div>
    </FormDialog>
  );
}

/** A pipeline file's problems. */
export function PipelineDialog({ info, onClose }: { info: CiPipelineInfo | null; onClose: () => void }) {
  return (
    <Dialog open={!!info} onClose={onClose} title={info?.file ?? ''} size="md">
      {info && (info.diagnostics.length ? <Diagnostics items={info.diagnostics} /> : <p className="text-[14px] text-muted">No problems</p>)}
    </Dialog>
  );
}
