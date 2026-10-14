import { Button, Dialog, EmptyState, RowsSkeleton, useToast } from '@isnanme/ui';
import type { PersonaProposal } from '@portal/contracts';
import { Check, FileText, Image as ImageIcon, Tag, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { personasApi } from './api';
import { LineDiff } from './Diff';
import { PersonaAvatar } from './PersonaAvatar';

const KIND = { name: { label: 'Name', icon: Tag }, avatar: { label: 'Avatar', icon: ImageIcon }, instructions: { label: 'Instructions', icon: FileText } } as const;

/**
 * The review queue (Persona PRD A10, interface I11): what sessions asked to change about their own persona. A
 * proposal is not live; approving it is one tap, and so is rejecting it. What an agent wrote is shown as plain
 * text and never acted on. `poolId` narrows it to one persona; `names` says whose each one is.
 */
/** `focus`: one proposal to ring and scroll to (a link from Needs you). */
export function ProposalsDialog({ open, onClose, poolId, names, focus }: { open: boolean; onClose: () => void; poolId?: string; names: Record<string, string>; focus?: string | null }) {
  const toast = useToast();
  const [items, setItems] = useState<PersonaProposal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(await personasApi.proposals({ pool: poolId, status: 'pending' }));
    } catch {
      setItems([]);
    }
  }, [poolId]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  useLive('pools', () => void load(), open);
  const focused = !!focus && !!items?.some((p) => p.id === focus);
  useEffect(() => {
    if (focused) document.getElementById(`proposal-${focus}`)?.scrollIntoView({ block: 'nearest' });
  }, [focused, focus]);

  const decide = async (p: PersonaProposal, verb: 'approve' | 'reject') => {
    setBusy(p.id);
    try {
      await personasApi.decide(p.id, verb);
      toast(verb === 'approve' ? `${KIND[p.kind].label} approved` : `${KIND[p.kind].label} rejected`);
    } catch (e) {
      toast(errorText(e, 'Could not decide it.'), 'error');
    } finally {
      setBusy(null);
      await load();
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Proposals">
      {items === null ? (
        <RowsSkeleton rows={2} lines={2} trailing />
      ) : items.length === 0 ? (
        <EmptyState icon={<Check className="size-6" />} title="Nothing to review" />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((p) => {
            const { label, icon: Icon } = KIND[p.kind];
            return (
              <li
                key={p.id}
                id={`proposal-${p.id}`}
                aria-current={p.id === focus ? 'true' : undefined}
                className={`flex flex-col gap-2 rounded-2xl border px-3.5 py-3 ${p.id === focus ? 'border-accent ring-2 ring-accent' : 'border-line'}`}
              >
                <div className="flex items-center gap-2">
                  <Icon className="size-4 shrink-0 text-muted" />
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {label}
                    {!poolId && <span className="font-normal text-muted"> · {names[p.poolId] ?? 'persona'}</span>}
                  </p>
                  <Button size="sm" variant="ghost" aria-label={`Reject the ${label.toLowerCase()} proposal`} title="Reject" icon={<X className="size-4" />} onClick={() => void decide(p, 'reject')} disabled={busy === p.id} />
                  <Button size="sm" aria-label={`Approve the ${label.toLowerCase()} proposal`} title={p.problem ?? 'Approve'} icon={<Check className="size-4" />} onClick={() => void decide(p, 'approve')} loading={busy === p.id} disabled={!!p.problem} />
                </div>
                {p.kind === 'name' && (
                  <p className="text-[13.5px]">
                    <span className="text-muted">{names[p.poolId] ?? 'Now'}</span> → <span className="font-semibold">{p.name}</span>
                  </p>
                )}
                {p.kind === 'avatar' && p.avatar && <PersonaAvatar name={names[p.poolId] ?? 'Persona'} avatar={p.avatar} size="lg" />}
                {p.kind === 'instructions' && p.instructions && <LineDiff before={p.instructions.before} after={p.instructions.after} max={16} />}
                {p.reason && <p className="line-clamp-3 text-[13px] text-ink-soft">“{p.reason}”</p>}
                {p.problem && <p className="text-[12.5px] text-danger">{p.problem}</p>}
                <p className="text-[12px] text-muted">
                  {p.actor.replace('session:', 'session ').slice(0, 24)} · {timeAgo(p.createdAt)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
