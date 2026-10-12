import { EmptyState, Select, Switch, useToast } from '@isnanme/ui';
import { NOTIFY_KIND_INFO, type NotifyDestination, type NotifyKind } from '@portal/contracts';
import { BellOff } from 'lucide-react';
import { useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { notifyApi } from './api';
import { ClampedText } from './ClampedText';
import { hears, KIND_WHEN, MATRIX_KINDS, withKind } from './matrix';
import { loadNotifyOverview, patchOverview } from './store';

/**
 * Which events go where. Wide screens: events as rows, destinations as columns. Phones: pick a destination, then one switch per event
 * (a table of three columns does not fit 390 px). Each switch saves at once.
 */
export function EventsMatrix({ destinations }: { destinations: NotifyDestination[] }) {
  const toast = useToast();
  const [pick, setPick] = useState<string>('');
  if (destinations.length === 0)
    return (
      <EmptyState icon={<BellOff className="size-6" />} title="No destinations">
        Turn on this device or add a channel to choose events.
      </EmptyState>
    );

  const toggle = async (d: NotifyDestination, kind: NotifyKind, on: boolean) => {
    const kinds = withKind(d.kinds, kind, on);
    patchOverview((o) => ({ ...o, destinations: o.destinations.map((x) => (x.id === d.id ? { ...x, kinds } : x)) }));
    try {
      const saved = await notifyApi.update(d.id, { kinds });
      patchOverview((o) => ({ ...o, destinations: o.destinations.map((x) => (x.id === d.id ? saved : x)) }));
    } catch (e) {
      toast(errorText(e, 'Could not save.'), 'error');
      await loadNotifyOverview();
    }
  };

  const label = (kind: NotifyKind) => (
    <span className="inline-flex items-center gap-1">
      <span>{NOTIFY_KIND_INFO[kind].label}</span>
      <InfoTip label={`About ${NOTIFY_KIND_INFO[kind].label}`}>{KIND_WHEN[kind]}</InfoTip>
    </span>
  );
  const current = destinations.find((d) => d.id === pick) ?? destinations[0]!;

  return (
    <>
      <div className="hidden overflow-x-auto overflow-y-hidden rounded-2xl border border-line bg-surface md:block">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="border-b border-line text-left text-[12.5px] text-muted">
              <th scope="col" className="px-4 py-2.5 font-semibold">
                <span className="sr-only">Event</span>
              </th>
              {destinations.map((d) => (
                <th key={d.id} scope="col" className="max-w-40 px-3 py-2.5 text-center font-semibold">
                  <ClampedText>{d.name}</ClampedText>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MATRIX_KINDS.map((k) => (
              <tr key={k} className="border-b border-line last:border-0">
                <th scope="row" className="px-4 py-1.5 text-left font-medium">
                  {label(k)}
                </th>
                {destinations.map((d) => (
                  <td key={d.id} className="px-3 py-1.5 text-center">
                    <Switch checked={hears(d, k)} onChange={(on) => void toggle(d, k, on)} label={`${NOTIFY_KIND_INFO[k].label} for ${d.name}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden">
        {destinations.length > 1 && <Select label="For" value={current.id} onChange={setPick} options={destinations.map((d) => ({ value: d.id, label: d.name }))} />}
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {MATRIX_KINDS.map((k) => (
            <li key={k} className="flex min-h-12 items-center justify-between gap-3 px-4 py-1.5 font-medium">
              <span id={`ev-${k}`}>{label(k)}</span>
              <Switch checked={hears(current, k)} onChange={(on) => void toggle(current, k, on)} labelledBy={`ev-${k}`} />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
