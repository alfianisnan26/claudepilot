import { ChipGroup } from '@isnanme/ui';
import type { PoolSummary } from '@portal/contracts';
import { poolSummary } from './summary';

/** The create dialog's Add-on and the Configuration picker: one browser or none. */
export function BrowserAddOn({ pools, value, onChange }: { pools: PoolSummary[]; value: string[]; onChange: (poolIds: string[]) => void }) {
  if (pools.length === 0) return <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No browsers yet.</p>;
  return (
    <ChipGroup
      label="Browser"
      hideLabel
      value={value[0] ?? 'none'}
      onChange={(id) => onChange(id === 'none' ? [] : [id])}
      options={[{ value: 'none', label: 'None' }, ...pools.map((p) => ({ value: p.id, label: p.name, detail: poolSummary(p).split(' · ')[0] }))]}
    />
  );
}
