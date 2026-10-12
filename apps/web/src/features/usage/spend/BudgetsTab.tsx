import { Button, ConfirmDialog, FormDialog, LoadError, Menu, RowsSkeleton, Segmented, Select, SwitchRow, TextField, useToast } from '@isnanme/ui';
import type { BudgetPeriod, BudgetState } from '@portal/contracts';
import { Ellipsis } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { ApiError, errorText } from '@/lib/api';
import { formatPercent } from '@/lib/usage';
import { localTime, TONE_TEXT } from '../claude/format';
import { Bar } from '../claude/Meter';
import { useClaudeUsage, useNow } from '../claude/useClaudeUsage';
import { FigureValue } from '../figure';
import { usageSpendApi } from './api';
import { budgetName, EMPTY_FORM, formFrom, LEVEL_TONE, limitText, pausedSentence, resetWords, sortBudgets, toInput, usedText, type BudgetForm, type FormErrors } from './budget';
import { NotAvailable } from './shared';
import { stableOrder } from './stable';
import { useLoad } from './useLoad';

const BUDGET_FORMULA = 'Used ÷ limit, for the day or month in the portal’s time zone. Dollars are Claude Code’s price estimate (API list prices), not a bill; tokens are input + output + cache writes. With both limits the fuller one counts.';

/** The scopes a budget can have: everything, a workspace, or one Claude, from the Claudes the portal knows (plus the one being edited if it is gone). */
function useScopeOptions(current: string | null): { value: string; label: string }[] {
  const { report } = useClaudeUsage();
  return useMemo(() => {
    const out = [{ value: 'all', label: 'Everything' }];
    const seen = new Set<string>();
    for (const c of report?.claudes ?? []) {
      if (!seen.has(c.workspaceId)) {
        seen.add(c.workspaceId);
        out.push({ value: `workspace:${c.workspaceId}`, label: `Workspace · ${c.workspaceName}` });
      }
    }
    for (const c of report?.claudes ?? []) out.push({ value: `claude:${c.claudeId}`, label: `${c.claudeName} · ${c.workspaceName}` });
    if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: 'Removed' });
    return out;
  }, [report, current]);
}

