import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import type { AttentionKind, AttentionList } from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

/** `GET /api/attention`: `{ data }` on success, an ApiError otherwise; a 401 tells the app the session ended. */
export async function fetchAttention(q: { kind?: AttentionKind | null; limit?: number } = {}): Promise<AttentionList> {
  const params = new URLSearchParams();
  if (q.kind) params.set('kind', q.kind);
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  let res: Response;
  try {
    res = await fetch(`/api/attention${params.size ? `?${params}` : ''}`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<AttentionList>(json)) return json.data;
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}
