import type { ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';

/** Org settings' shared bits (owner request 2026-11-01): a section's title with its InfoTip, a sub-heading, an error line. */

export const selectField = 'h-12 rounded-2xl border border-line bg-surface px-3 text-[15px] font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-accent';

export function SectionTitle({ id, children, about }: { id: string; children: ReactNode; about?: ReactNode }) {
  return (
    <h2 id={id} className="mb-3 flex items-center gap-1 px-1 text-lg font-semibold text-ink">
      {children}
      {about && <InfoTip label={`About ${typeof children === 'string' ? children.toLowerCase() : 'this section'}`}>{about}</InfoTip>}
    </h2>
  );
}

export function SubTitle({ children, about, label }: { children: ReactNode; about?: ReactNode; label?: string }) {
  return (
    <h3 className="mt-4 mb-2 flex items-center gap-1 px-1 text-[13px] font-semibold text-muted">
      {children}
      {about && <InfoTip label={label ?? 'About this'}>{about}</InfoTip>}
    </h3>
  );
}

export function Alert({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" data-org-error="" className="mb-3 rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm font-medium [overflow-wrap:anywhere] text-danger">
      {text}
    </p>
  );
}

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
