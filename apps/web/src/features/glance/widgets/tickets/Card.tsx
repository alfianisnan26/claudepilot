import { TICKET_PRIORITY_LABEL, TICKET_STATUS_LABEL } from '@portal/contracts';
import { Ticket } from 'lucide-react';
import { CardFoot, CardList, CardRow, Stat, Stats } from '../shared/card';
import { shortAgo } from '../shared/format';
import { GlanceFailed, GlanceSkeleton, StaleNote } from '../shared/states';
import { useNow } from '../shared/useNow';
import { ticketsView } from './model';
import { ticketsStore } from './store';

/** Home's Tickets: the queue by status, how many wait for a person (a tap lists them), and the three newest open tickets. */
export function TicketsCard() {
  const { data, failed, denied, stale, reload } = ticketsStore.use();
  const now = useNow();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const v = ticketsView(data);
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      <Stats>
        <Stat value={v.needsYou} label="For you" tone={v.needsYou ? 'danger' : undefined} to="/admin/tickets?assignee=user" />
        {v.byStatus.map((s) => (
          <Stat key={s.status} value={s.count} label={s.label} to={`/admin/tickets?s=${s.status}`} />
        ))}
      </Stats>
      {data.items.length > 0 ? (
        <CardList label="Newest tickets">
          {data.items.map((t) => (
            <CardRow
              key={t.id}
              to={`/admin/tickets/${encodeURIComponent(t.id)}`}
              label={`${t.id}: ${t.summary}. ${TICKET_STATUS_LABEL[t.status]}, ${TICKET_PRIORITY_LABEL[t.priority]}`}
              lead={<Ticket className="size-4 text-muted" />}
              title={t.summary}
              meta={
                <span className="min-w-0 truncate">
                  <span className="font-mono">{t.id}</span> · {TICKET_STATUS_LABEL[t.status]} · <span className={t.priority === 'urgent' ? 'font-semibold text-danger' : undefined}>{TICKET_PRIORITY_LABEL[t.priority]}</span>
                </span>
              }
              trail={shortAgo(t.createdAt, now)}
            />
          ))}
        </CardList>
      ) : (
        <p className="py-2 text-center text-sm text-muted">No open tickets.</p>
      )}
      <CardFoot to="/admin/tickets">All tickets</CardFoot>
    </>
  );
}