/** Making or changing a budget: its scope, period, limits and whether it pauses new messages. Field errors come from the portal. */
function BudgetDialog({ editing, onClose, onSaved }: { editing: BudgetState | 'new'; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const base = editing === 'new' ? EMPTY_FORM : formFrom(editing.budget);
  const [form, setForm] = useState<BudgetForm>(base);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scopes = useScopeOptions(editing === 'new' ? null : form.scope);
  const set = <K extends keyof BudgetForm>(k: K, v: BudgetForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const submit = async () => {
    const parsed = toInput(form);
    setErrors(parsed.errors ?? {});
    setFormError(null);
    if (!parsed.input) return;
    setSaving(true);
    try {
      if (editing === 'new') await usageSpendApi.createBudget(parsed.input);
      else await usageSpendApi.updateBudget(editing.budget.id, parsed.input);
      toast('Budget saved.', 'success');
      onSaved();
      onClose();
    } catch (e) {
      const d = e instanceof ApiError && e.details && typeof e.details === 'object' ? (e.details as Record<string, string>) : {};
      setErrors({ usd: d.limitUsd, tokens: d.limitTokens, name: d.name, limits: d.limits });
      setFormError(errorText(e, 'Couldn’t save the budget.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog
      open
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-1">
          {editing === 'new' ? 'New budget' : 'Edit budget'}
          <InfoTip label="About budgets">{BUDGET_FORMULA}</InfoTip>
        </span>
      }
      onSubmit={submit}
      submitLabel="Save"
      saving={saving}
      error={formError}
      dirty={dirty}
    >
      <div className="flex flex-col gap-4">
        <Select label="Scope" value={form.scope} onChange={(v) => set('scope', v)} options={scopes} />
        <Segmented
          label="Period"
          value={form.period}
          options={[
            { value: 'day' as BudgetPeriod, label: 'Day' },
            { value: 'month' as BudgetPeriod, label: 'Month' },
          ]}
          onChange={(v) => set('period', v)}
        />
        <TextField label="Dollars (est.)" inputMode="decimal" prefix="$" optional value={form.usd} onChange={(e) => set('usd', e.target.value)} error={errors.usd ?? errors.limits} />
        <TextField label="Tokens" inputMode="numeric" optional value={form.tokens} onChange={(e) => set('tokens', e.target.value)} error={errors.tokens} />
        <SwitchRow label="Pause new messages" description={form.pause ? 'Refuses new messages once used up, until the period ends or the budget changes.' : undefined} checked={form.pause} onChange={(v) => set('pause', v)} />
        <TextField label="Name" optional value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} maxLength={60} />
      </div>
    </FormDialog>
  );
}

/** One budget: its name and percent, a bar, what was used of the limit and when the count starts again. */
function BudgetRow({ s, nowMs, onEdit, onChanged, onDelete }: { s: BudgetState; nowMs: number; onEdit: () => void; onChanged: () => void; onDelete: () => void }) {
  const toast = useToast();
  const b = s.budget;
  const tone = LEVEL_TONE[s.level];
  const pct = s.usedPct.basis === 'unavailable' ? null : s.usedPct.value;
  const run = async (what: () => Promise<unknown>) => {
    try {
      await what();
      onChanged();
    } catch (e) {
      toast(errorText(e, 'Couldn’t change the budget.'), 'error');
    }
  };
  const snoozed = s.snoozedUntil ? `snoozed until ${localTime(s.snoozedUntil, nowMs)}` : null;
  return (
    <li className={`rounded-[24px] border border-line bg-surface p-4 ${b.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-2">
        <span dir="auto" className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={budgetName(s)}>
          {budgetName(s)}
        </span>
        <span className={`shrink-0 text-[15px] font-semibold tabular-nums ${TONE_TEXT[tone]}`}>
          <FigureValue figure={s.usedPct} format={formatPercent} formula={BUDGET_FORMULA} />
        </span>
        <Menu
          label={`${budgetName(s)} options`}
          align="right"
          trigger={<Ellipsis className="size-[18px]" aria-hidden="true" />}
          items={[
            { label: 'Edit', onSelect: onEdit },
            ...(b.mode === 'alert'
              ? [
                  { label: 'Snooze 1 hour', onSelect: () => void run(() => usageSpendApi.snoozeBudget(b.id, '1h')) },
                  { label: 'Snooze 4 hours', onSelect: () => void run(() => usageSpendApi.snoozeBudget(b.id, '4h')) },
                  { label: 'Until it resets', onSelect: () => void run(() => usageSpendApi.snoozeBudget(b.id, 'reset')) },
                  ...(s.snoozedUntil ? [{ label: 'Alert me again', onSelect: () => void run(() => usageSpendApi.unsnoozeBudget(b.id)) }] : []),
                ]
              : []),
            { label: b.enabled ? 'Turn off' : 'Turn on', onSelect: () => void run(() => usageSpendApi.updateBudget(b.id, { enabled: !b.enabled })) },
            { label: 'Delete', danger: true, onSelect: onDelete },
          ]}
        />
      </div>
      <Bar pct={pct === null ? null : Math.min(100, pct)} tone={tone} className="mt-2.5 h-2" />
      <p className="mt-2 text-[13px] text-muted [overflow-wrap:anywhere]">
        {[usedText(s) || limitText(b), resetWords(s.periodEnd, nowMs), b.mode === 'pause' ? 'pauses when used up' : null, snoozed, b.enabled ? null : 'off'].filter(Boolean).join(' · ')}
      </p>
      {s.paused && (
        <p className="mt-1 flex items-center gap-1 text-[13px] font-medium text-danger">
          New messages are paused.
          <InfoTip label="Why messages are paused">{pausedSentence(s)}</InfoTip>
        </p>
      )}
    </li>
  );
}

/**
 * Usage → Budgets: a daily or monthly limit for everything, one workspace or one Claude, in estimated dollars and/or tokens
 * (docs/prd/claude-usage.md §23). A budget only alerts unless it is set to pause new messages, which is opt-in and says so on its row.
 */
export function BudgetsTab() {
  const { data, failed, forbidden, reload } = useLoad(() => usageSpendApi.budgets(), 'budgets');
  const now = useNow(30_000);
  const [editing, setEditing] = useState<BudgetState | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BudgetState | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // Sorted neediest first when the tab opens or a budget is saved; a refresh while it is open never moves a card (new ones go last).
  const order = useRef<string[]>([]);
  const rows = useMemo(() => {
    const out = stableOrder(sortBudgets(data?.budgets ?? []), (s) => s.budget.id, order.current);
    order.current = out.map((s) => s.budget.id);
    return out;
  }, [data]);
  const resort = () => {
    order.current = [];
    void reload();
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await usageSpendApi.deleteBudget(deleting.budget.id);
      setDeleting(null);
      resort();
    } catch (e) {
      toast(errorText(e, 'Couldn’t delete the budget.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Budgets"
        description="A daily or monthly limit for everything, a workspace or one Claude. It alerts at 80 %, 95 % and when used up; it only refuses new messages if you set it to."
        action={
          <Button size="sm" onClick={() => setEditing('new')} disabled={forbidden}>
            New budget
          </Button>
        }
      />
      {forbidden ? (
        <NotAvailable />
      ) : failed ? (
        <LoadError onRetry={reload} />
      ) : !data ? (
        <RowsSkeleton rows={2} card progress trailing label="Loading budgets" />
      ) : rows.length === 0 ? (
        <p className="py-3 text-[13px] text-muted">No budgets yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((s) => (
            <BudgetRow key={s.budget.id} s={s} nowMs={now} onEdit={() => setEditing(s)} onChanged={() => void reload()} onDelete={() => setDeleting(s)} />
          ))}
        </ul>
      )}
      {editing && <BudgetDialog key={editing === 'new' ? 'new' : editing.budget.id} editing={editing} onClose={() => setEditing(null)} onSaved={resort} />}
      <ConfirmDialog
        open={!!deleting}
        title="Delete budget"
        description={deleting ? `“${budgetName(deleting)}” stops counting and its alerts end.` : ''}
        confirmLabel="Delete"
        loading={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}
