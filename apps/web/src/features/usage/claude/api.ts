import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import { CLAUDE_USAGE_API, type ClaudeUsage, type ClaudeUsageHistory, type ClaudeUsageReport, type SnoozeUntil, type UsageRange } from '@portal/contracts';
import { ApiError } from '@/lib/api';

/** Same shape as the other features' `request`: same-origin credentials, the `{ data }` / `{ error }` envelope unwrapped. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await track(
      fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

export const claudeUsageApi = {
  /** Every Claude's plan windows. `watch`: the Usage tab is open, so the portal reads them more often for a while. */
  report: (watch = false) => request<ClaudeUsageReport>('GET', `${CLAUDE_USAGE_API.list}${watch ? '?watch=1' : ''}`),
  history: (claudeId: string, range: UsageRange) => request<ClaudeUsageHistory>('GET', `${CLAUDE_USAGE_API.one(claudeId)}/history?range=${range}`),
  /** Reads one Claude now (a cooldown applies). */
  check: (claudeId: string) => request<ClaudeUsage>('POST', `${CLAUDE_USAGE_API.one(claudeId)}/check`),
  snooze: (claudeId: string, until: SnoozeUntil) => request<ClaudeUsage>('PUT', `${CLAUDE_USAGE_API.one(claudeId)}/snooze`, { until }),
  unsnooze: (claudeId: string) => request<ClaudeUsage>('DELETE', `${CLAUDE_USAGE_API.one(claudeId)}/snooze`),
};
