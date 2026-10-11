import { ChipGroup } from '@isnanme/ui';
import type { PoolSummary } from '@portal/contracts';
import { TriangleAlert } from 'lucide-react';
import { setCounts } from './summary';

/**
 * Secret sets in the create dialog's Add-ons and the Configuration picker, with what assigning means
 * (FR10): everyone who can sign in can read them, and a set other workspaces use spreads further.
 */
export function SecretsAddOn({ pools, value, onChange }: { pools: PoolSummary[]; value: string[]; onChange: (poolIds: string[]) => void }) {
  if (pools.length === 0) return <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No secret sets yet.</p>;
  const picked = pools.filter((p) => value.includes(p.id));
  const shared = picked.filter((p) => p.workspaces > 0);
  const empty = picked.filter((p) => setCounts(p).needsValue > 0);
  return (
    <div className="flex flex-col gap-2">
      <ChipGroup
        multiple
        label="Secrets"
        value={value}
        onChange={onChange}
        options={pools.map((p) => ({ value: p.id, label: p.name, detail: p.revision ? `r${p.revision}` : undefined }))}
      />
      {picked.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-flame-soft px-3 py-2 text-[13px] text-ink-soft">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p>Anyone who can sign in to this portal can read these secrets.</p>
            {shared.map((p) => (
              <p key={p.id}>
                {p.name} is used by {p.workspaces} workspace{p.workspaces === 1 ? '' : 's'} already: prefer read-only tokens.
              </p>
            ))}
            {empty.map((p) => (
              <p key={p.id}>{p.name} has secrets that need a value; they’re left out until someone saves one.</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
