import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import { LAB_API, SCORECARD_API, type CrewScorecard, type CrewWindow, type LabExperimentView, type LabPeriod, type LabSummary } from '@portal/contracts';
import { ApiError } from '@/lib/api';

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
