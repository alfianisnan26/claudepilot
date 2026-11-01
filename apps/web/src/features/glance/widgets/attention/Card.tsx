import { ATTENTION_KIND_LABEL, ATTENTION_WHY_LABEL } from '@portal/contracts';
import { KIND_ICON } from '@/features/attention/look';
import { ATTENTION_PATH, needsYouPreview } from '@/features/attention/model';
import { useAttention } from '@/features/attention/store';
import { CardFoot, CardList, CardRow, Unread } from '../shared/card';
import { compactCount, shortAgo } from '../shared/format';
import { GlanceFailed, GlanceSkeleton } from '../shared/states';
import { useNow } from '../shared/useNow';
import { ContextLine } from '../shared/context';

/**
 * Home's "Needs you": a strict preview of the Needs you page (owner, 2026-11-01: "consistency"). It reads the page's own list
 * (`GET /api/attention`, the same store), keeps the page's order, shows its first rows (each opens the exact item, as the page's row does),
 * and Show all opens the page. It used to read the glance snapshot and also listed interrupted agents, failed CI runs and tickets, which
 * the page does not (they have their own tiles: Agents, CI, Tickets), so the tile said 47 where the page said nothing.
 */
export function AttentionCard() {
  const { list, failed, reload } = useAttention();
  const now = useNow();
  if (!list) return failed ? <GlanceFailed reload={reload} message="Could not read what needs you." /> : <GlanceSkeleton />;
  const p = needsYouPreview(list);
  return (
    <div data-needs-you-preview="">
      {p.items.length === 0 ? (
        <ContextLine>{p.unavailable.length ? 'Nothing found.' : 'Nothing needs you.'}</ContextLine>
      ) : (
        <CardList label="Needs you">
          {p.items.map((i) => {
            const Icon = KIND_ICON[i.kind];
            const meta = [ATTENTION_WHY_LABEL[i.why], ...i.who.map((w) => w.label)].join(' · ');
            return (
              <CardRow
                key={`${i.kind}:${i.id}`}
                to={i.link}
                label={`${ATTENTION_KIND_LABEL[i.kind]}: ${i.title}. ${meta}`}
                lead={<Icon className={i.why === 'production_uat' || i.why === 'secrets_permissions' ? 'size-4 text-danger' : 'size-4 text-gold'} />}
                title={i.title}
                meta={<span className="min-w-0 truncate">{meta}</span>}
                trail={shortAgo(i.since, now)}
              />
            );
          })}
        </CardList>
      )}
      {p.total > 0 && <CardFoot to={`${ATTENTION_PATH}?view=list`}>{p.more > 0 ? `Show all · ${compactCount(p.total)}` : 'Show all'}</CardFoot>}
      <Unread what={p.unavailable.map((k) => ATTENTION_KIND_LABEL[k])} />
    </div>
  );
}
