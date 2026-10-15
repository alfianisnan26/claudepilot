import { SummaryView } from '@/features/lab/SummaryBlock';
import { CardFoot } from '../shared/card';
import { GlanceFailed, GlanceSkeleton, StaleNote } from '../shared/states';
import { paceStore } from './store';

/** Home's Pace: the five figures of the Crew summary for the day, against the day before. */
export function PaceCard() {
  const { data, failed, denied, stale, reload } = paceStore.use();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  return (
    <>
      {stale && <StaleNote reload={reload} />}
      {data.headline ? (
        <SummaryView summary={data.headline} expandable={false} />
      ) : (
        <p className="py-2 text-center text-xs text-muted">unavailable: this portal does not report it yet.</p>
      )}
      <CardFoot to="/admin/usage?tab=crew">Crew</CardFoot>
    </>
  );
}
