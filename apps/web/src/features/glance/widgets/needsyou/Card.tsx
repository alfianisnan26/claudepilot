import { ATTENTION_KIND_LABEL, ATTENTION_WHY_LABEL } from '@portal/contracts';
import { useAttention } from '@/features/attention/store';
import { KIND_ICON } from '@/features/attention/look';
import { ATTENTION_PATH } from '@/features/attention/model';
import { CardFoot, CardList, CardRow, Stat, Stats } from '../shared/card';
import { shortAgo } from '../shared/format';
import { GlanceFailed, GlanceLine, GlanceSkeleton } from '../shared/states';
import { useNow } from '../shared/useNow';
import { reviewView } from './model';

/** Home's Review: the count by source (each opens the list of that kind) and the newest item (opens the deck at its card). */
export function ReviewCard() {
  const { list, failed, reload } = useAttention();
  const now = useNow();
  if (!list) return failed ? <GlanceFailed reload={reload} /> : <GlanceSkeleton />;
  const v = reviewView(list);
  const newest = v.newest;
  const Icon = newest ? KIND_ICON[newest.item.kind] : null;
  return (
    <div data-review="">
      <Stats>
        {v.sources.map((s) => (
          <Stat key={s.kind} value={s.count} label={s.label} tone={s.count ? 'gold' : undefined} to={`${ATTENTION_PATH}?view=list`} />
        ))}
      </Stats>
      {newest && Icon ? (
        <CardList label="Newest">
          <CardRow
            to={newest.to}
            label={`Newest, ${ATTENTION_KIND_LABEL[newest.item.kind]}: ${newest.item.title}`}
            lead={<Icon className="size-4 text-gold" />}
            title={newest.item.title}
            meta={<span className="min-w-0 truncate">{`${ATTENTION_KIND_LABEL[newest.item.kind]} · ${ATTENTION_WHY_LABEL[newest.item.why]}`}</span>}
            trail={shortAgo(newest.item.since, now)}
          />
        </CardList>
      ) : (
        <GlanceLine>Nothing needs you.</GlanceLine>
      )}
      <CardFoot to={ATTENTION_PATH}>{v.total ? `Open deck · ${v.total}` : 'Open'}</CardFoot>
    </div>
  );
}
