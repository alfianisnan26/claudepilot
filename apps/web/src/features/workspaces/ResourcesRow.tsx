import { Badge, ConfirmDialog, FormDialog, Segmented, TextField, useToast } from '@isnanme/ui';
import type { Workspace, WorkspaceResources, WorkspaceResourcesApply } from '@portal/contracts';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';
import { draftOf, parseDraft, requestsSummary, resourcesSummary, type ResourceDraft, type ResourceKey } from './resources';

const FIELDS: { key: ResourceKey; label: string; unit: string }[] = [
  { key: 'cpus', label: 'CPU limit', unit: 'cores' },
  { key: 'memoryMb', label: 'Memory limit', unit: 'MiB' },
  { key: 'cpuRequest', label: 'CPU reserved', unit: 'cores' },
  { key: 'memoryRequestMb', label: 'Memory reserved', unit: 'MiB' },
];

/**
 * The Resources row of a Kubernetes workspace's sheet (T-98): its limits and what it reserves, as the Deployment has them, and a change
 * waiting for the next start. Edit opens the four numbers with when to apply them: now (a confirm first: the pod restarts and every
 * session in it ends) or at the next restart. The server decides (bounds, a CI run, the fit on the node) and its refusal is shown as it is.
 */
export function ResourcesRow({ w, open }: { w: Workspace; open: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<WorkspaceResources | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<ResourceDraft | null>(null);
  const [when, setWhen] = useState<WorkspaceResourcesApply>('next_restart');
  const [problems, setProblems] = useState<Partial<Record<ResourceKey, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFailed(false);
    api.workspaces.resources(w.id).then(
      (r) => live && setState(r),
      () => live && setFailed(true),
    );
    return () => void (live = false);
  }, [open, w.id, w.status, w.cpus, w.memoryMb]);

  const edit = () => {
    if (!state) return;
    setDraft(draftOf(state.wanted, state.live));
    setWhen('next_restart');
    setProblems({});
    setError(state.problem);
  };

  const send = async () => {
    if (!draft) return;
    const parsed = parseDraft(draft);
    if (!parsed.values) return setProblems(parsed.problems);
    setSaving(true);
    try {
      const done = await api.workspaces.setResources(w.id, { apply: when, ...parsed.values });
      setState(done);
      setDraft(null);
      toast(done.outcome === 'applied' ? (done.running ? 'Applied. Restarting' : 'Applied') : done.outcome === 'pending' ? 'Saved for the next restart' : 'No change');
    } catch (e) {
      const details = (e as { details?: Record<string, string> }).details ?? {};
      const fields = Object.fromEntries(FIELDS.filter((f) => details[f.key]).map((f) => [f.key, details[f.key]!]));
      setProblems(fields);
      setError(Object.keys(fields).length ? null : errorText(e, 'Couldn’t change it.'));
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  const submit = () => {
    if (!draft) return;
    const parsed = parseDraft(draft);
    if (!parsed.values) return setProblems(parsed.problems);
    if (when === 'now' && state?.running) return setConfirming(true);
    return send();
  };

  return (
    <>
      <div className="flex items-start justify-between gap-4 px-3.5 py-2.5">
        <dt className="inline-flex shrink-0 items-center gap-1 text-muted">
          Resources
          <InfoTip label="About resources">
            CPU and memory of this workspace: the limits it may use, and what its pod reserves on the node. A change applies now (the pod restarts and every agent in it ends) or at its next restart. It must fit on the node, and it waits for a running CI run.
          </InfoTip>
        </dt>
        <dd className="flex min-w-0 items-center justify-end gap-1 text-right">
          <span className="min-w-0">
            <span className="block break-words font-medium tabular-nums">{state ? resourcesSummary(state.live) : failed ? 'Unavailable' : '…'}</span>
            {state && <span className="block break-words text-[12.5px] tabular-nums text-muted">{requestsSummary(state.live)}</span>}
            {state?.pending && (
              <span className="mt-1 block">
                <Badge tone={state.problem ? 'danger' : 'neutral'}>{state.problem ? 'Not applied' : 'At next restart'}</Badge>
              </span>
            )}
          </span>
          <button
            type="button"
            aria-label="Change resources"
            title="Change"
            disabled={!state}
            onClick={edit}
            className="press -my-2 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40"
          >
            <SlidersHorizontal className="size-4" />
          </button>
        </dd>
      </div>

      <FormDialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        size="sm"
        title="Resources"
        onSubmit={submit}
        submitLabel={when === 'now' ? 'Apply now' : 'Save'}
        danger={when === 'now' && !!state?.running}
        saving={saving && !confirming}
        error={error}
      >
        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              inputMode="decimal"
              autoComplete="off"
              suffix={<span className="text-[12.5px] text-muted">{f.unit}</span>}
              value={draft?.[f.key] ?? ''}
              onChange={(e) => (setDraft((d) => (d ? { ...d, [f.key]: e.target.value } : d)), setProblems((p) => ({ ...p, [f.key]: undefined })))}
              error={problems[f.key]}
            />
          ))}
        </div>
        <div className="mt-4">
          <Segmented<WorkspaceResourcesApply>
            label="When"
            value={when}
            options={[
              { value: 'next_restart', label: 'Next restart' },
              { value: 'now', label: 'Now' },
            ]}
            onChange={setWhen}
          />
        </div>
        {when === 'now' && state?.running && <p className="mt-3 rounded-2xl bg-danger-soft p-3 text-sm text-ink-soft">The pod restarts: every agent in this workspace ends.</p>}
      </FormDialog>

      <ConfirmDialog
        open={confirming}
        title="Restart now?"
        description="Every agent in this workspace ends. The pod restarts with the new CPU and memory."
        confirmLabel="Apply now"
        loading={saving}
        onConfirm={() => void send()}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
