import { Button, ChipGroup, FormDialog, Select, SwitchRow, TextField, useToast } from '@isnanme/ui';
import { NOTIFY_KIND_INFO, type NotifyDestination, type QuietHours } from '@portal/contracts';
import { Moon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorText } from '@/lib/api';
import { ClampedText } from './ClampedText';
import { MATRIX_KINDS } from './matrix';
import { notifyApi } from './api';
import { browserZone, quietDefault, quietLine, quietProblem, windowMinutes, zoneList } from './quiet';
import { loadNotifyOverview } from './store';

/** Quiet hours, one line per destination (22:00 to 07:00 · Asia/Jakarta, or Off) and an editor. */
export function QuietSection({ destinations }: { destinations: NotifyDestination[] }) {
  const [editing, setEditing] = useState<NotifyDestination | null>(null);
  if (destinations.length === 0) return <p className="text-[13.5px] text-muted">Quiet hours are set per device or channel. None yet.</p>;
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {destinations.map((d) => (
          <li key={d.id} className="flex items-center gap-3 px-4 py-3">
            <Moon className="size-5 shrink-0 text-ink-soft" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold"><ClampedText>{d.name}</ClampedText></div>
              <p className="truncate text-[13px] text-muted">{quietLine(d.quiet)}</p>
            </div>
            <Button variant="secondary" onClick={() => setEditing(d)}>
              Edit
            </Button>
          </li>
        ))}
      </ul>
      <QuietDialog destination={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function QuietDialog({ destination, onClose }: { destination: NotifyDestination | null; onClose: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState<QuietHours>(() => quietDefault(browserZone()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!destination) return;
    setQ(destination.quiet.tz ? destination.quiet : { ...destination.quiet, tz: browserZone() });
    setError(null);
  }, [destination]);

  const problem = q.enabled ? quietProblem(q) : null;
  const dirty = !!destination && JSON.stringify(q) !== JSON.stringify(destination.quiet);

  const submit = async () => {
    if (!destination) return;
    setSaving(true);
    setError(null);
    try {
      await notifyApi.update(destination.id, { quiet: q, tz: q.tz });
      await loadNotifyOverview();
      toast('Saved');
      onClose();
    } catch (e) {
      setError(errorText(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  const mins = !problem && q.enabled ? windowMinutes(q) : 0;
  return (
    <FormDialog open={!!destination} onClose={onClose} title={`Quiet hours`} description={destination ? <ClampedText>{destination.name}</ClampedText> : undefined} onSubmit={submit} saving={saving} error={error} submitDisabled={!!problem || !dirty} dirty={dirty}>
      <div className="flex flex-col gap-4">
        <SwitchRow label="On" checked={q.enabled} onChange={(enabled) => setQ({ ...q, enabled })} />
        {q.enabled && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <TextField label="From" type="time" value={q.start} onChange={(e) => setQ({ ...q, start: e.target.value })} />
              <TextField label="To" type="time" value={q.end} onChange={(e) => setQ({ ...q, end: e.target.value })} error={problem ?? undefined} hint={mins ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}` : undefined} />
            </div>
            <Select label="Time zone" value={q.tz} onChange={(tz) => setQ({ ...q, tz })} options={zoneList(q.tz).map((z) => ({ value: z, label: z }))} />
            <ChipGroup
              multiple
              label="Break through"
              hint="Delivered even during quiet hours."
              value={q.breakthrough}
              onChange={(kinds) => setQ({ ...q, breakthrough: MATRIX_KINDS.filter((k) => kinds.includes(k)) })}
              options={MATRIX_KINDS.map((k) => ({ value: k, label: NOTIFY_KIND_INFO[k].label }))}
            />
          </>
        )}
      </div>
    </FormDialog>
  );
}
