import { Select } from '@isnanme/ui';
import type { PoolSummary } from '@portal/contracts';
import { Link } from 'react-router';

/**
 * The persona choice in the create dialog's Add-ons and the Configuration picker: one persona or none
 * (Persona PRD FR10). Only a published persona can be assigned, so a draft shows but can't be picked.
 */
export function PersonaAddOn({ pools, value, onChange }: { pools: PoolSummary[]; value: string[]; onChange: (poolIds: string[]) => void }) {
  if (pools.length === 0)
    return (
      <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">
        No personas yet.{' '}
        <Link className="font-semibold text-accent" to="/admin/pools?tab=personas">
          Create one
        </Link>
      </p>
    );
  return (
    <Select
      label="Persona"
      value={value[0] ?? ''}
      onChange={(id) => onChange(id ? [id] : [])}
      options={[{ value: '', label: 'None' }, ...pools.map((p) => ({ value: p.id, label: p.revision ? `${p.name} · r${p.revision}` : `${p.name} (not published)`, disabled: !p.revision }))]}
    />
  );
}
