import { Button, cn, Dialog, Segmented, Select, SwitchRow, TextField } from '@isnanme/ui';
import { CONNECT_LABEL_MAX, CONNECT_TARGET_ID_MAX, type ConnectEnrollmentCreated, type ConnectKind, type ConnectRole, type ConnectSettings, type ConnectTargetRow, type ConnectTargetView } from '@portal/contracts';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { connectApi } from './api';
import { CommandBlock } from './CommandBlock';
import { kindsOf } from './kinds';
import { LiveLine } from './LiveLine';
import { PlatformPicker } from './PlatformPicker';
import { PlanSheet, ScriptSheet } from './ScriptSheet';
import { useEnrollment } from './useEnrollment';
import { canAddNode, cell, formProblems, idFromInput, initialForm, offersSudo, platformChoices, toCreateRequest, toEnrollmentRequest, withKind, withPlatform, withRole, type WizardForm } from './wizard';

/** A new target (step 1, then step 2), or another command for one that exists ("Command", "Add node", the Outdated upgrade). */
export type WizardMode = { type: 'new' } | { type: 'command'; target: ConnectTargetView; upgrade?: boolean };

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);

export function AddTargetDialog({
  open,
  mode,
  rows,
  settings,
  onClose,
  onChanged,
}: {
  open: boolean;
  mode: WizardMode;
  rows: ConnectTargetRow[];
  settings: ConnectSettings | null;
  onClose: () => void;
  /** Something changed on the server (a target made or removed): the page loads again. */
  onChanged: () => void;
}) {
  const [form, setForm] = useState<WizardForm>(() => initialForm(ua(), ''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  // The secret lives here, in memory, until the dialog closes.
  const [created, setCreated] = useState<ConnectEnrollmentCreated | null>(null);
  const [baseline, setBaseline] = useState<string[]>([]);
  const [script, setScript] = useState(false);
  const [plan, setPlan] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const platformLabel = useId();
  const mine = mode.type === 'new' ? null : mode.target;

  const step = created ? 'command' : mine ? 'creating' : 'form';
  const { target: live, line, refresh } = useEnrollment(created?.target.id ?? null, created?.enrollment.id ?? null, baseline);

  const makeCommand = useCallback(
    async (target: ConnectTargetView) => {
      setSaving(true);
      setFormError(null);
      try {
        const platform = target.enrollment?.platform ?? initialForm(ua(), '').platform;
        const res = await connectApi.enroll(target.id, toEnrollmentRequest({ platform, kind: target.kind }));
        setBaseline(target.nodes.filter((n) => n.state === 'enrolled').map((n) => n.id));
        setCreated(res);
        onChanged();
      } catch (e) {
        setFormError(errorText(e, 'Could not make a command.'));
      } finally {
        setSaving(false);
      }
    },
    [onChanged],
  );

  useEffect(() => {
    if (!open) {
      setCreated(null);
      return;
    }
    setForm(initialForm(ua(), ''));
    setErrors({});
    setShowErrors(false);
    setFormError(null);
    setAdvanced(false);
    setScript(false);
    setPlan(false);
    setCreated(null);
    setBaseline([]);
    if (mine) void makeCommand(mine);
    // `mine` identity changes with every refresh of the page; the dialog opening is what starts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode.type === 'command' ? mode.target.id : '']);

  const taken = useMemo(() => rows.map((r) => r.id), [rows]);
  const problems = useMemo(() => formProblems(form, { taken, allowHttp: settings?.allowHttp ?? false }), [form, taken, settings?.allowHttp]);
  const set = (patch: Partial<WizardForm>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(problems).length) {
      if (problems.portalUrl || problems.ttlMinutes) setAdvanced(true);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await connectApi.create(toCreateRequest(form));
      setBaseline([]);
      setCreated(res);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object') setErrors(e.details as Record<string, string>);
      setFormError(errorText(e, 'Could not add it.'));
    } finally {
      setSaving(false);
    }
  };

  const connected = line?.state === 'connected';
  // Cancel undoes what this dialog made: a new target (while nothing connected) or the new token.
  const cancel = async () => {
    if (!created) return onClose();
    try {
      if (mode.type === 'new') await connectApi.remove(created.target.id);
      else await connectApi.revokeEnrollment(created.target.id, created.enrollment.id);
    } catch {
      // gone already, or not allowed: the row says what is true
    }
    onChanged();
    onClose();
  };

  const done = () => {
    onChanged();
    onClose();
  };

  const err = (k: 'id' | 'portalUrl' | 'ttlMinutes' | 'hostAccess' | 'platform') => (showErrors ? (problems[k] ?? errors[k]) : errors[k]);

  const title = step === 'form' ? 'Add target' : (created?.target.label ?? mine?.label ?? 'Command');

  const footer =
    step === 'form' ? (
      <>
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" form="add-target-form" loading={saving}>
          Continue
        </Button>
      </>
    ) : (
      <>
        {created && !connected && mode.type === 'new' && (
          <Button variant="ghost" onClick={() => void cancel()}>
            Cancel
          </Button>
        )}
        {created && !connected && mode.type === 'command' && (
          <Button variant="ghost" onClick={() => void cancel()}>
            Revoke command
          </Button>
        )}
        <Button onClick={done}>Done</Button>
      </>
    );

  return (
    <>
      <Dialog open={open} onClose={onClose} title={title} footer={footer} stepKey={step}>
        {step === 'form' && (
          <form
            id="add-target-form"
            noValidate
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <RolePick value={form.role} onChange={(r) => setForm((f) => withRole(f, r))} />
            <Select
              label="Type"
              value={form.kind}
              onChange={(v) => setForm((f) => withKind(f, v as ConnectKind))}
              options={kindsOf(form.role).map((k) => ({ value: k.kind, label: k.label }))}
            />
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-1">
                <span id={platformLabel} className="text-sm font-semibold text-ink-soft">
                  System
                </span>
                <InfoTip label="About systems">{cell(form).note || 'Where you paste the command.'}</InfoTip>
              </div>
              <PlatformPicker value={form.platform} choices={platformChoices(form.kind)} onChange={(p) => setForm((f) => withPlatform(f, p))} labelledBy={platformLabel} invalid={!!err('platform')} />
              {err('platform') && <p className="text-[13px] font-medium text-danger">{err('platform')}</p>}
            </div>
            <TextField
              label="Name"
              placeholder="my-server"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={CONNECT_TARGET_ID_MAX}
              className="[&_input]:font-mono"
              value={form.id}
              onChange={(e) => (set({ id: idFromInput(e.target.value) }), setErrors(({ id: _, ...rest }) => rest))}
              error={err('id')}
              data-autofocus
            />
            {form.kind === 'host' && (
              <div className="flex flex-col gap-1">
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
                  <input type="checkbox" className="size-5 shrink-0 accent-[var(--color-primary)]" checked={form.hostAccess} onChange={(e) => set({ hostAccess: e.target.checked })} aria-invalid={!!err('hostAccess')} />
                  Shell as you, no isolation.
                </label>
                {err('hostAccess') && <p className="text-[13px] font-medium text-danger">{err('hostAccess')}</p>}
              </div>
            )}
            <div className="rounded-2xl border border-line">
              <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} className="press flex min-h-11 w-full items-center gap-2 rounded-2xl px-4 py-2 text-left">
                <span className="flex-1 text-sm font-semibold text-ink-soft">Advanced</span>
                <ChevronDown className={cn('size-4 text-muted transition-transform', advanced && 'rotate-180')} />
              </button>
              {advanced && (
                <div className="flex min-w-0 flex-col gap-4 border-t border-line px-4 py-3">
                  <TextField
                    label="Portal address"
                    placeholder={settings?.publicUrl ?? (typeof location === 'undefined' ? '' : location.origin)}
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="[&_input]:font-mono"
                    value={form.portalUrl}
                    onChange={(e) => set({ portalUrl: e.target.value })}
                    error={err('portalUrl')}
                    hint={/^http:\/\//i.test(form.portalUrl.trim()) && !err('portalUrl') ? 'Not https: the token is sent in the clear.' : undefined}
                  />
                  {form.kind === 'kubernetes' && (
                    <>
                      <TextField label="Namespace" placeholder="claudepilot-workspaces" autoCapitalize="none" spellCheck={false} className="[&_input]:font-mono" value={form.namespace} onChange={(e) => set({ namespace: e.target.value })} />
                      <TextField label="Storage class" optional autoCapitalize="none" spellCheck={false} className="[&_input]:font-mono" value={form.storageClass} onChange={(e) => set({ storageClass: e.target.value })} />
                    </>
                  )}
                  {form.kind !== 'kubernetes' && (
                    <TextField label="Node name" optional autoCapitalize="none" spellCheck={false} maxLength={CONNECT_LABEL_MAX} className="[&_input]:font-mono" value={form.nodeName} onChange={(e) => set({ nodeName: e.target.value })} />
                  )}
                  <TextField label="Token lifetime" optional inputMode="numeric" suffix="min" placeholder={String(settings?.tokenTtlMinutes ?? 15)} value={form.ttlMinutes} onChange={(e) => set({ ttlMinutes: e.target.value.replace(/\D/g, '') })} error={err('ttlMinutes')} />
                  {offersSudo(form) && <SwitchRow label="Run with sudo" checked={form.sudo} onChange={(sudo) => set({ sudo })} />}
                  {settings?.caConfigured && <SwitchRow label="Private CA" checked={form.privateCa} onChange={(privateCa) => set({ privateCa })} />}
                </div>
              )}
            </div>
            {formError && (
              <p role="alert" className="text-[13px] font-medium text-danger [overflow-wrap:anywhere]">
                {formError}
              </p>
            )}
          </form>
        )}
        {step === 'creating' && (
          <div className="flex min-h-40 flex-col items-start gap-3" role="status" aria-live="polite">
            {formError ? (
              <>
                <p className="text-sm font-medium text-danger [overflow-wrap:anywhere]">{formError}</p>
                {mine && (
                  <Button variant="secondary" onClick={() => void makeCommand(mine)}>
                    Try again
                  </Button>
                )}
              </>
            ) : (
              <div className="h-28 w-full animate-pulse rounded-xl bg-surface-2" aria-label="Making the command" />
            )}
          </div>
        )}
        {step === 'command' && created && (
          <div className="flex min-w-0 flex-col gap-3">
            {!connected && (
              <CommandBlock commands={created.commands} upgradeFirst={mode.type === 'command' && !!mode.upgrade} onViewScript={() => setScript(true)} onWhatItDoes={() => setPlan(true)} />
            )}
            <LiveLine
              line={line}
              onRetry={() => void refresh()}
              onNewCommand={() => void makeCommand(live ?? created.target)}
            />
            {connected && canAddNode(created.target.kind) && (
              <Button variant="secondary" className="self-start" onClick={() => void makeCommand(live ?? created.target)}>
                Add node
              </Button>
            )}
          </div>
        )}
      </Dialog>
      {created && <ScriptSheet open={script} onClose={() => setScript(false)} commands={created.commands} />}
      {created && <PlanSheet open={plan} onClose={() => setPlan(false)} targetId={created.target.id} enrollmentId={created.enrollment.id} />}
    </>
  );
}

function RolePick({ value, onChange }: { value: ConnectRole; onChange: (r: ConnectRole) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="text-sm font-semibold text-ink-soft">Role</span>
        <InfoTip label="About roles">Cluster: new workspaces can be placed here. Single: the machine or container becomes one workspace.</InfoTip>
      </div>
      <Segmented<ConnectRole>
        label="Role"
        value={value}
        onChange={onChange}
        options={[
          { value: 'cluster', label: 'Cluster' },
          { value: 'single', label: 'Single' },
        ]}
      />
    </div>
  );
}
