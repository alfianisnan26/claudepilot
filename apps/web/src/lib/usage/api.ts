import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  CLAUDE_USAGE_API,
  usageExportUrl,
  type ChatUsageRange,
  type MoveRecommendation,
  type RequestsReport,
  type UsageExportQuery,
  type UsagePalette,
  type UsageSummary,
} from '@portal/contracts';
import { ApiError } from '@/lib/api';

/** Same shape as the other features' `request`: same-origin credentials, the `{ data }` / `{ error }` envelope unwrapped. */
async function request<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await track(fetch(path, { method: 'GET', credentials: 'same-origin' }));
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

const tz = () => new Date().getTimezoneOffset();
const q = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** The usage insight routes (docs/prd/claude-usage.md §20): the page's and the widgets' reads. */
export const usageApi = {
  palette: () => request<UsagePalette>(CLAUDE_USAGE_API.palette),
  /** The summary strip. Without `claudeId` every Claude counts. */
  summary: (claudeId?: string) => request<UsageSummary>(`${CLAUDE_USAGE_API.summary}${q({ claudeId, tz: tz() })}`),
  /** The Requests report with the previous period, the cache split, palette slots and per-bucket series. */
  requests: (range: ChatUsageRange, claudeId?: string) => request<RequestsReport>(`${CLAUDE_USAGE_API.requests}${q({ range, claudeId, tz: tz() })}`),
  /** The Claudes a chat in `workspaceId` can move to, ranked; `from` is the Claude it leaves. */
  recommend: (workspaceId: string, from?: string) => request<MoveRecommendation>(`${CLAUDE_USAGE_API.recommend}${q({ workspaceId, from })}`),
  /** A download link (the browser sends the session cookie): `what` requests or quota, as csv or json. */
  exportUrl: (query: Omit<UsageExportQuery, 'tz'>) => usageExportUrl(CLAUDE_USAGE_API.export, { ...query, tz: tz() }),
};
