import { InfoTip } from '@/components/InfoTip';
import { Stat, Stats, CardFoot } from '../shared/card';
import { GlanceFailed, GlanceSkeleton, StaleNote } from '../shared/states';
import { metricsFigures } from './model';
import { metricsStore } from './store';

/** Home's Metrics: the four headline numbers of all programs over 24 hours; the page behind it has the charts. */
export function MetricsCard() {
  const { data, failed, denied, stale, reload } = metricsStore.use();
  if (!data) return failed ? <GlanceFailed reload={reload} denied={denied} /> : <GlanceSkeleton />;
  const figures = metricsFigures(data);
  return (
    <div data-metrics-card="">
      {stale && <StaleNote reload={reload} />}
      <Stats>
        {figures.map((f) => (
          <Stat key={f.key} value={f.value} label={f.key === 'effectiveness' ? 'Effective' : f.label} />
        ))}
      </Stats>
      <p className="flex items-center justify-center gap-1 text-xs text-muted">
        Last 24 hours
        <InfoTip label="About these numbers">
          Efficiency and effectiveness are scores from 0 to 100 (the Metrics page lists their parts and weights). Resolved: tickets done in
          the last 24 hours. Median: created to done. A dash is a number the portal does not have, not a zero.
        </InfoTip>
      </p>
      <CardFoot to="/admin/usage?tab=metrics">Metrics</CardFoot>
    </div>
  );
}
