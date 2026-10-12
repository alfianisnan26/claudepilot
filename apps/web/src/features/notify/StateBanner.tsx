import type { NotifyOverview } from '@portal/contracts';
import { TriangleAlert } from 'lucide-react';

const TEXT: Record<Exclude<NotifyOverview['state'], 'ready'>, string> = {
  locked: 'The portal is locked, so nothing is sent. Unlock it to receive notifications.',
  frozen: 'The portal is frozen, so nothing is sent.',
  readonly: 'The database is read-only, so settings cannot be saved.',
};

/** One line when the portal cannot deliver (PWA PRD 11.2, Locked, Frozen, read-only). */
export function StateBanner({ state }: { state: NotifyOverview['state'] }) {
  if (state === 'ready') return null;
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-2xl border border-line bg-gold-soft px-4 py-3 text-[13.5px] text-ink">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-gold" aria-hidden="true" />
      <span>{TEXT[state]}</span>
    </div>
  );
}
