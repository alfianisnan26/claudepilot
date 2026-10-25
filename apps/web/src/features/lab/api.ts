import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  LAB_API,
  METRICS_API,
  SCORECARD_API,
  type CrewScorecard,
  type CrewWindow,
  type LabExperimentView,
  type LabPeriod,
  type LabSummary,
  type MetricsFlow,
  type MetricsGroupBy,
  type MetricsInsights,
  type MetricsOverview,
  type MetricsProgram,
  type MetricsStage,
  type MetricsTickets,
  type MetricsTrend,
  type MetricsTrendKey,
  type MetricsTrendWindow,
  type MetricsWindow,
} from '@portal/contracts';
import { ApiError } from '@/lib/api';
import { metricsQuery } from './metricsModel';

/** GET with the session cookie; the `{ data }` / `{ error }` envelope unwrapped. The lab answers a refusal as 404: shown as "not available". */
async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await track(fetch(path, { credentials: 'same-origin' }));
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (res.status === 404) throw new ApiError('FORBIDDEN', 'Not available.', 403);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

/** The efficiency lab's read routes (docs/prd/claude-usage.md §28.10). */
export const labApi = {
  summary: (period: LabPeriod) => get<LabSummary>(`${LAB_API.summary}?period=${period}`),
  scorecard: (window: CrewWindow, compare: boolean) => get<CrewScorecard>(`${SCORECARD_API.scorecard}?window=${window}&compare=${compare ? 1 : 0}`),
  experiments: () => get<LabExperimentView[]>(LAB_API.experiments),
};

/** The pilot metrics read routes (docs/prd/claude-usage.md §28.15). A program the portal does not know is the same 404 as a refusal. */
export const metricsApi = {
  programs: () => get<MetricsProgram[]>(METRICS_API.programs),
  overview: (program: string, window: MetricsWindow) => get<MetricsOverview>(`${METRICS_API.overview}?${metricsQuery({ program, window })}`),
  flow: (program: string, window: MetricsWindow, groupBy?: MetricsGroupBy) => get<MetricsFlow>(`${METRICS_API.flow}?${metricsQuery({ program, window, groupBy })}`),
  trend: (program: string, metric: MetricsTrendKey, window: MetricsTrendWindow) => get<MetricsTrend>(`${METRICS_API.trend}?${metricsQuery({ program, metric, window })}`),
  tickets: (program: string, window: MetricsWindow, o: { stage?: MetricsStage | null; groupBy?: MetricsGroupBy | null; group?: string | null } = {}) =>
    get<MetricsTickets>(`${METRICS_API.tickets}?${metricsQuery({ program, window, stage: o.stage, groupBy: o.groupBy, group: o.group })}`),
  insights: (program: string, window: MetricsWindow) => get<MetricsInsights>(`${METRICS_API.insights}?${metricsQuery({ program, window })}`),
};
