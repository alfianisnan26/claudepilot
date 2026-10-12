import { Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ticketsApi } from './api';

/**
 * A small link to a ticket (tickets PRD FR17). `compact` (the session page's header line) is the icon and the id,
 * with the summary in the tooltip; otherwise a pill that names the summary too: "T-12 · Fix the login redirect".
 */
export function TicketChip({ ticketId, compact, className }: { ticketId: string; compact?: boolean; className?: string }) {
  const [summary, setSummary] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    ticketsApi.brief(ticketId).then(
      (b) => current && setSummary(b.summary),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [ticketId]);
  return (
    <Link
      to={`/admin/tickets/${ticketId}`}
      title={summary ? `${ticketId}: ${summary}` : ticketId}
      className={
        compact
          ? `inline-flex items-center gap-1 rounded align-bottom font-semibold text-ink-soft hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${className ?? ''}`
          : `inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-semibold text-ink-soft hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${className ?? ''}`
      }
    >
      <Ticket className={compact ? 'size-3' : 'size-3.5 shrink-0'} aria-hidden="true" />
      <span className="tabular-nums">{ticketId}</span>
      {summary && !compact && <span className="min-w-0 truncate font-medium">· {summary}</span>}
    </Link>
  );
}
