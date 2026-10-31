import { FormDialog, Segmented, Select, SwitchRow, TextArea, TextField, useToast } from '@isnanme/ui';
import { type Trigger, type TriggerActionType, type TriggerInput, workspaceDisplayName } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { api, ApiError, errorText } from '@/lib/api';
import { ACTION_OPTIONS, detailErrors, emptyTriggerForm, formFromTrigger, formProblems, TRIGGER_NAME_MAX, triggerBody, type TriggerForm } from './editor';

/**
 * The triggers editor on the Schedules page (T-2950, general-manager PRD §9.2): makes a cron trigger, or changes a trigger's name,
 * schedule, workspace, action and instruction, through the trigger routes (`POST`/`PATCH /api/triggers`), which check the person's
 * right and the values. A 422's field errors land on their fields. `trigger`: the record to change; null: a new cron trigger.
 */
export function TriggerEditor(p: { open: boolean; trigger: Trigger | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<TriggerForm>(emptyTriggerForm());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [workspaces, setWorkspaces] = useState<{ value: string; label: string }[]>([]);
  const isCron = !p.trigger || p.trigger.source === 'cron';

  useEffect(() => {
    if (!p.open) return;
    setForm(p.trigger ? formFromTrigger(p.trigger) : emptyTriggerForm());
    setErrors({});
    setError(null);
    setDirty(false);
    let live = true;
    api.workspaces.list().then(
      (list) => live && setWorkspaces(list.map((w) => ({ value: w.id, label: workspaceDisplayName(w) }))),
      () => live && setWorkspaces([]),
    );
    return () => {
      live = false;
    };
  }, [p.open, p.trigger]);

  const set = <K extends keyof TriggerForm>(k: K, v: TriggerForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  // A workspace the list does not hold (removed, or not visible) stays selectable, so a change never moves the trigger silently.
  const wsOptions =
    form.workspaceId && !workspaces.some((w) => w.value === form.workspaceId) ? [...workspaces, { value: form.workspaceId, label: form.workspaceId }] : workspaces;

  const submit = async () => {
    const found = formProblems(form, isCron);
    setErrors(found);
    setError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      if (p.trigger) await api.updateTrigger(p.trigger.id, triggerBody(form, p.trigger) as Partial<TriggerInput>);
      else await api.createTrigger(triggerBody(form, null) as TriggerInput);
      toast(p.trigger ? `${form.name.trim()} saved` : `${form.name.trim()} added`);
      p.onSaved();
    } catch (e) {
      const fields = e instanceof ApiError ? detailErrors(e.details) : {};
      setErrors(fields);
      setError(errorText(e, 'Couldn’t save it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={p.open}
      onClose={p.onClose}
      title={
        <span className="inline-flex items-center gap-1.5">
          {p.trigger ? 'Edit trigger' : 'New trigger'}
          <InfoTip label="About triggers">
            A trigger starts an agent session, a ticket or both on a schedule. Its limits and approval are kept as they are; a webhook trigger
            is made with the API, where its secret can be shown once.
          </InfoTip>
        </span>
      }
      onSubmit={submit}
      submitLabel={p.trigger ? 'Save' : 'Add'}
      saving={saving}
      error={error}
      dirty={dirty}
    >
      <div className="flex flex-col gap-4" data-trigger-editor={p.trigger?.id ?? 'new'}>
        <TextField label="Name" value={form.name} maxLength={TRIGGER_NAME_MAX} error={errors.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        {isCron ? (
          <>
            <TextField
              label="Cron"
              value={form.expr}
              error={errors['cron.expr'] ?? errors.cron}
              hint="Minute hour day month weekday, e.g. 0 3 * * * for 03:00 every day."
              inputMode="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => set('expr', e.target.value)}
            />
            <TextField
              label="Time zone"
              optional
              value={form.tz}
              error={errors['cron.tz']}
              placeholder="The portal’s"
              hint="An IANA zone such as Asia/Jakarta."
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => set('tz', e.target.value)}
            />
          </>
        ) : null}
        <Select
          label="Workspace"
          value={form.workspaceId}
          placeholder="Pick one"
          options={wsOptions}
          error={errors['action.workspaceId']}
          onChange={(v) => set('workspaceId', v)}
        />
        <Segmented<TriggerActionType> label="Starts" value={form.action} onChange={(v) => set('action', v)} options={ACTION_OPTIONS} />
        <TextArea
          label="Instruction"
          rows={4}
          value={form.template}
          error={errors['action.template']}
          hint="The opening message of the session or the ticket’s text."
          onChange={(e) => set('template', e.target.value)}
        />
        <SwitchRow label="On" checked={form.enabled} onChange={(v) => set('enabled', v)} />
      </div>
    </FormDialog>
  );
}
