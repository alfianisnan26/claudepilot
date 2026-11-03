import type { SettingValue, SettingView, SettingsView as SettingsList } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { settingInput } from './model';
import { btnPlain, Confirm, field, InfoTip, list, Section, type Run } from './ui';

/*
 * Settings: the portal-wide policies (the same settings store as the main portal's Settings page: Bypass, caps, lockdown, retention, ...),
 * by group. A switch that turns a protection off asks first (the server refuses it without the confirmation). Every change is step-up.
 */

export function SettingsView({ run }: { run: Run }) {
  const [view, setView] = useState<SettingsList | null>(null);
  const load = useCallback(() => void run(api.settings).then((v) => v && setView(v)), [run]);
  useEffect(load, [load]);
  const [ask, setAsk] = useState<{ s: SettingView; value: SettingValue } | null>(null);
  const save = async (s: SettingView, value: SettingValue, confirm = false) => {
    const r = await run(() => api.setSetting(s.key, value, confirm));
    if (r) setView((v) => (v ? { ...v, settings: v.settings.map((x) => (x.key === r.key ? r : x)) } : v));
    return !!r;
  };
  const change = (s: SettingView, value: SettingValue) => {
    if (s.protective !== undefined && value !== s.protective) setAsk({ s, value });
    else void save(s, value);
  };
  return (
    <Section title="Settings" onReload={load} tip="Policies for the whole portal. The same values as Settings in the portal.">
      {!view && <p className="text-sm text-muted">Loading</p>}
      {view?.groups.map((g) => {
        const rows = view.settings.filter((s) => s.group === g.id);
        if (!rows.length) return null;
        return (
          <div key={g.id} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{g.label}</h3>
            <ul className={list}>
              {rows.map((s) => (
                <li key={s.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="flex min-w-0 flex-1 items-center gap-1 text-sm">
                    <span className="break-any">{s.label}</span>
                    {s.help && <InfoTip label={`About ${s.label}`}>{s.help}</InfoTip>}
                  </span>
                  <SettingControl s={s} onChange={(v) => change(s, v)} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {ask && (
        <Confirm
          title={ask.s.label}
          body={ask.s.confirmText ?? 'This turns a protection off.'}
          action="Change"
          danger
          onConfirm={() => save(ask.s, ask.value, true)}
          onClose={() => setAsk(null)}
        />
      )}
    </Section>
  );
}

function SettingControl({ s, onChange }: { s: SettingView; onChange: (v: SettingValue) => void }) {
  const [text, setText] = useState(String(s.value));
  useEffect(() => setText(String(s.value)), [s.value]);
  // PILOT-1129: set in the deploy manifest, read-only here.
  if (s.fixedBy)
    return (
      <span className="text-[13px] [overflow-wrap:anywhere]">
        {String(s.value) || 'Off'} <span className="text-muted">({s.fixedBy})</span>
      </span>
    );
  if (s.type === 'boolean') return <input type="checkbox" className="size-6" aria-label={s.label} checked={s.value === true} onChange={(e) => onChange(e.target.checked)} />;
  if (s.choices)
    return (
      <select className={`${field} max-w-48`} aria-label={s.label} value={String(s.value)} onChange={(e) => onChange(e.target.value)}>
        {s.choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  const next = settingInput(s.type, text);
  const dirty = text !== String(s.value);
  return (
    <span className="flex w-full gap-2 sm:w-auto">
      <input className={`${field} sm:w-40`} aria-label={s.label} inputMode={s.type === 'number' ? 'decimal' : undefined} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" className={btnPlain} disabled={!dirty || next === null} onClick={() => next !== null && onChange(next)}>
        Save
      </button>
    </span>
  );
}
