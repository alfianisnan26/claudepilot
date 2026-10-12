import { Button, ConfirmDialog, Dialog, LoadError, Switch, useToast } from '@isnanme/ui';
import type { SettingChange, SettingsView, SettingValue, SettingView } from '@portal/contracts';
import { History } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { ApiError, errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { settingsApi } from './api';

const verb = (v: SettingValue) => (v === true ? 'Turn on' : v === false ? 'Turn off' : 'Change');
const show = (v: SettingValue | null) => (v === null ? '' : typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v));

/**
 * Portal-wide settings (settings-policies PRD): every setting an area defines, in sections. A row is a label,
 * an ⓘ with what it does, and the control; nothing else. Turning a protection off (or an agent permission on)
 * asks first, in one line, and the server refuses the change without that confirmation.
 */
export function SettingsPage() {
  const toast = useToast();
  const [data, setData] = useState<SettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ setting: SettingView; value: SettingValue } | null>(null);
  const [history, setHistory] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setData(await settingsApi.list());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const apply = async (s: SettingView, value: SettingValue, confirmed = false) => {
    setBusy(s.key);
    try {
      const next = await settingsApi.set(s.key, { value, ...(confirmed ? { confirm: true } : {}) });
      setData((d) => d && { ...d, settings: d.settings.map((x) => (x.key === next.key ? next : x)) });
      setConfirm(null);
    } catch (e) {
      // The server decides what needs a confirmation: if the page didn't know, it asks now.
      if (e instanceof ApiError && e.code === 'CONFIRMATION_REQUIRED' && !confirmed) setConfirm({ setting: s, value });
      else toast(errorText(e, 'Could not change the setting.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  /** A protection moving away from its protective value asks first; everything else just applies. */
  const change = (s: SettingView, value: SettingValue) => {
    if (s.protective !== undefined && s.value === s.protective && value !== s.protective) setConfirm({ setting: s, value });
    else void apply(s, value);
  };

  return (
    <>
      <PageHeader
        title="Settings"
        action={
          <Button variant="ghost" size="icon" aria-label="Change history" onClick={() => setHistory(true)}>
            <History className="size-[18px]" />
          </Button>
        }
      />
      {failed && <LoadError onRetry={load} />}
      {!data && !failed && (
        <div className="flex flex-col gap-6" aria-busy="true">
          <div className="skeleton h-32 rounded-[24px]" />
          <div className="skeleton h-20 rounded-[24px]" />
        </div>
      )}
      {data && (
        <div className="flex flex-col gap-6">
          {data.groups.map((g) => (
            <section key={g.id} aria-labelledby={`settings-${g.id}`}>
              <h2 id={`settings-${g.id}`} className="mb-2 px-1 text-[13px] font-semibold text-muted">
                {g.label}
              </h2>
              <Card>
                <ul className="divide-y divide-line">
                  {data.settings
                    .filter((s) => s.group === g.id)
                    .map((s) => (
                      <li key={s.key} className="flex min-h-14 items-center gap-2 px-4 py-2.5 sm:px-5">
                        <span className="flex min-w-0 flex-1 items-center gap-1 font-semibold">
                          <span id={`setting-${s.key}`} className="line-clamp-2 break-words">
                            {s.label}
                          </span>
                          {s.help && <InfoTip label={`About ${s.label}`}>{s.help}</InfoTip>}
                        </span>
                        <Control setting={s} busy={busy === s.key} onChange={(v) => change(s, v)} />
                      </li>
                    ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={confirm ? `${verb(confirm.value)} “${confirm.setting.label}”?` : ''}
        description={confirm?.setting.confirmText ?? 'This removes a protection.'}
        confirmLabel={confirm ? verb(confirm.value) : ''}
        loading={!!busy}
        onConfirm={() => confirm && void apply(confirm.setting, confirm.value, true)}
        onClose={() => !busy && setConfirm(null)}
      />
      <HistoryDialog open={history} labels={Object.fromEntries((data?.settings ?? []).map((s) => [s.key, s.label]))} onClose={() => setHistory(false)} />
    </>
  );
}

/** The control at the end of a row: a switch for on/off, a small field for a number or a text. */
function Control({ setting, busy, onChange }: { setting: SettingView; busy: boolean; onChange: (v: SettingValue) => void }) {
  if (setting.type === 'boolean') return <Switch label={setting.label} checked={setting.value === true} disabled={busy} onChange={onChange} />;
  return <ValueField key={String(setting.value)} setting={setting} busy={busy} onCommit={onChange} />;
}

function ValueField({ setting, busy, onCommit }: { setting: SettingView; busy: boolean; onCommit: (v: SettingValue) => void }) {
  const number = setting.type === 'number';
  const [text, setText] = useState(String(setting.value));
  const commit = () => {
    if (text === String(setting.value)) return;
    if (!number) return onCommit(text);
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) onCommit(n);
    else setText(String(setting.value));
  };
  return (
    <input
      aria-label={setting.label}
      value={text}
      disabled={busy}
      inputMode={number ? 'decimal' : 'text'}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={`h-10 rounded-xl border border-line bg-surface px-3 text-base text-ink outline-none hover:border-line-strong focus:border-ink/40 focus:ring-4 focus:ring-[var(--ring)] disabled:opacity-50 ${number ? 'w-24 text-right' : 'w-48'}`}
    />
  );
}

/** Who changed what, newest first (every change is audited). */
function HistoryDialog({ open, labels, onClose }: { open: boolean; labels: Record<string, string>; onClose: () => void }) {
  const [rows, setRows] = useState<SettingChange[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    setRows(null);
    setFailed(false);
    settingsApi.audit().then(setRows, () => setFailed(true));
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title="History">
      {failed && <p className="text-[13px] text-danger">Could not load.</p>}
      {rows && rows.length === 0 && <p className="text-[13px] text-muted">No changes yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {rows.map((r) => (
            <li key={r.id} className="flex items-baseline gap-3 px-4 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{labels[r.key] ?? r.key}</span>
                <span className="text-muted">
                  {' '}
                  {show(r.oldValue)} → {show(r.newValue)}
                </span>
              </span>
              <span className="shrink-0 text-muted" title={formatDateTime(r.at)}>
                {r.actor} · {timeAgo(r.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
