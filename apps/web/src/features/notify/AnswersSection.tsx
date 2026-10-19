import { ConfirmDialog, SwitchRow, useToast } from '@isnanme/ui';
import type { NotifyOverview, NotifyUserPrefs } from '@portal/contracts';
import { useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { notifyApi } from './api';
import { loadNotifyOverview, patchOverview } from './store';

type Key = 'deny' | 'allowRead' | 'allowEdit' | 'allowCommand';

const ROWS: { key: Key; label: string; tip: string; confirm?: string }[] = [
  { key: 'deny', label: 'Deny', tip: 'Deny a tool request from the notification. The request stays open in the app only if you do not answer.' },
  { key: 'allowRead', label: 'Read', tip: 'Allow Read, Glob, Grep and LS from the notification, only for a path inside the agent folder that is not hidden, and only when the whole request is shown.', confirm: 'Reading files will be allowed from a notification, when the request is fully shown and inside the agent folder.' },
  { key: 'allowEdit', label: 'Edit', tip: 'Allow Edit, Write and NotebookEdit from the notification, with the same path rules as Read.', confirm: 'Editing files will be allowed from a notification, when the request is fully shown and inside the agent folder.' },
  { key: 'allowCommand', label: 'Command', tip: 'Allow a Bash command from the notification, only when it is short, plain text with no shell operators, and fully shown.', confirm: 'Running commands will be allowed from a notification. Only short plain commands without operators qualify, but one tap on a lock screen will run them.' },
];

/** The caller's answer switches. An Allow needs a confirmation; the platform ceiling greys everything out. */
export function AnswersSection({ overview }: { overview: NotifyOverview }) {
  const toast = useToast();
  const [asking, setAsking] = useState<Key | null>(null);
  const [saving, setSaving] = useState(false);
  const off = !overview.actionsCeiling;

  const save = async (key: Key, value: boolean, confirm = false) => {
    setSaving(true);
    const next: NotifyUserPrefs = { ...overview.policy, [key]: value, ...(confirm ? { confirm: true } : {}) };
    try {
      const saved = await notifyApi.setPrefs(next);
      patchOverview((o) => ({ ...o, policy: { deny: saved.deny, allowRead: saved.allowRead, allowEdit: saved.allowEdit, allowCommand: saved.allowCommand } }));
      setAsking(null);
    } catch (e) {
      toast(errorText(e, 'Could not save.'), 'error');
      setAsking(null);
      await loadNotifyOverview();
    } finally {
      setSaving(false);
    }
  };

  const row = ROWS.find((r) => r.key === asking);
  return (
    <>
      {off && <p className="mb-2 text-[13.5px] text-muted">An administrator has switched answers from notifications off for everyone.</p>}
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {ROWS.map((r) => (
          <li key={r.key}>
            <SwitchRow
              className="px-4"
              disabled={off}
              label={
                <span className="inline-flex items-center gap-1.5">
                  {r.label}
                  <InfoTip label={`About ${r.label}`}>{r.tip}</InfoTip>
                </span>
              }
              checked={overview.policy[r.key]}
              onChange={(v) => (v && r.confirm ? setAsking(r.key) : void save(r.key, v))}
            />
          </li>
        ))}
      </ul>
      <ConfirmDialog open={!!row} title={`Allow ${row?.label.toLowerCase() ?? ''} from a notification`} description={row?.confirm} confirmLabel="Allow" tone={row?.key === 'allowCommand' ? 'danger' : 'primary'} loading={saving} onConfirm={() => asking && void save(asking, true, true)} onClose={() => setAsking(null)} />
    </>
  );
}
