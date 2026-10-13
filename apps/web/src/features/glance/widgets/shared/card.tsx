import { cn } from '@isnanme/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { compactCount } from './format';

// The parts the Home cards share (docs/prd/glance-widgets.md §18): a row that opens its source, a small figure with its label, and
// the link at a card's foot. Rows are 44 px and their text truncates with the whole of it in the title (QA A5, A9).

/** A row that opens its source: a leading mark, two lines (the first truncates, the second is quiet), and a trailing figure. */
export function CardRow({ to, lead, title, meta, trail, label, dim }: { to: string; lead: ReactNode; title: ReactNode; meta?: ReactNode; trail?: ReactNode; label: string; dim?: boolean }) {
  return (
    <li>
      <Link to={to} aria-label={label} title={label} className={cn('press -mx-2 flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-surface-2', dim && 'opacity-70')}>
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          {lead}
        </span>
        <span className="min-w-0 flex-1">
          <span dir="auto" className="block truncate text-sm font-semibold">
            {title}
          </span>
          {meta && (
            <span dir="auto" className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
              {meta}
            </span>
          )}
        </span>
        {trail !== undefined && <span className="shrink-0 text-xs text-muted tabular-nums">{trail}</span>}
      </Link>
    </li>
  );
}

export function CardList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="flex flex-col">
      {children}
    </ul>
  );
}

/** A figure and its one-word label; "-" stands for a figure the portal could not give (never a guessed zero). */
export function Stat({ value, label, tone, to }: { value: number | string | null; label: string; tone?: 'danger' | 'gold' | 'accent'; to?: string }) {
  const shown = value === null ? '-' : typeof value === 'number' ? compactCount(value) : value;
  const body = (
    <>
      <span className={cn('block text-xl leading-7 font-bold tabular-nums', tone === 'danger' && 'text-danger', tone === 'accent' && 'text-accent')}>{shown}</span>
      <span className="block truncate text-xs text-muted">{label}</span>
    </>
  );
  const cls = 'flex min-h-11 min-w-0 flex-col justify-center rounded-xl px-2 py-1';
  return to ? (
    <Link to={to} aria-label={`${label}: ${shown}`} className={cn(cls, 'press hover:bg-surface-2')}>
      {body}
    </Link>
  ) : (
    <div className={cls} role="group" aria-label={`${label}: ${shown}`}>
      {body}
    </div>
  );
}

/** A row of figures that wraps on a narrow card, never scrolls sideways. */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="-mx-2 mb-2 grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-1">{children}</div>;
}

/** The link at a card's foot: the page behind it, with how many more there are when the card lists only some. */
export function CardFoot({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="press -mx-2 mt-1 flex min-h-11 items-center justify-center rounded-xl text-xs font-semibold text-muted hover:bg-surface-2 hover:text-ink">
      {children}
    </Link>
  );
}

/** One quiet line under a list: what could not be read. */
export function Unread({ what }: { what: string[] }) {
  if (!what.length) return null;
  return (
    <p role="status" className="pt-1 text-center text-xs text-muted">
      {what.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(', ')} could not be read.
    </p>
  );
}
