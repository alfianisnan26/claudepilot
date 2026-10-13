import { CircleAlert, MessagesSquare, Rocket, Ticket, Workflow } from 'lucide-react';
import { CardFoot, CardList, CardRow, Unread } from '../shared/card';
import { compactCount, shortAgo } from '../shared/format';
import { GlanceFailed, GlanceLine, GlanceSkeleton, StaleNote } from '../shared/states';
import { useGlance } from '../shared/store';
import { useNow } from '../shared/useNow';
import { needsYou, type NeedKind } from './needs';

const ICON: Record<NeedKind, typeof Ticket> = { approval: CircleAlert, deploy: Rocket, interrupted: MessagesSquare, ci: Workflow, ticket: Ticket };
const KIND_WORD: Record<NeedKind, string> = { approval: 'Approval', deploy: 'Deploy to approve', interrupted: 'Interrupted session', ci: 'Failed CI run', ticket: 'Ticket for you' };

/**
 * Home's "Needs you": every approval, held deploy, interrupted session, failed CI run and ticket waiting on a person, most blocking first,
 * one tap to each. Answering an approval happens where its whole text is shown (its session, or the Attention widget's full form).
 */
export function AttentionCard() {
  const { data, failed, denied, stale, reload } = useGlance();
  const now = useNow();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const n = needsYou(data, 6);
  const more = n.total - n.listed;
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      {n.items.length === 0 ? (
        <GlanceLine>{n.unread.length ? 'Nothing found.' : 'Nothing needs you.'}</GlanceLine>
      ) : (
        <CardList label="Needs you">
          {n.items.map((i) => {
            const Icon = ICON[i.kind];
            return (
              <CardRow
                key={i.key}
                to={i.href}
                label={`${KIND_WORD[i.kind]}: ${i.title}. ${i.meta}`}
                lead={<Icon className={i.level === 'critical' ? 'size-4 text-danger' : 'size-4 text-gold'} />}
                title={i.title}
                meta={<span className="min-w-0 truncate">{i.meta}</span>}
                trail={i.at ? shortAgo(i.at, now) : undefined}
              />
            );
          })}
        </CardList>
      )}
      {more > 0 && <CardFoot to="/admin/home?glance=attention">+{compactCount(more)} more</CardFoot>}
      <Unread what={n.unread} />
    </>
  );
}
