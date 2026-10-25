import type { MetricsOverview } from '@portal/contracts';
import { headlineFigures, type HeadlineFigure } from '@/features/lab/metricsModel';
import type { GlanceCompact } from '../../types';

// The Metrics widget and its Home card (T-2360, docs/prd/claude-usage.md §28.15): efficiency and effectiveness (0 to 100), tickets resolved
// in the last 24 hours and the median created-to-done. Not a judgement: the dot is neutral while there are numbers (no threshold is a
// standing decision), and "-" with a hollow dot when the portal has none.

export type { HeadlineFigure };
export const metricsFigures = (o: MetricsOverview | null): HeadlineFigure[] => headlineFigures(o);

/** The chip: the efficiency score ("72", never more than five characters); the four numbers in the title. */
export function metricsCompact(o: MetricsOverview | null, failed: boolean): GlanceCompact {
  if (!o) return { value: failed ? '-' : null, level: 'unknown', title: failed ? 'Metrics: not available' : 'Metrics: loading', loading: !failed };
  const f = headlineFigures(o);
  const eff = f.find((x) => x.key === 'efficiency');
  const said = f.map((x) => `${x.label.toLowerCase()} ${x.available ? x.value : 'unavailable'}`).join(', ');
  if (!eff?.available) return { value: '-', level: 'unknown', title: `Metrics, last 24 hours: ${said}` };
  return { value: eff.value, level: 'idle', title: `Metrics, last 24 hours: ${said}` };
}
