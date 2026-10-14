import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import type { AttentionItem, AttentionKind, AttentionList } from '@portal/contracts';
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

/** `POST /api/attention/snooze`: Later for this person (an hour by default; 0 brings it back). Returns the item as the list now shows it. */
export async function snoozeAttention(kind: AttentionKind, id: string, minutes?: number): Promise<AttentionItem> {
  let res: Response;
  try {
    res = await fetch('/api/attention/snooze', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minutes === undefined ? { kind, id } : { kind, id, minutes }),
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<AttentionItem>(json)) return json.data;
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}
