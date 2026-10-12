import { ChipGroup } from '@isnanme/ui';
import type { PoolSummary } from '@portal/contracts';
import { KeyRound } from 'lucide-react';
import { MONO } from './parts';
import { secretNames, setContent } from './summary';

/**
 * MCP sets in the create dialog's Add-ons and the Configuration picker (PRD §15), with the Secrets & env
 * names the picked sets reference listed under them: a server whose name the workspace's secret sets
 * don't provide is left out (FR10, Secrets & env FR22).
 */
export function McpAddOn({ pools, value, onChange }: { pools: PoolSummary[]; value: string[]; onChange: (poolIds: string[]) => void }) {
  if (pools.length === 0) return <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No MCP sets yet.</p>;
  const picked = pools.filter((p) => value.includes(p.id));
  const names = [...new Set(picked.flatMap((p) => secretNames(setContent(p))))].sort();
  return (
    <div className="flex flex-col gap-2">
      <ChipGroup
        multiple
        label="MCP sets"
        value={value}
        onChange={onChange}
        options={pools.map((p) => ({ value: p.id, label: p.name, detail: `${setContent(p).servers.length}` }))}
      />
      {names.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-ink-soft">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-muted" />
          <span>
            Needs{' '}
            <span className="text-[12px]" style={{ fontFamily: MONO }}>
              {names.join(', ')}
            </span>{' '}
            from a Secrets set. A server whose secret isn’t provided is left out until one is.
          </span>
        </p>
      )}
    </div>
  );
}
