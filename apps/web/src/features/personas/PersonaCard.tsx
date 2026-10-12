import { Button } from '@isnanme/ui';
import type { PoolSummary } from '@portal/contracts';
import { Inbox, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLive } from '@/lib/live';
import { usePersonaPoolInfo } from './identities';
import { partsLine, personaContent } from './labels';
import { PersonaAvatar } from './PersonaAvatar';
import { ProposalsDialog } from './ProposalsDialog';

/** The card's left side: the persona's avatar, or its initials (Persona PRD A10). */
export function PersonaLeading({ pool }: { pool: PoolSummary }) {
  const info = usePersonaPoolInfo()?.[pool.id];
  return <PersonaAvatar name={pool.name} avatar={info?.avatar} size="md" className="mt-0.5" />;
}

/** The card's detail line: what the persona sets, a star when it is the default, and the proposals waiting for a person. */
export function PersonaSummary({ pool }: { pool: PoolSummary }) {
  const info = usePersonaPoolInfo()?.[pool.id];
  const [open, setOpen] = useState(false);
  const c = personaContent(pool);
  const line = c ? partsLine(c) || 'Empty' : '';
  const pending = info?.pendingProposals ?? 0;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      {info?.isDefault && <Star aria-label="Default for new workspaces" className="size-3 shrink-0 fill-amber-400 text-amber-500" />}
      <span className="min-w-0 truncate">{line}</span>
      {pending > 0 && (
        <>
          <button type="button" onClick={() => setOpen(true)} className="shrink-0 font-semibold text-accent hover:underline">
            {pending} proposal{pending === 1 ? '' : 's'}
          </button>
          <ProposalsDialog open={open} onClose={() => setOpen(false)} poolId={pool.id} names={{ [pool.id]: pool.name }} />
        </>
      )}
    </span>
  );
}

/** Beside "New persona": the review queue, only while something waits (Persona PRD A10). */
export function ProposalsAction() {
  const info = usePersonaPoolInfo();
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const total = Object.values(info ?? {}).reduce((n, p) => n + p.pendingProposals, 0);
  const load = () => void api.pools.list('persona').then((list) => setNames(Object.fromEntries(list.map((p) => [p.id, p.name]))), () => undefined);
  useEffect(() => {
    if (open) load();
  }, [open]);
  useLive('pools', () => open && load(), open);
  if (total === 0) return null;
  return (
    <>
      <Button variant="secondary" icon={<Inbox className="size-4" />} aria-label={`Proposals: ${total} waiting`} onClick={() => setOpen(true)}>
        <span className="hidden sm:inline">Proposals</span>
        <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">{total}</span>
      </Button>
      <ProposalsDialog open={open} onClose={() => setOpen(false)} names={names} />
    </>
  );
}
