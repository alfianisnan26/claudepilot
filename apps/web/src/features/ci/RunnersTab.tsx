import { Button, ConfirmDialog, EmptyState, FormDialog, LoadError, Menu, RowsSkeleton, Select, Switch, TextArea, TextField, useToast, cn } from '@isnanme/ui';
import { type CiRunner, type UpsertCiRunnerRequest, type Workspace, workspaceDisplayName } from '@portal/contracts';
import { Pause, Pencil, Play, Server, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { ciApi } from './api';
import { labelProblem, MAX_RUNS, MIN_RUNS, normalizeLabel, runnerDraft, runnerMarks, workspaceName } from './runners';

/** What a runner is, in one line each (the InfoTip beside the title and in the sheet). */
export const RUNS_ON_TIP = 'A pipeline’s runs-on: [labels] sends its runs to a runner whose labels include all of them.';
export const RUNNER_RISK_TIP = 'A runner receives other workspaces’ code and secrets for each run it takes. Only a person can make one.';

const DOT: Record<CiRunner['state'], string> = { online: 'bg-ok', offline: 'bg-muted', gone: 'bg-danger' };

/** The runners (T-557, PRD §23): workspaces that take the runs of others by label. Managing is a person's: the server judges and its refusal is shown as it is. */
export function RunnersTab({ adding, onCloseAdd, onAdd }: { adding: boolean; onCloseAdd: () => void; onAdd: () => void }) {
  const toast = useToast();
  const [runners, setRunners] = useState<CiRunner[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<CiRunner | null>(null);
  const [removeFor, setRemoveFor] = useState<CiRunner | null>(null);
  const [removing, setRemoving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const list = await ciApi.runners();
      if (mine !== seq.current) return;
      setRunners(list);
      setFailed(false);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('ci', () => void load());

  const toggleDrain = async (r: CiRunner) => {
    try {
      await ciApi.upsertRunner(toRequest(r, { drained: !r.drained }));
      toast(r.drained ? `${workspaceName(r.workspaceId)} resumed` : `${workspaceName(r.workspaceId)} drained`);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not change it.'), 'error');
    }
  };

  const remove = async () => {
    if (!removeFor) return;
    setRemoving(true);
    try {
      await ciApi.removeRunner(removeFor.workspaceId);
      toast(`${workspaceName(removeFor.workspaceId)} is not a runner`);
      setRemoveFor(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
      setRemoveFor(null);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <>
      <div className="mb-2 flex items-center gap-1 px-1 text-[13px] text-muted">
        <span>Runs on labels</span>
        <InfoTip label="About runners">
          {RUNS_ON_TIP} {RUNNER_RISK_TIP}
        </InfoTip>
      </div>
      {failed && !runners && <LoadError onRetry={load} />}
      {!runners && !failed && <RowsSkeleton rows={2} lines={1} icon="rounded-2xl" />}
      {runners &&
        (runners.length === 0 ? (
          <>
            <EmptyState icon={<Server className="size-6" />} title="No runners" action={<Button onClick={onAdd}>Add runner</Button>} />
            <p className="mt-2 px-4 text-center text-[13px] text-muted">Add a workspace as a runner with labels, then put runs-on: [label] in a pipeline.</p>
          </>
        ) : (
          <ul className="flex flex-col gap-2">
            {runners.map((r) => (
              <RunnerRow key={r.workspaceId} runner={r} onEdit={() => setEditing(r)} onDrain={() => void toggleDrain(r)} onRemove={() => setRemoveFor(r)} />
            ))}
          </ul>
        ))}

      <RunnerSheet
        open={adding || !!editing}
        runner={editing}
        existing={runners ?? []}
        onClose={() => (setEditing(null), onCloseAdd())}
        onSaved={(r) => {
          setEditing(null);
          onCloseAdd();
          toast(`${workspaceName(r.workspaceId)} saved`);
          void load();
        }}
      />
      <ConfirmDialog
        open={!!removeFor}
        title={`Remove ${removeFor ? workspaceName(removeFor.workspaceId) : ''}`}
        description="It stops being a runner. Runs it already takes finish; the workspace stays."
        confirmLabel="Remove"
        loading={removing}
        onConfirm={() => void remove()}
        onClose={() => setRemoveFor(null)}
      />
    </>
  );
}

/** The request that keeps a runner as it is, with some fields changed. */
function toRequest(r: CiRunner, over: Partial<UpsertCiRunnerRequest> = {}): UpsertCiRunnerRequest {
  return { workspaceId: r.workspaceId, labels: r.labels, maxRuns: r.maxRuns, enabled: r.enabled, drained: r.drained, note: r.note, ...over };
}

function RunnerRow({ runner: r, onEdit, onDrain, onRemove }: { runner: CiRunner; onEdit: () => void; onDrain: () => void; onRemove: () => void }) {
  const marks = runnerMarks(r);
  const name = workspaceName(r.workspaceId);
  return (
    <li className="flex items-center gap-1 rounded-2xl border border-line bg-surface py-2.5 pr-1.5 pl-3.5">
      <span className={cn('size-2.5 shrink-0 rounded-full', DOT[r.state])} aria-hidden="true" />
      <span className="sr-only">{r.state}</span>
      <div className="ml-2 min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14.5px] font-semibold" title={r.workspaceId}>
            {name}
          </span>
          <span className="shrink-0 text-[12.5px] text-muted tabular-nums" title="Running now / runs at once">
            {r.running}/{r.maxRuns}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {r.labels.map((l) => (
            <span key={l} className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[12px] text-ink-soft">
              {l}
            </span>
          ))}
          {marks.map((m) => (
            <span key={m} className="rounded-full bg-gold/15 px-2 py-0.5 text-[12px] font-semibold text-gold">
              {m}
            </span>
          ))}
        </div>
        {r.note && <p className="mt-1 truncate text-[12.5px] text-muted [overflow-wrap:anywhere]">{r.note}</p>}
      </div>
      <Menu
        label={`${name} actions`}
        items={[
          { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: onEdit },
          { label: r.drained ? 'Resume' : 'Drain', icon: r.drained ? <Play className="size-4" /> : <Pause className="size-4" />, onSelect: onDrain },
          { label: 'Remove', icon: <Trash2 className="size-4" />, onSelect: onRemove, danger: true },
        ]}
      />
    </li>
  );
}

/** Add a runner, or edit one: a workspace, label chips, runs at once (1 to 8) and a note. */
function RunnerSheet({ open, runner, existing, onClose, onSaved }: { open: boolean; runner: CiRunner | null; existing: CiRunner[]; onClose: () => void; onSaved: (r: CiRunner) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [labelText, setLabelText] = useState('');
  const [maxRuns, setMaxRuns] = useState('1');
  const [enabled, setEnabled] = useState(true);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setWorkspaceId(runner?.workspaceId ?? '');
    setLabels(runner?.labels ?? []);
    setLabelText('');
    setMaxRuns(String(runner?.maxRuns ?? 1));
    setEnabled(runner?.enabled ?? true);
    setNote(runner?.note ?? '');
    setError(null);
    setProblem(null);
    if (runner) return;
    let current = true;
    api.workspaces.list().then(
      (all) => {
        if (!current) return;
        const free = all.filter((w) => !existing.some((r) => r.workspaceId === w.id));
        setWorkspaces(free);
        setWorkspaceId((id) => (free.some((w) => w.id === id) ? id : (free[0]?.id ?? '')));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
    // `existing` changes with every reload; the sheet reads it when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runner]);

  const typed = labelProblem(labelText, labels);
  const addLabel = (text = labelText) => {
    const l = normalizeLabel(text);
    if (!l || labelProblem(text, labels)) return;
    setLabels((x) => [...x, l]);
    setLabelText('');
    setProblem(null);
  };

  const submit = async () => {
    // A label still in the field counts: it is added first.
    const pending = normalizeLabel(labelText);
    const all = pending && !labelProblem(labelText, labels) ? [...labels, pending] : labels;
    const draft = runnerDraft({ workspaceId, labels: all, maxRuns, note });
    if (!draft.ok) return setProblem({ field: draft.field, message: draft.message });
    setSaving(true);
    setError(null);
    setProblem(null);
    try {
      onSaved(await ciApi.upsertRunner(runner ? { ...draft.body, enabled, drained: runner.drained } : draft.body));
    } catch (e) {
      // The server refuses an agent or a token here: say so as it is.
      setError(errorText(e, 'Could not save it.'));
    } finally {
      setSaving(false);
    }
  };

  const err = (f: string) => (problem?.field === f ? problem.message : undefined);
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={runner ? 'Edit runner' : 'Add runner'}
      onSubmit={submit}
      submitLabel="Save"
      saving={saving}
      error={error}
      dirty={!!runner ? true : labels.length > 0 || !!labelText.trim() || !!note.trim()}
    >
      <div className="flex flex-col gap-4">
        {runner ? (
          <p className="text-[14px] font-semibold">{workspaceName(runner.workspaceId)}</p>
        ) : (
          <Select
            label="Workspace"
            value={workspaceId}
            onChange={setWorkspaceId}
            options={workspaces.map((w) => ({ value: w.id, label: workspaceDisplayName(w) }))}
            placeholder={workspaces.length ? undefined : 'No workspace left'}
            error={err('workspaceId')}
          />
        )}
        <div className="flex flex-col gap-2">
          <TextField
            label="Labels"
            placeholder="gpu"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            value={labelText}
            onChange={(e) => (e.target.value.endsWith(',') ? addLabel(e.target.value.slice(0, -1)) : setLabelText(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && labelText.trim()) (e.preventDefault(), addLabel());
            }}
            onBlur={() => addLabel()}
            error={typed ?? err('labels')}
            hint={<InfoTip label="About labels">{`${RUNS_ON_TIP} ${RUNNER_RISK_TIP}`}</InfoTip>}
          />
          {labels.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Labels">
              {labels.map((l) => (
                <li key={l}>
                  <button
                    type="button"
                    aria-label={`Remove label ${l}`}
                    onClick={() => setLabels((x) => x.filter((y) => y !== l))}
                    className="press inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full bg-surface-2 pr-2.5 pl-3 font-mono text-[13px] focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                  >
                    <span className="truncate">{l}</span>
                    <X className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <TextField
          label="At once"
          inputMode="numeric"
          autoComplete="off"
          value={maxRuns}
          onChange={(e) => setMaxRuns(e.target.value)}
          error={err('maxRuns')}
          hint={<InfoTip label="About at once">{`Runs it takes at the same time, ${MIN_RUNS} to ${MAX_RUNS} (its own included).`}</InfoTip>}
        />
        {runner && (
          <div className="flex items-center justify-between gap-3">
            <span id="runner-enabled" className="text-[14px] font-medium">
              Enabled
            </span>
            <Switch labelledBy="runner-enabled" checked={enabled} onChange={setEnabled} />
          </div>
        )}
        <TextArea label="Note" optional rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </FormDialog>
  );
}
